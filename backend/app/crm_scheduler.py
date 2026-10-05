"""Расписание разбора CRM: вчерашний день разбирается сам утром.

Отдельного процесса под расписание нет намеренно: API работает одним
процессом, и фоновая задача в нём раз в несколько минут проверяет, не пора
ли поставить вчерашний день в очередь. Так разбор запускается без правок
в деплое; сам разбор, как и раньше, делает воркер Celery.
"""
import asyncio
import logging
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.exc import ProgrammingError

from . import crm_ai
from .db import async_session_factory
from .models import CrmEvent, CrmMessage, CrmRun, CrmSettings, Organization

log = logging.getLogger(__name__)

TICK_SECONDS = 300
FIRST_TICK_SECONDS = 60
DEFAULT_TZ = "Asia/Tbilisi"
DEFAULT_RUN_HOUR = 9


def due_date(data: dict, now_utc: datetime) -> date | None:
    """Какой день пора разобрать по расписанию: вчерашний по часам студии,
    когда наступил час запуска. None — ещё рано или авторазбор выключен."""
    if not data.get("auto_run", True):
        return None
    try:
        tz = ZoneInfo(data.get("timezone") or DEFAULT_TZ)
    except Exception:  # noqa: BLE001 — опечатка в поясе не должна стопорить всё
        tz = ZoneInfo(DEFAULT_TZ)
    local = now_utc.astimezone(tz)
    try:
        hour = int(data.get("run_hour", DEFAULT_RUN_HOUR))
    except (TypeError, ValueError):
        hour = DEFAULT_RUN_HOUR
    if local.hour < hour:
        return None
    return local.date() - timedelta(days=1)


async def has_activity(db, org_id, day: date, tz) -> bool:
    start, end = crm_ai.day_bounds(day, tz)
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
    """Поставить разбор в очередь воркера. Импорт здесь, чтобы роутеры и
    планировщик не тянули Celery при импорте модуля."""
    from .pipeline.crm_tasks import analyze_crm_day

    analyze_crm_day.delay(str(run_id))


async def tick(now_utc: datetime | None = None) -> int:
    """Один проход: по каждой организации — пора ли и есть ли что разбирать."""
    now_utc = now_utc or datetime.now(timezone.utc)
    started = 0
    async with async_session_factory() as db:
        orgs = (await db.scalars(select(Organization))).all()
        for org in orgs:
            row = await db.get(CrmSettings, org.id)
            data = dict((row.data if row else None) or {})
            day = due_date(data, now_utc)
            if not day:
                continue
            exists = await db.scalar(
                select(CrmRun.id).where(CrmRun.org_id == org.id, CrmRun.date == day)
            )
            if exists:
                continue
            tz = ZoneInfo(data.get("timezone") or DEFAULT_TZ)
            if not await has_activity(db, org.id, day, tz):
                continue
            run = CrmRun(org_id=org.id, date=day, status="queued", trigger="schedule")
            db.add(run)
            await db.commit()
            try:
                enqueue(run.id)
            except Exception as e:  # noqa: BLE001 — нет брокера: видно в админке
                run.set_status("error", f"не удалось поставить в очередь: {e}")
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
        await asyncio.sleep(TICK_SECONDS)
