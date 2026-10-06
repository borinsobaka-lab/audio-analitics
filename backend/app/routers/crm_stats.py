"""Статистика CRM по менеджерам за период — то, ради чего критерии копятся.

Разбор дня отвечает «что было вчера»; здесь — кто из администраторов
системно теряет клиентов в переписке, у кого висят сделки без ответа и как
это меняется от недели к неделе: каждый показатель рядом со своим значением
за предыдущий период такой же длины, как на дашборде аналитики.
"""
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext, require_user
from ..db import get_db
from ..models import CrmCriterion, CrmReview, CrmReviewScore, CrmRun, Employee
from ..schemas import (
    CrmCategoryStat,
    CrmCriterionStat,
    CrmManagerStat,
    CrmStatsOut,
    CrmTotals,
    CrmTrendPoint,
)
from .playbook_common import current_org, missing_migration

router = APIRouter(prefix="/api/crm", tags=["crm"])

MAX_RANGE_DAYS = 730


@dataclass
class ReviewRow:
    date: date
    employee_id: uuid.UUID | None
    manager_key: str
    manager_name: str
    category: str
    severity: str
    problem: bool
    unanswered: bool
    first_reply: float | None


@dataclass
class ScoreRow:
    date: date
    employee_id: uuid.UUID | None
    manager_key: str
    criterion_id: uuid.UUID
    score: int


def group_key(employee_id, manager_key: str) -> str:
    """Менеджер в статистике — сотрудник админки, если сопоставлен, иначе
    ключ из CRM: статистика читается и до сопоставления."""
    return str(employee_id) if employee_id else f"crm:{manager_key or ''}"


def totals_of(rows: list[ReviewRow], runs: int = 0, cost: float = 0.0) -> CrmTotals:
    replies = [r.first_reply for r in rows if r.first_reply is not None]
    problems = sum(1 for r in rows if r.problem)
    return CrmTotals(
        deals=len(rows),
        problems=problems,
        critical=sum(1 for r in rows if r.severity == "critical"),
        unanswered=sum(1 for r in rows if r.unanswered),
        problem_share=round(problems / len(rows), 3) if rows else None,
        avg_first_reply_minutes=round(sum(replies) / len(replies), 1) if replies else None,
        runs=runs,
        cost_usd=round(cost, 4),
    )


def criteria_stats(
    scores: list[ScoreRow], prev: list[ScoreRow], criteria: list
) -> list[CrmCriterionStat]:
    cur: dict = defaultdict(list)
    for s in scores:
        cur[s.criterion_id].append(s.score)
    old: dict = defaultdict(list)
    for s in prev:
        old[s.criterion_id].append(s.score)
    out = []
    for c in criteria:
        if c.id not in cur and c.id not in old:
            continue
        values = cur.get(c.id, [])
        prev_values = old.get(c.id, [])
        out.append(
            CrmCriterionStat(
                criterion_id=c.id,
                name=c.name,
                scale_max=c.scale_max,
                count=len(values),
                avg_score=round(sum(values) / len(values), 1) if values else None,
                prev_avg_score=round(sum(prev_values) / len(prev_values), 1) if prev_values else None,
            )
        )
    return out


def category_stats(rows: list[ReviewRow]) -> list[CrmCategoryStat]:
    counts: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for r in rows:
        counts[r.category][0] += 1
        counts[r.category][1] += 1 if r.problem else 0
    return [
        CrmCategoryStat(category=cat, count=n, problems=p)
        for cat, (n, p) in sorted(counts.items(), key=lambda kv: -kv[1][0])
    ]


def aggregate(
    *,
    date_from: date,
    date_to: date,
    prev_from: date,
    prev_to: date,
    current: list[ReviewRow],
    previous: list[ReviewRow],
    scores: list[ScoreRow],
    prev_scores: list[ScoreRow],
    criteria: list,
    employee_names: dict,
    runs: tuple[int, float],
    prev_runs: tuple[int, float],
) -> CrmStatsOut:
    by_manager: dict[str, list[ReviewRow]] = defaultdict(list)
    for r in current:
        by_manager[group_key(r.employee_id, r.manager_key)].append(r)
    prev_by_manager: dict[str, list[ReviewRow]] = defaultdict(list)
    for r in previous:
        prev_by_manager[group_key(r.employee_id, r.manager_key)].append(r)
    scores_by_manager: dict[str, list[ScoreRow]] = defaultdict(list)
    for s in scores:
        scores_by_manager[group_key(s.employee_id, s.manager_key)].append(s)
    prev_scores_by_manager: dict[str, list[ScoreRow]] = defaultdict(list)
    for s in prev_scores:
        prev_scores_by_manager[group_key(s.employee_id, s.manager_key)].append(s)

    managers = []
    for key, rows in by_manager.items():
        first = rows[0]
        name = (
            employee_names.get(first.employee_id) if first.employee_id else None
        ) or first.manager_name or "Менеджер не указан"
        managers.append(
            CrmManagerStat(
                employee_id=first.employee_id,
                manager_key=first.manager_key,
                name=name,
                totals=totals_of(rows),
                previous=totals_of(prev_by_manager.get(key, [])),
                criteria=criteria_stats(
                    scores_by_manager.get(key, []), prev_scores_by_manager.get(key, []), criteria
                ),
                categories=category_stats(rows),
            )
        )
    managers.sort(key=lambda m: (-m.totals.deals, m.name))

    by_date: dict[date, list[ReviewRow]] = defaultdict(list)
    for r in current:
        by_date[r.date].append(r)
    scores_by_date: dict[date, dict[uuid.UUID, list[int]]] = defaultdict(lambda: defaultdict(list))
    for s in scores:
        scores_by_date[s.date][s.criterion_id].append(s.score)
    trend = []
    for day in sorted(by_date):
        rows = by_date[day]
        problems = sum(1 for r in rows if r.problem)
        trend.append(
            CrmTrendPoint(
                date=day,
                deals=len(rows),
                problems=problems,
                problem_share=round(problems / len(rows), 3) if rows else None,
                avg_scores={
                    str(cid): round(sum(v) / len(v), 1)
                    for cid, v in scores_by_date.get(day, {}).items()
                    if v
                },
            )
        )

    return CrmStatsOut(
        date_from=date_from,
        date_to=date_to,
        prev_date_from=prev_from,
        prev_date_to=prev_to,
        totals=totals_of(current, *runs),
        previous=totals_of(previous, *prev_runs),
        criteria=criteria_stats(scores, prev_scores, criteria),
        managers=managers,
        categories=category_stats(current),
        trend=trend,
    )


async def collect(
    db: AsyncSession, org_id, date_from: date, date_to: date, employee_id
) -> tuple[list[ReviewRow], list[ScoreRow], tuple[int, float]]:
    review_q = select(CrmReview).where(
        CrmReview.org_id == org_id, CrmReview.date >= date_from, CrmReview.date <= date_to
    )
    if employee_id:
        review_q = review_q.where(CrmReview.employee_id == employee_id)
    reviews = (await db.scalars(review_q)).all()
    rows = [
        ReviewRow(
            date=r.date,
            employee_id=r.employee_id,
            manager_key=r.manager_key,
            manager_name=r.manager_name,
            category=r.category,
            severity=r.severity,
            problem=r.problem,
            unanswered=r.unanswered,
            first_reply=r.first_reply_minutes,
        )
        for r in reviews
    ]
    scores: list[ScoreRow] = []
    if reviews:
        by_id = {r.id: r for r in reviews}
        for s in (
            await db.scalars(
                select(CrmReviewScore).where(
                    CrmReviewScore.review_id.in_(list(by_id)),
                    CrmReviewScore.applicable.is_(True),
                    CrmReviewScore.score.is_not(None),
                )
            )
        ).all():
            r = by_id[s.review_id]
            scores.append(
                ScoreRow(
                    date=r.date,
                    employee_id=r.employee_id,
                    manager_key=r.manager_key,
                    criterion_id=s.criterion_id,
                    score=int(s.score),
                )
            )
    runs = (
        await db.execute(
            select(func.count(), func.coalesce(func.sum(CrmRun.cost_usd), 0.0)).where(
                CrmRun.org_id == org_id,
                CrmRun.status == "done",
                CrmRun.date >= date_from,
                CrmRun.date <= date_to,
            )
        )
    ).one()
    return rows, scores, (int(runs[0] or 0), float(runs[1] or 0.0))


@router.get("/stats", response_model=CrmStatsOut)
async def crm_stats(
    date_from: date = Query(..., description="Начало периода включительно"),
    date_to: date = Query(..., description="Конец периода включительно"),
    employee_id: uuid.UUID | None = Query(default=None),
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    if not user.can_view_all_crm:
        if not user.employee_id:
            raise HTTPException(403, "Учётной записи не сопоставлен сотрудник")
        employee_id = user.employee_id
    if date_to < date_from:
        raise HTTPException(400, "Конец периода раньше начала")
    length = (date_to - date_from).days + 1
    if length > MAX_RANGE_DAYS:
        raise HTTPException(400, f"Период длиннее {MAX_RANGE_DAYS} дней")
    prev_to = date_from - timedelta(days=1)
    prev_from = prev_to - timedelta(days=length - 1)

    org = await current_org(db)
    try:
        current, scores, runs = await collect(db, org.id, date_from, date_to, employee_id)
        previous, prev_scores, prev_runs = await collect(db, org.id, prev_from, prev_to, employee_id)
        criteria = (
            await db.scalars(
                select(CrmCriterion)
                .where(CrmCriterion.org_id == org.id)
                .order_by(CrmCriterion.position, CrmCriterion.created_at)
            )
        ).all()
    except ProgrammingError as exc:
        await db.rollback()
        raise missing_migration("CRM ещё не включена", "018_crm.sql") from exc
    employee_names = {e.id: e.full_name for e in (await db.scalars(select(Employee))).all()}
    return aggregate(
        date_from=date_from,
        date_to=date_to,
        prev_from=prev_from,
        prev_to=prev_to,
        current=current,
        previous=previous,
        scores=scores,
        prev_scores=prev_scores,
        criteria=list(criteria),
        employee_names=employee_names,
        runs=runs,
        prev_runs=prev_runs,
    )
