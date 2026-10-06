"""Коннектор amoCRM.

Откуда что берётся:

- **Сделки, этапы, ответственные, задачи, заметки, звонки, SMS** —
  синхронизацией по API v4 раз в несколько минут: `leads`, `events`
  (смена этапа, смена ответственного), `leads/notes`, `tasks`, плюс словари
  (воронки и этапы, пользователи, источники) и контакты по сделкам.
- **Текст сообщений из чатов** («Беседы»: WhatsApp, Instagram, Telegram…)
  API amoCRM не отдаёт — он приходит только вебхуком в момент отправки
  (`message[add]`). Поэтому вебхук обязателен, а переписка собирается с
  момента его подключения; прошлые чаты из amoCRM вытащить нельзя.
  Вебхук заодно дублирует смену этапов, заметки и задачи — они попадают
  в базу сразу, не дожидаясь синхронизации, а повторы отсекает приём.

Авторизация — долгосрочный токен приватной интеграции (Настройки →
Интеграции → ваша интеграция → «Ключи и доступы»): без редиректов и
обновления. Код авторизации OAuth тоже принимается: тогда токены
обновляются сами по refresh_token.

Всё, что преобразует данные, — чистые функции, проверяемые без сети;
сеть — в AmoClient, оркестрация — в sync_org.
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone

import httpx

log = logging.getLogger(__name__)

DOMAINS = ("amocrm.ru", "kommo.com", "amocrm.com")
WON_STATUS = 142
LOST_STATUS = 143
PAGE_LIMIT = 250
EVENTS_PAGE_LIMIT = 100
# Страниц на сущность за один проход: остальное — следующим проходом, по
# курсору. Защита от первого запуска на аккаунте с десятками тысяч сделок.
MAX_PAGES = 30
DEFAULT_LOOKBACK_DAYS = 7
DEFAULT_SYNC_MINUTES = 15
# Нахлёст курсора: часы серверов расходятся, а событие могло записаться в
# amoCRM чуть позже, чем мы спросили.
CURSOR_OVERLAP = timedelta(minutes=10)
# Лимит amoCRM — 7 запросов в секунду; пауза между страницами держит нас
# далеко от него даже при параллельной ручной синхронизации.
REQUEST_PAUSE_S = 0.2
OAUTH_REFRESH_AHEAD = timedelta(minutes=15)

EVENT_TYPES = "lead_status_changed,entity_responsible_changed"
NOTE_TYPES_CALL = {"call_in": "in", "call_out": "out"}
NOTE_TYPES_SMS = {"sms_in": "in", "sms_out": "out"}
# Типы примечаний в вебхуках — числами.
WEBHOOK_NOTE_TYPES = {
    "4": "common",
    "10": "call_in",
    "11": "call_out",
    "25": "service_message",
    "102": "sms_in",
    "103": "sms_out",
}
# Что включить в настройках вебхука amoCRM — подсказка в админке.
WEBHOOK_EVENTS = [
    "Входящее сообщение в чате",
    "Исходящее сообщение в чате",
    "Сделка: добавлена",
    "Сделка: изменена",
    "Сделка: смена статуса",
    "Примечание: добавлено в сделку",
    "Задача: добавлена",
    "Задача: изменена",
]


class AmoError(Exception):
    """Понятная владельцу причина, почему amoCRM не ответила."""


# --- Мелочи ------------------------------------------------------------------


def clean_subdomain(value: str) -> str:
    """«https://ladystretch.amocrm.ru/leads» → «ladystretch»."""
    value = (value or "").strip().lower()
    value = re.sub(r"^https?://", "", value)
    value = value.split("/")[0]
    for domain in DOMAINS:
        if value.endswith("." + domain):
            value = value[: -len(domain) - 1]
    return value


def base_url(subdomain: str, domain: str) -> str:
    domain = domain if domain in DOMAINS else DOMAINS[0]
    return f"https://{subdomain}.{domain}"


def lead_url(base: str, lead_id) -> str:
    return f"{base}/leads/detail/{lead_id}"


def ts(value) -> datetime | None:
    """Время amoCRM — unix-секунды (бывает строкой) → aware UTC."""
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    return datetime.fromtimestamp(number, tz=timezone.utc)


def iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value else None


def _str(value) -> str:
    return "" if value is None else str(value).strip()


# --- Словари -----------------------------------------------------------------


def pipelines_dict(payload: dict | None) -> dict:
    """{"pipelines": {id: name}, "statuses": {status_id: {name, pipeline_id, type}}}.
    Ключи — строками: из вебхуков id приходят текстом."""
    pipelines: dict[str, str] = {}
    statuses: dict[str, dict] = {}
    for p in ((payload or {}).get("_embedded") or {}).get("pipelines") or []:
        pid = _str(p.get("id"))
        pipelines[pid] = _str(p.get("name"))
        for s in (p.get("_embedded") or {}).get("statuses") or []:
            statuses[_str(s.get("id"))] = {
                "name": _str(s.get("name")),
                "pipeline_id": pid,
                "type": int(s.get("type") or 0),
            }
    return {"pipelines": pipelines, "statuses": statuses}


def users_dict(payload: dict | None) -> dict[str, str]:
    return {
        _str(u.get("id")): _str(u.get("name")) or _str(u.get("email"))
        for u in ((payload or {}).get("_embedded") or {}).get("users") or []
    }


def sources_dict(payload: dict | None) -> dict[str, str]:
    return {
        _str(s.get("id")): _str(s.get("name"))
        for s in ((payload or {}).get("_embedded") or {}).get("sources") or []
    }


def contact_fields(contact: dict | None) -> tuple[str, str]:
    """Имя и телефон контакта: телефон — первое значение поля с кодом PHONE."""
    if not contact:
        return "", ""
    name = _str(contact.get("name")) or " ".join(
        x for x in (_str(contact.get("first_name")), _str(contact.get("last_name"))) if x
    )
    phone = ""
    for field in contact.get("custom_fields_values") or []:
        if _str(field.get("field_code")).upper() == "PHONE":
            for v in field.get("values") or []:
                phone = _str(v.get("value"))
                if phone:
                    break
        if phone:
            break
    return name, phone


def deal_status(status_id) -> str:
    sid = _str(status_id)
    return "won" if sid == str(WON_STATUS) else "lost" if sid == str(LOST_STATUS) else "open"


def status_name(dicts: dict, status_id) -> str:
    return (dicts.get("statuses") or {}).get(_str(status_id), {}).get("name", "")


def user_name(dicts: dict, user_id) -> str:
    return (dicts.get("users") or {}).get(_str(user_id), "")


# --- Сделки, события, заметки, задачи → формат приёма ------------------------


def map_lead(lead: dict, dicts: dict, contacts: dict, base: str) -> dict:
    main = None
    embedded = (lead.get("_embedded") or {}).get("contacts") or []
    for c in embedded:
        if c.get("is_main") or main is None:
            main = c
            if c.get("is_main"):
                break
    contact_id = _str(main.get("id")) if main else ""
    name, phone = contact_fields(contacts.get(contact_id)) if contact_id else ("", "")
    responsible = _str(lead.get("responsible_user_id"))
    out = {
        "id": _str(lead.get("id")),
        "title": _str(lead.get("name")),
        "contact_name": name,
        "contact_phone": phone,
        "contact_id": contact_id,
        "pipeline": (dicts.get("pipelines") or {}).get(_str(lead.get("pipeline_id")), ""),
        "stage": status_name(dicts, lead.get("status_id")),
        "status": deal_status(lead.get("status_id")),
        "manager_id": responsible,
        "manager_name": user_name(dicts, responsible),
        "url": lead_url(base, lead.get("id")),
        "created_at": iso(ts(lead.get("created_at"))),
        "updated_at": iso(ts(lead.get("updated_at"))),
    }
    source = (dicts.get("sources") or {}).get(_str(lead.get("source_id")))
    if source:
        out["source"] = source
    price = lead.get("price")
    if isinstance(price, (int, float)) and price:
        out["budget"] = float(price)
    return out


def map_event(ev: dict, dicts: dict) -> dict | None:
    """Событие из `GET /api/v4/events` → событие приёма; None — не наше."""
    if _str(ev.get("entity_type")) != "lead":
        return None
    at = ts(ev.get("created_at"))
    if not at:
        return None
    kind = _str(ev.get("type"))
    before = (ev.get("value_before") or [{}])[0] if ev.get("value_before") else {}
    after = (ev.get("value_after") or [{}])[0] if ev.get("value_after") else {}
    author = _str(ev.get("created_by"))
    common = {
        "id": f"ev:{_str(ev.get('id'))}",
        "deal_id": _str(ev.get("entity_id")),
        "author_id": author,
        "author_name": user_name(dicts, author),
        "at": iso(at),
    }
    if kind == "lead_status_changed":
        return {
            **common,
            "kind": "stage_change",
            "from": status_name(dicts, (before.get("lead_status") or {}).get("id")),
            "to": status_name(dicts, (after.get("lead_status") or {}).get("id")),
        }
    if kind == "entity_responsible_changed":
        return {
            **common,
            "kind": "field_change",
            "from": user_name(dicts, (before.get("responsible_user") or {}).get("id")),
            "to": user_name(dicts, (after.get("responsible_user") or {}).get("id")),
            "text": "ответственный",
        }
    return None


def map_note(note: dict, dicts: dict) -> dict | None:
    """Примечание сделки → {"message": …} (SMS) или {"event": …}; None — не наше."""
    note_type = _str(note.get("note_type"))
    at = ts(note.get("created_at"))
    deal_id = _str(note.get("entity_id"))
    if not at or not deal_id:
        return None
    params = note.get("params") or {}
    author = _str(note.get("created_by"))
    base = {
        "deal_id": deal_id,
        "author_id": author,
        "author_name": user_name(dicts, author),
        "at": iso(at),
    }
    note_id = _str(note.get("id"))
    if note_type in NOTE_TYPES_SMS:
        direction = NOTE_TYPES_SMS[note_type]
        return {
            "message": {
                **base,
                "id": f"note:{note_id}",
                "direction": direction,
                "channel": "sms",
                "text": _str(params.get("text")),
                **({"author_id": "", "author_name": ""} if direction == "in" else {}),
            }
        }
    if note_type in NOTE_TYPES_CALL:
        direction = NOTE_TYPES_CALL[note_type]
        duration = params.get("duration")
        parts = ["входящий звонок" if direction == "in" else "исходящий звонок"]
        if isinstance(duration, (int, float)) and duration:
            parts.append(f"{int(duration)} с")
        if _str(params.get("phone")):
            parts.append(_str(params.get("phone")))
        return {"event": {**base, "id": f"note:{note_id}", "kind": "call", "text": ", ".join(parts)}}
    if note_type in ("common", "service_message", "extended_service_message"):
        text = _str(params.get("text")) or _str(params.get("service"))
        if not text:
            return None
        return {"event": {**base, "id": f"note:{note_id}", "kind": "note", "text": text}}
    return None


def map_task(task: dict, dicts: dict, tz=None) -> list[dict]:
    """Задача → событие «задача» при создании и «задача выполнена»."""
    deal_id = _str(task.get("entity_id"))
    if _str(task.get("entity_type")) not in ("leads", "lead") or not deal_id:
        return []
    created = ts(task.get("created_at"))
    if not created:
        return []
    task_id = _str(task.get("id"))
    author = _str(task.get("created_by")) or _str(task.get("responsible_user_id"))
    text = _str(task.get("text"))
    due = ts(task.get("complete_till"))
    if due:
        local = due.astimezone(tz) if tz else due
        text = f"{text} · срок {local.strftime('%d.%m %H:%M')}" if text else f"срок {local.strftime('%d.%m %H:%M')}"
    out = [
        {
            "id": f"task:{task_id}",
            "deal_id": deal_id,
            "kind": "task",
            "text": text,
            "author_id": author,
            "author_name": user_name(dicts, author),
            "at": iso(created),
        }
    ]
    if task.get("is_completed"):
        done_by = _str(task.get("updated_by")) or _str(task.get("responsible_user_id"))
        result = _str((task.get("result") or {}).get("text"))
        out.append(
            {
                "id": f"task:{task_id}:done",
                "deal_id": deal_id,
                "kind": "task_done",
                "text": f"{_str(task.get('text'))}{f' — {result}' if result else ''}",
                "author_id": done_by,
                "author_name": user_name(dicts, done_by),
                "at": iso(ts(task.get("updated_at")) or created),
            }
        )
    return out


# --- Вебхук ------------------------------------------------------------------


def expand_form(pairs) -> dict:
    """Форма amoCRM с PHP-ключами → вложенные словари и списки:
    `leads[status][0][id]=5` → {"leads": {"status": [{"id": "5"}]}}."""
    root: dict = {}
    for key, value in pairs:
        head = re.match(r"^[^\[\]]+", key)
        parts = [head.group(0)] if head else []
        parts += re.findall(r"\[([^\]]*)\]", key)
        if not parts:
            continue
        node = root
        for i, part in enumerate(parts):
            last = i == len(parts) - 1
            if last:
                node[part] = value
            else:
                nxt = node.get(part)
                if not isinstance(nxt, dict):
                    nxt = {}
                    node[part] = nxt
                node = nxt
    return _listify(root)


def _listify(node):
    if isinstance(node, dict):
        converted = {k: _listify(v) for k, v in node.items()}
        if converted and all(re.fullmatch(r"\d+", k) for k in converted):
            return [converted[k] for k in sorted(converted, key=int)]
        return converted
    return node


def _items(section) -> list:
    if isinstance(section, list):
        return [x for x in section if isinstance(x, dict)]
    if isinstance(section, dict):
        return [section] if section and not all(re.fullmatch(r"\d+", k) for k in section) else [
            v for v in section.values() if isinstance(v, dict)
        ]
    return []


def _is_lead(entity) -> bool:
    return _str(entity).lower() in ("2", "lead", "leads")


def parse_webhook(payload: dict, dicts: dict, base: str, tz=None) -> dict:
    """Вебхук amoCRM → пакет приёма.

    Сообщение без сделки (привязано к контакту) кладётся в contact_messages
    с contact_id: сделку по контакту находит обработчик, у которого есть база.
    """
    deals: list[dict] = []
    messages: list[dict] = []
    events: list[dict] = []
    contact_messages: list[dict] = []

    leads = payload.get("leads") or {}
    for section in ("add", "update", "status", "restore"):
        for lead in _items(leads.get(section)):
            lead_id = _str(lead.get("id"))
            if not lead_id:
                continue
            deal = {"id": lead_id, "url": lead_url(base, lead_id)}
            if "name" in lead:
                deal["title"] = _str(lead.get("name"))
            if _str(lead.get("status_id")):
                deal["stage"] = status_name(dicts, lead.get("status_id")) or None
                deal["status"] = deal_status(lead.get("status_id"))
            if _str(lead.get("pipeline_id")):
                deal["pipeline"] = (dicts.get("pipelines") or {}).get(_str(lead.get("pipeline_id"))) or None
            if _str(lead.get("responsible_user_id")):
                deal["manager_id"] = _str(lead.get("responsible_user_id"))
                deal["manager_name"] = user_name(dicts, lead.get("responsible_user_id")) or None
            if _str(lead.get("price")) and _str(lead.get("price")).replace(".", "", 1).isdigit():
                deal["budget"] = float(lead["price"])
            created = ts(lead.get("date_create") or lead.get("created_at"))
            updated = ts(lead.get("last_modified") or lead.get("updated_at"))
            if created:
                deal["created_at"] = iso(created)
            if updated:
                deal["updated_at"] = iso(updated)
            deals.append({k: v for k, v in deal.items() if v is not None})
            if section == "status" and _str(lead.get("status_id")):
                at = updated or datetime.now(timezone.utc)
                author = _str(lead.get("modified_user_id"))
                events.append(
                    {
                        "id": f"wh:status:{lead_id}:{int(at.timestamp())}",
                        "deal_id": lead_id,
                        "kind": "stage_change",
                        "from": status_name(dicts, lead.get("old_status_id")),
                        "to": status_name(dicts, lead.get("status_id")),
                        "author_id": author,
                        "author_name": user_name(dicts, author),
                        "at": iso(at),
                    }
                )

    for m in _items((payload.get("message") or {}).get("add")):
        at = ts(m.get("created_at")) or datetime.now(timezone.utc)
        incoming = _str(m.get("type")).lower() in ("incoming", "in")
        author = m.get("author") or {}
        text = _str(m.get("text"))
        if not text:
            # Вложение без подписи: пусть будет видно, что что-то прислали.
            text = f"[{_str(m.get('attachment_type') or m.get('media_type') or 'вложение')}]"
        entry = {
            "id": f"msg:{_str(m.get('id'))}" if _str(m.get("id")) else None,
            "direction": "in" if incoming else "out",
            "channel": _str(m.get("origin")).lower(),
            "author_id": "" if incoming else _str(author.get("id")),
            "author_name": "" if incoming else _str(author.get("name")) or user_name(dicts, author.get("id")),
            "text": text,
            "at": iso(at),
        }
        entity_type = m.get("element_type") or m.get("entity_type")
        entity_id = _str(m.get("element_id") or m.get("entity_id"))
        if _is_lead(entity_type) and entity_id:
            messages.append({**entry, "deal_id": entity_id})
        else:
            contact_id = _str(m.get("contact_id")) or (_str(author.get("id")) if incoming else "")
            if contact_id:
                contact_messages.append({**entry, "contact_id": contact_id})

    for key in ("note_lead", "note"):
        for note in _items((payload.get(key) or {}).get("add")):
            if key == "note" and not _is_lead(note.get("element_type")):
                continue
            kind = WEBHOOK_NOTE_TYPES.get(_str(note.get("note_type")), _str(note.get("note_type")))
            mapped = map_note(
                {
                    "id": note.get("id"),
                    "entity_id": note.get("element_id") or note.get("entity_id"),
                    "note_type": kind,
                    "created_at": note.get("created_at") or note.get("date_create"),
                    "created_by": note.get("created_by") or note.get("responsible_user_id"),
                    "params": {"text": note.get("text"), "duration": _num(note.get("duration")), "phone": note.get("phone")},
                },
                dicts,
            )
            if mapped and "message" in mapped:
                messages.append(mapped["message"])
            elif mapped:
                events.append(mapped["event"])

    tasks = payload.get("task") or {}
    for section in ("add", "update"):
        for t in _items(tasks.get(section)):
            if not _is_lead(t.get("element_type") or t.get("entity_type")):
                continue
            events.extend(
                map_task(
                    {
                        "id": t.get("id"),
                        "entity_id": t.get("element_id") or t.get("entity_id"),
                        "entity_type": "leads",
                        "created_at": t.get("date_create") or t.get("created_at"),
                        "updated_at": t.get("last_modified") or t.get("updated_at"),
                        "created_by": t.get("created_by"),
                        "updated_by": t.get("modified_user_id") or t.get("updated_by"),
                        "responsible_user_id": t.get("responsible_user_id"),
                        "text": t.get("text"),
                        "complete_till": t.get("complete_till"),
                        "is_completed": _str(t.get("status")) == "1" or _str(t.get("is_completed")).lower() in ("1", "true"),
                        "result": {"text": t.get("result_text") or (t.get("result") or {}).get("text") if isinstance(t.get("result"), dict) else t.get("result")},
                    },
                    dicts,
                    tz,
                )
            )

    return {"deals": deals, "messages": messages, "events": events, "contact_messages": contact_messages}


def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# --- Курсоры и расписание ----------------------------------------------------


def since_for(amo: dict, entity: str, now: datetime) -> datetime:
    """С какого момента спрашивать сущность: курсор с нахлёстом или глубина
    первого запуска."""
    cursor = (amo.get("cursor") or {}).get(entity)
    if cursor:
        try:
            return datetime.fromisoformat(cursor) - CURSOR_OVERLAP
        except ValueError:
            pass
    days = int(amo.get("lookback_days") or DEFAULT_LOOKBACK_DAYS)
    return now - timedelta(days=max(1, days))


def sync_due(amo: dict, now: datetime) -> bool:
    if not amo.get("enabled") or not amo.get("access_token"):
        return False
    last = amo.get("last_sync_at")
    if not last:
        return True
    try:
        last_dt = datetime.fromisoformat(last)
    except ValueError:
        return True
    minutes = int(amo.get("sync_every_minutes") or DEFAULT_SYNC_MINUTES)
    return now - last_dt >= timedelta(minutes=max(1, minutes))


def token_needs_refresh(amo: dict, now: datetime) -> bool:
    if amo.get("auth") != "oauth" or not amo.get("refresh_token"):
        return False
    expires = amo.get("expires_at")
    if not expires:
        return True
    try:
        return datetime.fromisoformat(expires) - now < OAUTH_REFRESH_AHEAD
    except ValueError:
        return True


# --- Сеть --------------------------------------------------------------------


class AmoClient:
    def __init__(self, base: str, token: str, timeout: float = 30.0):
        self.base = base
        self.token = token
        self.http = httpx.AsyncClient(
            base_url=base,
            timeout=timeout,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )

    async def close(self) -> None:
        await self.http.aclose()

    async def get(self, path: str, params=None) -> dict | None:
        """GET → JSON; None на 204 (пустой список). Ошибки — словами."""
        try:
            resp = await self.http.get(path, params=params)
        except httpx.HTTPError as exc:
            raise AmoError(f"нет связи с amoCRM: {exc}") from exc
        return self._parse(resp, path)

    async def post(self, path: str, body) -> dict | None:
        """POST JSON → JSON. Используется для постановки задач."""
        try:
            resp = await self.http.post(path, json=body)
        except httpx.HTTPError as exc:
            raise AmoError(f"нет связи с amoCRM: {exc}") from exc
        return self._parse(resp, path)

    @staticmethod
    def _parse(resp: httpx.Response, path: str) -> dict | None:
        if resp.status_code == 204:
            return None
        if resp.status_code == 401:
            raise AmoError("amoCRM не приняла токен — он отозван или истёк")
        if resp.status_code == 402:
            raise AmoError("аккаунт amoCRM не оплачен — API закрыт")
        if resp.status_code == 403:
            raise AmoError(f"amoCRM отказала в доступе к {path}: у интеграции нет прав")
        if resp.status_code == 429:
            raise AmoError("amoCRM ограничила частоту запросов — попробуйте позже")
        if resp.status_code >= 400:
            raise AmoError(f"amoCRM ответила {resp.status_code} на {path}: {resp.text[:200]}")
        try:
            return resp.json()
        except ValueError as exc:
            raise AmoError(f"amoCRM вернула не JSON на {path}") from exc

    async def pages(self, path: str, params: list[tuple], key: str, limit: int = PAGE_LIMIT) -> tuple[list[dict], bool]:
        """Все страницы списка (до MAX_PAGES). Возвращает (элементы, обрезано)."""
        items: list[dict] = []
        page = 1
        while page <= MAX_PAGES:
            payload = await self.get(path, [*params, ("limit", limit), ("page", page)])
            if not payload:
                return items, False
            chunk = ((payload.get("_embedded") or {}).get(key)) or []
            items.extend(x for x in chunk if isinstance(x, dict))
            has_next = bool(((payload.get("_links") or {}).get("next") or {}).get("href"))
            if not has_next or len(chunk) < limit:
                return items, False
            page += 1
            await asyncio.sleep(REQUEST_PAUSE_S)
        return items, True

    async def account(self) -> dict:
        return await self.get("/api/v4/account") or {}

    @staticmethod
    async def oauth(base: str, body: dict) -> dict:
        try:
            async with httpx.AsyncClient(timeout=30.0) as http:
                resp = await http.post(f"{base}/oauth2/access_token", json=body)
        except httpx.HTTPError as exc:
            raise AmoError(f"нет связи с amoCRM: {exc}") from exc
        if resp.status_code >= 400:
            hint = ""
            try:
                hint = resp.json().get("hint") or resp.json().get("detail") or ""
            except ValueError:
                pass
            raise AmoError(f"amoCRM не выдала токен ({resp.status_code}): {hint or resp.text[:200]}")
        return resp.json()


def apply_tokens(amo: dict, tokens: dict, now: datetime) -> None:
    amo["access_token"] = _str(tokens.get("access_token"))
    amo["refresh_token"] = _str(tokens.get("refresh_token"))
    try:
        seconds = int(tokens.get("expires_in") or 0)
    except (TypeError, ValueError):
        seconds = 0
    amo["expires_at"] = iso(now + timedelta(seconds=seconds)) if seconds else None


async def ensure_token(amo: dict, now: datetime) -> bool:
    """Обновить OAuth-токен, если скоро истечёт. Возвращает, менялись ли
    настройки — их надо сохранить сразу: refresh_token одноразовый."""
    if not token_needs_refresh(amo, now):
        return False
    base = base_url(amo.get("subdomain", ""), amo.get("domain", ""))
    tokens = await AmoClient.oauth(
        base,
        {
            "client_id": amo.get("client_id", ""),
            "client_secret": amo.get("client_secret", ""),
            "grant_type": "refresh_token",
            "refresh_token": amo.get("refresh_token", ""),
            "redirect_uri": amo.get("redirect_uri", ""),
        },
    )
    apply_tokens(amo, tokens, now)
    return True


async def load_dicts(client: AmoClient) -> dict:
    """Воронки, этапы, пользователи, источники — одним словарём."""
    dicts = pipelines_dict(await client.get("/api/v4/leads/pipelines"))
    dicts["users"] = users_dict(await client.get("/api/v4/users", [("limit", 250)]))
    try:
        dicts["sources"] = sources_dict(await client.get("/api/v4/sources"))
    except AmoError:
        # Источники есть не у всех тарифов и интеграций — без них можно.
        dicts["sources"] = {}
    return dicts


async def fetch_contacts(client: AmoClient, ids: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    unique = [i for i in dict.fromkeys(ids) if i]
    for start in range(0, len(unique), 50):
        chunk = unique[start : start + 50]
        payload = await client.get(
            "/api/v4/contacts", [*(("filter[id][]", i) for i in chunk), ("limit", 250)]
        )
        for c in ((payload or {}).get("_embedded") or {}).get("contacts") or []:
            out[_str(c.get("id"))] = c
        await asyncio.sleep(REQUEST_PAUSE_S)
    return out


async def collect(client: AmoClient, amo: dict, dicts: dict, now: datetime, tz=None) -> dict:
    """Всё новое с курсоров → пакет приёма и новые курсоры."""
    cursor: dict = {}
    base = client.base
    batch = {"deals": [], "messages": [], "events": []}
    truncated: list[str] = []

    def unix(dt: datetime) -> int:
        return int(dt.timestamp())

    def advance(entity: str, items: list[dict], cut: bool, field: str) -> None:
        if cut and items:
            last = max((ts(i.get(field)) for i in items if ts(i.get(field))), default=now)
            cursor[entity] = iso(last)
            truncated.append(entity)
        else:
            cursor[entity] = iso(now)

    # Сделки, обновлённые с курсора, с их контактами.
    leads, cut = await client.pages(
        "/api/v4/leads",
        [("with", "contacts"), ("filter[updated_at][from]", unix(since_for(amo, "leads", now))), ("order[updated_at]", "asc")],
        "leads",
    )
    contact_ids = []
    for lead in leads:
        for c in (lead.get("_embedded") or {}).get("contacts") or []:
            contact_ids.append(_str(c.get("id")))
    contacts = await fetch_contacts(client, contact_ids)
    batch["deals"] = [map_lead(lead, dicts, contacts, base) for lead in leads]
    advance("leads", leads, cut, "updated_at")

    events, cut = await client.pages(
        "/api/v4/events",
        [("filter[created_at][from]", unix(since_for(amo, "events", now))), ("filter[entity]", "lead"), ("filter[type]", EVENT_TYPES)],
        "events",
        limit=EVENTS_PAGE_LIMIT,
    )
    batch["events"] = [e for e in (map_event(ev, dicts) for ev in events) if e]
    advance("events", events, cut, "created_at")

    notes, cut = await client.pages(
        "/api/v4/leads/notes",
        [("filter[updated_at][from]", unix(since_for(amo, "notes", now)))],
        "notes",
    )
    for note in notes:
        mapped = map_note(note, dicts)
        if not mapped:
            continue
        if "message" in mapped:
            batch["messages"].append(mapped["message"])
        else:
            batch["events"].append(mapped["event"])
    advance("notes", notes, cut, "updated_at")

    tasks, cut = await client.pages(
        "/api/v4/tasks",
        [("filter[updated_at][from]", unix(since_for(amo, "tasks", now))), ("filter[entity_type]", "leads")],
        "tasks",
    )
    for task in tasks:
        batch["events"].extend(map_task(task, dicts, tz))
    advance("tasks", tasks, cut, "updated_at")

    return {"batch": batch, "cursor": cursor, "truncated": truncated, "counts": {
        "leads": len(leads), "events": len(events), "notes": len(notes), "tasks": len(tasks),
    }}


def summarize(result: dict, applied) -> str:
    c = result["counts"]
    parts = [
        f"сделок {c['leads']}",
        f"событий {c['events']}",
        f"примечаний {c['notes']}",
        f"задач {c['tasks']}",
        f"новых сообщений {applied.messages_added}",
    ]
    if result["truncated"]:
        parts.append("не всё за раз — продолжение следующим проходом")
    return ", ".join(parts)
