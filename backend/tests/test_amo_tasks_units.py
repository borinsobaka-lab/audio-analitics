"""Задачи менеджерам в amoCRM: отбор, текст, отправка — без настоящей amoCRM."""
import asyncio
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import amo, amo_tasks  # noqa: E402

DAY = date(2026, 10, 6)
URL = "https://admin.example/crm/days/2026-10-06"
USERS = {"7": "Мария", "9": "Нино"}


def row(deal="4821", severity="warning", manager="7", deal_manager="7", recs=("Предложить два времени",), problems=("Нет следующего шага",)):
    return {
        "deal": deal, "deal_title": "Анна", "deal_manager_key": deal_manager, "manager_key": manager,
        "severity": severity, "summary": "Клиентка спросила цену, ответ без предложения записи.",
        "recommendations": list(recs), "problems": list(problems),
    }


def cfg(**kw):
    return {"enabled": True, "min_severity": "warning", "due_hours": 2, **kw}


def test_config_defaults_and_bounds():
    assert amo_tasks.config({}) == {"enabled": False, "min_severity": "warning", "due_hours": 2}
    assert amo_tasks.config({"tasks": {"enabled": True, "min_severity": "critical", "due_hours": 500}}) == {
        "enabled": True, "min_severity": "critical", "due_hours": 72,
    }
    assert amo_tasks.config({"tasks": {"min_severity": "x", "due_hours": "y"}})["due_hours"] == 2


def test_task_text_lists_what_to_do_and_link():
    text = amo_tasks.task_text(DAY, row(), URL)
    assert text.startswith("ИИ-разбор переписки за 06.10 — есть замечания.")
    assert "Что сделать:\n— Предложить два времени" in text and text.endswith(f"Разбор: {URL}")
    # Без рекомендаций — проблемы.
    assert "— Нет следующего шага" in amo_tasks.task_text(DAY, row(recs=()), "")
    assert len(amo_tasks.task_text(DAY, row(recs=("x" * 3000,)), URL)) <= amo_tasks.MAX_TEXT


def test_plan_filters_severity_duplicates_and_users():
    rows = [
        row("1", "ok"),
        row("2", "warning"),
        row("3", "critical", manager="55", deal_manager="9"),  # писал не из списка — ответственный по сделке
        row("4", "warning"),
        row("crm-5", "critical"),
        row("6", "critical", manager="", deal_manager=""),
    ]
    items, counts = amo_tasks.plan(rows, USERS, cfg(), {"4": "100"}, DAY, URL)
    assert [i["deal"] for i in items] == ["2", "3"]
    assert items[1]["payload"]["responsible_user_id"] == 9 and items[1]["payload"]["entity_id"] == 3
    assert items[0]["payload"]["entity_type"] == "leads" and items[0]["payload"]["task_type_id"] == 1
    assert items[0]["payload"]["request_id"] == "2"
    assert counts == {"already": 1, "below": 1, "no_user": 1, "not_amo": 1}
    critical_only, counts = amo_tasks.plan(rows, USERS, cfg(min_severity="critical"), {}, DAY, URL)
    assert [i["deal"] for i in critical_only] == ["3"] and counts["below"] == 3


def test_push_sends_batches_and_maps_request_ids(monkeypatch):
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json
        body = json.loads(request.content)
        sent.append(body)
        return httpx.Response(200, json={"_embedded": {"tasks": [{"id": 1000 + int(t["request_id"]), "request_id": t["request_id"]} for t in body]}})

    real = amo.AmoClient.__init__

    def init(self, base, token, timeout=30.0):
        real(self, base, token, timeout)
        self.http = httpx.AsyncClient(base_url=base, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(amo.AmoClient, "__init__", init)
    monkeypatch.setattr(amo_tasks, "BATCH", 2)
    monkeypatch.setattr(amo, "REQUEST_PAUSE_S", 0)
    items, _ = amo_tasks.plan([row(str(n)) for n in range(1, 4)], USERS, cfg(), {}, DAY, URL)
    due = datetime(2026, 10, 7, 6, 0, tzinfo=timezone.utc)
    created, errors = asyncio.run(amo_tasks.push("https://x.amocrm.ru", "t", items, due))
    assert created == {"1": "1001", "2": "1002", "3": "1003"} and errors == []
    assert [len(b) for b in sent] == [2, 1]
    assert sent[0][0]["complete_till"] == int(due.timestamp())


def test_push_reports_errors_without_raising(monkeypatch):
    def handler(request):
        return httpx.Response(403)

    real = amo.AmoClient.__init__

    def init(self, base, token, timeout=30.0):
        real(self, base, token, timeout)
        self.http = httpx.AsyncClient(base_url=base, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(amo.AmoClient, "__init__", init)
    items, _ = amo_tasks.plan([row("1")], USERS, cfg(), {}, DAY, URL)
    created, errors = asyncio.run(amo_tasks.push("https://x.amocrm.ru", "t", items, datetime.now(timezone.utc)))
    assert created == {} and "нет прав" in errors[0]


def test_remember_keeps_earlier_tasks_and_errors():
    run = SimpleNamespace(summary_json={"stats": {}, "amo_tasks": {"1": "11"}})
    amo_tasks.remember(run, {"2": "22"}, ["сбой"])
    assert run.summary_json["amo_tasks"] == {"1": "11", "2": "22"} and run.summary_json["amo_tasks_error"] == "сбой"
    amo_tasks.remember(run, {}, [])
    assert "amo_tasks_error" not in run.summary_json


def test_due_at_uses_working_hours():
    # Разбор в 20:00 по Тбилиси, срок 2 рабочих часа при работе 9–21 → 10:00 утра.
    now = datetime(2026, 10, 6, 16, 0, tzinfo=timezone.utc)
    due = amo_tasks.due_at({"timezone": "Asia/Tbilisi"}, cfg(), now)
    assert due == datetime(2026, 10, 7, 6, 0, tzinfo=timezone.utc)


def test_telegram_mentions_created_tasks():
    from app import crm_notify

    text = crm_notify.build_message(
        day=DAY, stats={"deals": 3, "problems": 1, "critical": 0, "unanswered": 0}, summary={}, url="", tasks_created=2
    )
    assert "Поставлено задач менеджерам в amoCRM: <b>2</b>" in text
    assert "amoCRM" not in crm_notify.build_message(day=DAY, stats={"deals": 3, "problems": 1}, summary={}, url="", tasks_created=0)
