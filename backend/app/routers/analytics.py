"""Сводная статистика за период — то, ради чего метрики вообще копятся.

Отчёт по одной смене отвечает на вопрос «как прошёл этот день». Здесь другой
вопрос: растёт менеджер или проседает. Поэтому всё считается за произвольный
период и сразу сравнивается с предыдущим периодом такой же длины.
"""
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext, require_user
from ..db import get_db
from ..models import (
    AnalysisMetric,
    DayRecording,
    Employee,
    MetricEvaluation,
    MetricsDaily,
)
from ..schemas import (
    EmployeePeriodStat,
    MetricPeriodStat,
    PeriodTotals,
    SummaryOut,
    TrendPoint,
)

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

MAX_RANGE_DAYS = 730


@dataclass
class ShiftRow:
    """Одна обработанная смена — минимум, нужный для всех разрезов."""

    date: date
    employee_id: uuid.UUID | None
    dialogs: int
    sales: int
    speech_seconds: float
    cost_usd: float


@dataclass
class ScoreGroup:
    """Сумма и количество вместо готового среднего.

    Среднее из средних врёт, если в группах разное число оценок, поэтому
    складываются суммы, а деление происходит один раз в самом конце.
    """

    total: float = 0.0
    count: int = 0

    def add(self, score_sum: float, n: int) -> None:
        self.total += score_sum
        self.count += n

    @property
    def avg(self) -> float | None:
        return round(self.total / self.count, 1) if self.count else None


@dataclass
class Slice:
    """Сырьё периода: смены и оценки, разложенные по нужным ключам."""

    shifts: list[ShiftRow] = field(default_factory=list)
    # metric_id -> оценки за период
    by_metric: dict[uuid.UUID, ScoreGroup] = field(default_factory=dict)
    # (employee_id, metric_id) -> оценки
    by_employee_metric: dict[tuple, ScoreGroup] = field(default_factory=dict)
    # (date, metric_id) -> оценки
    by_date_metric: dict[tuple, ScoreGroup] = field(default_factory=dict)


def totals_of(shifts: list[ShiftRow]) -> PeriodTotals:
    dialogs = sum(s.dialogs for s in shifts)
    sales = sum(s.sales for s in shifts)
    return PeriodTotals(
        shifts=len(shifts),
        dialogs=dialogs,
        sales=sales,
        # Конверсия по сумме, а не среднее дневных: иначе день с одним
        # разговором весит столько же, сколько день с двадцатью.
        conversion=round(sales / dialogs, 3) if dialogs else None,
        speech_seconds=round(sum(s.speech_seconds for s in shifts), 1),
        cost_usd=round(sum(s.cost_usd for s in shifts), 4),
    )


async def collect(
    db: AsyncSession,
    date_from: date,
    date_to: date,
    employee_id: uuid.UUID | None,
    location_ids: list[uuid.UUID] | None = None,
) -> Slice:
    """Одна выборка периода. Вызывается дважды: текущий период и предыдущий."""
    result = Slice()

    shift_q = (
        select(
            DayRecording.date,
            DayRecording.employee_id,
            func.coalesce(MetricsDaily.dialogs_total, 0),
            func.coalesce(MetricsDaily.sales_count, 0),
            func.coalesce(DayRecording.speech_duration_s, 0.0),
            func.coalesce(DayRecording.cost_usd, 0.0),
        )
        .join(MetricsDaily, MetricsDaily.day_recording_id == DayRecording.id, isouter=True)
        .where(
            DayRecording.status == "done",
            DayRecording.date >= date_from,
            DayRecording.date <= date_to,
        )
    )
    if employee_id:
        shift_q = shift_q.where(DayRecording.employee_id == employee_id)
    if location_ids:
        shift_q = shift_q.where(DayRecording.location_id.in_(location_ids))

    for row in (await db.execute(shift_q)).all():
        result.shifts.append(
            ShiftRow(
                date=row[0],
                employee_id=row[1],
                dialogs=row[2],
                sales=row[3],
                speech_seconds=float(row[4]),
                cost_usd=float(row[5]),
            )
        )

    # Оценки сворачиваются в базе до (метрика, менеджер, дата) — этого хватает
    # на все три разреза, а строк остаётся на порядки меньше, чем оценок.
    score_q = (
        select(
            MetricEvaluation.metric_id,
            DayRecording.employee_id,
            DayRecording.date,
            func.count(MetricEvaluation.score),
            func.sum(MetricEvaluation.score),
        )
        .join(DayRecording, DayRecording.id == MetricEvaluation.day_recording_id)
        .where(
            MetricEvaluation.applicable.is_(True),
            MetricEvaluation.score.is_not(None),
            DayRecording.status == "done",
            DayRecording.date >= date_from,
            DayRecording.date <= date_to,
        )
        .group_by(MetricEvaluation.metric_id, DayRecording.employee_id, DayRecording.date)
    )
    if employee_id:
        score_q = score_q.where(DayRecording.employee_id == employee_id)
    if location_ids:
        score_q = score_q.where(DayRecording.location_id.in_(location_ids))

    for metric_id, emp_id, day, count, score_sum in (await db.execute(score_q)).all():
        n = int(count or 0)
        total = float(score_sum or 0)
        if not n:
            continue
        result.by_metric.setdefault(metric_id, ScoreGroup()).add(total, n)
        result.by_employee_metric.setdefault((emp_id, metric_id), ScoreGroup()).add(total, n)
        result.by_date_metric.setdefault((day, metric_id), ScoreGroup()).add(total, n)

    return result


@router.get("/summary", response_model=SummaryOut)
async def summary(
    date_from: date = Query(..., description="Начало периода включительно"),
    date_to: date = Query(..., description="Конец периода включительно"),
    employee_id: uuid.UUID | None = Query(default=None),
    # Повторяемый параметр: можно выбрать одну студию, несколько или ни одной
    # (последнее означает «все»).
    location_id: list[uuid.UUID] | None = Query(default=None, description="Точки продажи"),
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    # Менеджер с доступом «только свои» видит здесь свой прогресс и ничей
    # больше: фильтр по себе ставится принудительно, что бы ни пришло в
    # параметрах запроса.
    if not user.can_view_all:
        if not user.employee_id:
            raise HTTPException(403, "Учётной записи не сопоставлен менеджер")
        employee_id = user.employee_id
    if date_to < date_from:
        raise HTTPException(400, "Конец периода раньше начала")
    length = (date_to - date_from).days + 1
    if length > MAX_RANGE_DAYS:
        raise HTTPException(400, f"Период длиннее {MAX_RANGE_DAYS} дней")

    # Предыдущий период — такой же длины, вплотную перед текущим: сравнение
    # недели с неделей, месяца с месяцем без ручной арифметики.
    prev_to = date_from - timedelta(days=1)
    prev_from = prev_to - timedelta(days=length - 1)

    current = await collect(db, date_from, date_to, employee_id, location_id)
    previous = await collect(db, prev_from, prev_to, employee_id, location_id)

    metrics = list(
        await db.scalars(select(AnalysisMetric).order_by(AnalysisMetric.position))
    )
    # Метрику, которую успели удалить, из истории не выкидываем: оценки за
    # прошлые смены остались, и без неё период выглядел бы пустым.
    known = {m.id for m in metrics}
    seen = set(current.by_metric) | set(previous.by_metric)
    if seen - known:
        metrics += list(
            await db.scalars(
                select(AnalysisMetric).where(AnalysisMetric.id.in_(seen - known))
            )
        )

    def metric_stats(
        source: dict[uuid.UUID, ScoreGroup], prev: dict[uuid.UUID, ScoreGroup]
    ) -> list[MetricPeriodStat]:
        out = []
        for m in metrics:
            group = source.get(m.id)
            if group is None and prev.get(m.id) is None:
                continue
            out.append(
                MetricPeriodStat(
                    metric_id=m.id,
                    name=m.name,
                    scale_max=m.scale_max,
                    triggered_count=group.count if group else 0,
                    avg_score=group.avg if group else None,
                    prev_avg_score=prev[m.id].avg if m.id in prev else None,
                )
            )
        return out

    # --- Разрез по менеджерам ---
    employees = {
        e.id: e.full_name for e in await db.scalars(select(Employee))
    }
    by_employee: dict[uuid.UUID | None, list[ShiftRow]] = defaultdict(list)
    for shift in current.shifts:
        by_employee[shift.employee_id].append(shift)

    employee_rows: list[EmployeePeriodStat] = []
    for emp_id, shifts in by_employee.items():
        per_metric = {
            metric_id: group
            for (e, metric_id), group in current.by_employee_metric.items()
            if e == emp_id
        }
        prev_per_metric = {
            metric_id: group
            for (e, metric_id), group in previous.by_employee_metric.items()
            if e == emp_id
        }
        employee_rows.append(
            EmployeePeriodStat(
                employee_id=emp_id,
                full_name=employees.get(emp_id, "Менеджер не указан"),
                totals=totals_of(shifts),
                metrics=metric_stats(per_metric, prev_per_metric),
            )
        )
    employee_rows.sort(key=lambda r: (-r.totals.dialogs, r.full_name))

    # --- Ряд по дням для графика ---
    by_date: dict[date, list[ShiftRow]] = defaultdict(list)
    for shift in current.shifts:
        by_date[shift.date].append(shift)

    trend: list[TrendPoint] = []
    for day in sorted(by_date):
        day_totals = totals_of(by_date[day])
        trend.append(
            TrendPoint(
                date=day,
                dialogs=day_totals.dialogs,
                sales=day_totals.sales,
                conversion=day_totals.conversion,
                cost_usd=day_totals.cost_usd,
                avg_scores={
                    str(metric_id): group.avg
                    for (d, metric_id), group in current.by_date_metric.items()
                    if d == day and group.avg is not None
                },
            )
        )

    return SummaryOut(
        date_from=date_from,
        date_to=date_to,
        prev_date_from=prev_from,
        prev_date_to=prev_to,
        totals=totals_of(current.shifts),
        previous=totals_of(previous.shifts),
        metrics=metric_stats(current.by_metric, previous.by_metric),
        employees=employee_rows,
        trend=trend,
    )
