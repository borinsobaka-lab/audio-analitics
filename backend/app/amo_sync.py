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

from . import amo, wazzup_sync
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
    """Сохранить раздел amo в настройках CRM, не трогая остальное.

    Остальные ключи берутся из свежей строки, а не из копии, прочитанной в
    начале синхронизации: пока шли запросы к amoCRM, владелец мог сохранить
    промпт или рабочее время, и затирать это нельзя."""
    data["amo"] = amo_data
    if row is None:
        row = await db.get(CrmSettings, org.id)
    if row:
        await db.refresh(row)
        merged = dict(row.data or {})
        merged["amo"] = amo_data
        row.data = merged
        row.updated_at = utcnow()
    else:
        row = CrmSettings(org_id=org.id, data=data, updated_by="amoCRM")
        db.add(row)
    await db.commit()
    return row


# Пакет приёма ограничен по размеру; первая синхронизация переписки за
# неделю бывает больше — она уходит частями.
CHUNK = 2000


async def apply_all(db: AsyncSession, org: Organization, batch: dict) -> CrmIngestOut:
    """Пакет любого размера: сначала сделки, потом сообщения и события —
    частями, итог складывается."""
    total = CrmIngestOut()
    parts = []
    for key in ("deals", "messages", "events"):
        items = batch.get(key) or []
        parts += [{key: items[i : i + CHUNK]} for i in range(0, len(items), CHUNK)]
    for part in parts:
        out = await apply_batch(db, org, CrmIngestIn(**part))
        for field in CrmIngestOut.model_fields:
            setattr(total, field, getattr(total, field) + getattr(out, field))
    return total


async def attach_to_deals(
    db: AsyncSession, org: Organization, contact_messages: list[dict]
) -> tuple[list[dict], int]:
    """Сообщения, привязанные к контакту, а не к сделке, — в последнюю сделку
    этого контакта. Возвращает (сообщения со сделкой, сколько не пристроено)."""
    found: dict[str, str | None] = {}
    out: list[dict] = []
    dropped = 0
    for m in contact_messages:
        contact = m["contact_id"]
        if contact not in found:
            deal = await db.scalar(
                select(CrmDeal)
                .where(CrmDeal.org_id == org.id, CrmDeal.contact_key == contact)
                .order_by(CrmDeal.last_activity_at.desc().nulls_last(), CrmDeal.updated_at.desc())
                .limit(1)
            )
            found[contact] = deal.external_id if deal else None
        if found[contact]:
            entry = {k: v for k, v in m.items() if k != "contact_id"}
            out.append({**entry, "deal_id": found[contact]})
        else:
            dropped += 1
    return out, dropped


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
        attached, _ = await attach_to_deals(db, org, result["contact_messages"])
        result["batch"]["messages"].extend(attached)
        applied = await apply_all(db, org, result["batch"])
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
    # Тексты из Wazzup, ждавшие свою сделку: она могла прийти только сейчас.
    await wazzup_sync.retry_pending(db, org)
    return a["last_sync_result"], applied


async def apply_webhook(
    db: AsyncSession, org: Organization, row: CrmSettings | None, data: dict, payload: dict
) -> dict:
    """Вебхук amoCRM → приём. Сообщение, привязанное к контакту, а не к
    сделке, идёт в последнюю сделку этого контакта."""
    a = section(data)
    base = amo.base_url(a.get("subdomain") or "", a.get("domain") or "")
    parsed = amo.parse_webhook(payload, a.get("dicts") or {}, base, tz_of(data))

    attached, dropped = await attach_to_deals(db, org, parsed["contact_messages"])
    parsed["messages"].extend(attached)

    applied = await apply_batch(
        db,
        org,
        CrmIngestIn(deals=parsed["deals"], messages=parsed["messages"], events=parsed["events"]),
    )
    a["last_webhook_at"] = amo.iso(datetime.now(timezone.utc))
    a["webhooks_received"] = int(a.get("webhooks_received") or 0) + 1
    await save(db, org, row, data, a)
    return {**applied.model_dump(), "messages_without_deal": dropped}
