"""amoCRM: синхронизация и вебхук — то, что ходит в базу.

Чистые преобразования и сеть — в amo.py; здесь они соединяются с приёмом
данных (crm_ingest.apply_batch) и настройками (crm_settings.data["amo"]).
Вызывается из роутера (кнопки) и из планировщика (по расписанию).
"""
import logging
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import amo
from .models import CrmDeal, CrmSettings, Organization, utcnow
from .routers.crm_ingest import apply_batch
from .schemas import CrmIngestIn, CrmIngestOut

log = logging.getLogger(__name__)

DEFAULT_TZ = "Asia/Tbilisi"


def section(data: dict) -> dict:
    return dict(data.get("amo") or {})


def tz_of(data: dict):
    try:
        return ZoneInfo((data.get("timezone") or "").strip() or DEFAULT_TZ)
    except Exception:  # noqa: BLE001
        return ZoneInfo(DEFAULT_TZ)


async def save(
    db: AsyncSession, org: Organization, row: CrmSettings | None, data: dict, amo_data: dict
) -> CrmSettings:
    """Сохранить раздел amo в настройках CRM, не трогая остальное."""
    data["amo"] = amo_data
    if row is None:
        row = await db.get(CrmSettings, org.id)
    if row:
        row.data = data
        row.updated_at = utcnow()
    else:
        row = CrmSettings(org_id=org.id, data=data, updated_by="amoCRM")
        db.add(row)
    await db.commit()
    return row


def cache_dicts(a: dict, dicts: dict) -> None:
    """Словари amoCRM кладутся в настройки: вебхук приходит без них, а
    названия этапов и имена людей нужны сразу."""
    a["dicts"] = {
        "pipelines": dicts.get("pipelines") or {},
        "statuses": dicts.get("statuses") or {},
        "users": dicts.get("users") or {},
        "sources": dicts.get("sources") or {},
    }


async def sync_org(
    db: AsyncSession, org: Organization, row: CrmSettings | None, data: dict
) -> tuple[str, CrmIngestOut]:
    """Один проход синхронизации: словари → новое с курсоров → приём."""
    a = section(data)
    now = datetime.now(timezone.utc)
    if not a.get("access_token") or not a.get("subdomain"):
        raise amo.AmoError("amoCRM не подключена")
    if await amo.ensure_token(a, now):
        # refresh_token одноразовый: новый сохраняется до любых запросов.
        row = await save(db, org, row, data, a)
    client = amo.AmoClient(amo.base_url(a["subdomain"], a.get("domain", "")), a["access_token"])
    try:
        dicts = await amo.load_dicts(client)
        cache_dicts(a, dicts)
        result = await amo.collect(client, a, dicts, now, tz_of(data))
        applied = await apply_batch(db, org, CrmIngestIn(**result["batch"]))
        a["cursor"] = {**(a.get("cursor") or {}), **result["cursor"]}
        a["last_sync_at"] = amo.iso(now)
        a["last_sync_result"] = amo.summarize(result, applied)
        a["last_error"] = ""
    except amo.AmoError as exc:
        a["last_error"] = str(exc)
        a["last_error_at"] = amo.iso(now)
        await save(db, org, row, data, a)
        raise
    finally:
        await client.close()
    await save(db, org, row, data, a)
    return a["last_sync_result"], applied


async def apply_webhook(
    db: AsyncSession, org: Organization, row: CrmSettings | None, data: dict, payload: dict
) -> dict:
    """Вебхук amoCRM → приём. Сообщение, привязанное к контакту, а не к
    сделке, идёт в последнюю сделку этого контакта."""
    a = section(data)
    base = amo.base_url(a.get("subdomain") or "", a.get("domain") or "")
    parsed = amo.parse_webhook(payload, a.get("dicts") or {}, base, tz_of(data))

    dropped = 0
    for m in parsed["contact_messages"]:
        deal = await db.scalar(
            select(CrmDeal)
            .where(CrmDeal.org_id == org.id, CrmDeal.contact_key == m["contact_id"])
            .order_by(CrmDeal.last_activity_at.desc().nulls_last(), CrmDeal.updated_at.desc())
            .limit(1)
        )
        if deal:
            entry = {k: v for k, v in m.items() if k != "contact_id"}
            parsed["messages"].append({**entry, "deal_id": deal.external_id})
        else:
            dropped += 1

    applied = await apply_batch(
        db,
        org,
        CrmIngestIn(deals=parsed["deals"], messages=parsed["messages"], events=parsed["events"]),
    )
    a["last_webhook_at"] = amo.iso(datetime.now(timezone.utc))
    a["webhooks_received"] = int(a.get("webhooks_received") or 0) + 1
    await save(db, org, row, data, a)
    return {**applied.model_dump(), "messages_without_deal": dropped}
