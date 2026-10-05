"""Приём данных из CRM.

Какая именно CRM у студии, здесь не выбирается: любая система (или сценарий
в n8n/Make, или скрипт выгрузки) присылает сделки, сообщения переписки и
события в одном JSON-формате по ключу интеграции. Тот же формат принимает
ручной импорт файла из админки — так данные можно загрузить за прошлые дни
или проверить разбор до настройки интеграции.

Пакет идемпотентен: сделки обновляются по id из CRM, сообщения и события с
внешним id не дублируются, а без него отсекаются по (сделка, время,
направление, текст). Повторная отправка того же — не ошибка и не дубли.
"""
import hmac
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import crm_ai
from ..auth import UserContext, require_crm_manage
from ..db import get_db
from ..models import CrmDeal, CrmEvent, CrmMessage, CrmSettings, Employee, Organization, utcnow
from ..schemas import CrmIngestIn, CrmIngestOut
from .playbook_common import current_org, missing_migration

router = APIRouter(prefix="/api/crm", tags=["crm"])
log = logging.getLogger(__name__)

MIGRATION = "018_crm.sql"
DEFAULT_TZ = "Asia/Tbilisi"


async def require_integration(
    x_crm_key: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
) -> Organization:
    """Ключ интеграции — из настроек CRM; создаётся при первом открытии
    настроек. Сравнение постоянного времени, как у паролей."""
    key = x_crm_key.strip()
    if not key:
        raise HTTPException(401, "Нет ключа интеграции: заголовок X-Crm-Key")
    org = await current_org(db)
    try:
        row = await db.get(CrmSettings, org.id)
    except ProgrammingError as exc:
        await db.rollback()
        raise missing_migration("CRM ещё не включена", MIGRATION) from exc
    saved = ((row.data if row else None) or {}).get("integration_key") or ""
    if not saved or not hmac.compare_digest(saved, key):
        raise HTTPException(401, "Неверный ключ интеграции CRM")
    return org


@router.get("/ingest/ping")
async def ingest_ping(org: Organization = Depends(require_integration)):
    """Проверка связи из CRM или n8n: ключ подходит, сервер готов принимать."""
    return {"ok": True, "organization": org.name}


def clean_text(text: str | None) -> str:
    return (text or "").replace("\r\n", "\n").strip()


WON = {"won", "success", "successful", "sold", "closed_won", "paid"}
LOST = {"lost", "fail", "failed", "cancelled", "canceled", "closed_lost", "rejected", "refused"}


def deal_status(value: str) -> str:
    """Статус сделки из CRM — к трём своим: open | won | lost."""
    key = value.strip().lower().replace(" ", "_")
    if key in WON:
        return "won"
    if key in LOST:
        return "lost"
    return "open"


def aware(value: datetime, tz) -> datetime:
    """Время без пояса считается временем студии."""
    return value if value.tzinfo else value.replace(tzinfo=tz)


async def apply_batch(db: AsyncSession, org: Organization, body: CrmIngestIn) -> CrmIngestOut:
    row = await db.get(CrmSettings, org.id)
    data = dict((row.data if row else None) or {})
    try:
        tz = ZoneInfo((data.get("timezone") or "").strip() or DEFAULT_TZ)
    except Exception:  # noqa: BLE001
        tz = ZoneInfo(DEFAULT_TZ)
    manager_map = data.get("manager_map") or {}
    employees = [
        {"id": e.id, "full_name": e.full_name}
        for e in (await db.scalars(select(Employee).where(Employee.org_id == org.id))).all()
    ]
    out = CrmIngestOut()

    # --- Сделки: обновление по id из CRM, недостающие — заглушками ---
    wanted = {d.id.strip() for d in body.deals}
    wanted |= {m.deal_id.strip() for m in body.messages}
    wanted |= {e.deal_id.strip() for e in body.events}
    wanted.discard("")
    existing: dict[str, CrmDeal] = {}
    if wanted:
        existing = {
            d.external_id: d
            for d in (
                await db.scalars(
                    select(CrmDeal).where(CrmDeal.org_id == org.id, CrmDeal.external_id.in_(wanted))
                )
            ).all()
        }

    for d in body.deals:
        ext = d.id.strip()
        if not ext:
            continue
        deal = existing.get(ext)
        if deal is None:
            deal = CrmDeal(org_id=org.id, external_id=ext)
            db.add(deal)
            existing[ext] = deal
            out.deals_created += 1
        else:
            out.deals_updated += 1
        for field, value in (
            ("title", d.title),
            ("contact_name", d.contact_name),
            ("contact_phone", d.contact_phone),
            ("pipeline", d.pipeline),
            ("stage", d.stage),
            ("status", deal_status(d.status) if d.status is not None else None),
            ("source", d.source),
            ("manager_key", d.manager_id),
            ("manager_name", d.manager_name),
            ("url", d.url),
        ):
            if value is not None:
                setattr(deal, field, value.strip())
        if d.budget is not None:
            deal.budget = d.budget
        if d.created_at is not None:
            deal.created_at_crm = aware(d.created_at, tz)
        if d.updated_at is not None:
            deal.updated_at_crm = aware(d.updated_at, tz)
        deal.employee_id = crm_ai.resolve_employee(
            deal.manager_key, deal.manager_name, manager_map, employees
        )
        deal.updated_at = utcnow()

    for ext in wanted - set(existing):
        # Сообщение по сделке, которой ещё нет, — заводим её с одним id:
        # карточка придёт следующим пакетом, а переписка не потеряется.
        deal = CrmDeal(org_id=org.id, external_id=ext)
        db.add(deal)
        existing[ext] = deal
        out.deals_stubbed += 1
    await db.flush()

    def bump(deal: CrmDeal, at: datetime) -> None:
        if deal.last_activity_at is None or at > deal.last_activity_at:
            deal.last_activity_at = at

    # --- Сообщения ---
    ext_ids = {m.id.strip() for m in body.messages if m.id and m.id.strip()}
    known_ext: set[str] = set()
    if ext_ids:
        known_ext = set(
            (
                await db.scalars(
                    select(CrmMessage.external_id).where(
                        CrmMessage.org_id == org.id, CrmMessage.external_id.in_(ext_ids)
                    )
                )
            ).all()
        )
    natural: set[tuple] = set()
    deal_ids = {existing[m.deal_id.strip()].id for m in body.messages if m.deal_id.strip() in existing}
    if deal_ids:
        times = [aware(m.at, tz) for m in body.messages]
        for m in (
            await db.scalars(
                select(CrmMessage).where(
                    CrmMessage.deal_id.in_(deal_ids),
                    CrmMessage.at >= min(times),
                    CrmMessage.at <= max(times),
                )
            )
        ).all():
            natural.add((m.deal_id, m.at, m.direction, m.text))
    for m in body.messages:
        deal = existing.get(m.deal_id.strip())
        if deal is None:
            out.messages_skipped += 1
            continue
        ext = (m.id or "").strip() or None
        at = aware(m.at, tz)
        text = clean_text(m.text)
        key = (deal.id, at, m.direction, text)
        if (ext and ext in known_ext) or key in natural:
            out.messages_skipped += 1
            continue
        db.add(
            CrmMessage(
                org_id=org.id,
                deal_id=deal.id,
                external_id=ext,
                direction=m.direction,
                channel=m.channel.strip().lower(),
                author_key=m.author_id.strip(),
                author_name=m.author_name.strip(),
                text=text,
                at=at,
            )
        )
        natural.add(key)
        if ext:
            known_ext.add(ext)
        bump(deal, at)
        out.messages_added += 1

    # --- События ---
    ext_ids = {e.id.strip() for e in body.events if e.id and e.id.strip()}
    known_ext = set()
    if ext_ids:
        known_ext = set(
            (
                await db.scalars(
                    select(CrmEvent.external_id).where(
                        CrmEvent.org_id == org.id, CrmEvent.external_id.in_(ext_ids)
                    )
                )
            ).all()
        )
    natural = set()
    deal_ids = {existing[e.deal_id.strip()].id for e in body.events if e.deal_id.strip() in existing}
    if deal_ids:
        times = [aware(e.at, tz) for e in body.events]
        for e in (
            await db.scalars(
                select(CrmEvent).where(
                    CrmEvent.deal_id.in_(deal_ids),
                    CrmEvent.at >= min(times),
                    CrmEvent.at <= max(times),
                )
            )
        ).all():
            natural.add((e.deal_id, e.at, e.kind, e.to_value, e.text))
    for e in body.events:
        deal = existing.get(e.deal_id.strip())
        if deal is None:
            out.events_skipped += 1
            continue
        ext = (e.id or "").strip() or None
        at = aware(e.at, tz)
        kind = e.kind.strip().lower()
        text = clean_text(e.text)
        to_value = e.to_value.strip()
        key = (deal.id, at, kind, to_value, text)
        if (ext and ext in known_ext) or key in natural:
            out.events_skipped += 1
            continue
        db.add(
            CrmEvent(
                org_id=org.id,
                deal_id=deal.id,
                external_id=ext,
                kind=kind,
                from_value=e.from_value.strip(),
                to_value=to_value,
                text=text,
                author_key=e.author_id.strip(),
                author_name=e.author_name.strip(),
                at=at,
            )
        )
        natural.add(key)
        if ext:
            known_ext.add(ext)
        bump(deal, at)
        # Смена этапа — и текущий этап сделки, если пакет не принёс карточку.
        if kind == "stage_change" and to_value and not any(d.id.strip() == e.deal_id.strip() for d in body.deals):
            if deal.updated_at_crm is None or at >= deal.updated_at_crm:
                deal.stage = to_value
        out.events_added += 1

    try:
        await db.commit()
    except ProgrammingError as exc:
        await db.rollback()
        raise missing_migration("CRM ещё не включена", MIGRATION) from exc
    return out


@router.post("/ingest", response_model=CrmIngestOut)
async def ingest(
    body: CrmIngestIn,
    org: Organization = Depends(require_integration),
    db: AsyncSession = Depends(get_db),
):
    """Пакет из CRM: сделки, сообщения, события. Присылать можно сколько
    угодно раз — повторы отсекаются."""
    return await apply_batch(db, org, body)


@router.post("/import", response_model=CrmIngestOut)
async def import_file(
    body: CrmIngestIn,
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    """Тот же формат, но из админки: файл выгрузки за прошлые дни или
    проверка разбора до того, как интеграция настроена."""
    org = await current_org(db)
    return await apply_batch(db, org, body)
