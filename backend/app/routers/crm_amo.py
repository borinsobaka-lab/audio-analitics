"""amoCRM: подключение, синхронизация, вебхук."""
import hmac
import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import amo, amo_sync
from ..auth import UserContext, require_crm_manage
from ..config import get_settings
from ..db import get_db
from ..schemas import AmoConnectIn, AmoPipelineOut, AmoStatusOut, AmoSyncOut
from .crm import settings_data
from .playbook_common import author, current_org, missing_migration

router = APIRouter(prefix="/api/crm/amo", tags=["crm"])
log = logging.getLogger(__name__)

SUBDOMAIN = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


def status_out(data: dict) -> AmoStatusOut:
    settings = get_settings()
    a = amo_sync.section(data)
    token = a.get("access_token") or ""
    dicts = a.get("dicts") or {}
    pipelines = []
    for pid, name in (dicts.get("pipelines") or {}).items():
        stages = [
            s["name"]
            for s in (dicts.get("statuses") or {}).values()
            if s.get("pipeline_id") == pid and s.get("name")
        ]
        pipelines.append(AmoPipelineOut(id=pid, name=name, stages=stages))
    key = data.get("integration_key") or ""
    base = settings.api_base_url.rstrip("/")
    return AmoStatusOut(
        connected=bool(token and a.get("subdomain")),
        enabled=bool(a.get("enabled", True)),
        subdomain=a.get("subdomain") or "",
        domain=a.get("domain") or "amocrm.ru",
        account_name=a.get("account_name") or "",
        auth=a.get("auth") or "",
        token_hint=token[-4:] if token else "",
        token_expires_at=a.get("expires_at"),
        sync_every_minutes=int(a.get("sync_every_minutes") or amo.DEFAULT_SYNC_MINUTES),
        lookback_days=int(a.get("lookback_days") or amo.DEFAULT_LOOKBACK_DAYS),
        last_sync_at=a.get("last_sync_at"),
        last_sync_result=a.get("last_sync_result") or "",
        last_error=a.get("last_error") or "",
        last_error_at=a.get("last_error_at"),
        last_webhook_at=a.get("last_webhook_at"),
        webhooks_received=int(a.get("webhooks_received") or 0),
        webhook_url=f"{base}/api/crm/amo/webhook?key={key}" if key else "",
        webhook_events=list(amo.WEBHOOK_EVENTS),
        pipelines=pipelines,
        users=len(dicts.get("users") or {}),
    )


@router.get("", response_model=AmoStatusOut)
async def amo_status(
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    _, data = await settings_data(db, org.id)
    return status_out(data)


@router.put("", response_model=AmoStatusOut)
async def amo_connect(
    body: AmoConnectIn,
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    """Подключить или перенастроить: проверяет токен запросом к аккаунту и
    сразу забирает словари — воронки, этапы, людей."""
    org = await current_org(db)
    row, data = await settings_data(db, org.id)
    a = amo_sync.section(data)
    subdomain = amo.clean_subdomain(body.subdomain)
    if not SUBDOMAIN.fullmatch(subdomain):
        raise HTTPException(400, "Поддомен — это часть адреса до .amocrm.ru, например «ladystretch»")
    now = datetime.now(timezone.utc)
    a.update(
        subdomain=subdomain,
        domain=body.domain,
        enabled=body.enabled,
        sync_every_minutes=body.sync_every_minutes,
        lookback_days=body.lookback_days,
    )
    base = amo.base_url(subdomain, body.domain)
    token = body.token.strip()
    code = body.code.strip()
    if token:
        a.update(auth="token", access_token=token, refresh_token="", expires_at=None)
    elif code:
        if not (body.client_id.strip() and body.client_secret.strip() and body.redirect_uri.strip()):
            raise HTTPException(400, "Для кода авторизации нужны ID интеграции, секретный ключ и ссылка для перенаправления")
        try:
            tokens = await amo.AmoClient.oauth(
                base,
                {
                    "client_id": body.client_id.strip(),
                    "client_secret": body.client_secret.strip(),
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": body.redirect_uri.strip(),
                },
            )
        except amo.AmoError as exc:
            raise HTTPException(400, str(exc)) from exc
        a.update(
            auth="oauth",
            client_id=body.client_id.strip(),
            client_secret=body.client_secret.strip(),
            redirect_uri=body.redirect_uri.strip(),
        )
        amo.apply_tokens(a, tokens, now)
    elif not a.get("access_token"):
        raise HTTPException(400, "Вставьте долгосрочный токен интеграции или код авторизации")

    client = amo.AmoClient(base, a["access_token"])
    try:
        account = await client.account()
        dicts = await amo.load_dicts(client)
    except amo.AmoError as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        await client.close()
    a["account_name"] = str(account.get("name") or "")
    a["last_error"] = ""
    amo_sync.cache_dicts(a, dicts)
    data["amo"] = a
    if row:
        row.updated_by = author(user)
    await amo_sync.save(db, org, row, data, a)
    return status_out(data)


@router.post("/sync", response_model=AmoSyncOut)
async def amo_sync_now(
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    org = await current_org(db)
    row, data = await settings_data(db, org.id)
    try:
        result, applied = await amo_sync.sync_org(db, org, row, data)
    except amo.AmoError as exc:
        raise HTTPException(502, str(exc)) from exc
    return AmoSyncOut(result=result, applied=applied)


@router.delete("", response_model=AmoStatusOut)
async def amo_disconnect(
    user: UserContext = Depends(require_crm_manage),
    db: AsyncSession = Depends(get_db),
):
    """Отключить: токены стираются, данные CRM остаются."""
    org = await current_org(db)
    row, data = await settings_data(db, org.id)
    a = amo_sync.section(data)
    kept = {k: a.get(k) for k in ("subdomain", "domain", "sync_every_minutes", "lookback_days", "dicts") if a.get(k)}
    kept["enabled"] = False
    if row:
        row.updated_by = author(user)
    await amo_sync.save(db, org, row, data, kept)
    return status_out(data)


@router.post("/webhook")
async def amo_webhook(
    request: Request,
    key: str = Query(default=""),
    db: AsyncSession = Depends(get_db),
):
    """Приём вебхука amoCRM. Ключ интеграции — в адресе: amoCRM не умеет
    подписывать запросы и присылать заголовки."""
    org = await current_org(db)
    try:
        row, data = await settings_data(db, org.id)
    except ProgrammingError as exc:
        raise missing_migration("CRM ещё не включена", "018_crm.sql") from exc
    saved = data.get("integration_key") or ""
    if not key.strip() or not saved or not hmac.compare_digest(saved, key.strip()):
        raise HTTPException(401, "Неверный ключ интеграции")

    content_type = (request.headers.get("content-type") or "").lower()
    if "json" in content_type:
        try:
            payload = await request.json()
        except ValueError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
    else:
        form = await request.form()
        payload = amo.expand_form([(k, str(v)) for k, v in form.multi_items()])
    counts = await amo_sync.apply_webhook(db, org, row, data, payload)
    return {"ok": True, **counts}
