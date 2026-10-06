"""Сводка разбора CRM в Telegram: текст и уровень внимания — без сети."""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import crm_notify  # noqa: E402

STATS = {
    "deals": 14, "problems": 5, "critical": 1, "unanswered": 2,
    "by_category": {"booking": 8, "question": 3, "service": 3},
    "by_manager": {
        "Мария": {"deals": 9, "problems": 4, "critical": 1, "unanswered": 2, "avg_first_reply_minutes": 20},
        "Нино <b>": {"deals": 5, "problems": 1, "critical": 0, "unanswered": 0, "avg_first_reply_minutes": 5},
    },
}
SUMMARY = {"top_problems": ["Ответ без следующего шага — 4 сделки", "Сделка не переведена — 3"], "by_manager": []}


def test_attention_levels_follow_the_numbers():
    assert crm_notify.attention({"deals": 0})[0] == "none"
    assert crm_notify.attention({"deals": 10, "problems": 0, "critical": 0, "unanswered": 0})[0] == "low"
    assert crm_notify.attention({"deals": 10, "problems": 2, "critical": 0, "unanswered": 0})[0] == "medium"
    assert crm_notify.attention({"deals": 10, "problems": 2, "critical": 1, "unanswered": 0})[0] == "high"
    assert crm_notify.attention({"deals": 10, "problems": 5, "critical": 0, "unanswered": 0})[0] == "high"
    assert crm_notify.attention({"deals": 10, "problems": 1, "critical": 0, "unanswered": 1})[0] == "high"


def test_message_has_counts_types_managers_attention_and_link():
    text = crm_notify.build_message(
        day=date(2026, 10, 6), stats=STATS, summary=SUMMARY,
        url="https://admin.example/crm/days/2026-10-06", window="06.10.2026 (с 05.10 20:00 до 06.10 20:00)",
    )
    assert text.startswith("<b>CRM — разбор за 6 октября</b>\n06.10.2026 (с 05.10 20:00 до 06.10 20:00)")
    assert "Разобрано 14 сделок · с замечаниями <b>5</b> (36%) · критичных <b>1</b> · без ответа клиенту <b>2</b>" in text
    assert "<b>По типам:</b> запись на пробное — 8, вопрос клиента — 3, сервис — 3" in text
    assert "Мария — 9 (замечаний 4, критичных 1, без ответа 2); Нино &lt;b&gt; — 5 (замечаний 1)" in text
    assert "<b>Внимание:</b> 🔴 Высокое" in text
    assert "• Ответ без следующего шага — 4 сделки" in text
    assert text.endswith('<a href="https://admin.example/crm/days/2026-10-06">Открыть разбор — сделки за день</a>')


def test_message_without_deals_and_on_error():
    empty = crm_notify.build_message(day=date(2026, 10, 6), stats={"deals": 0}, summary=None, url="")
    assert "не было ни переписки" in empty and "Открыть" not in empty
    failed = crm_notify.build_message(day=date(2026, 10, 6), stats={}, summary=None, url="https://a/crm", error="модель не ответила <x>")
    assert failed.startswith("⚠️") and "модель не ответила &lt;x&gt;" in failed and "Запустите его заново" in failed


def test_quiet_day_skips_the_problem_list():
    text = crm_notify.build_message(
        day=date(2026, 10, 6), stats={"deals": 3, "problems": 0, "critical": 0, "unanswered": 0},
        summary={"top_problems": ["что-то"]}, url="",
    )
    assert "🟢 Всё в порядке" in text and "Главное" not in text


def test_chat_ids_and_dashboard_base(monkeypatch):
    from types import SimpleNamespace

    cfg = SimpleNamespace(
        telegram_bot_token=" t ", telegram_chat_id="-100, 42 ,", dashboard_url="",
        cors_origin_list=lambda: ["https://admin.example/", "https://x"],
    )
    monkeypatch.setattr(crm_notify, "get_settings", lambda: cfg)
    assert crm_notify.chat_ids() == ["-100", "42"]
    assert crm_notify.configured()
    assert crm_notify.day_url(date(2026, 10, 6)) == "https://admin.example/crm/days/2026-10-06"
    cfg.dashboard_url = "https://d.example"
    assert crm_notify.dashboard_base() == "https://d.example"
