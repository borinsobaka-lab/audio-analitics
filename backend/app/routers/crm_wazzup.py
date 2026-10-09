"""Wazzup: подключение и вебхук с текстами ответов администраторов."""
import hmac
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import amo_sync, wazzup, wazzup_sync
from ..auth import UserContext, require_crm_manage
from ..config import get_settings
from ..db import get_db
from ..schemas import WazzupConnectIn, WazzupStatusOut
from .crm import settings_data
from .playbook_common import current_org, missing_migration

router = APIRouter(prefix="/api/crm/wazzup", tags=["crm"])
log = logging.getLogger(__name__)


def webhook_url(data: dict) -> str:
    key = data.get("integration_key") or ""
    base = get_settings().api_base_url.rstrip("/")
    return f"{base}/api/crm/wazzup/webhook?key={key}" if key else ""


def status_out(data: dict) -> WazzupStatusOut:
    w = wazzup_sync.section(data)
    key = w.get("api_key") or ""
    return WazzupStatusOut(
        connected=bool(key and w.get("enabled")),
        key_hint=key[-4:] if key else "",
        connected_at=w.get("connected_at"),
        last_webhook_at=w.get("last_webhook_at"),
        webhooks_received=int(w.get("webhooks_received") or 0),
        texts_added=int(w.get("texts_added") or 0),
        texts_merged=int(w.get("texts_merged") or 0),
        pending=len(w.get("pending") or []),
        unmatched=int(w.get("unmatched") or 0),
        last_error=w.get("last_error") or "",
        replaced_uri=w.get("replaced_uri") or "",
    )


@router.get("", response_model=WazzupStatusOut)
async def wazzup_status(
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    _, data = await settings_data(db, org.id)
    return status_out(data)


@router.put("", response_model=WazzupStatusOut)
async def wazzup_connect(
    body: WazzupConnectIn,
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    """Подключить: проверить ключ и подписать наш адрес на сообщения.

    Адрес вебхуков у аккаунта Wazzup один. Если там уже чужой адрес — им
    пользуется другой сервис, и замена его отключит; без force=true не
    меняем, а говорим, чей адрес стоит."""
    org = await current_org(db)
    row, data = await settings_data(db, org.id)
    w = wazzup_sync.section(data)
    key = body.api_key.strip() or w.get("api_key") or ""
    if not key:
        raise HTTPException(400, "Вставьте API-ключ из личного кабинета Wazzup")
    ours = webhook_url(data)
    if not ours:
        raise HTTPException(400, "Нет ключа интеграции CRM — откройте «Настройки» CRM, он создастся сам")
    try:
        current = await wazzup.get_webhooks(key)
        uri = str(current.get("webhooksUri") or "").strip()
        if uri and uri != ours and not body.force:
            raise HTTPException(
                409,
                f"В Wazzup уже указан адрес для вебхуков: {uri}. Им пользуется другой сервис; "
                "если подключить CRM, он перестанет получать сообщения из Wazzup.",
            )
        await wazzup.set_webhooks(key, ours, True)
    except wazzup.WazzupError as exc:
        raise HTTPException(400, str(exc)) from exc
    w.update(
        api_key=key,
        enabled=True,
        connected_at=datetime.now(timezone.utc).isoformat(),
        last_error="",
    )
    if uri and uri != ours:
        w["replaced_uri"] = uri
    await wazzup_sync.save(db, org, row, w)
    data["wazzup"] = w
    return status_out(data)


@router.delete("", response_model=WazzupStatusOut)
async def wazzup_disconnect(
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    """Отключить: отписать адрес от сообщений и забыть ключ."""
    org = await current_org(db)
    row, data = await settings_data(db, org.id)
    w = wazzup_sync.section(data)
    key = w.get("api_key") or ""
    if key:
        try:
            await wazzup.set_webhooks(key, webhook_url(data), False)
        except wazzup.WazzupError as exc:
            # Ключ могли уже отозвать — забыть его всё равно нужно.
            log.warning("wazzup: отписка не удалась: %s", exc)
    w.update(api_key="", enabled=False, pending=[])
    await wazzup_sync.save(db, org, row, w)
    data["wazzup"] = w
    return status_out(data)


@router.post("/webhook")
async def wazzup_webhook(
    request: Request,
    key: str = Query(default=""),
    db: AsyncSession = Depends(get_db),
):
    """Приём вебхука Wazzup. Ключ интеграции CRM — в адресе: Wazzup не
    подписывает запросы. На проверочный {"test": true} отвечаем 200 сразу —
    без этого Wazzup не сохранит адрес."""
    org = await current_org(db)
    try:
        row, data = await settings_data(db, org.id)
    except ProgrammingError as exc:
        raise missing_migration("CRM ещё не включена", "018_crm.sql") from exc
    saved = data.get("integration_key") or ""
    if not key.strip() or not saved or not hmac.compare_digest(saved, key.strip()):
        raise HTTPException(401, "Неверный ключ интеграции")
    try:
        payload = await request.json()
    except ValueError:
        payload = {}
    users = (amo_sync.section(data).get("dicts") or {}).get("users") or {}
    parsed = wazzup.parse_webhook(payload, users)
    if parsed["test"]:
        return {"ok": True}
    w = wazzup_sync.section(data)
    if not w.get("enabled"):
        # Отключили, а Wazzup ещё шлёт: принимать не во что.
        return {"ok": True, "ignored": True}
    w["webhooks_received"] = int(w.get("webhooks_received") or 0) + 1
    w["last_webhook_at"] = datetime.now(timezone.utc).isoformat()
    result = {"accepted": 0, "pending": len(w.get("pending") or [])}
    if parsed["messages"]:
        try:
            result = await wazzup_sync.apply_messages(db, org, w, parsed["messages"])
            w["last_error"] = ""
        except Exception as exc:  # noqa: BLE001 — ответ Wazzup важнее: иначе он будет повторять
            await db.rollback()
            log.warning("wazzup webhook: %s", exc)
            w["last_error"] = str(exc)[:500]
    await wazzup_sync.save(db, org, row, w)
    return {"ok": True, "skipped": parsed["skipped"], **result}
