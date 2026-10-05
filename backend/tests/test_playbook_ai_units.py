"""ИИ-помощник скриптов: каталог для модели и подсказка по переменным —
без обращения к OpenAI."""
from app import playbook_ai
from app.routers.playbook_insights import variables_hint


def test_strip_markup_removes_editor_marks():
    text = "**Сразу** после ответа. [[Возврат]] и [см. скрипт](script:" + "0" * 8 + "-0000-0000-0000-" + "0" * 12 + ")"
    assert playbook_ai.strip_markup(text) == "Сразу после ответа. Возврат и «см. скрипт»"


def test_catalog_lists_ids_titles_and_russian_text():
    tree = [
        {
            "title": "Возражения",
            "items": [
                {
                    "id": "11111111-1111-1111-1111-111111111111",
                    "title": "Дорого",
                    "kind": "chat",
                    "note": "**Когда** клиент говорит «дорого»",
                    "follow_up": "",
                    "variants": [
                        {"label": "", "messages": [{"label": "", "ru": "Понимаю вас!", "en": "I see!", "ka": ""}]}
                    ],
                }
            ],
        }
    ]
    catalog = playbook_ai.build_catalog(tree)
    assert "## Раздел: Возражения" in catalog
    assert "[id=11111111-1111-1111-1111-111111111111] Дорого (чат)" in catalog
    assert "Как использовать: Когда клиент говорит «дорого»" in catalog
    assert "Понимаю вас!" in catalog and "I see!" not in catalog
    assert "[есть: RU, EN]" in catalog
    # Один и тот же каталог — байт в байт: от этого зависит кэш промпта.
    assert catalog == playbook_ai.build_catalog(tree)


def test_sales_rules_from_script_template():
    rules = playbook_ai.build_sales_rules(
        {"stages": [{"key": "greet", "title": "Приветствие", "description": "Назвать себя"}], "body": ""}
    )
    assert rules == "— Приветствие: Назвать себя"
    assert playbook_ai.build_sales_rules(None) == ""


def test_variables_hint_includes_builtins_text_and_dates():
    hint = variables_hint(
        {
            "variables": [
                {"key": "цена", "type": "text", "description": "цена пробного", "ru": "14 лари"},
                {"key": "слот1", "type": "date", "description": "", "offset_days": 2},
            ]
        }
    )
    assert "{админ}" in hint and "{студия}" in hint
    assert "{цена} — цена пробного (сейчас: 14 лари)" in hint
    assert "{слот1} — дата через 2 дн. от сегодня" in hint


# --- Генерация с проверкой: цикл и «fail closed» ---

import asyncio
from types import SimpleNamespace


def run_ask(monkeypatch, replies):
    """Подменяет вызов модели очередью готовых ответов и запускает ask."""
    calls = []

    async def fake_call(model, knowledge, instructions, user, schema, name):
        calls.append({"name": name, "user": user})
        return replies.pop(0)

    monkeypatch.setattr(playbook_ai, "call", fake_call)
    monkeypatch.setattr(playbook_ai, "get_settings", lambda: SimpleNamespace(openai_api_key="k"))
    result = asyncio.run(
        playbook_ai.ask(
            model="m", prompt="p", verify_prompt="v", catalog="c", sales_rules="",
            variables="", studio="", lang="ru", message="Сколько стоит?",
        )
    )
    return result, calls


def gen(reply="", status="ready", missing=""):
    return {
        "status": status, "language": "ru", "matches": [], "reply": reply,
        "used_sources": [], "missing_information": missing, "comment": "",
    }


def test_verified_reply_is_shown(monkeypatch):
    result, calls = run_ask(monkeypatch, [gen("Пробное — {цена}"), {"verification": "passed", "issues": []}])
    assert result["status"] == "ready" and result["verified"] and result["reply"] == "Пробное — {цена}"
    assert [c["name"] for c in calls] == ["script_assist", "script_verify"]


def test_rejected_twice_is_never_shown(monkeypatch):
    bad = {"verification": "failed", "issues": [{"claim": "скидка 25%", "reason": "нет в базе"}]}
    result, calls = run_ask(monkeypatch, [gen("Скидка 25%!"), bad, gen("Скидка 20%!"), bad])
    assert result["status"] == "unverified" and result["reply"] == "" and not result["verified"]
    assert result["issues"][0]["claim"] == "скидка 25%"
    # Вторая генерация получила замечания проверяющего.
    assert "скидка 25%" in calls[2]["user"]
    assert len(calls) == 4


def test_fixed_on_second_try(monkeypatch):
    bad = {"verification": "failed", "issues": [{"claim": "исключение", "reason": "не обещаем"}]}
    result, _ = run_ask(
        monkeypatch, [gen("Сделаем исключение"), bad, gen("Передам руководителю"), {"verification": "passed", "issues": []}]
    )
    assert result["status"] == "ready" and result["attempts"] == 2 and result["reply"] == "Передам руководителю"


def test_needs_clarification_skips_verifier(monkeypatch):
    result, calls = run_ask(monkeypatch, [gen(status="needs_clarification", missing="нет условий заморозки")])
    assert result["status"] == "needs_clarification" and result["missing_information"] == "нет условий заморозки"
    assert len(calls) == 1


def test_insufficient_context_stops_without_retry(monkeypatch):
    result, calls = run_ask(
        monkeypatch, [gen("Заморозка на месяц"), {"verification": "insufficient_context", "issues": []}]
    )
    assert result["status"] == "unverified" and result["reply"] == ""
    assert len(calls) == 2
