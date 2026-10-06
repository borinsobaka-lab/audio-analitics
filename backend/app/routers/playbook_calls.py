"""Аналитика сценария звонка: докуда доходит разговор и где заканчивается.

Админка пишет путь звонка по блокам сценария по ходу разговора — после
каждого клика. Отсюда «Настройки скриптов» → «Звонки»:
- сводка: воронка по этапам сценария (сколько звонков дошли до этапа и
  сколько на нём закончились) и блоки, на которых звонки заканчивались;
- история: каждый звонок — когда, кто, докуда дошёл и где закончился.
Цель одна — видеть, где сценарий теряет клиентов, и править его.
"""
import logging
import statistics
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import UserContext, require_user
from ..db import get_db
from ..models import PlaybookCallRun, PlaybookSection, utcnow
from ..schemas import (
    CallEndStat,
    CallFunnelStep,
    CallRunIn,
    CallRunOut,
    CallRunPathStep,
    CallRunsPage,
    CallStatSection,
    CallStatsOut,
    CallStatTotals,
    CallStatUser,
)
from .playbook import load_flows
from .playbook_common import PAGE, author, current_org, missing_migration, page_by_time

router = APIRouter(prefix="/api/playbook", tags=["playbook"])
log = logging.getLogger(__name__)

# Не завершённый звонок, который трогали меньше получаса назад, ещё идёт —
# в статистику он не попадает, иначе «закончился» бы на текущем шаге.
LIVE_WINDOW = timedelta(minutes=30)


@router.put("/call-runs/{run_id}", status_code=204)
async def save_run(
    run_id: uuid.UUID,
    body: CallRunIn,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Путь звонка целиком, после каждого шага. Админка шлёт, не дожидаясь
    ответа: разговор не должен зависеть от статистики. Поэтому и до
    миграции 017 здесь не ошибка, а тихий пропуск."""
    org = await current_org(db)
    section = await db.get(PlaybookSection, body.section_id)
    if section and section.org_id != org.id:
        raise HTTPException(404, "Раздел не найден")
    now = utcnow()
    last = body.path[-1]
    fields = {
        "user_name": author(user),
        "path": [s.model_dump(mode="json") for s in body.path],
        "steps": len(body.path),
        "last_node_id": last.id,
        "last_node_title": last.title,
        "updated_at": now,
    }
    stmt = pg_insert(PlaybookCallRun).values(
        id=run_id,
        org_id=org.id,
        section_id=body.section_id,
        section_title=section.title if section else "",
        user_key=user.author_key,
        started_at=now,
        ended_at=now if body.finished else None,
        **fields,
    )
    update = {
        **fields,
        # Шаг назад с последнего блока снова открывает звонок.
        "ended_at": func.coalesce(PlaybookCallRun.ended_at, now) if body.finished else None,
    }
    if section:
        # Раздел удалили посреди звонка — название остаётся прежним.
        update["section_title"] = section.title
    stmt = stmt.on_conflict_do_update(
        index_elements=[PlaybookCallRun.id],
        set_=update,
        # Чужой звонок не перезаписать, даже зная его id.
        where=(PlaybookCallRun.user_key == user.author_key) & (PlaybookCallRun.org_id == org.id),
    )
    try:
        await db.execute(stmt)
        await db.commit()
    except ProgrammingError:
        await db.rollback()
        log.warning("Звонок не записан: нет таблицы playbook_call_runs (миграция 017)")
    return None


# --- Подсчёт ---

@dataclass
class Run:
    path: list[dict]
    ended: bool
    updated_at: datetime

    @property
    def ids(self) -> set[str]:
        return {s.get("id", "") for s in self.path}

    def live(self, now: datetime) -> bool:
        return not self.ended and now - self.updated_at < LIVE_WINDOW

    @property
    def seconds(self) -> float | None:
        """От первого шага до последнего — по часам админки."""
        try:
            a = datetime.fromisoformat(self.path[0]["at"])
            b = datetime.fromisoformat(self.path[-1]["at"])
        except (IndexError, KeyError, TypeError, ValueError):
            return None
        sec = (b - a).total_seconds()
        return sec if sec >= 0 and len(self.path) > 1 else None


def aggregate(runs: list[Run], nodes: list[dict], now: datetime) -> dict:
    """Воронка и места окончания звонков одного сценария. nodes — блоки
    текущего сценария: этапы воронки идут в их порядке. Идущие сейчас
    звонки не считаются."""
    done = [r for r in runs if r.path and not r.live(now)]
    by_id = {n["id"]: n for n in nodes}
    ends_ids = script_ends(nodes)

    reached: Counter[str] = Counter()
    ended: Counter[str] = Counter()
    titles: dict[str, tuple[str, str]] = {}
    for run in done:
        reached.update(run.ids)
        last = run.path[-1]
        node_id = last.get("id", "")
        ended[node_id] += 1
        titles.setdefault(node_id, (last.get("title", "") or node_id, last.get("group", "main")))

    funnel = [
        CallFunnelStep(
            node_id=n["id"],
            title=n.get("title", ""),
            reached=reached[n["id"]],
            ended_here=ended[n["id"]],
        )
        for n in nodes
        if n.get("group", "main") == "main"
    ]
    ends = [
        CallEndStat(
            node_id=node_id,
            title=by_id[node_id].get("title", "") if node_id in by_id else titles[node_id][0],
            group=by_id[node_id].get("group", "main") if node_id in by_id else titles[node_id][1],
            script_end=node_id in ends_ids,
            count=count,
        )
        for node_id, count in ended.most_common()
    ]
    totals = CallStatTotals(
        runs=len(done),
        completed=sum(c for node_id, c in ended.items() if node_id in ends_ids),
        avg_steps=statistics.fmean(len(r.path) for r in done) if done else None,
    )
    return {"totals": totals, "funnel": funnel, "ends": ends}


def script_ends(nodes: list[dict]) -> set[str]:
    """Конец сценария — блок без ответов. У этапов, восстановленных по
    звонкам удалённого сценария, ответов не знаем — концом не считаем."""
    return {n["id"] for n in nodes if "answers" in n and not n["answers"]}


def run_progress(path: list[dict], nodes: list[dict]) -> dict:
    """Докуда дошёл один звонок: самый дальний этап сценария по порядку и
    блок, на котором закончился."""
    stages = [n for n in nodes if n.get("group", "main") == "main"]
    ids = {s.get("id", "") for s in path}
    reached = max((i + 1 for i, n in enumerate(stages) if n["id"] in ids), default=0)
    last = path[-1] if path else {}
    titles = {n["id"]: n.get("title", "") for n in nodes}
    return {
        "reached": reached,
        "stages": len(stages),
        "reached_title": stages[reached - 1].get("title", "") if reached else "",
        "last_title": titles.get(last.get("id", "")) or last.get("title", ""),
        "last_group": last.get("group", "main"),
        "script_end": last.get("id", "") in script_ends(nodes),
    }


# --- Отчёт ---

def period(q, date_from: datetime | None, date_to: datetime | None):
    if date_from:
        q = q.where(PlaybookCallRun.started_at >= date_from)
    if date_to:
        q = q.where(PlaybookCallRun.started_at < date_to)
    return q


@router.get("/call-stats", response_model=CallStatsOut)
async def call_stats(
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    section: uuid.UUID | None = None,
    user_key: str = Query("", alias="user"),
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Воронка звонков одного сценария за период — у всех или у одного
    администратора. Границы периода присылает админка уже с часовым поясом
    браузера. Сотрудник с доступом «только свои» видит только свои звонки."""
    org = await current_org(db)
    flows = await load_flows(db, org.id)
    live_sections = {
        s.id: s
        for s in (
            await db.scalars(select(PlaybookSection).where(PlaybookSection.id.in_(list(flows))))
        ).all()
    } if flows else {}

    base = [PlaybookCallRun.org_id == org.id]
    if not user.can_view_all:
        base.append(PlaybookCallRun.user_key == user.author_key)
    try:
        per_section = (
            await db.execute(
                period(
                    select(
                        PlaybookCallRun.section_id,
                        func.max(PlaybookCallRun.section_title).label("title"),
                        func.count().label("runs"),
                    ).where(*base),
                    date_from,
                    date_to,
                ).group_by(PlaybookCallRun.section_id)
            )
        ).all()
    except ProgrammingError as exc:
        await db.rollback()
        raise missing_migration("Аналитика звонков ещё не включена", "017_call_runs.sql") from exc

    counts = {r.section_id: (r.title, r.runs) for r in per_section}
    sections = [
        CallStatSection(id=sid, title=s.title, runs=counts.get(sid, ("", 0))[1])
        for sid, s in sorted(live_sections.items(), key=lambda kv: kv[1].position)
    ]
    sections += [
        CallStatSection(id=sid, title=title or "Удалённый звонок", runs=runs, deleted=True)
        for sid, (title, runs) in counts.items()
        if sid not in live_sections
    ]
    out = CallStatsOut(sections=sections)
    if not sections:
        return out
    chosen = section if section and any(s.id == section for s in sections) else None
    if not chosen:
        # По умолчанию — сценарий, по которому больше всего звонили.
        chosen = max(sections, key=lambda s: (s.runs, not s.deleted)).id
    out.section_id = chosen

    in_section = [*base, PlaybookCallRun.section_id == chosen]
    # Список администраторов — без фильтра по администратору: из него выбирают.
    out.users = [
        CallStatUser(key=r.user_key, name=r.name or r.user_key, runs=r.runs)
        for r in (
            await db.execute(
                period(
                    select(
                        PlaybookCallRun.user_key,
                        func.max(PlaybookCallRun.user_name).label("name"),
                        func.count().label("runs"),
                    ).where(*in_section),
                    date_from,
                    date_to,
                )
                .group_by(PlaybookCallRun.user_key)
                .order_by(func.count().desc())
            )
        ).all()
    ]
    if user_key:
        in_section.append(PlaybookCallRun.user_key == user_key)
    rows = (
        await db.execute(
            period(
                select(
                    PlaybookCallRun.path,
                    PlaybookCallRun.ended_at,
                    PlaybookCallRun.updated_at,
                ).where(*in_section),
                date_from,
                date_to,
            ).limit(50_000)
        )
    ).all()
    runs = [Run(path=list(r.path or []), ended=r.ended_at is not None, updated_at=r.updated_at) for r in rows]
    nodes = flow_nodes(flows.get(chosen), [r.path for r in runs])
    return out.model_copy(update=aggregate(runs, nodes, utcnow()))


def flow_nodes(flow_row, paths: list[list[dict]]) -> list[dict]:
    """Блоки сценария по порядку. Сценарий удалён — этапы восстанавливаются
    по самим звонкам, в порядке первого появления."""
    nodes = list((flow_row.flow if flow_row else {}).get("nodes") or [])
    if nodes:
        return nodes
    seen: dict[str, dict] = {}
    for path in paths:
        for step in path:
            seen.setdefault(
                step.get("id", ""),
                {"id": step.get("id", ""), "title": step.get("title", ""), "group": step.get("group", "main")},
            )
    return list(seen.values())


@router.get("/call-runs", response_model=CallRunsPage)
async def call_runs(
    section: uuid.UUID,
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    user_key: str = Query("", alias="user"),
    cursor: str = "",
    limit: int = PAGE,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """История звонков по сценарию, от новых к старым, порциями: когда, кто,
    докуда дошёл и на каком блоке закончился. Тестовые прогоны сюда не
    попадают — админка их не присылает."""
    org = await current_org(db)
    if not user.can_view_all:
        user_key = user.author_key
    q = period(
        select(PlaybookCallRun).where(
            PlaybookCallRun.org_id == org.id, PlaybookCallRun.section_id == section
        ),
        date_from,
        date_to,
    )
    if user_key:
        q = q.where(PlaybookCallRun.user_key == user_key)
    try:
        rows, next_cursor = await page_by_time(db, q, PlaybookCallRun, cursor, limit, "started_at")
    except ProgrammingError as exc:
        await db.rollback()
        raise missing_migration("Аналитика звонков ещё не включена", "017_call_runs.sql") from exc
    nodes = flow_nodes((await load_flows(db, org.id)).get(section), [r.path or [] for r in rows])
    now = utcnow()
    items = []
    for r in rows:
        path = list(r.path or [])
        run = Run(path=path, ended=r.ended_at is not None, updated_at=r.updated_at)
        items.append(
            CallRunOut(
                id=r.id,
                user_name=r.user_name,
                started_at=r.started_at,
                seconds=run.seconds,
                live=run.live(now),
                steps=len(path),
                path=[
                    CallRunPathStep(
                        title=s.get("title", ""), group=s.get("group", "main"), answer=s.get("answer", "")
                    )
                    for s in path
                ],
                **run_progress(path, nodes),
            )
        )
    return CallRunsPage(items=items, next_cursor=next_cursor)
