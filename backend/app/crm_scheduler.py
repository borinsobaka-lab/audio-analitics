"""Расписание разбора CRM: отчётный день разбирается сам в назначенный час.

Отчётный день заканчивается в час запуска (по умолчанию 20:00 по времени
студии) и начинается за сутки до него. Планировщик — фоновая задача в самом
API, просыпается на каждой минуте: разбор стартует в 20:00:0x, не раньше и
не позже, и выполняется в потоке API (crm_runner.py), так что ему не
приходится ждать воркер, занятый аудио. Час 0 — обычный календарный день,
разбираемый после полуночи.
"""
import asyncio
import logging
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.exc import ProgrammingError

from . import amo, amo_sync, crm_ai
from .db import async_session_factory
from .models import CrmEvent, CrmMessage, CrmRun, CrmSettings, Organization

log = logging.getLogger(__name__)

FIRST_TICK_SECONDS = 20
DEFAULT_TZ = "Asia/Tbilisi"
DEFAULT_RUN_HOUR = 20


def run_hour_of(data: dict) -> int:
    try:
        return max(0, min(23, int(data.get("run_hour", DEFAULT_RUN_HOUR))))
    except (TypeError, ValueError):
        return DEFAULT_RUN_HOUR


def tz_of(data: dict):
    try:
        return ZoneInfo(data.get("timezone") or DEFAULT_TZ)
    except Exception:  # noqa: BLE001 — опечатка в поясе не должна стопорить всё
        return ZoneInfo(DEFAULT_TZ)


def due_date(data: dict, now_utc: datetime) -> date | None:
    """Какой отчётный день пора разобрать: сегодняшний, когда по часам
    студии наступил час окончания дня (при часе 0 — вчерашний, после
    полуночи). None — ещё рано или авторазбор выключен."""
    if not data.get("auto_run", True):
        return None
    local = now_utc.astimezone(tz_of(data))
    hour = run_hour_of(data)
    if not hour:
        return local.date() - timedelta(days=1)
    if local.hour < hour:
        return None
    return local.date()


def seconds_to_next_minute(now_utc: datetime) -> float:
    """Спать до следующей целой минуты: тик на :00 секунд даёт старт разбора
    в назначенный час с точностью до секунд."""
    return 60 - now_utc.second - now_utc.microsecond / 1_000_000 + 0.2


async def has_activity(db, org_id, day: date, tz, end_hour: int = 0) -> bool:
    start, end = crm_ai.day_bounds(day, tz, end_hour)
    msg = await db.scalar(
        select(CrmMessage.id)
        .where(CrmMessage.org_id == org_id, CrmMessage.at >= start, CrmMessage.at < end)
        .limit(1)
    )
    if msg:
        return True
    ev = await db.scalar(
        select(CrmEvent.id)
        .where(CrmEvent.org_id == org_id, CrmEvent.at >= start, CrmEvent.at < end)
        .limit(1)
    )
    return ev is not None


def enqueue(run_id) -> None:
    """Запустить разбор — в потоке API, см. crm_runner."""
    from . import crm_runner

    crm_runner.launch(run_id)


async def sync_amo(db, org, row, data, *, force: bool) -> None:
    """Синхронизация с amoCRM по расписанию (или принудительно — перед
    разбором дня). Ошибка — в настройки, видна в админке; тик не падает."""
    a = amo_sync.section(data)
    if not (a.get("enabled") and a.get("access_token")):
        return
    if not force and not amo.sync_due(a, datetime.now(timezone.utc)):
        return
    try:
        await amo_sync.sync_org(db, org, row, data)
    except amo.AmoError as e:
        log.warning("amoCRM sync (%s): %s", org.name, e)


async def tick(now_utc: datetime | None = None) -> int:
    """Один проход: по каждой организации — синхронизация с amoCRM, если
    пора, и разбор вчерашнего дня, если наступил час и есть что разбирать."""
    now_utc = now_utc or datetime.now(timezone.utc)
    started = 0
    async with async_session_factory() as db:
        orgs = (await db.scalars(select(Organization))).all()
        for org in orgs:
            row = await db.get(CrmSettings, org.id)
            data = dict((row.data if row else None) or {})
            await sync_amo(db, org, row, data, force=False)
            day = due_date(data, now_utc)
            if not day:
                continue
            exists = await db.scalar(
                select(CrmRun.id).where(CrmRun.org_id == org.id, CrmRun.date == day)
            )
            if exists:
                continue
            # Перед разбором — свежие данные: последние часы могли ещё не
            # дойти по расписанию.
            await sync_amo(db, org, row, data, force=True)
            if not await has_activity(db, org.id, day, tz_of(data), run_hour_of(data)):
                continue
            run = CrmRun(org_id=org.id, date=day, status="queued", trigger="schedule")
            db.add(run)
            await db.commit()
            try:
                enqueue(run.id)
            except Exception as e:  # noqa: BLE001 — видно в админке
                run.set_status("error", f"не удалось запустить разбор: {e}")
                await db.commit()
                log.warning("crm schedule: enqueue failed: %s", e)
                continue
            started += 1
            log.info("crm schedule: run %s for %s queued", run.id, day)
    return started


async def loop() -> None:
    await asyncio.sleep(FIRST_TICK_SECONDS)
    warned_migration = False
    while True:
        try:
            await tick()
        except asyncio.CancelledError:
            raise
        except ProgrammingError:
            if not warned_migration:
                log.warning("crm schedule: таблицы CRM нет — выполните миграцию 018_crm.sql")
                warned_migration = True
        except Exception as e:  # noqa: BLE001
            log.warning("crm schedule: %s", e)
        await asyncio.sleep(seconds_to_next_minute(datetime.now(timezone.utc)))
