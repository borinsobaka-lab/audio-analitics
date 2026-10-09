"""Wazzup: тексты ответов администраторов.

amoCRM через API не отдаёт текст исходящих сообщений из чатов — только факт
(журнал событий, amo.py). WhatsApp у студии идёт через Wazzup, а Wazzup
присылает вебхуком каждое сообщение канала, исходящие тоже: с текстом и
номером пользователя CRM, который его отправил (isEcho = true, authorId).

Берём только исходящие: входящие с текстом уже приходят вебхуком amoCRM.
Сделка находится по телефону клиента — в WhatsApp chatId и есть номер.
Факт из журнала amoCRM и текст из Wazzup потом сливаются в одно сообщение
при приёме (crm_ingest.merge_twin).

Здесь сеть и чистые преобразования; с базой соединяет роутер crm_wazzup.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

import httpx

API = "https://api.wazzup24.com/v3"
TIMEOUT_S = 30.0
# Каналы, где chatId — номер телефона.
PHONE_CHATS = ("whatsapp", "viber")
# Хвост номера, по которому сравниваются телефоны: код страны и «8» в начале
# пишут по-разному, а последние девять цифр у мобильного номера одни и те же.
PHONE_TAIL = 9
CONTENT_LABELS = {
    "image": "изображение",
    "audio": "голосовое сообщение",
    "video": "видео",
    "document": "документ",
    "vcard": "контакт",
    "geo": "геолокация",
    "wapi_template": "шаблон WhatsApp",
    "sticker": "стикер",
}


class WazzupError(Exception):
    pass


def phone_tail(value) -> str:
    """Последние цифры номера для сравнения; пусто — номера нет."""
    digits = re.sub(r"\D", "", str(value or ""))
    return digits[-PHONE_TAIL:] if len(digits) >= PHONE_TAIL else ""


def _str(value) -> str:
    return "" if value is None else str(value).strip()


def _when(value) -> datetime | None:
    raw = _str(value)
    if not raw:
        return None
    try:
        at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    # Время Wazzup — UTC, иногда без указания пояса.
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


def parse_webhook(payload: dict, users: dict | None = None) -> dict:
    """Вебхук Wazzup → исходящие сообщения для приёма.

    Возвращает {"test": проверочный ли запрос, "messages": [...], "skipped": N}.
    У сообщения вместо deal_id — phone (хвост номера) или chat (id чата):
    сделку по ним находит роутер, у которого есть база."""
    if not isinstance(payload, dict):
        return {"test": False, "messages": [], "skipped": 0}
    if payload.get("test"):
        return {"test": True, "messages": [], "skipped": 0}
    users = users or {}
    out: list[dict] = []
    skipped = 0
    for m in payload.get("messages") or []:
        if not isinstance(m, dict):
            continue
        # Входящие приходят вебхуком amoCRM, удалённые не нужны.
        if not m.get("isEcho") or m.get("isDeleted"):
            skipped += 1
            continue
        at = _when(m.get("dateTime"))
        msg_id = _str(m.get("messageId"))
        if not at or not msg_id:
            skipped += 1
            continue
        chat_type = _str(m.get("chatType")).lower()
        text = _str(m.get("text"))
        if not text:
            kind = _str(m.get("type")).lower()
            text = f"[{CONTENT_LABELS.get(kind, kind or 'вложение')}]"
        author_id = _str(m.get("authorId"))
        contact = m.get("contact") if isinstance(m.get("contact"), dict) else {}
        phone = ""
        if chat_type in PHONE_CHATS:
            phone = phone_tail(m.get("chatId"))
        if not phone:
            phone = phone_tail(contact.get("phone"))
        out.append(
            {
                "id": f"wz:{msg_id}",
                "direction": "out",
                "channel": chat_type,
                "author_id": author_id,
                "author_name": _str(m.get("authorName")) or _str(users.get(author_id)),
                "text": text,
                "at": at.isoformat(),
                "phone": phone,
                "chat": _str(m.get("chatId")),
            }
        )
    return {"test": False, "messages": out, "skipped": skipped}


async def _call(method: str, api_key: str, path: str, json: dict | None = None) -> dict:
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as http:
            resp = await http.request(
                method,
                f"{API}{path}",
                headers={"Authorization": f"Bearer {api_key}"},
                json=json,
            )
    except httpx.HTTPError as exc:
        raise WazzupError(f"нет связи с Wazzup: {exc}") from exc
    if resp.status_code in (401, 403):
        raise WazzupError("Wazzup не принял API-ключ: проверьте его в личном кабинете Wazzup")
    if resp.status_code >= 400:
        detail = ""
        try:
            body = resp.json()
            detail = _str(body.get("description") or body.get("error") or body)
        except ValueError:
            detail = resp.text[:300]
        raise WazzupError(f"Wazzup ответил {resp.status_code}: {detail}".strip())
    try:
        return resp.json() if resp.content else {}
    except ValueError:
        return {}


async def get_webhooks(api_key: str) -> dict:
    """Текущий адрес вебхуков аккаунта: он у Wazzup один на аккаунт."""
    return await _call("GET", api_key, "/webhooks")


async def set_webhooks(api_key: str, uri: str, enabled: bool) -> None:
    """Подписаться на сообщения или отписаться. При подписке Wazzup сразу
    шлёт на адрес проверочный запрос {"test": true} и ждёт ответа 200."""
    await _call(
        "PATCH",
        api_key,
        "/webhooks",
        {"webhooksUri": uri, "subscriptions": {"messagesAndStatuses": enabled}},
    )
