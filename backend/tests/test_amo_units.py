"""amoCRM: преобразования, вебхук, курсоры и клиент — без настоящей amoCRM."""
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import amo  # noqa: E402
from app.schemas import CrmIngestIn  # noqa: E402

TZ = ZoneInfo("Asia/Tbilisi")
BASE = "https://ladystretch.amocrm.ru"
NOW = datetime(2026, 10, 5, 8, 0, tzinfo=timezone.utc)

DICTS = {
    "pipelines": {"11": "Продажи"},
    "statuses": {
        "21": {"name": "Новая заявка", "pipeline_id": "11", "type": 0},
        "22": {"name": "Записан на пробное", "pipeline_id": "11", "type": 0},
        "142": {"name": "Успешно реализовано", "pipeline_id": "11", "type": 1},
        "143": {"name": "Закрыто и не реализовано", "pipeline_id": "11", "type": 2},
    },
    "users": {"7": "Мария", "9": "Нино"},
    "sources": {"3": "Instagram"},
}


def test_clean_subdomain_accepts_urls_and_plain_names():
    assert amo.clean_subdomain("https://ladystretch.amocrm.ru/leads/detail/1") == "ladystretch"
    assert amo.clean_subdomain(" LadyStretch.kommo.com ") == "ladystretch"
    assert amo.clean_subdomain("ladystretch") == "ladystretch"
    assert amo.base_url("x", "junk") == "https://x.amocrm.ru"


def test_dicts_from_api_payloads():
    pipelines = amo.pipelines_dict(
        {"_embedded": {"pipelines": [{"id": 11, "name": "Продажи", "_embedded": {"statuses": [
            {"id": 21, "name": "Новая заявка", "pipeline_id": 11, "type": 0},
            {"id": 142, "name": "Успешно реализовано", "pipeline_id": 11, "type": 1},
        ]}}]}}
    )
    assert pipelines["pipelines"] == {"11": "Продажи"}
    assert pipelines["statuses"]["21"]["name"] == "Новая заявка"
    assert amo.users_dict({"_embedded": {"users": [{"id": 7, "name": "Мария"}, {"id": 8, "email": "x@y"}]}}) == {"7": "Мария", "8": "x@y"}
    assert amo.users_dict(None) == {}
    name, phone = amo.contact_fields(
        {"name": "Анна Г.", "custom_fields_values": [
            {"field_code": "EMAIL", "values": [{"value": "a@b"}]},
            {"field_code": "PHONE", "values": [{"value": "+995 555"}]},
        ]}
    )
    assert (name, phone) == ("Анна Г.", "+995 555")
    assert amo.contact_fields({"first_name": "Анна", "last_name": "Г"}) == ("Анна Г", "")


def test_map_lead_resolves_names_contacts_and_status():
    lead = {
        "id": 4821, "name": "Анна — пробное", "price": 289, "status_id": 22, "pipeline_id": 11,
        "responsible_user_id": 7, "created_at": 1759572000, "updated_at": 1759575600, "source_id": 3,
        "_embedded": {"contacts": [{"id": 5, "is_main": False}, {"id": 99, "is_main": True}]},
    }
    contacts = {"99": {"name": "Анна", "custom_fields_values": [{"field_code": "PHONE", "values": [{"value": "+995 5"}]}]}}
    deal = amo.map_lead(lead, DICTS, contacts, BASE)
    assert deal["id"] == "4821" and deal["title"] == "Анна — пробное"
    assert deal["contact_id"] == "99" and deal["contact_name"] == "Анна" and deal["contact_phone"] == "+995 5"
    assert deal["pipeline"] == "Продажи" and deal["stage"] == "Записан на пробное" and deal["status"] == "open"
    assert deal["manager_id"] == "7" and deal["manager_name"] == "Мария"
    assert deal["url"] == "https://ladystretch.amocrm.ru/leads/detail/4821"
    assert deal["source"] == "Instagram" and deal["budget"] == 289.0
    assert deal["created_at"] == "2025-10-04T10:00:00+00:00"
    won = amo.map_lead({"id": 1, "status_id": 142}, DICTS, {}, BASE)
    assert won["status"] == "won" and "source" not in won and "budget" not in won
    assert amo.map_lead({"id": 2, "status_id": 143}, DICTS, {}, BASE)["status"] == "lost"
    # Пакет проходит схему приёма как есть.
    CrmIngestIn(deals=[deal, won])


def test_map_event_stage_and_responsible():
    ev = {
        "id": "e1", "type": "lead_status_changed", "entity_id": 4821, "entity_type": "lead",
        "created_by": 7, "created_at": 1759572000,
        "value_before": [{"lead_status": {"id": 21, "pipeline_id": 11}}],
        "value_after": [{"lead_status": {"id": 22, "pipeline_id": 11}}],
    }
    out = amo.map_event(ev, DICTS)
    assert out["kind"] == "stage_change" and out["from"] == "Новая заявка" and out["to"] == "Записан на пробное"
    assert out["deal_id"] == "4821" and out["author_name"] == "Мария" and out["id"] == "ev:e1"
    resp = amo.map_event(
        {"id": "e2", "type": "entity_responsible_changed", "entity_id": 4821, "entity_type": "lead", "created_by": 9,
         "created_at": 1759572000, "value_before": [{"responsible_user": {"id": 7}}], "value_after": [{"responsible_user": {"id": 9}}]},
        DICTS,
    )
    assert resp["kind"] == "field_change" and (resp["from"], resp["to"]) == ("Мария", "Нино")
    assert amo.map_event({"type": "lead_status_changed", "entity_type": "contact", "created_at": 1}, DICTS) is None
    assert amo.map_event({"type": "task_added", "entity_type": "lead", "entity_id": 1, "created_at": 1}, DICTS) is None


def test_map_note_sms_call_and_text():
    sms = amo.map_note({"id": 1, "entity_id": 4821, "note_type": "sms_in", "created_at": 1759572000, "params": {"text": "Приду"}}, DICTS)
    assert sms["message"]["direction"] == "in" and sms["message"]["channel"] == "sms" and sms["message"]["author_name"] == ""
    out = amo.map_note({"id": 2, "entity_id": 4821, "note_type": "sms_out", "created_by": 7, "created_at": 1759572000, "params": {"text": "Ждём"}}, DICTS)
    assert out["message"]["direction"] == "out" and out["message"]["author_name"] == "Мария"
    call = amo.map_note({"id": 3, "entity_id": 4821, "note_type": "call_out", "created_by": 7, "created_at": 1759572000, "params": {"duration": 95, "phone": "+995"}}, DICTS)
    assert call["event"]["kind"] == "call" and call["event"]["text"] == "исходящий звонок, 95 с, +995"
    note = amo.map_note({"id": 4, "entity_id": 4821, "note_type": "common", "created_by": 7, "created_at": 1759572000, "params": {"text": "Перезвонить"}}, DICTS)
    assert note["event"]["kind"] == "note" and note["event"]["text"] == "Перезвонить"
    assert amo.map_note({"id": 5, "entity_id": 4821, "note_type": "attachment", "created_at": 1759572000, "params": {}}, DICTS) is None
    assert amo.map_note({"id": 6, "entity_id": 4821, "note_type": "common", "created_at": 1759572000, "params": {}}, DICTS) is None


def test_map_task_adds_done_event_when_completed():
    task = {
        "id": 55, "entity_id": 4821, "entity_type": "leads", "created_by": 7, "updated_by": 9,
        "created_at": 1759572000, "updated_at": 1759579200, "complete_till": 1759600800,
        "text": "Напомнить", "is_completed": True, "result": {"text": "Напомнила"},
    }
    events = amo.map_task(task, DICTS, TZ)
    assert [e["kind"] for e in events] == ["task", "task_done"]
    assert events[0]["text"] == "Напомнить · срок 04.10 22:00" and events[0]["author_name"] == "Мария"
    assert events[1]["text"] == "Напомнить — Напомнила" and events[1]["author_name"] == "Нино"
    assert events[0]["id"] == "task:55" and events[1]["id"] == "task:55:done"
    assert amo.map_task({**task, "entity_type": "contacts"}, DICTS) == []
    assert len(amo.map_task({**task, "is_completed": False}, DICTS)) == 1


# --- Вебхук ---


def test_expand_form_builds_nested_lists():
    data = amo.expand_form([
        ("leads[status][0][id]", "4821"),
        ("leads[status][0][status_id]", "142"),
        ("leads[status][1][id]", "4822"),
        ("account[subdomain]", "ladystretch"),
        ("message[add][0][author][name]", "Анна"),
    ])
    assert data["leads"]["status"][0] == {"id": "4821", "status_id": "142"}
    assert data["leads"]["status"][1] == {"id": "4822"}
    assert data["account"] == {"subdomain": "ladystretch"}
    assert data["message"]["add"][0]["author"]["name"] == "Анна"


def test_parse_webhook_status_change_and_messages():
    payload = amo.expand_form([
        ("leads[status][0][id]", "4821"),
        ("leads[status][0][status_id]", "22"),
        ("leads[status][0][old_status_id]", "21"),
        ("leads[status][0][pipeline_id]", "11"),
        ("leads[status][0][modified_user_id]", "7"),
        ("leads[status][0][last_modified]", "1759572000"),
        ("message[add][0][id]", "m1"),
        ("message[add][0][contact_id]", "99"),
        ("message[add][0][text]", "Здравствуйте!"),
        ("message[add][0][created_at]", "1759572100"),
        ("message[add][0][element_type]", "2"),
        ("message[add][0][element_id]", "4821"),
        ("message[add][0][type]", "incoming"),
        ("message[add][0][author][id]", "99"),
        ("message[add][0][author][type]", "contact"),
        ("message[add][0][author][name]", "Анна"),
        ("message[add][0][origin]", "whatsapp"),
        ("message[add][1][id]", "m2"),
        ("message[add][1][contact_id]", "99"),
        ("message[add][1][text]", "Анна, добрый день!"),
        ("message[add][1][created_at]", "1759572400"),
        ("message[add][1][element_type]", "2"),
        ("message[add][1][element_id]", "4821"),
        ("message[add][1][type]", "outgoing"),
        ("message[add][1][author][id]", "7"),
        ("message[add][1][author][type]", "user"),
        ("message[add][1][origin]", "whatsapp"),
        ("message[add][2][id]", "m3"),
        ("message[add][2][contact_id]", "100"),
        ("message[add][2][text]", "Сколько стоит?"),
        ("message[add][2][created_at]", "1759572500"),
        ("message[add][2][element_type]", "1"),
        ("message[add][2][element_id]", "100"),
        ("message[add][2][type]", "incoming"),
    ])
    out = amo.parse_webhook(payload, DICTS, BASE, TZ)
    deal = out["deals"][0]
    assert deal["id"] == "4821" and deal["stage"] == "Записан на пробное" and deal["pipeline"] == "Продажи"
    assert deal["status"] == "open" and deal["url"].endswith("/leads/detail/4821")
    (ev,) = out["events"]
    assert ev["kind"] == "stage_change" and (ev["from"], ev["to"]) == ("Новая заявка", "Записан на пробное")
    assert ev["author_name"] == "Мария" and ev["id"] == "wh:status:4821:1759572000"
    m_in, m_out = out["messages"]
    assert m_in["direction"] == "in" and m_in["deal_id"] == "4821" and m_in["channel"] == "whatsapp"
    assert m_in["author_name"] == "" and m_in["id"] == "msg:m1"
    assert m_out["direction"] == "out" and m_out["author_id"] == "7" and m_out["author_name"] == "Мария"
    # Сообщение, привязанное к контакту, ждёт сделку по контакту.
    (cm,) = out["contact_messages"]
    assert cm["contact_id"] == "100" and cm["text"] == "Сколько стоит?"
    # Всё проходит схему приёма.
    CrmIngestIn(deals=out["deals"], messages=out["messages"], events=out["events"])


def test_parse_webhook_notes_tasks_and_unknown_stage():
    payload = amo.expand_form([
        ("leads[add][0][id]", "5000"),
        ("leads[add][0][name]", "Новый лид"),
        ("leads[add][0][status_id]", "999"),
        ("leads[add][0][responsible_user_id]", "7"),
        ("leads[add][0][date_create]", "1759572000"),
        ("note_lead[add][0][id]", "n1"),
        ("note_lead[add][0][element_id]", "5000"),
        ("note_lead[add][0][note_type]", "4"),
        ("note_lead[add][0][text]", "Хочет утро"),
        ("note_lead[add][0][created_at]", "1759572300"),
        ("note_lead[add][0][created_by]", "7"),
        ("note_lead[add][0][id]", "n1"),
        ("task[add][0][id]", "t1"),
        ("task[add][0][element_id]", "5000"),
        ("task[add][0][element_type]", "2"),
        ("task[add][0][text]", "Перезвонить"),
        ("task[add][0][status]", "0"),
        ("task[add][0][date_create]", "1759572600"),
        ("task[add][0][complete_till]", "1759600800"),
        ("task[add][0][responsible_user_id]", "9"),
        ("message[add][0][id]", "m9"),
        ("message[add][0][element_type]", "2"),
        ("message[add][0][element_id]", "5000"),
        ("message[add][0][type]", "incoming"),
        ("message[add][0][created_at]", "1759572700"),
        ("message[add][0][attachment_type]", "picture"),
    ])
    out = amo.parse_webhook(payload, DICTS, BASE, TZ)
    deal = out["deals"][0]
    # Неизвестный этап не затирает сохранённый: поля просто нет.
    assert "stage" not in deal and deal["status"] == "open" and deal["manager_name"] == "Мария"
    kinds = [e["kind"] for e in out["events"]]
    assert kinds == ["note", "task"]
    assert out["events"][0]["text"] == "Хочет утро" and out["events"][1]["author_name"] == "Нино"
    assert out["events"][1]["text"] == "Перезвонить · срок 04.10 22:00"
    assert out["messages"][0]["text"] == "[picture]"


def test_parse_webhook_tolerates_empty_payload():
    assert amo.parse_webhook({}, {}, BASE) == {"deals": [], "messages": [], "events": [], "contact_messages": []}


# --- Курсоры, расписание, токены ---


def test_since_for_uses_cursor_with_overlap_or_lookback():
    a = {"cursor": {"leads": "2026-10-05T07:00:00+00:00"}, "lookback_days": 3}
    assert amo.since_for(a, "leads", NOW) == datetime(2026, 10, 5, 6, 50, tzinfo=timezone.utc)
    assert amo.since_for(a, "events", NOW) == NOW - timedelta(days=3)
    assert amo.since_for({}, "tasks", NOW) == NOW - timedelta(days=amo.DEFAULT_LOOKBACK_DAYS)


def test_sync_due_respects_interval_and_connection():
    assert not amo.sync_due({"enabled": True}, NOW)
    assert amo.sync_due({"enabled": True, "access_token": "t"}, NOW)
    recent = {"enabled": True, "access_token": "t", "last_sync_at": amo.iso(NOW - timedelta(minutes=5)), "sync_every_minutes": 15}
    assert not amo.sync_due(recent, NOW)
    assert amo.sync_due({**recent, "sync_every_minutes": 5}, NOW)
    assert not amo.sync_due({**recent, "enabled": False, "sync_every_minutes": 1}, NOW)


def test_token_refresh_only_for_oauth_near_expiry():
    assert not amo.token_needs_refresh({"auth": "token", "access_token": "t"}, NOW)
    oauth = {"auth": "oauth", "refresh_token": "r", "expires_at": amo.iso(NOW + timedelta(hours=5))}
    assert not amo.token_needs_refresh(oauth, NOW)
    assert amo.token_needs_refresh({**oauth, "expires_at": amo.iso(NOW + timedelta(minutes=5))}, NOW)
    assert amo.token_needs_refresh({**oauth, "expires_at": None}, NOW)
    a = {}
    amo.apply_tokens(a, {"access_token": "A", "refresh_token": "R", "expires_in": 86400}, NOW)
    assert a["access_token"] == "A" and a["expires_at"] == amo.iso(NOW + timedelta(days=1))


# --- Клиент: страницы, 204, ошибки ---


def mock_client(handler) -> amo.AmoClient:
    client = amo.AmoClient(BASE, "token")
    client.http = httpx.AsyncClient(base_url=BASE, transport=httpx.MockTransport(handler))
    return client


def test_pages_follow_next_links_and_stop_on_204():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.params.get("page"))
        page = int(request.url.params.get("page") or 1)
        if request.url.path == "/api/v4/tasks":
            return httpx.Response(204)
        if page == 1:
            return httpx.Response(200, json={"_embedded": {"leads": [{"id": i} for i in range(2)]}, "_links": {"next": {"href": "x"}}})
        return httpx.Response(200, json={"_embedded": {"leads": [{"id": 2}]}})

    async def run():
        client = mock_client(handler)
        leads, cut = await client.pages("/api/v4/leads", [], "leads", limit=2)
        tasks, _ = await client.pages("/api/v4/tasks", [], "tasks")
        await client.close()
        return leads, cut, tasks

    leads, cut, tasks = asyncio.run(run())
    assert [l["id"] for l in leads] == [0, 1, 2] and not cut and tasks == []
    assert calls[:2] == ["1", "2"]


def test_client_errors_are_explained(monkeypatch):
    monkeypatch.setattr(amo, "MAX_PAGES", 1)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v4/account":
            return httpx.Response(401)
        return httpx.Response(200, json={"_embedded": {"leads": [{"id": 1}]}, "_links": {"next": {"href": "x"}}})

    async def run():
        client = mock_client(handler)
        try:
            with pytest.raises(amo.AmoError, match="токен"):
                await client.account()
            items, cut = await client.pages("/api/v4/leads", [], "leads", limit=1)
            return items, cut
        finally:
            await client.close()

    items, cut = asyncio.run(run())
    assert len(items) == 1 and cut  # упёрлись в лимит страниц — продолжим в следующий раз
