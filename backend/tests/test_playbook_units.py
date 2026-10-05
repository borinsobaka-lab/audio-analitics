"""Скрипты администраторов: стартовый набор и правила сохранения — без базы."""
import re
import sys
import uuid
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.routers.playbook import clean_variants, default_playbook  # noqa: E402
from app.schemas import PlaybookItemIn, PlaybookSettingsIn  # noqa: E402

GEORGIAN = re.compile(r"[Ⴀ-ჿᲐ-Ჿ]")
CYRILLIC = re.compile(r"[Ѐ-ӿ]")
VARIABLE = re.compile(r"\{[^{}\s]{1,40}\}")


def all_items():
    return [item for _, _, items in default_playbook() for item in items]


def test_default_playbook_loads_through_the_api_schema():
    """Стартовый набор проходит ту же проверку, что правка из админки:
    битый файл должен падать здесь, а не у владельца при первом входе."""
    sections = default_playbook()
    assert len(sections) >= 5
    assert all(title.strip() for title, _, _ in sections)
    assert all(icon for _, icon, _ in sections), "у каждого раздела стартового набора своя иконка"
    assert len(all_items()) >= 30


def test_titles_are_unique():
    """По названию работают ссылки «…» между скриптами — дубль сделал бы
    ссылку неоднозначной."""
    titles = [item.title.lower() for item in all_items()]
    assert len(titles) == len(set(titles))


def test_references_point_to_existing_scripts():
    titles = {item.title for item in all_items()}
    for item in all_items():
        for text in (item.note, item.follow_up):
            for ref in re.findall(r"«([^«»\n]+)»", text):
                # Ёлочки бывают и в обычных цитатах; проверяем только то, что
                # похоже на название скрипта (короткое, с большой буквы).
                if len(ref) <= 40 and ref[:1].isupper():
                    assert ref in titles, f"{item.title}: ссылка на «{ref}» никуда не ведёт"


def test_texts_are_clean_for_chat():
    """В чат уходит ровно текст: без разметки документа и пометок языка."""
    for item in all_items():
        for variant in item.variants:
            for m in variant.messages:
                for text in (m.ru, m.en, m.ka):
                    for junk in ("\\!", "\\-", "**", "][image", "RU:", "EN:", "GE:", "\x0b"):
                        assert junk not in text, f"{item.title}: {junk!r} в тексте"
                assert not GEORGIAN.search(m.ru), f"{item.title}: грузинский в RU"
                assert not GEORGIAN.search(m.en), f"{item.title}: грузинский в EN"
                # {админ} — ключ переменной, а не русский текст: его заменит имя.
                en, ka = VARIABLE.sub("", m.en), VARIABLE.sub("", m.ka)
                assert not CYRILLIC.search(en), f"{item.title}: кириллица в EN"
                assert not CYRILLIC.search(ka), f"{item.title}: кириллица в GE"


def test_studio_variants_are_named():
    for item in all_items():
        if len(item.variants) > 1:
            labels = [v.label for v in item.variants]
            assert all(labels), item.title
            assert len(set(labels)) == len(labels), item.title


def _item(**fields) -> dict:
    base = {
        "section_id": str(uuid.uuid4()),
        "title": "Где мы?",
        "variants": [{"label": "", "messages": [{"ru": "Чавчавадзе 51"}]}],
    }
    base.update(fields)
    return base


def test_item_needs_some_text():
    with pytest.raises(ValidationError):
        PlaybookItemIn(**_item(variants=[{"messages": [{"ru": "  ", "en": ""}]}]))


def test_each_studio_variant_needs_text():
    with pytest.raises(ValidationError, match="Сабуртало"):
        PlaybookItemIn(
            **_item(
                variants=[
                    {"label": "Ваке", "messages": [{"ru": "Чавчавадзе 51"}]},
                    {"label": "Сабуртало", "messages": [{"ru": ""}]},
                ]
            )
        )


def test_blank_title_and_unknown_kind_rejected():
    with pytest.raises(ValidationError):
        PlaybookItemIn(**_item(title="   "))
    with pytest.raises(ValidationError):
        PlaybookItemIn(**_item(kind="sms"))


def test_clean_variants_trims_edges_and_windows_newlines():
    body = PlaybookItemIn(
        **_item(
            variants=[
                {
                    "label": " Ваке ",
                    "messages": [{"label": " Ветка ", "ru": "  Привет!\r\nКак дела?  \n"}],
                }
            ]
        )
    )
    assert clean_variants(body) == [
        {
            "label": "Ваке",
            "messages": [{"label": "Ветка", "ru": "Привет!\nКак дела?", "en": "", "ka": ""}],
        }
    ]


def test_document_names_became_admin_variable():
    """Имя автора документа в скриптах заменено на {админ}: каждый
    администратор видит в тексте своё имя, а не «Анастасия»."""
    texts = [
        t
        for item in all_items()
        for v in item.variants
        for m in v.messages
        for t in (m.ru, m.en, m.ka)
    ]
    joined = "\n".join(texts)
    assert "{админ}" in joined
    for name in ("Меня зовут Анастасия", "My name is Anastasia", "Это Мария"):
        assert name not in joined


def test_settings_reject_builtin_and_duplicate_variables():
    with pytest.raises(ValidationError, match="автоматически"):
        PlaybookSettingsIn(variables=[{"key": "админ", "ru": "x"}])
    with pytest.raises(ValidationError, match="дважды"):
        PlaybookSettingsIn(variables=[{"key": "цена", "ru": "1"}, {"key": "Цена", "ru": "2"}])
    with pytest.raises(ValidationError):
        PlaybookSettingsIn(variables=[{"key": "с пробелом", "ru": "x"}])
    ok = PlaybookSettingsIn(variables=[{"key": "цена_пробного", "ru": "14 лари", "en": "14 GEL"}])
    assert ok.variables[0].key == "цена_пробного"
