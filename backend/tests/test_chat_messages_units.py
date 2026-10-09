"""Ответы администраторов: факты из журнала amoCRM, тексты из Wazzup, робот,
склейка дублей — чистая логика без сети и базы."""
import asyncio
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import amo, crm_ai, wazzup  # noqa: E402
from app.routers.crm_ingest import merge_twin  # noqa: E402

DICTS = {"users": {"7": "Админ Ваке"}, "pipelines": {"1": "Продажи"}, "statuses": {}}
TS = 1_760_000_000  # 2025-10-09 08:53:20 UTC


# --- журнал событий amoCRM ---


def chat_event(kind, entity_type="lead", entity_id="555", created_by=7, **extra):
    return {
        "id": "ev1", "type": kind, "entity_type": entity_type, "entity_id": entity_id,
        "created_by": created_by, "created_at": TS,
        "value_after": [{"message": {"id": "5f1c-uuid"}}], **extra,
    }


def test_outgoing_chat_event_becomes_message_without_text():
    m = amo.map_chat_event(chat_event("outgoing_chat_message"), DICTS)["message"]
    assert m["id"] == "msg:5f1c-uuid"
    assert m["deal_id"] == "555" and m["direction"] == "out"
    assert m["author_id"] == "7" and m["author_name"] == "Админ Ваке"
    assert m["text"] == ""


def test_incoming_chat_event_has_no_author_and_contact_fallback():
    m = amo.map_chat_event(chat_event("incoming_chat_message"), DICTS)["message"]
    assert m["direction"] == "in" and m["author_id"] == "" and m["author_name"] == ""
    # Сделка удалена или беседа не привязана — сообщение уходит контакту.
    c = amo.map_chat_event(
        chat_event("incoming_chat_message", entity_type="contact", entity_id="900"), DICTS
    )["contact_message"]
    assert c["contact_id"] == "900"
    linked = amo.map_chat_event(
        chat_event("outgoing_chat_message", entity_type="customer", linked_talk_contact_id=901), DICTS
    )["contact_message"]
    assert linked["contact_id"] == "901"
    assert amo.map_chat_event(chat_event("lead_added"), DICTS) is None


def test_robot_is_not_user_zero():
    assert amo.author_of(DICTS, 0) == (crm_ai.ROBOT_KEY, crm_ai.ROBOT_NAME)
    m = amo.map_chat_event(chat_event("outgoing_chat_message", created_by=0), DICTS)["message"]
    assert m["author_id"] == crm_ai.ROBOT_KEY
    ev = amo.map_event(
        {"type": "lead_status_changed", "entity_type": "lead", "entity_id": "5", "created_by": 0,
         "created_at": TS, "value_before": [{"lead_status": {"id": 1}}], "value_after": [{"lead_status": {"id": 2}}]},
        DICTS,
    )
    assert ev["author_id"] == crm_ai.ROBOT_KEY and ev["author_name"] == crm_ai.ROBOT_NAME


class FakeClient:
    def __init__(self):
        self.calls = []

    async def pages(self, path, params, key, limit=250):
        self.calls.append(dict(params) | {"_types": [v for k, v in params if k == "filter[type][]"]})
        return [{"id": str(len(self.calls))}], False


def test_chat_events_go_in_six_hour_windows_filtered_by_contact(monkeypatch):
    monkeypatch.setattr(amo, "REQUEST_PAUSE_S", 0)
    client = FakeClient()
    now = datetime(2026, 10, 9, 12, tzinfo=timezone.utc)
    since = now - timedelta(days=1)
    items, cursor, cut = asyncio.run(amo.chat_events(client, since, now))
    assert len(client.calls) == 4 and len(items) == 4
    assert cursor == now and cut is False
    first = client.calls[0]
    assert first["filter[entity][]"] == "contact"
    assert first["_types"] == ["incoming_chat_message", "outgoing_chat_message"]
    assert first["filter[created_at][to]"] - first["filter[created_at][from]"] == 6 * 3600


def test_chat_events_continue_next_pass_when_too_many_windows(monkeypatch):
    monkeypatch.setattr(amo, "REQUEST_PAUSE_S", 0)
    client = FakeClient()
    now = datetime(2026, 10, 9, 12, tzinfo=timezone.utc)
    since = now - timedelta(days=30)
    items, cursor, cut = asyncio.run(amo.chat_events(client, since, now))
    assert len(client.calls) == amo.CHAT_WINDOWS_PER_PASS
    assert cut is True and cursor == since + amo.CHAT_WINDOW * amo.CHAT_WINDOWS_PER_PASS


def test_stage_names_follow_pipeline_order_closed_last():
    dicts = {"statuses": {
        "142": {"name": "Успешно реализовано", "pipeline_id": "1", "sort": 10000},
        "143": {"name": "Закрыто и не реализовано", "pipeline_id": "1", "sort": 11000},
        "12": {"name": "В работе", "pipeline_id": "1", "sort": 20},
        "11": {"name": "Новая заявка", "pipeline_id": "1", "sort": 10},
        "99": {"name": "Чужая", "pipeline_id": "2", "sort": 5},
    }}
    assert amo.stage_names(dicts, "1") == [
        "Новая заявка", "В работе", "Успешно реализовано", "Закрыто и не реализовано",
    ]


def test_webhook_events_list_has_only_real_amocrm_events():
    assert "Входящее сообщение добавлено" in amo.WEBHOOK_EVENTS
    assert not any("Исходящее" in e for e in amo.WEBHOOK_EVENTS)


# --- склейка факта и текста ---

AT = datetime(2026, 10, 8, 14, 5, tzinfo=timezone.utc)


def stored(seconds, text=""):
    return SimpleNamespace(at=AT + timedelta(seconds=seconds), text=text)


def test_text_finds_nearest_fact_without_text():
    far, near, texted = stored(-100), stored(20), stored(5, "Добрый день")
    assert merge_twin([far, near, texted], AT, "Записала вас на 19:00") is near


def test_text_redelivery_matches_same_text():
    same = stored(30, "Записала вас на 19:00")
    assert merge_twin([same], AT, "Записала вас на 19:00") is same


def test_fact_is_absorbed_by_any_message_nearby_and_window_is_two_minutes():
    texted = stored(-40, "Здравствуйте")
    assert merge_twin([texted], AT, "") is texted
    assert merge_twin([stored(-200)], AT, "") is None
    assert merge_twin([stored(-200)], AT, "текст") is None


# --- разбор: скрытый текст и робот ---

TZ = ZoneInfo("Asia/Tbilisi")
START, END = crm_ai.day_bounds(date(2026, 10, 8), TZ, 20)


def msg(direction, hours, text="текст", author="7"):
    return {
        "direction": direction, "channel": "", "text": text,
        "author_key": "" if direction == "in" else author,
        "author_name": "" if direction == "in" else ("Робот amoCRM" if author == crm_ai.ROBOT_KEY else "Админ Ваке"),
        "at": START + timedelta(hours=hours),
    }


def test_robot_autoreply_does_not_close_waiting():
    s = crm_ai.reply_stats([msg("in", 14), msg("out", 14.01, author=crm_ai.ROBOT_KEY), msg("out", 15, text="")], START, END)
    # Ответил человек через час; автоответ робота через минуту не в счёт.
    assert s["first_reply_minutes"] == 60.0
    assert s["messages_out"] == 1 and s["hidden_out"] == 1
    old = crm_ai.reply_stats([msg("in", 14), msg("out", 14.01, author="0")], START, END)
    assert old["first_reply_minutes"] is None


def test_hidden_text_is_rendered_and_explained_to_model():
    line = crm_ai.render_message(msg("out", 15, text=""), TZ, False)
    assert crm_ai.HIDDEN_TEXT in line and "Администратор Админ Ваке" in line
    robot = crm_ai.render_message(msg("out", 15, author=crm_ai.ROBOT_KEY), TZ, False)
    assert crm_ai.ROBOT_NAME in robot
    prompt = crm_ai.review_prompt(date_label="08.10", instructions="x", criteria=[], deal_text="d")
    assert crm_ai.HIDDEN_TEXT in prompt and "Не пиши, что ответа не было" in prompt
    speed = crm_ai.speed_text({"messages_in": 2, "messages_out": 3, "hidden_out": 3})
    assert "текст 3 из них недоступен" in speed


def test_robot_does_not_lead_the_deal():
    deal = {"manager_key": "9", "manager_name": "Админ Сабуртало"}
    events = [{"author_key": crm_ai.ROBOT_KEY, "author_name": crm_ai.ROBOT_NAME}, {"author_key": "0", "author_name": ""}]
    assert crm_ai.day_manager(deal, [], events) == ("9", "Админ Сабуртало")


def test_client_waiting_is_judged_by_human_messages():
    deal = {"status": "open"}
    messages = [msg("in", -3), msg("out", -2.9, author=crm_ai.ROBOT_KEY), msg("out", 2, text="")]
    assert crm_ai.needs_model(deal, messages, [], START, END)


# --- Wazzup ---

USERS = {"7": "Админ Ваке"}


def test_wazzup_test_request_is_acknowledged():
    assert wazzup.parse_webhook({"test": True})["test"] is True


def test_wazzup_takes_only_outgoing_with_phone():
    payload = {"messages": [
        {"messageId": "a", "dateTime": "2026-10-08T10:05:00.000", "chatType": "whatsapp",
         "chatId": "995555123456", "type": "text", "isEcho": True, "text": "Записала вас на 19:00",
         "authorId": "7", "status": "sent"},
        {"messageId": "b", "dateTime": "2026-10-08T10:01:00.000", "chatType": "whatsapp",
         "chatId": "995555123456", "type": "text", "isEcho": False, "text": "Можно на вечер?", "status": "inbound"},
        {"messageId": "c", "dateTime": "2026-10-08T10:06:00Z", "chatType": "whatsapp",
         "chatId": "995555123456", "type": "image", "isEcho": True, "authorName": "Нино"},
        {"messageId": "d", "dateTime": "2026-10-08T10:07:00Z", "chatType": "whatsapp",
         "chatId": "995555123456", "type": "text", "isEcho": True, "text": "ой", "isDeleted": True},
        {"messageId": "e", "dateTime": "2026-10-08T10:08:00Z", "chatType": "instagram",
         "chatId": "anna.stretch", "type": "text", "isEcho": True, "text": "Привет"},
    ]}
    out = wazzup.parse_webhook(payload, USERS)
    assert out["skipped"] == 2
    first, image, insta = out["messages"]
    assert first["id"] == "wz:a" and first["direction"] == "out"
    assert first["author_name"] == "Админ Ваке" and first["phone"] == "555123456"
    assert first["at"].startswith("2026-10-08T10:05:00") and first["at"].endswith("+00:00")
    assert image["text"] == "[изображение]" and image["author_name"] == "Нино"
    assert insta["phone"] == "" and insta["chat"] == "anna.stretch"


def test_phone_tail_compares_numbers_written_differently():
    assert wazzup.phone_tail("+995 555 12-34-56") == wazzup.phone_tail("995555123456") == "555123456"
    assert wazzup.phone_tail("123") == ""


class FakeAmo:
    """Отвечает на запросы синхронизации: сделок, событий и прочего нет,
    в журнале чатов — одно исходящее по сделке и одно входящее по контакту."""

    base = "https://studio.amocrm.ru"

    async def pages(self, path, params, key, limit=250):
        types = [v for k, v in params if k == "filter[type][]"]
        if path == "/api/v4/events" and types:
            frm = dict(params)["filter[created_at][from]"]
            if frm > TS_SINCE:
                return [], False
            return [
                chat_event("outgoing_chat_message"),
                chat_event("incoming_chat_message", entity_type="contact", entity_id="900"),
            ], False
        return [], False


TS_SINCE = int((datetime(2026, 10, 9, 12, tzinfo=timezone.utc) - timedelta(days=7)).timestamp())


def test_collect_brings_chat_facts_and_contact_messages(monkeypatch):
    monkeypatch.setattr(amo, "REQUEST_PAUSE_S", 0)
    now = datetime(2026, 10, 9, 12, tzinfo=timezone.utc)

    async def no_contacts(client, ids):
        return {}

    monkeypatch.setattr(amo, "fetch_contacts", no_contacts)
    result = asyncio.run(amo.collect(FakeAmo(), {"lookback_days": 7}, DICTS, now))
    assert [m["direction"] for m in result["batch"]["messages"]] == ["out"]
    assert [m["contact_id"] for m in result["contact_messages"]] == ["900"]
    assert result["counts"]["chats"] == 2
    assert result["cursor"]["chats"] == amo.iso(now)
    assert "сообщений в чатах 2" in amo.summarize(result, SimpleNamespace(messages_added=1))
