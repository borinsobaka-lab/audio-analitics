"""CRM: разбор переписок и движения сделок — чистая логика без сети и базы."""
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import crm_ai, crm_scheduler  # noqa: E402
from app.routers.crm_ingest import deal_status  # noqa: E402
from app.routers.crm_stats import ReviewRow, ScoreRow, aggregate  # noqa: E402
from app.schemas import CrmIngestIn, CrmSettingsIn  # noqa: E402

TZ = ZoneInfo("Asia/Tbilisi")
DAY = date(2026, 10, 4)
START, END = crm_ai.day_bounds(DAY, TZ)


def at(hour: int, minute: int = 0, days: int = 0) -> datetime:
    return START + timedelta(days=days, hours=hour, minutes=minute)


def msg(direction: str, hour: int, minute: int = 0, days: int = 0, **extra) -> dict:
    return {
        "direction": direction,
        "channel": "whatsapp",
        "author_key": "" if direction == "in" else extra.pop("author_key", "7"),
        "author_name": "" if direction == "in" else extra.pop("author_name", "Мария"),
        "text": extra.pop("text", "текст"),
        "at": at(hour, minute, days),
        **extra,
    }


# --- Границы дня и скорость ответа ---


def test_day_bounds_follow_studio_timezone():
    assert START == datetime(2026, 10, 4, 0, 0, tzinfo=TZ)
    assert END - START == timedelta(days=1)
    # Тбилиси — UTC+4: полночь по студии наступает в 20:00 UTC накануне.
    assert START.astimezone(timezone.utc) == datetime(2026, 10, 3, 20, 0, tzinfo=timezone.utc)


def test_reply_stats_measures_waiting_and_unanswered():
    messages = [
        msg("in", 10, 0),
        msg("in", 10, 2),            # второе сообщение подряд не сбрасывает ожидание
        msg("out", 10, 20),          # ответ через 20 минут
        msg("in", 15, 0),
        msg("out", 16, 30),          # через 90 минут
        msg("in", 20, 0),            # без ответа до конца дня
    ]
    s = crm_ai.reply_stats(messages, START, END)
    assert s["messages_in"] == 4 and s["messages_out"] == 2
    assert s["first_reply_minutes"] == 20.0
    assert s["max_reply_minutes"] == 90.0
    assert s["unanswered"] is True


def test_reply_stats_counts_yesterdays_question_answered_today():
    messages = [msg("in", 22, days=-1), msg("out", 9, 30)]
    s = crm_ai.reply_stats(messages, START, END)
    # Клиент написал вчера в 22:00, ответили сегодня в 9:30 — 690 минут.
    assert s["first_reply_minutes"] == 690.0
    assert s["messages_in"] == 0 and s["messages_out"] == 1
    assert s["unanswered"] is False


def test_reply_stats_ignores_tomorrow_and_handles_silence():
    messages = [msg("out", 11), msg("in", 2, days=1)]
    s = crm_ai.reply_stats(messages, START, END)
    assert s == {
        "messages_in": 0,
        "messages_out": 1,
        "first_reply_minutes": None,
        "max_reply_minutes": None,
        "unanswered": False,
    }


# --- Кто вёл сделку ---


def test_day_manager_prefers_the_only_person_who_wrote():
    deal = {"manager_key": "1", "manager_name": "Анна"}
    day_m = [msg("in", 10), msg("out", 10, 5, author_key="7", author_name="Мария")]
    assert crm_ai.day_manager(deal, day_m, []) == ("7", "Мария")
    # Писали двое — ответственный по сделке.
    two = day_m + [msg("out", 12, author_key="9", author_name="Нино")]
    assert crm_ai.day_manager(deal, two, []) == ("1", "Анна")
    # Никто не писал, но этап двигал один человек.
    events = [{"author_key": "9", "author_name": "Нино", "kind": "stage_change", "at": at(12)}]
    assert crm_ai.day_manager(deal, [msg("in", 10)], events) == ("9", "Нино")


def test_resolve_employee_by_map_then_name():
    anna, maria = uuid.uuid4(), uuid.uuid4()
    employees = [{"id": anna, "full_name": "Анна Гелашвили"}, {"id": maria, "full_name": "Мария Иванова"}]
    assert crm_ai.resolve_employee("7", "кто-то", {"7": str(maria)}, employees) == maria
    assert crm_ai.resolve_employee("", "анна гелашвили", {}, employees) == anna
    assert crm_ai.resolve_employee("", "Мария", {}, employees) == maria
    assert crm_ai.resolve_employee("", "Пётр", {}, employees) is None
    # Два сотрудника с одним именем — по первому слову не угадываем.
    twins = employees + [{"id": uuid.uuid4(), "full_name": "Мария Петрова"}]
    assert crm_ai.resolve_employee("", "Мария", {}, twins) is None


# --- Текст для модели ---


def test_render_deal_splits_context_and_day():
    deal = {
        "external_id": "42", "title": "Анна — пробное", "contact_name": "Анна",
        "contact_phone": "+995 5", "pipeline": "Продажи", "stage": "Новая заявка",
        "status": "open", "source": "Instagram", "manager_name": "Мария", "budget": None,
        "created_at_crm": at(9, days=-2),
    }
    messages = [msg("in", 18, days=-1, text="Сколько стоит?"), msg("out", 9, 5, text="Доброе утро, Анна!")]
    events = [
        {"kind": "stage_change", "from_value": "Новая заявка", "to_value": "В работе",
         "text": "", "author_key": "7", "author_name": "Мария", "at": at(9, 10)},
        {"kind": "task", "from_value": "", "to_value": "", "text": "Напомнить", "author_key": "7",
         "author_name": "Мария", "at": at(9, 11)},
    ]
    text = crm_ai.render_deal(deal, messages, events, START, END, TZ)
    assert "Сделка #42: Анна — пробное" in text
    assert "ДО ЭТОГО ДНЯ" in text and "[03.10 18:00] Клиент (whatsapp): Сколько стоит?" in text
    assert "ПЕРЕПИСКА ЗА 04.10.2026" in text and "[09:05] Администратор Мария (whatsapp): Доброе утро, Анна!" in text
    assert "этап: «Новая заявка» → «В работе»" in text
    assert "задача: Напомнить" in text


def test_render_deal_says_when_nothing_happened():
    deal = {"external_id": "1", "title": ""}
    text = crm_ai.render_deal(deal, [], [], START, END, TZ)
    assert "без названия" in text
    assert "(сообщений за день не было)" in text and "(событий за день не было)" in text
    assert "ДО ЭТОГО ДНЯ" not in text


def test_review_prompt_keeps_json_shape_and_criteria():
    criteria = [{"id": "c1", "name": "Скорость", "prompt": "Ответ за 15 минут", "scale_max": 5}]
    prompt = crm_ai.review_prompt(
        date_label="04.10.2026", instructions="Считай ошибкой {это}", criteria=criteria, deal_text="СДЕЛКА"
    )
    assert "Считай ошибкой {это}" in prompt
    assert "- id=c1 · «Скорость» · шкала 1–5: Ответ за 15 минут" in prompt
    assert '{"category": "...", "severity": "ok|warning|critical"' in prompt
    assert prompt.rstrip().endswith("СДЕЛКА")


def test_knowledge_is_stable_and_complete():
    k = crm_ai.build_knowledge("## Раздел: X", "— Приветствие", "1. Новая заявка", "{админ} — имя")
    assert k.startswith("# БАЗА ЗНАНИЙ")
    for part in ("Правила продаж", "Правила воронки", "Переменные", "Каталог скриптов"):
        assert part in k
    assert k == crm_ai.build_knowledge("## Раздел: X", "— Приветствие", "1. Новая заявка", "{админ} — имя")


# --- Ответ модели ---

CRITERIA = [
    {"id": "aaa", "name": "Тон", "scale_max": 10},
    {"id": "bbb", "name": "Этап", "scale_max": 5},
]


def test_normalize_review_derives_severity_from_problems():
    raw = {
        "category": "Booking", "severity": "critical", "summary": "ok",
        "problems": [], "good": ["Быстро ответила"], "criteria": [
            {"id": "aaa", "applicable": True, "score": 12, "comment": "тепло"},
            {"id": "bbb", "applicable": False, "score": 3},
        ],
    }
    r = crm_ai.normalize_review(raw, CRITERIA)
    assert r["category"] == "booking"
    # Проблем нет — серьёзность «ok», что бы модель ни написала.
    assert r["severity"] == "ok" and r["problem"] is False
    assert r["scores"][0] == {"criterion_id": "aaa", "applicable": True, "score": 10, "comment": "тепло"}
    assert r["scores"][1]["applicable"] is False and r["scores"][1]["score"] is None
    assert r["pipeline"]["ok"] is True


def test_normalize_review_with_problems_and_bad_fields():
    raw = {
        "category": "что-то", "severity": "ok",
        "problems": ["Не ответила", {"kind": "pipeline", "text": "Сделка не переведена", "quote": "—"}, {"text": ""}],
        "scripts": {"used": "Запись на пробное", "deviations": None},
        "pipeline": {"expected_stage": "Записан на пробное", "comment": "нужно перевести"},
        "criteria": [{"id": "aaa", "applicable": True, "score": "семь"}],
    }
    r = crm_ai.normalize_review(raw, CRITERIA)
    assert r["category"] == "other"
    # Проблемы есть, а модель сказала «ok» — становится «warning».
    assert r["severity"] == "warning" and r["problem"] is True
    assert [p["kind"] for p in r["problems"]] == ["chat", "pipeline"]
    assert r["scripts"] == {"used": ["Запись на пробное"], "deviations": []}
    # ok не прислали — выводится из наличия проблемы с воронкой.
    assert r["pipeline"]["ok"] is False and r["pipeline"]["expected_stage"] == "Записан на пробное"
    # Нечитаемая оценка — критерий не применим, а не ноль.
    assert r["scores"][0]["applicable"] is False
    assert r["scores"][1]["criterion_id"] == "bbb"


def test_normalize_review_tolerates_garbage():
    r = crm_ai.normalize_review(["not", "a", "dict"], CRITERIA)
    assert r["category"] == "other" and r["severity"] == "ok" and len(r["scores"]) == 2


def test_normalize_summary_and_day_stats():
    s = crm_ai.normalize_summary({"top_problems": ["x"], "by_manager": [{"manager": "Мария", "note": "ок"}, "junk"]})
    assert s == {"top_problems": ["x"], "by_manager": [{"manager": "Мария", "note": "ок"}], "recommendations": [], "highlights": []}
    reviews = [
        {"category": "booking", "problem": True, "severity": "critical", "manager_name": "Мария",
         "unanswered": True, "first_reply_minutes": 30, "scores": [{"criterion_id": "aaa", "applicable": True, "score": 4}]},
        {"category": "booking", "problem": False, "severity": "ok", "manager_name": "Мария",
         "unanswered": False, "first_reply_minutes": 10, "scores": [{"criterion_id": "aaa", "applicable": True, "score": 8}]},
        {"category": "service", "problem": False, "severity": "ok", "manager_name": "",
         "unanswered": False, "first_reply_minutes": None, "scores": []},
    ]
    stats = crm_ai.day_stats(reviews, CRITERIA)
    assert stats["deals"] == 3 and stats["problems"] == 1 and stats["critical"] == 1 and stats["unanswered"] == 1
    assert stats["by_category"] == {"booking": 2, "service": 1}
    assert stats["by_manager"]["Мария"] == {"deals": 2, "problems": 1, "critical": 1, "unanswered": 1, "avg_first_reply_minutes": 20.0}
    assert stats["by_manager"]["не указан"]["avg_first_reply_minutes"] is None
    assert stats["avg_by_criterion"] == {"Тон": 6.0}


# --- Расписание ---


def test_due_date_waits_for_run_hour_in_studio_time():
    # 05:30 UTC = 09:30 в Тбилиси: час запуска 9 наступил — вчерашний день.
    now = datetime(2026, 10, 5, 5, 30, tzinfo=timezone.utc)
    assert crm_scheduler.due_date({}, now) == date(2026, 10, 4)
    assert crm_scheduler.due_date({"run_hour": 10}, now) is None
    assert crm_scheduler.due_date({"auto_run": False}, now) is None
    # В 20:30 UTC в Тбилиси уже 00:30 следующего дня — «вчера» сдвигается.
    late = datetime(2026, 10, 5, 20, 30, tzinfo=timezone.utc)
    assert crm_scheduler.due_date({"run_hour": 0}, late) == date(2026, 10, 5)
    assert crm_scheduler.due_date({"timezone": "junk", "run_hour": "x"}, now) == date(2026, 10, 4)


# --- Схемы ---


def test_settings_reject_unknown_timezone_and_keep_known():
    with pytest.raises(ValidationError, match="часовой пояс"):
        CrmSettingsIn(timezone="Mars/Olympus")
    assert CrmSettingsIn(timezone=" Europe/Moscow ").timezone == "Europe/Moscow"
    assert CrmSettingsIn(timezone="").timezone == "Asia/Tbilisi"
    with pytest.raises(ValidationError):
        CrmSettingsIn(run_hour=24)


def test_ingest_schema_accepts_crm_shaped_payload():
    body = CrmIngestIn(
        deals=[{"id": "42", "title": "Анна", "stage": "Новая заявка", "manager_id": "7", "manager_name": "Мария"}],
        messages=[{"deal_id": "42", "direction": "in", "text": "Привет", "at": "2026-10-04T10:00:00+04:00"}],
        events=[{"deal_id": "42", "kind": "stage_change", "from": "Новая заявка", "to": "В работе", "at": "2026-10-04T10:05:00+04:00"}],
    )
    assert body.deals[0].contact_name is None  # не прислали — не трогаем
    assert body.events[0].from_value == "Новая заявка" and body.events[0].to_value == "В работе"
    with pytest.raises(ValidationError):
        CrmIngestIn(messages=[{"deal_id": "42", "direction": "sideways", "at": "2026-10-04T10:00:00Z"}])


def test_deal_status_maps_foreign_names():
    assert deal_status("won") == "won" and deal_status("Success") == "won"
    assert deal_status("Closed Lost") == "lost" and deal_status("canceled") == "lost"
    assert deal_status("open") == "open" and deal_status("в работе") == "open"


# --- Статистика за период ---


def rows():
    anna = uuid.uuid4()
    cur = [
        ReviewRow(date(2026, 10, 1), anna, "1", "Анна", "booking", "warning", True, False, 20.0),
        ReviewRow(date(2026, 10, 1), anna, "1", "Анна", "booking", "ok", False, False, 10.0),
        ReviewRow(date(2026, 10, 2), None, "9", "Нино", "service", "critical", True, True, None),
    ]
    prev = [ReviewRow(date(2026, 9, 28), anna, "1", "Анна", "booking", "ok", False, False, 5.0)]
    c1 = uuid.uuid4()
    scores = [
        ScoreRow(date(2026, 10, 1), anna, "1", c1, 6),
        ScoreRow(date(2026, 10, 1), anna, "1", c1, 8),
        ScoreRow(date(2026, 10, 2), None, "9", c1, 2),
    ]
    prev_scores = [ScoreRow(date(2026, 9, 28), anna, "1", c1, 9)]

    class C:
        def __init__(self, id, name):
            self.id, self.name, self.scale_max, self.position = id, name, 10, 0

    return anna, c1, cur, prev, scores, prev_scores, [C(c1, "Тон")]


def test_aggregate_groups_by_employee_or_crm_key():
    anna, c1, cur, prev, scores, prev_scores, criteria = rows()
    out = aggregate(
        date_from=date(2026, 10, 1), date_to=date(2026, 10, 3), prev_from=date(2026, 9, 28), prev_to=date(2026, 9, 30),
        current=cur, previous=prev, scores=scores, prev_scores=prev_scores, criteria=criteria,
        employee_names={anna: "Анна Гелашвили"}, runs=(2, 0.5), prev_runs=(1, 0.1),
    )
    assert out.totals.deals == 3 and out.totals.problems == 2 and out.totals.critical == 1
    assert out.totals.problem_share == 0.667 and out.totals.avg_first_reply_minutes == 15.0
    assert out.totals.runs == 2 and out.totals.cost_usd == 0.5
    assert out.previous.deals == 1 and out.previous.problem_share == 0.0
    names = [m.name for m in out.managers]
    assert names == ["Анна Гелашвили", "Нино"]  # больше сделок — выше; без сотрудника — имя из CRM
    anna_stat = out.managers[0]
    assert anna_stat.totals.deals == 2 and anna_stat.previous.deals == 1
    assert anna_stat.criteria[0].avg_score == 7.0 and anna_stat.criteria[0].prev_avg_score == 9.0
    assert out.managers[1].employee_id is None and out.managers[1].totals.unanswered == 1
    assert out.criteria[0].avg_score == 5.3 and out.criteria[0].count == 3
    assert [c.category for c in out.categories] == ["booking", "service"]
    assert [t.date for t in out.trend] == [date(2026, 10, 1), date(2026, 10, 2)]
    assert out.trend[0].avg_scores == {str(c1): 7.0} and out.trend[1].problem_share == 1.0
