"""Экономия на модели: метрики одним запросом, отсев диалогов и сделок,
проверка движения сделок правилами — чистая логика без сети и базы."""
import sys
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import amo, crm_ai, crm_notify  # noqa: E402
from app.pipeline.llm import (  # noqa: E402
    METRICS_EVAL_TEMPLATE,
    LlmClient,
    LlmUsage,
    group_metrics,
    parse_metric_evals,
    render_metrics,
)
from app.pipeline.tasks import metric_types, skip_reason  # noqa: E402

METRICS = [
    {"name": "Приветствие", "prompt": "Поздоровался ли {по имени}", "scale_max": 10},
    {"name": "Закрытие", "prompt": "Предложил ли запись", "scale_max": 5},
]


# --- метрики одним запросом ---


def test_parse_metric_evals_by_number_and_scale():
    raw = {"evaluations": [
        {"metric": 2, "applicable": True, "score": 9, "good": ["записал"], "bad": [], "comment": "ок"},
        {"metric": 1, "applicable": False, "score": None},
    ]}
    first, second = parse_metric_evals(raw, METRICS)
    assert first["applicable"] is False and first["score"] is None
    # шкала берётся у своей метрики: 9 из 5 обрезается до 5
    assert second["applicable"] is True and second["score"] == 5


def test_parse_metric_evals_by_name_or_order():
    by_name = {"evaluations": [{"metric": "«Закрытие»", "applicable": True, "score": 3}]}
    first, second = parse_metric_evals(by_name, METRICS)
    assert first is None and second["score"] == 3
    in_order = {"evaluations": [
        {"applicable": True, "score": 7},
        {"applicable": True, "score": 4},
    ]}
    assert [r["score"] for r in parse_metric_evals(in_order, METRICS)] == [7, 4]


def test_parse_metric_evals_marks_missing_metric():
    raw = {"evaluations": [{"metric": 1, "applicable": True, "score": 8}]}
    first, second = parse_metric_evals(raw, METRICS)
    assert first["score"] == 8
    assert second is None


def test_parse_metric_evals_accepts_bare_list_and_single_object():
    assert parse_metric_evals([{"metric": 1, "applicable": True, "score": 6}], METRICS[:1])[0]["score"] == 6
    assert parse_metric_evals({"applicable": True, "score": 6}, METRICS[:1])[0]["score"] == 6
    with pytest.raises(ValueError):
        parse_metric_evals({"verdict": "хорошо"}, METRICS)


def test_metrics_prompt_keeps_owner_braces_and_sends_dialog_once():
    prompt = METRICS_EVAL_TEMPLATE.format(metrics=render_metrics(METRICS), dialog="ДИАЛОГ-ТЕКСТ")
    assert "МЕТРИКА 1 — «Приветствие», шкала от 1 до 10." in prompt
    assert "МЕТРИКА 2 — «Закрытие», шкала от 1 до 5." in prompt
    assert "Поздоровался ли {по имени}" in prompt
    assert prompt.count("ДИАЛОГ-ТЕКСТ") == 1


def test_group_metrics_packs_until_limit_and_keeps_order():
    items = [SimpleNamespace(name=str(i), prompt="x" * n) for i, n in enumerate([30, 30, 50, 120, 10])]
    groups = group_metrics(items, 100)
    assert [[m.name for m in g] for g in groups] == [["0", "1"], ["2"], ["3"], ["4"]]
    # всё влезает — один запрос
    assert len(group_metrics(items, 1000)) == 1
    assert group_metrics([], 100) == []


class _Stream:
    def __init__(self, message):
        self._message = message

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        return self._message


def test_evaluate_metrics_is_one_request_for_all_metrics():
    message = SimpleNamespace(
        content=[SimpleNamespace(
            type="text",
            text='{"evaluations": [{"metric": 1, "applicable": true, "score": 7}, '
                 '{"metric": 2, "applicable": false, "score": null}]}',
        )],
        stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=3000, output_tokens=400),
    )
    calls = []
    llm = LlmClient.__new__(LlmClient)
    llm.settings = SimpleNamespace(llm_max_tokens=16000)
    llm.usage = LlmUsage()
    llm.client = SimpleNamespace(messages=SimpleNamespace(
        stream=lambda **kw: calls.append(kw) or _Stream(message)
    ))
    results = llm.evaluate_metrics("ДИАЛОГ", METRICS, "claude-haiku-5-5")
    assert len(calls) == 1
    assert calls[0]["model"] == "claude-haiku-5-5"
    assert results[0]["score"] == 7 and results[1]["applicable"] is False
    assert llm.usage.cost_usd == pytest.approx((3000 * 0.10 + 400 * 0.50) / 1_000_000)


# --- какие диалоги смены оцениваются ---


def test_skip_reason_service_short_and_irrelevant():
    types = metric_types(SimpleNamespace(llm_metrics_on_service=False))
    assert skip_reason("sale", 6, types, 4) is None
    assert skip_reason("consultation", 3, types, 4) == "short"
    assert skip_reason("service", 10, types, 4) == "service"
    assert skip_reason("irrelevant", 10, types, 4) == "irrelevant"
    # включили оценку сервиса — сервис оценивается, но короткий всё равно нет
    with_service = metric_types(SimpleNamespace(llm_metrics_on_service=True))
    assert skip_reason("service", 10, with_service, 4) is None
    assert skip_reason("service", 2, with_service, 4) == "short"
    # порог 0 или 1 — оценивать всё, где есть хоть одна реплика
    assert skip_reason("refusal", 1, types, 0) is None


# --- какие сделки CRM идут в модель ---

TZ = ZoneInfo("Asia/Tbilisi")
START, END = crm_ai.day_bounds(date(2026, 10, 4), TZ, 20)


def m(direction, hours, **extra):
    return {"direction": direction, "at": START + timedelta(hours=hours), "text": "…", **extra}


def ev(kind, hours, frm="", to="", **extra):
    return {"kind": kind, "at": START + timedelta(hours=hours), "from_value": frm, "to_value": to, **extra}


OPEN = {"status": "open", "pipeline": "Продажи"}


def test_needs_model_when_client_wrote_today():
    assert crm_ai.needs_model(OPEN, [m("in", 3), m("out", 4)], [], START, END)


def test_needs_model_when_client_waits_from_previous_days():
    # написал вчера вечером, ответа не было — сегодняшний ответ надо проверить
    assert crm_ai.needs_model(OPEN, [m("in", -5), m("out", 2)], [], START, END)
    # ждёт с прошлой недели — это уже разобрано в прошлые дни
    assert not crm_ai.needs_model(OPEN, [m("in", -24 * 6), m("out", 2)], [], START, END)
    # последним писал администратор — клиент ничего не ждал
    assert not crm_ai.needs_model(OPEN, [m("in", -5), m("out", -4), m("out", 2)], [], START, END)


def test_quiet_deal_goes_to_rules_but_lost_closure_goes_to_model():
    moved = [ev("stage_change", 3, "В работе", "Записан на пробное")]
    assert not crm_ai.needs_model(OPEN, [m("out", 2)], moved, START, END)
    assert not crm_ai.needs_model(OPEN, [], [ev("task", 5)], START, END)
    lost = {"status": "lost", "pipeline": "Продажи"}
    closed = [ev("stage_change", 3, "В работе", "Закрыто и не реализовано")]
    assert crm_ai.needs_model(lost, [], closed, START, END)
    # закрыта давно, сегодня только задача — не повод звать модель
    assert not crm_ai.needs_model(lost, [], [ev("task", 5)], START, END)


ORDER = {"Продажи": {"Новая заявка": 10, "В работе": 20, "Записан на пробное": 30}}


def test_stage_checks_flag_only_backward_moves():
    events = [
        ev("stage_change", 1, "Новая заявка", "В работе"),
        ev("stage_change", 2, "Записан на пробное", "в работе", author_name="Мария"),
        ev("stage_change", 3, "В работе", "Закрыто и не реализовано"),
        ev("note", 4),
    ]
    checks = crm_ai.stage_checks(OPEN, events, ORDER)
    assert len(checks) == 1
    assert checks[0]["rule"] == "stage_back" and checks[0]["severity"] == "warning"
    assert "«Записан на пробное» на «в работе»" in checks[0]["text"]
    assert checks[0]["author_name"] == "Мария"


def test_stage_checks_need_known_order():
    events = [ev("stage_change", 2, "Записан на пробное", "В работе")]
    assert crm_ai.stage_checks({"pipeline": "Другая"}, events, ORDER) == []
    assert crm_ai.stage_checks(OPEN, events, {}) == []


def test_amo_stage_order_skips_closed_and_unsorted_dicts():
    dicts = amo.pipelines_dict({"_embedded": {"pipelines": [{
        "id": 7, "name": "Продажи",
        "_embedded": {"statuses": [
            {"id": 1, "name": "Неразобранное", "type": 1, "sort": 10},
            {"id": 2, "name": "В работе", "sort": 20},
            {"id": 142, "name": "Успешно реализовано", "sort": 10000},
            {"id": 143, "name": "Закрыто и не реализовано", "sort": 11000},
        ]},
    }]}})
    assert amo.stage_order(dicts) == {"Продажи": {"Неразобранное": 10, "В работе": 20}}
    # словари, сохранённые до появления sort, порядка не дают
    old = {"pipelines": {"7": "Продажи"}, "statuses": {"2": {"name": "В работе", "pipeline_id": "7"}}}
    assert amo.stage_order(old) == {}


# --- сводка в Telegram ---

QUIET = {"rule_checks": {"deals": 6, "items": [{"text": "Сделку вернули"}]}}


def test_message_mentions_rule_checked_deals():
    stats = {"deals": 4, "problems": 1, "critical": 0, "unanswered": 0}
    text = crm_notify.build_message(day=date(2026, 10, 6), stats=stats, summary=QUIET, url="")
    assert "Без сообщений клиента, проверено правилами: 6 · замечаний <b>1</b>" in text


def test_message_for_day_with_only_quiet_deals():
    text = crm_notify.build_message(day=date(2026, 10, 6), stats={"deals": 0}, summary=QUIET, url="")
    assert "Без сообщений клиента, проверено правилами: 6" in text
    assert "не было ни переписки" not in text
    assert "🟡" in text and "Разбирать было нечего" not in text
    clean = {"rule_checks": {"deals": 3, "items": []}}
    text = crm_notify.build_message(day=date(2026, 10, 6), stats={"deals": 0}, summary=clean, url="")
    assert "🟢 Всё в порядке" in text
