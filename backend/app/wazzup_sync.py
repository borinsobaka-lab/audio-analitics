"""Wazzup: то, что ходит в базу.

Чистые преобразования и сеть — в wazzup.py; здесь сообщения из вебхука
находят свои сделки и уходят в приём (crm_ingest.apply_batch), а счётчики —
в настройки CRM (crm_settings.data["wazzup"]).

Сообщение, для которого сделки ещё нет — новый клиент, а синхронизация с
amoCRM проходит раз в 15 минут, — откладывается и пристраивается при
следующем вебхуке или после синхронизации.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import wazzup
from .models import CrmDeal, CrmSettings, Organization, utcnow
from .routers.crm_ingest import apply_batch
from .schemas import CrmIngestIn

log = logging.getLogger(__name__)

# Отложенных сообщений не больше этого и не старше суток: сделка, которой
# нет сутки, уже не появится, а настройки не должны разрастаться.
PENDING_LIMIT = 200
PENDING_TTL = timedelta(days=1)


def section(data: dict) -> dict:
    return dict(data.get("wazzup") or {})


async def save(db: AsyncSession, org: Organization, row: CrmSettings | None, w: dict) -> None:
    """Сохранить раздел wazzup, не трогая остальное: остальные ключи — из
    свежей строки, их могли поменять, пока шёл вебхук."""
    if row is None:
        row = await db.get(CrmSettings, org.id)
    if row is None:
        db.add(CrmSettings(org_id=org.id, data={"wazzup": w}, updated_by="Wazzup"))
    else:
        await db.refresh(row)
        merged = dict(row.data or {})
        merged["wazzup"] = w
        row.data = merged
        row.updated_at = utcnow()
    await db.commit()


async def deals_by_phone(db: AsyncSession, org_id, tails: set[str]) -> dict[str, str]:
    """Хвост номера → id сделки в CRM. У клиента бывает несколько сделок:
    берётся открытая, из открытых — с последней активностью."""
    if not tails:
        return {}
    tail = func.right(func.regexp_replace(CrmDeal.contact_phone, r"\D", "", "g"), wazzup.PHONE_TAIL)
    rows = (
        await db.execute(
            select(tail, CrmDeal.external_id)
            .where(CrmDeal.org_id == org_id, tail.in_(tails))
            .order_by(
                case((CrmDeal.status == "open", 0), else_=1),
                CrmDeal.last_activity_at.desc().nulls_last(),
            )
        )
    ).all()
    found: dict[str, str] = {}
    for t, external_id in rows:
        found.setdefault(t, external_id)
    return found


def _fresh(m: dict, now: datetime) -> bool:
    try:
        at = datetime.fromisoformat(m["at"])
    except (KeyError, ValueError):
        return False
    return now - at <= PENDING_TTL


async def apply_messages(
    db: AsyncSession, org: Organization, w: dict, messages: list[dict]
) -> dict:
    """Пристроить сообщения (новые и отложенные) к сделкам и принять.
    Меняет счётчики и очередь в w; сохраняет вызывающий."""
    now = datetime.now(timezone.utc)
    queue: list[dict] = []
    seen: set[str] = set()
    # Wazzup доставляет повторно, если не дождался ответа: одно сообщение —
    # одно место в очереди.
    for m in [m for m in (w.get("pending") or []) if _fresh(m, now)] + messages:
        if m.get("id") in seen:
            continue
        seen.add(m.get("id"))
        queue.append(m)
    found = await deals_by_phone(db, org.id, {m["phone"] for m in queue if m.get("phone")})
    ready: list[dict] = []
    pending: list[dict] = []
    for m in queue:
        deal = found.get(m.get("phone") or "")
        if deal:
            entry = {k: v for k, v in m.items() if k not in ("phone", "chat")}
            ready.append({**entry, "deal_id": deal})
        elif m.get("phone"):
            pending.append(m)
        else:
            # Без номера (Instagram, Telegram без телефона) сделку не найти.
            w["unmatched"] = int(w.get("unmatched") or 0) + 1
    dropped = max(0, len(pending) - PENDING_LIMIT)
    w["pending"] = pending[-PENDING_LIMIT:]
    w["unmatched"] = int(w.get("unmatched") or 0) + dropped
    if ready:
        applied = await apply_batch(db, org, CrmIngestIn(messages=ready))
        w["texts_added"] = int(w.get("texts_added") or 0) + applied.messages_added
        w["texts_merged"] = int(w.get("texts_merged") or 0) + applied.messages_merged
    return {"accepted": len(ready), "pending": len(w["pending"])}


async def retry_pending(db: AsyncSession, org: Organization) -> None:
    """После синхронизации с amoCRM: новые сделки могли появиться."""
    row = await db.get(CrmSettings, org.id)
    if row is not None:
        # Строка могла остаться в сессии с начала синхронизации, а вебхук
        # Wazzup за это время дописал очередь.
        await db.refresh(row)
    w = section(dict((row.data if row else None) or {}))
    if not w.get("pending"):
        return
    try:
        await apply_messages(db, org, w, [])
        await save(db, org, row, w)
    except Exception as exc:  # noqa: BLE001 — синхронизация amoCRM важнее
        log.warning("wazzup: отложенные сообщения не пристроены: %s", exc)
        await db.rollback()
