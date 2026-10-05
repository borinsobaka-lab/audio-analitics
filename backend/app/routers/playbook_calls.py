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
import csv
import io
import logging
import statistics
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy import update as update_
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from ..access import visible_day
from ..auth import UserContext, require_manage, require_user
from ..db import get_db
from ..models import (
    DayRecording,
    PlaybookCallRun,
    PlaybookChange,
    PlaybookSection,
    PlaybookSettings,
    utcnow,
)
from ..schemas import (
    CallAnswerCount,
    CallbackOut,
    CallbackPatch,
    CallEndStat,
    CallFunnelStep,
    CallGapStat,
    CallObjectionStat,
    CallRunIn,
    CallRunOut,
    CallRunPathStep,
    CallRunsPage,
    CallSliceStat,
    CallStatSection,
    CallStatsOut,
    CallStatTotals,
    CallTargetIn,
    CallUserStat,
    CallVersionStat,
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
MISSING_MIGRATION = (
    "Аналитика звонков ещё не включена: выполните миграции 017_call_runs.sql и 018_call_callbacks.sql"
)


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
    миграции 017 здесь не ошибка, а тихий пропуск; до миграции 018 звонок
    пишется без клиента и перезвона."""
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
    client = {
        "client_name": body.client_name.strip(),
        "client_phone": body.client_phone.strip(),
        "callback_at": body.callback_at if body.outcome == "callback" else None,
        "callback_note": body.callback_note.strip() if body.outcome == "callback" else "",
        "callback_of": body.callback_of,
    }

    def upsert(extra: dict):
        stmt = pg_insert(PlaybookCallRun).values(
            id=run_id,
            org_id=org.id,
            section_id=body.section_id,
            section_title=section.title if section else "",
            user_key=user.author_key,
            started_at=now,
            ended_at=now if ended else None,
            **fields,
            **extra,
        )
        update = {
            **fields,
            **extra,
            # Завершённый звонок, который просто пересохранили, не сдвигает
            # время конца; шаг назад с последнего блока снова открывает звонок.
            "ended_at": func.coalesce(PlaybookCallRun.ended_at, now) if ended else None,
        }
        if section:
            # Раздел удалили посреди звонка — название остаётся прежним.
            update["section_title"] = section.title
        return stmt.on_conflict_do_update(
            index_elements=[PlaybookCallRun.id],
            set_=update,
            # Чужой звонок не перезаписать, даже зная его id.
            where=(PlaybookCallRun.user_key == user.author_key) & (PlaybookCallRun.org_id == org.id),
        )

    try:
        async with db.begin_nested():
            await db.execute(upsert(client))
            if ended and body.callback_of and body.outcome != "no_answer":
                # Перезвонили и поговорили — перезвон закрыт. Не дозвонились —
                # остаётся в списке.
                await db.execute(
                    update_(PlaybookCallRun)
                    .where(
                        PlaybookCallRun.id == body.callback_of,
                        PlaybookCallRun.org_id == org.id,
                        PlaybookCallRun.callback_done_at.is_(None),
                    )
                    .values(callback_done_at=now, callback_done_by=author(user))
                )
        await db.commit()
        return None
    except ProgrammingError:
        pass
    try:
        await db.execute(upsert({}))
        await db.commit()
        log.warning("Звонок записан без клиента и перезвона: выполните миграцию 018")
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
    started_at: datetime | None = None
    studio: str = ""
    flow_version: datetime | None = None
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

    @property
    def conversion(self) -> float | None:
        return conversion(self.booked, self.connected)

    def fields(self) -> dict:
        return {
            "runs": self.runs,
            "booked": self.booked,
            "callback": self.callback,
            "refused": self.refused,
            "no_answer": self.no_answer,
            "no_outcome": self.no_outcome,
            "conversion": self.conversion,
            "avg_steps": mean(self.steps),
            "avg_seconds": mean(self.seconds),
        }


def count(runs) -> Counts:
    c = Counts()
    for run in runs:
        c.add(run)
    return c


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


def slices(groups: dict[str, list[Run]]) -> list[CallSliceStat]:
    out = []
    for key, runs in groups.items():
        c = count(runs)
        out.append(CallSliceStat(key=key, runs=c.runs, booked=c.booked, conversion=c.conversion))
    return out


def local_zone(tz: str):
    try:
        return ZoneInfo(tz) if tz else timezone.utc
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc


def time_slices(runs: list[Run], tz: str) -> tuple[list[CallSliceStat], list[CallSliceStat]]:
    """Звонки по часам и дням недели — по местному времени студии."""
    zone = local_zone(tz)
    hours: dict[str, list[Run]] = defaultdict(list)
    days: dict[str, list[Run]] = defaultdict(list)
    for run in runs:
        if not run.started_at:
            continue
        local = run.started_at.astimezone(zone)
        hours[f"{local.hour:02d}"].append(run)
        days[str(local.weekday())].append(run)
    by_key = lambda s: s.key  # noqa: E731
    return sorted(slices(hours), key=by_key), sorted(slices(days), key=by_key)


def version_stats(runs: list[Run], notes: dict[datetime, str]) -> list[CallVersionStat]:
    """Звонки по версиям сценария, от новой к старой."""
    groups: dict[datetime | None, list[Run]] = defaultdict(list)
    for run in runs:
        groups[run.flow_version].append(run)
    out = []
    for version, group in groups.items():
        c = count(group)
        out.append(
            CallVersionStat(
                version=version,
                note=match_note(version, notes) if version else "",
                runs=c.runs,
                booked=c.booked,
                conversion=c.conversion,
                avg_steps=mean(c.steps),
                avg_seconds=mean(c.seconds),
            )
        )
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    return sorted(out, key=lambda v: v.version or epoch, reverse=True)


def aggregate(
    runs: list[Run], nodes: list[dict], now: datetime, user_key: str = "", tz: str = ""
) -> dict:
    """Воронка, возражения, обрывы, пробелы сценария, время и
    администраторы по звонкам одного сценария. nodes — блоки текущего
    сценария: этапы воронки идут в их порядке. user_key — смотреть одного
    администратора: всё по нему, список администраторов — по всем.
    Звонки — от новых к старым (примеры «нет ответа» — последние)."""
    for run in runs:
        run.status = classify(run, now)
    titles = {n["id"]: (n.get("title", ""), n.get("group", "main")) for n in nodes}
    mine = [r for r in runs if r.user_key == user_key] if user_key else runs

    reached: Counter[str] = Counter()
    ended_here: Counter[str] = Counter()
    booked_after: Counter[str] = Counter()
    step_seconds: dict[str, list[float]] = defaultdict(list)
    answers: dict[str, Counter[str]] = defaultdict(Counter)
    gaps: Counter[str] = Counter()
    gap_examples: dict[str, list[str]] = defaultdict(list)
    gap_titles: dict[str, str] = {}
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
            if gap := (step.get("gap") or "").strip():
                gaps[node_id] += 1
                gap_titles.setdefault(node_id, step.get("title", "") or node_id)
                if len(gap_examples[node_id]) < 5:
                    gap_examples[node_id].append(gap)
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
                CallAnswerCount(label=label, count=c) for label, c in answers[n["id"]].most_common()
            ],
            gaps=gaps[n["id"]],
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
    gap_stats = [
        CallGapStat(
            node_id=node_id,
            title=titles.get(node_id, (gap_titles[node_id], ""))[0] or gap_titles[node_id],
            count=c,
            examples=gap_examples[node_id],
        )
        for node_id, c in gaps.most_common()
    ]

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

    totals = count(mine)
    hours, weekdays = time_slices(mine, tz)
    return {
        "totals": CallStatTotals(live=totals.live, **totals.fields()),
        "funnel": funnel,
        "objections": objections,
        "ends": end_stats(mine, titles),
        "users": user_stats,
        "gaps": gap_stats,
        "hours": hours,
        "weekdays": weekdays,
    }


# --- Отчёт ---

def period(q, date_from: datetime | None, date_to: datetime | None):
    if date_from:
        q = q.where(PlaybookCallRun.started_at >= date_from)
    if date_to:
        q = q.where(PlaybookCallRun.started_at < date_to)
    return q


def parse_version(value: str) -> datetime | None | str:
    """«none» — звонки без версии; пусто — все версии."""
    if not value:
        return ""
    if value == "none":
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        raise HTTPException(400, "Неверная версия сценария") from None


async def version_notes(db: AsyncSession, org_id, section_id) -> dict[datetime, str]:
    """Комментарии к правкам сценария из хронологии — по времени правки."""
    try:
        async with db.begin_nested():
            rows = (
                await db.execute(
                    select(PlaybookChange.created_at, PlaybookChange.change_note).where(
                        PlaybookChange.org_id == org_id, PlaybookChange.item_id == section_id
                    )
                )
            ).all()
    except ProgrammingError:
        return {}
    return {at: note for at, note in rows}


def match_note(version: datetime, notes: dict[datetime, str]) -> str:
    """Правка сценария и запись в хронологию — одна транзакция, но время
    разное на доли секунды: берём ближайшую запись в пределах минуты."""
    best = min(notes, key=lambda at: abs((at - version).total_seconds()), default=None)
    if best and abs((best - version).total_seconds()) <= 60:
        return notes[best]
    return ""


async def call_target(db: AsyncSession, org_id) -> float | None:
    row = await db.get(PlaybookSettings, org_id)
    value = ((row.data if row else None) or {}).get("call_target")
    return value / 100 if isinstance(value, int) and 1 <= value <= 100 else None


async def open_callbacks(db: AsyncSession, org_id, section_id=None) -> int:
    q = select(func.count()).where(
        PlaybookCallRun.org_id == org_id,
        PlaybookCallRun.outcome == "callback",
        PlaybookCallRun.callback_done_at.is_(None),
    )
    if section_id:
        q = q.where(PlaybookCallRun.section_id == section_id)
    try:
        async with db.begin_nested():
            return await db.scalar(q) or 0
    except ProgrammingError:
        return 0


@router.get("/call-stats", response_model=CallStatsOut)
async def call_stats(
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    section: uuid.UUID | None = None,
    user_key: str = Query("", alias="user"),
    studio: str = "",
    version: str = "",
    tz: str = "",
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Воронка и разбор звонков одного сценария за период. Границы периода
    присылает админка уже с часовым поясом браузера, tz — его же название
    (для разреза по часам). Сотрудник с доступом «только свои» видит только
    свои звонки."""
    org = await current_org(db)
    if not user.can_view_all:
        user_key = user.author_key
    want_version = parse_version(version)
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
    try:
        per_section = (
            await db.execute(
                period(
                    select(
                        PlaybookCallRun.section_id,
                        func.max(PlaybookCallRun.section_title).label("title"),
                        func.count().label("runs"),
                    ).where(*base, *([PlaybookCallRun.studio == studio] if studio else [])),
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
    out = CallStatsOut(sections=sections, target=await call_target(db, org.id))
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
                    PlaybookCallRun.started_at,
                    PlaybookCallRun.studio,
                    PlaybookCallRun.flow_version,
                ).where(*base, PlaybookCallRun.section_id == chosen),
                date_from,
                date_to,
            )
            .order_by(PlaybookCallRun.started_at.desc())
            .limit(50_000)
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
            started_at=r.started_at,
            studio=r.studio or "",
            flow_version=r.flow_version,
        )
        for r in rows
    ]
    if not nodes:
        # Сценарий удалён — этапы восстанавливаются по самим звонкам, в
        # порядке первого появления.
        seen: dict[str, dict] = {}
        for run in reversed(runs):
            for step in run.path:
                seen.setdefault(
                    step.get("id", ""),
                    {"id": step.get("id", ""), "title": step.get("title", ""), "group": step.get("group", "main")},
                )
        nodes = list(seen.values())

    # Разрезы, из которых выбирают, — без своего фильтра: выбрав студию,
    # видно и остальные.
    by_user = [r for r in runs if r.user_key == user_key] if user_key else runs
    studio_groups: dict[str, list[Run]] = defaultdict(list)
    for run in by_user:
        studio_groups[run.studio or "—"].append(run)
    out.studios = sorted(slices(studio_groups), key=lambda s: -s.runs)
    if studio:
        runs = [r for r in runs if r.studio == studio]
        by_user = [r for r in by_user if r.studio == studio]
    notes = await version_notes(db, org.id, chosen)
    for run in by_user:
        run.status = classify(run, utcnow())
    out.versions = version_stats(by_user, notes)
    if want_version != "":
        runs = [r for r in runs if r.flow_version == want_version]

    out.callbacks_open = await open_callbacks(db, org.id, chosen)
    result = aggregate(runs, nodes, utcnow(), user_key, tz)
    return out.model_copy(update=result)


@router.put("/call-target", status_code=204)
async def save_call_target(
    body: CallTargetIn,
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    """Цель по конверсии в запись — общая для всех сценариев. Хранится в
    настройках скриптов, рядом с остальными ключами."""
    org = await current_org(db)
    row = await db.get(PlaybookSettings, org.id)
    if not row:
        row = PlaybookSettings(org_id=org.id, data={})
        db.add(row)
    data = dict(row.data or {})
    if body.target is None:
        data.pop("call_target", None)
    else:
        data["call_target"] = body.target
    row.data = data
    await db.commit()
    return None


# --- Журнал ---

def runs_query(
    org_id,
    user: UserContext,
    date_from,
    date_to,
    section,
    user_key,
    studio,
    outcome,
    node,
    version,
):
    if not user.can_view_all:
        user_key = user.author_key
    q = period(select(PlaybookCallRun).where(PlaybookCallRun.org_id == org_id), date_from, date_to)
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
        q = q.where(PlaybookCallRun.last_node_id == node, PlaybookCallRun.outcome.notin_(("booked", "no_answer")))
    want = parse_version(version)
    if want is None:
        q = q.where(PlaybookCallRun.flow_version.is_(None))
    elif want != "":
        q = q.where(PlaybookCallRun.flow_version == want)
    return q


def as_run(r: PlaybookCallRun) -> Run:
    return Run(
        user_key=r.user_key,
        user_name=r.user_name,
        path=list(r.path or []),
        outcome=r.outcome or "",
        ended=r.ended_at is not None,
        updated_at=r.updated_at,
        started_at=r.started_at,
        studio=r.studio,
        flow_version=r.flow_version,
    )


def employee_of(user_key: str) -> uuid.UUID | None:
    if not user_key.startswith("emp:"):
        return None
    try:
        return uuid.UUID(user_key[4:])
    except ValueError:
        return None


# Смена без длительности (ещё не обработана) — считаем, что идёт до 16 часов.
SHIFT_FALLBACK = timedelta(hours=16)


async def recording_links(db: AsyncSession, rows: list[PlaybookCallRun]) -> dict:
    """Запись смены, на которой был звонок: тот же сотрудник, звонок —
    между началом записи и её концом. Место в записи — секунды от начала:
    паузы пишутся тишиной, поэтому время на часах и время в записи совпадают."""
    employees = {e for r in rows if (e := employee_of(r.user_key))}
    if not employees or not rows:
        return {}
    first = min(r.started_at for r in rows) - timedelta(days=1)
    last = max(r.started_at for r in rows)
    recs = (
        await db.execute(
            select(DayRecording.id, DayRecording.employee_id, DayRecording.created_at, DayRecording.total_duration_s)
            .where(
                DayRecording.employee_id.in_(employees),
                DayRecording.created_at >= first,
                DayRecording.created_at <= last,
            )
            .order_by(DayRecording.created_at.desc())
        )
    ).all()
    links = {}
    for r in rows:
        emp = employee_of(r.user_key)
        for rec in recs:
            if rec.employee_id != emp or rec.created_at > r.started_at:
                continue
            length = timedelta(seconds=rec.total_duration_s) if rec.total_duration_s else SHIFT_FALLBACK
            if r.started_at <= rec.created_at + length + timedelta(minutes=5):
                links[r.id] = (rec.id, (r.started_at - rec.created_at).total_seconds())
            break
    return links


def run_out(r: PlaybookCallRun, now: datetime, link=None) -> CallRunOut:
    run = as_run(r)
    return CallRunOut(
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
                title=s.get("title", ""),
                group=s.get("group", "main"),
                answer=s.get("answer", ""),
                gap=s.get("gap", ""),
            )
            for s in run.path
        ],
        client_name=r.client_name,
        client_phone=r.client_phone,
        callback_at=r.callback_at,
        callback_note=r.callback_note,
        callback_done_at=r.callback_done_at,
        recording_id=link[0] if link else None,
        recording_offset_s=link[1] if link else None,
    )


@router.get("/call-runs", response_model=CallRunsPage)
async def call_runs(
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    section: uuid.UUID | None = None,
    user_key: str = Query("", alias="user"),
    studio: str = "",
    outcome: str = "",
    node: str = "",
    version: str = "",
    cursor: str = "",
    limit: int = 30,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Журнал звонков, от новых к старым, порциями. node — только звонки,
    оборвавшиеся на этом блоке без записи: из воронки можно провалиться в
    конкретные разговоры."""
    org = await current_org(db)
    limit = max(1, min(limit, 100))
    q = runs_query(org.id, user, date_from, date_to, section, user_key, studio, outcome, node, version)
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
    links = await recording_links(db, rows)
    now = utcnow()
    return CallRunsPage(
        items=[run_out(r, now, links.get(r.id)) for r in rows],
        next_cursor=encode_cursor(rows[-1].started_at, rows[-1].id) if more and rows else "",
    )


OUTCOME_TEXT = {
    "booked": "Записан",
    "callback": "Перезвонить",
    "refused": "Отказ",
    "no_answer": "Не дозвонились",
}
STATUS_TEXT = {"live": "Идёт", "dropped": "Брошен", "ended": "Без итога"}


@router.get("/call-runs.csv")
async def call_runs_csv(
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    section: uuid.UUID | None = None,
    user_key: str = Query("", alias="user"),
    studio: str = "",
    outcome: str = "",
    version: str = "",
    tz: str = "",
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Звонки таблицей для Excel: те же фильтры, что у журнала. Время — по
    часовому поясу браузера; разделитель «;» и BOM — чтобы русский Excel
    открыл файл двойным щелчком."""
    org = await current_org(db)
    q = runs_query(org.id, user, date_from, date_to, section, user_key, studio, outcome, "", version)
    try:
        rows = (await db.scalars(q.order_by(PlaybookCallRun.started_at.desc()).limit(20_000))).all()
    except ProgrammingError as exc:
        await db.rollback()
        raise HTTPException(503, MISSING_MIGRATION) from exc
    zone = local_zone(tz)
    now = utcnow()
    buf = io.StringIO()
    buf.write("\ufeff")
    w = csv.writer(buf, delimiter=";")
    w.writerow([
        "Дата", "Время", "Администратор", "Студия", "Сценарий", "Итог", "Клиент", "Телефон",
        "Перезвонить", "Шагов", "Длительность, с", "Последний шаг", "Нет нужного ответа", "Путь",
    ])
    for r in rows:
        run = as_run(r)
        local = r.started_at.astimezone(zone)
        w.writerow([
            local.strftime("%d.%m.%Y"),
            local.strftime("%H:%M"),
            r.user_name,
            r.studio,
            r.section_title,
            OUTCOME_TEXT.get(r.outcome) or STATUS_TEXT[classify(run, now)],
            r.client_name,
            r.client_phone,
            r.callback_at.astimezone(zone).strftime("%d.%m.%Y %H:%M") if r.callback_at else "",
            r.steps,
            round(run.seconds) if run.seconds is not None else "",
            r.last_node_title,
            " | ".join(f"{s.get('title', '')}: {s['gap']}" for s in run.path if s.get("gap")),
            " → ".join(
                f"{s.get('title', '')} ({s['answer']})" if s.get("answer") else s.get("title", "")
                for s in run.path
            ),
        ])
    name = f"calls-{(date_from or now).astimezone(zone):%Y-%m-%d}.csv"
    return Response(
        content=buf.getvalue().encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@router.get("/call-runs/by-recording/{recording_id}", response_model=CallRunsPage)
async def runs_for_recording(
    recording_id: uuid.UUID,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Звонки по сценарию за смену — для отчёта смены: с местом в записи,
    чтобы послушать сам разговор."""
    rec = await visible_day(db, recording_id, user)
    if not rec.employee_id:
        return CallRunsPage()
    length = timedelta(seconds=rec.total_duration_s) if rec.total_duration_s else SHIFT_FALLBACK
    try:
        rows = (
            await db.scalars(
                select(PlaybookCallRun)
                .where(
                    PlaybookCallRun.org_id == rec.org_id,
                    PlaybookCallRun.user_key == f"emp:{rec.employee_id}",
                    PlaybookCallRun.started_at >= rec.created_at,
                    PlaybookCallRun.started_at <= rec.created_at + length + timedelta(minutes=5),
                )
                .order_by(PlaybookCallRun.started_at)
                .limit(300)
            )
        ).all()
    except ProgrammingError:
        await db.rollback()
        return CallRunsPage()
    now = utcnow()
    return CallRunsPage(
        items=[
            run_out(r, now, (rec.id, (r.started_at - rec.created_at).total_seconds())) for r in rows
        ]
    )


# --- Перезвонить ---

@router.get("/callbacks", response_model=list[CallbackOut])
async def list_callbacks(
    section: uuid.UUID | None = None,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Открытые перезвоны: звонки с итогом «Перезвонить», которые ещё не
    закрыли. Видны всем, кто ведёт звонки: перезвонить может любой
    администратор смены. Сначала — у кого время уже подошло."""
    org = await current_org(db)
    q = select(PlaybookCallRun).where(
        PlaybookCallRun.org_id == org.id,
        PlaybookCallRun.outcome == "callback",
        PlaybookCallRun.callback_done_at.is_(None),
    )
    if section:
        q = q.where(PlaybookCallRun.section_id == section)
    try:
        rows = (
            await db.scalars(
                q.order_by(
                    PlaybookCallRun.callback_at.asc().nulls_last(), PlaybookCallRun.started_at.desc()
                ).limit(200)
            )
        ).all()
        attempts = dict(
            (
                await db.execute(
                    select(PlaybookCallRun.callback_of, func.count())
                    .where(PlaybookCallRun.callback_of.in_([r.id for r in rows]))
                    .group_by(PlaybookCallRun.callback_of)
                )
            ).all()
        ) if rows else {}
    except ProgrammingError:
        await db.rollback()
        return []
    return [
        CallbackOut(
            id=r.id,
            section_id=r.section_id,
            section_title=r.section_title,
            user_name=r.user_name,
            client_name=r.client_name,
            client_phone=r.client_phone,
            callback_at=r.callback_at,
            callback_note=r.callback_note,
            started_at=r.started_at,
            last_node_title=r.last_node_title,
            attempts=attempts.get(r.id, 0),
        )
        for r in rows
    ]


@router.patch("/callbacks/{run_id}", status_code=204)
async def patch_callback(
    run_id: uuid.UUID,
    body: CallbackPatch,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Закрыть перезвон («Готово») или перенести на другое время."""
    org = await current_org(db)
    try:
        run = await db.get(PlaybookCallRun, run_id)
    except ProgrammingError as exc:
        await db.rollback()
        raise HTTPException(503, MISSING_MIGRATION) from exc
    if not run or run.org_id != org.id or run.outcome != "callback":
        raise HTTPException(404, "Перезвон не найден")
    if body.callback_at is not None:
        run.callback_at = body.callback_at
    if body.done:
        run.callback_done_at = utcnow()
        run.callback_done_by = author(user)
    else:
        run.callback_done_at = None
        run.callback_done_by = ""
    await db.commit()
    return None
