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
