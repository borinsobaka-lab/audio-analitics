"""Аналитика сценария звонка: докуда доходит разговор и где заканчивается.

Админка пишет путь звонка по блокам сценария по ходу разговора — после
каждого клика. Отсюда «Аналитика» → «Звонки»: воронка по этапам сценария
(сколько звонков дошли до этапа и сколько на нём закончились) и список
блоков, на которых звонки заканчивались. Цель одна — видеть, где сценарий
теряет клиентов, и править его.
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
    CallStatSection,
    CallStatsOut,
    CallStatTotals,
)
from .playbook import load_flows
from .playbook_common import author, current_org, missing_migration

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


def aggregate(runs: list[Run], nodes: list[dict], now: datetime) -> dict:
    """Воронка и места окончания звонков одного сценария. nodes — блоки
    текущего сценария: этапы воронки идут в их порядке. Идущие сейчас
    звонки не считаются."""
    done = [r for r in runs if r.path and not r.live(now)]
    by_id = {n["id"]: n for n in nodes}
    # Конец сценария — блок без ответов. У этапов, восстановленных по
    # звонкам удалённого сценария, ответов не знаем — концом не считаем.
    script_ends = {n["id"] for n in nodes if "answers" in n and not n["answers"]}

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
            script_end=node_id in script_ends,
            count=count,
        )
        for node_id, count in ended.most_common()
    ]
    totals = CallStatTotals(
        runs=len(done),
        completed=sum(c for node_id, c in ended.items() if node_id in script_ends),
        avg_steps=statistics.fmean(len(r.path) for r in done) if done else None,
    )
    return {"totals": totals, "funnel": funnel, "ends": ends}


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
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Воронка звонков одного сценария за период. Границы периода присылает
    админка уже с часовым поясом браузера. Сотрудник с доступом «только
    свои» видит только свои звонки."""
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
        raise missing_migration("Аналитика звонков", "017_call_runs.sql") from exc

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

    flow_row = flows.get(chosen)
    nodes = list((flow_row.flow if flow_row else {}).get("nodes") or [])
    rows = (
        await db.execute(
            period(
                select(
                    PlaybookCallRun.path,
                    PlaybookCallRun.ended_at,
                    PlaybookCallRun.updated_at,
                ).where(*base, PlaybookCallRun.section_id == chosen),
                date_from,
                date_to,
            ).limit(50_000)
        )
    ).all()
    runs = [Run(path=list(r.path or []), ended=r.ended_at is not None, updated_at=r.updated_at) for r in rows]
    if not nodes:
        # Сценарий удалён — этапы восстанавливаются по самим звонкам, в
        # порядке первого появления.
        seen: dict[str, dict] = {}
        for run in runs:
            for step in run.path:
                seen.setdefault(
                    step.get("id", ""),
                    {"id": step.get("id", ""), "title": step.get("title", ""), "group": step.get("group", "main")},
                )
        nodes = list(seen.values())
    return out.model_copy(update=aggregate(runs, nodes, utcnow()))
