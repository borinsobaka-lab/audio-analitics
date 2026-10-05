"""Аналитика звонков: каждый проход сценария звонка и воронка по нему.

Админка пишет звонок по ходу разговора — после каждого клика, целиком:
путь по блокам, ответы клиента, итог. Отсюда «Аналитика» → «Звонки»:

- воронка по этапам сценария — сколько звонков до какого этапа дошли и
  на каком оборвались без записи;
- возражения — как часто звучат и сколько после них всё-таки записались;
- ответы клиентов на этапах (чего хотят, какую студию выбирают);
- администраторы — сколько звонков, конверсия, докуда доходят.

Считается в Python, а не SQL: звонков у студии десятки в день, а путь по
сценарию — список, который удобнее разбирать кодом, чем jsonb-запросами.
"""
import logging
import statistics
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
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
    CallAnswerCount,
    CallEndStat,
    CallFunnelStep,
    CallObjectionStat,
    CallRunIn,
    CallRunOut,
    CallRunPathStep,
    CallRunsPage,
    CallStatSection,
    CallStatsOut,
    CallStatTotals,
    CallUserStat,
)
from .playbook import author, current_org, decode_cursor, encode_cursor, load_flows

router = APIRouter(prefix="/api/playbook", tags=["playbook"])
log = logging.getLogger(__name__)

# Не завершённый звонок, который не трогали полчаса, считается брошенным.
LIVE_WINDOW = timedelta(minutes=30)
# Дольше на одном шаге — это не разговор, а забытая вкладка: в медиану
# времени на этапе не идёт.
MAX_STEP_SECONDS = 15 * 60
JUMP_PREFIX = "→"
MISSING_MIGRATION = "Аналитика звонков ещё не включена: выполните миграцию 017_call_runs.sql"


# --- Запись звонка ---

@router.put("/call-runs/{run_id}", status_code=204)
async def save_run(
    run_id: uuid.UUID,
    body: CallRunIn,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Звонок целиком, после каждого шага. Админка шлёт, не дожидаясь
    ответа: разговор не должен зависеть от статистики. Поэтому и до
    миграции 017 здесь не ошибка, а тихий пропуск."""
    org = await current_org(db)
    section = await db.get(PlaybookSection, body.section_id)
    if section and section.org_id != org.id:
        raise HTTPException(404, "Раздел не найден")
    now = utcnow()
    last = body.path[-1]
    ended = body.finished or bool(body.outcome)
    fields = {
        "user_name": author(user),
        "studio": body.studio.strip(),
        "lang": body.lang,
        "flow_version": body.flow_version,
        "path": [s.model_dump(mode="json") for s in body.path],
        "steps": len(body.path),
        "last_node_id": last.id,
        "last_node_title": last.title,
        "outcome": body.outcome,
        "updated_at": now,
    }
    stmt = pg_insert(PlaybookCallRun).values(
        id=run_id,
        org_id=org.id,
        section_id=body.section_id,
        section_title=section.title if section else "",
        user_key=user.author_key,
        started_at=now,
        ended_at=now if ended else None,
        **fields,
    )
    update = {
        **fields,
        # Завершённый звонок, который просто пересохранили, не сдвигает
        # время конца; шаг назад с последнего блока снова открывает звонок.
        "ended_at": func.coalesce(PlaybookCallRun.ended_at, now) if ended else None,
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
    user_key: str
    user_name: str
    path: list[dict]
    outcome: str
    ended: bool
    updated_at: datetime
    status: str = ""

    @property
    def ids(self) -> list[str]:
        return [s.get("id", "") for s in self.path]

    @property
    def last_id(self) -> str:
        return self.path[-1].get("id", "") if self.path else ""

    @property
    def seconds(self) -> float | None:
        if len(self.path) < 2:
            return None
        try:
            a = datetime.fromisoformat(self.path[0]["at"])
            b = datetime.fromisoformat(self.path[-1]["at"])
        except (KeyError, TypeError, ValueError):
            return None
        sec = (b - a).total_seconds()
        return sec if sec >= 0 else None


def classify(run: Run, now: datetime) -> str:
    """live — идёт сейчас; ended — завершён; dropped — брошен без итога."""
    if run.ended or run.outcome:
        return "ended"
    return "live" if now - run.updated_at < LIVE_WINDOW else "dropped"


def conversion(booked: int, connected: int) -> float | None:
    return booked / connected if connected else None


def mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def talked(run: Run) -> bool:
    """Дозвонились: «не дозвонились» — не разговор, в воронку он не идёт,
    иначе первый этап всегда выглядел бы худшим местом обрыва."""
    return run.outcome != "no_answer"


def is_drop(run: Run) -> bool:
    """Разговор оборвался без записи — на последнем блоке «отвалился» клиент."""
    return run.status != "live" and run.outcome not in ("booked", "no_answer")


@dataclass
class Counts:
    runs: int = 0
    live: int = 0
    booked: int = 0
    callback: int = 0
    refused: int = 0
    no_answer: int = 0
    no_outcome: int = 0
    steps: list[float] = field(default_factory=list)
    seconds: list[float] = field(default_factory=list)

    def add(self, run: Run) -> None:
        self.runs += 1
        if run.status == "live" and not run.outcome:
            self.live += 1
            return
        if run.outcome in ("booked", "callback", "refused", "no_answer"):
            setattr(self, run.outcome, getattr(self, run.outcome) + 1)
        else:
            self.no_outcome += 1
        self.steps.append(len(run.path))
        if (sec := run.seconds) is not None:
            self.seconds.append(sec)

    @property
    def connected(self) -> int:
        """Дозвонились: всё, кроме «не дозвонились» и идущих сейчас."""
        return self.runs - self.live - self.no_answer

    def fields(self) -> dict:
        return {
            "runs": self.runs,
            "booked": self.booked,
            "callback": self.callback,
            "refused": self.refused,
            "no_answer": self.no_answer,
            "no_outcome": self.no_outcome,
            "conversion": conversion(self.booked, self.connected),
            "avg_steps": mean(self.steps),
            "avg_seconds": mean(self.seconds),
        }


def end_stats(runs: list[Run], titles: dict[str, tuple[str, str]]) -> list[CallEndStat]:
    """Где обрываются звонки без записи — по последнему блоку."""
    by_node: dict[str, CallEndStat] = {}
    for run in runs:
        if not is_drop(run) or not run.path:
            continue
        last = run.path[-1]
        node_id = last.get("id", "")
        title, group = titles.get(node_id, (last.get("title", "") or node_id, last.get("group", "main")))
        stat = by_node.setdefault(node_id, CallEndStat(node_id=node_id, title=title, group=group))
        stat.count += 1
        key = run.outcome if run.outcome in ("callback", "refused") else "no_outcome"
        setattr(stat, key, getattr(stat, key) + 1)
    return sorted(by_node.values(), key=lambda s: -s.count)


def aggregate(runs: list[Run], nodes: list[dict], now: datetime, user_key: str = "") -> dict:
    """Воронка, возражения, обрывы и администраторы по звонкам одного
    сценария. nodes — блоки текущего сценария: этапы воронки идут в их
    порядке. user_key — смотреть одного администратора: воронка и итоги
    по нему, список администраторов — по всем."""
    for run in runs:
        run.status = classify(run, now)
    titles = {n["id"]: (n.get("title", ""), n.get("group", "main")) for n in nodes}
    mine = [r for r in runs if r.user_key == user_key] if user_key else runs

    totals = Counts()
    for run in mine:
        totals.add(run)

    reached: Counter[str] = Counter()
    ended_here: Counter[str] = Counter()
    booked_after: Counter[str] = Counter()
    step_seconds: dict[str, list[float]] = defaultdict(list)
    answers: dict[str, Counter[str]] = defaultdict(Counter)
    for run in filter(talked, mine):
        ids = set(run.ids)
        reached.update(ids)
        if run.outcome == "booked":
            booked_after.update(ids)
        if is_drop(run):
            ended_here[run.last_id] += 1
        for i, step in enumerate(run.path):
            node_id = step.get("id", "")
            label = (step.get("answer") or "").strip()
            if label and not label.startswith(JUMP_PREFIX):
                answers[node_id][label] += 1
            if i + 1 < len(run.path):
                try:
                    sec = (
                        datetime.fromisoformat(run.path[i + 1]["at"])
                        - datetime.fromisoformat(step["at"])
                    ).total_seconds()
                except (KeyError, TypeError, ValueError):
                    continue
                if 0 <= sec <= MAX_STEP_SECONDS:
                    step_seconds[node_id].append(sec)

    funnel = [
        CallFunnelStep(
            node_id=n["id"],
            title=n.get("title", ""),
            reached=reached[n["id"]],
            ended_here=ended_here[n["id"]],
            median_seconds=statistics.median(step_seconds[n["id"]]) if step_seconds[n["id"]] else None,
            answers=[
                CallAnswerCount(label=label, count=count)
                for label, count in answers[n["id"]].most_common()
            ],
        )
        for n in nodes
        if n.get("group", "main") == "main"
    ]
    objections = sorted(
        (
            CallObjectionStat(
                node_id=n["id"],
                title=n.get("title", ""),
                runs=reached[n["id"]],
                booked=booked_after[n["id"]],
                ended_here=ended_here[n["id"]],
            )
            for n in nodes
            if n.get("group") == "objection"
        ),
        key=lambda o: -o.runs,
    )

    users: dict[str, tuple[Counts, list[Run], str]] = {}
    for run in runs:
        counts, own, _ = users.get(run.user_key, (Counts(), [], ""))
        counts.add(run)
        own.append(run)
        users[run.user_key] = (counts, own, run.user_name or run.user_key)
    user_stats = []
    for key, (counts, own, name) in users.items():
        drops = end_stats(own, titles)
        reach: Counter[str] = Counter()
        for run in filter(talked, own):
            reach.update(set(run.ids))
        user_stats.append(
            CallUserStat(
                user_key=key,
                name=name,
                top_drop=drops[0] if drops else None,
                reach={n["id"]: reach[n["id"]] for n in nodes if reach[n["id"]]},
                **counts.fields(),
            )
        )
    user_stats.sort(key=lambda u: (-u.runs, u.name))

    return {
        "totals": CallStatTotals(live=totals.live, **totals.fields()),
        "funnel": funnel,
        "objections": objections,
        "ends": end_stats(mine, titles),
        "users": user_stats,
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
    studio: str = "",
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Воронка и разбор звонков одного сценария за период. Границы периода
    присылает админка уже с часовым поясом браузера. Сотрудник с доступом
    «только свои» видит только свои звонки."""
    org = await current_org(db)
    if not user.can_view_all:
        user_key = user.author_key
    flows = await load_flows(db, org.id)
    live_sections = {
        s.id: s
        for s in (
            await db.scalars(select(PlaybookSection).where(PlaybookSection.id.in_(list(flows))))
        ).all()
    } if flows else {}

    base = [PlaybookCallRun.org_id == org.id]
    if not user.can_view_all:
        base.append(PlaybookCallRun.user_key == user_key)
    if studio:
        base.append(PlaybookCallRun.studio == studio)
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
        raise HTTPException(503, MISSING_MIGRATION) from exc

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
    out.flow_changed_at = flow_row.updated_at if flow_row else None

    rows = (
        await db.execute(
            period(
                select(
                    PlaybookCallRun.user_key,
                    PlaybookCallRun.user_name,
                    PlaybookCallRun.path,
                    PlaybookCallRun.outcome,
                    PlaybookCallRun.ended_at,
                    PlaybookCallRun.updated_at,
                ).where(*base, PlaybookCallRun.section_id == chosen),
                date_from,
                date_to,
            ).limit(50_000)
        )
    ).all()
    runs = [
        Run(
            user_key=r.user_key,
            user_name=r.user_name,
            path=list(r.path or []),
            outcome=r.outcome or "",
            ended=r.ended_at is not None,
            updated_at=r.updated_at,
        )
        for r in rows
    ]
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
    result = aggregate(runs, nodes, utcnow(), user_key)
    return out.model_copy(update=result)


@router.get("/call-runs", response_model=CallRunsPage)
async def call_runs(
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    section: uuid.UUID | None = None,
    user_key: str = Query("", alias="user"),
    studio: str = "",
    outcome: str = "",
    node: str = "",
    cursor: str = "",
    limit: int = 30,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Журнал звонков, от новых к старым, порциями. node — только звонки,
    оборвавшиеся на этом блоке без записи: из воронки можно провалиться в
    конкретные разговоры."""
    org = await current_org(db)
    if not user.can_view_all:
        user_key = user.author_key
    limit = max(1, min(limit, 100))
    q = period(select(PlaybookCallRun).where(PlaybookCallRun.org_id == org.id), date_from, date_to)
    if section:
        q = q.where(PlaybookCallRun.section_id == section)
    if user_key:
        q = q.where(PlaybookCallRun.user_key == user_key)
    if studio:
        q = q.where(PlaybookCallRun.studio == studio)
    if outcome == "none":
        q = q.where(PlaybookCallRun.outcome == "")
    elif outcome:
        q = q.where(PlaybookCallRun.outcome == outcome)
    if node:
        q = q.where(PlaybookCallRun.last_node_id == node, PlaybookCallRun.outcome != "booked")
    if cursor:
        at, row_id = decode_cursor(cursor)
        q = q.where(
            (PlaybookCallRun.started_at < at)
            | ((PlaybookCallRun.started_at == at) & (PlaybookCallRun.id < row_id))
        )
    try:
        rows = (
            await db.scalars(
                q.order_by(PlaybookCallRun.started_at.desc(), PlaybookCallRun.id.desc()).limit(limit + 1)
            )
        ).all()
    except ProgrammingError as exc:
        await db.rollback()
        raise HTTPException(503, MISSING_MIGRATION) from exc
    more = len(rows) > limit
    rows = rows[:limit]
    now = utcnow()
    items = []
    for r in rows:
        run = Run(
            user_key=r.user_key,
            user_name=r.user_name,
            path=list(r.path or []),
            outcome=r.outcome or "",
            ended=r.ended_at is not None,
            updated_at=r.updated_at,
        )
        items.append(
            CallRunOut(
                id=r.id,
                section_title=r.section_title,
                user_name=r.user_name,
                studio=r.studio,
                lang=r.lang,
                started_at=r.started_at,
                seconds=run.seconds,
                steps=r.steps,
                last_node_title=r.last_node_title,
                outcome=r.outcome,
                status=classify(run, now),
                path=[
                    CallRunPathStep(
                        title=s.get("title", ""), group=s.get("group", "main"), answer=s.get("answer", "")
                    )
                    for s in run.path
                ],
            )
        )
    return CallRunsPage(
        items=items,
        next_cursor=encode_cursor(rows[-1].started_at, rows[-1].id) if more and rows else "",
    )
