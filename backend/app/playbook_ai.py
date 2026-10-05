"""ИИ-помощник скриптов (OpenAI): администратор вставляет сообщение клиента,
модель смотрит все скрипты и правила продаж и либо называет подходящие
скрипты, либо — если подходящего нет — пишет ответ сам.

Запрос собран под кэширование промпта на стороне OpenAI: сначала неизменная
часть (промпт из настроек, правила продаж, каталог скриптов), потом — то, что
меняется в каждом запросе (сообщение клиента, студия). Каталог меняется только
при правке скриптов, поэтому повторные вопросы за смену читают его из кэша —
дешевле и быстрее.
"""
from __future__ import annotations

import json
import logging
import re

import openai

from .config import get_settings

log = logging.getLogger(__name__)

DEFAULT_PROMPT = """Ты — помощник администратора студии растяжки Lady Stretch в Тбилиси. Администратор переписывается с клиентами в чате и вставляет тебе сообщение клиента. Твоя задача — помочь ответить быстро и так, чтобы клиент записался и пришёл.

Как работать:
1. Сначала ищи готовый скрипт в каталоге ниже. Если есть скрипт, который отвечает на сообщение клиента, — выбери его (до трёх, лучший первым) и коротко объясни администратору, почему он подходит и что в нём поменять под клиента, если нужно. В этом случае свой ответ не пиши — поле reply оставь пустым.
2. Только если подходящего скрипта нет — напиши ответ сам, по правилам продаж ниже:
   — тепло и по-человечески, от лица администратора, как в скриптах студии;
   — коротко: 2–5 предложений, без канцелярита;
   — ответь именно на вопрос клиента, сними сомнение, подчеркни пользу для него;
   — веди к следующему шагу: записаться на пробное, выбрать время, прийти;
   — заканчивай вопросом, на который легко ответить;
   — эмодзи — умеренно, как в скриптах студии.
3. Не придумывай цены, адреса, расписание, акции и другие факты. Бери их только из скриптов и переменных. Если факта нет — оставь место в квадратных скобках, например [время], администратор впишет сам.
4. Переменные в фигурных скобках ({админ}, {студия} и другие из списка) оставляй как есть — админка подставит значения сама.
5. Пиши на языке клиента: русский — ru, английский — en, грузинский — ka. Определи язык по сообщению клиента и укажи его в поле language.
6. В поле comment — одна-две фразы администратору по-русски: что клиент на самом деле хочет и на что обратить внимание. Это видит только администратор."""

# Ответ ИИ — строго по схеме: админка показывает найденные скрипты карточками
# и текст ответа с кнопкой «Копировать», разбирать свободный текст не нужно.
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "language": {"type": "string", "enum": ["ru", "en", "ka"]},
        "matches": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "script_id": {"type": "string"},
                    "why": {"type": "string"},
                },
                "required": ["script_id", "why"],
                "additionalProperties": False,
            },
        },
        "reply": {"type": "string"},
        "comment": {"type": "string"},
    },
    "required": ["language", "matches", "reply", "comment"],
    "additionalProperties": False,
}

KIND_NAMES = {"chat": "чат", "call": "звонок", "task": "задача", "info": "справка"}

_MARKUP = [
    (re.compile(r"\[\[([^\]\n]+?)\]\]"), r"\1"),
    (re.compile(r"\[([^\]\n]+)\]\(script:[0-9a-fA-F-]{36}\)"), r"«\1»"),
    (re.compile(r"\*\*([^*\n]+?)\*\*"), r"\1"),
    (re.compile(r"__([^_\n]+?)__"), r"\1"),
]


def strip_markup(text: str) -> str:
    for pattern, repl in _MARKUP:
        text = pattern.sub(repl, text)
    return text.strip()


class AssistError(Exception):
    """Понятная администратору причина, почему ИИ не ответил."""


def build_catalog(sections: list[dict]) -> str:
    """Каталог скриптов для ИИ — текстом, в порядке меню. Тексты — русские
    (по ним ИИ понимает смысл; на язык клиента он переведёт сам), если
    русского нет — первый заполненный. Порядок и формат стабильны: от них
    зависит попадание в кэш."""
    out: list[str] = []
    for sec in sections:
        out.append(f"## Раздел: {sec['title']}")
        for item in sec["items"]:
            out.append(f"### [id={item['id']}] {item['title']} ({KIND_NAMES.get(item['kind'], item['kind'])})")
            if item.get("note"):
                out.append(f"Как использовать: {strip_markup(item['note'])}")
            variants = item.get("variants") or []
            for v in variants:
                for i, m in enumerate(v.get("messages") or []):
                    text = next((m.get(k, "").strip() for k in ("ru", "en", "ka") if m.get(k, "").strip()), "")
                    if not text:
                        continue
                    label = " · ".join(
                        x for x in (
                            v.get("label") if len(variants) > 1 else "",
                            m.get("label") or (f"сообщение {i + 1}" if len(v.get("messages") or []) > 1 else ""),
                        ) if x
                    )
                    langs = ", ".join(k.upper() for k in ("ru", "en", "ka") if m.get(k, "").strip())
                    out.append(f"Текст{f' ({label})' if label else ''} [есть: {langs}]:\n{text}")
            if item.get("follow_up"):
                out.append(f"Дальше: {strip_markup(item['follow_up'])}")
            out.append("")
    return "\n".join(out).strip()


def build_sales_rules(script: dict | None) -> str:
    """Правила продаж — тот же скрипт продаж по этапам, по которому
    оцениваются разговоры в «Аналитике»: ИИ пишет так, как студия учит."""
    if not script:
        return ""
    parts = []
    for stage in script.get("stages") or []:
        title = stage.get("title") or stage.get("key") or ""
        desc = stage.get("description") or ""
        if title or desc:
            parts.append(f"— {title}: {desc}".strip())
    body = (script.get("body") or "").strip()
    text = "\n".join(parts)
    if body:
        text = f"{text}\n\n{body}" if text else body
    return text.strip()


_client: openai.AsyncOpenAI | None = None


def client() -> openai.AsyncOpenAI:
    global _client
    if _client is None:
        settings = get_settings()
        _client = openai.AsyncOpenAI(api_key=settings.openai_api_key, timeout=120.0)
    return _client


async def ask(
    *,
    model: str,
    prompt: str,
    catalog: str,
    sales_rules: str,
    variables: str,
    studio: str,
    lang: str,
    message: str,
) -> dict:
    settings = get_settings()
    if not settings.openai_api_key:
        raise AssistError("ИИ не настроен: на сервере не задан ключ OpenAI (OPENAI_API_KEY)")
    if not model:
        raise AssistError(
            "ИИ не настроен: не выбрана модель — укажите её в «Настройки» → «ИИ-помощник»"
        )

    fixed = [prompt]
    if sales_rules:
        fixed.append(f"# Правила продаж студии\n\n{sales_rules}")
    fixed.append(f"# Каталог скриптов\n\n{catalog}")

    volatile = "\n".join(
        x for x in (
            f"Студия, выбранная у администратора: {studio}" if studio else "",
            f"Язык, выбранный у администратора: {lang} (язык ответа определяй по сообщению клиента)",
            f"Переменные, которые подставит админка:\n{variables}" if variables else "",
            "",
            "Сообщение клиента:",
            "<client_message>",
            message.strip(),
            "</client_message>",
        ) if x is not None
    )

    try:
        completion = await client().chat.completions.create(
            model=model,
            messages=[
                # Неизменная часть — первой: OpenAI кэширует общий начальный
                # кусок запросов сам, без отдельных пометок.
                {"role": "system", "content": "\n\n".join(fixed)},
                {"role": "user", "content": volatile},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "script_assist", "strict": True, "schema": OUTPUT_SCHEMA},
            },
        )
    except openai.AuthenticationError as exc:
        raise AssistError("ИИ не отвечает: неверный ключ OpenAI на сервере") from exc
    except openai.NotFoundError as exc:
        raise AssistError(
            f"Модель «{model}» не найдена у OpenAI — проверьте название в «Настройки» → «ИИ-помощник»"
        ) from exc
    except openai.RateLimitError as exc:
        raise AssistError(
            "OpenAI ограничил запросы (лимит или закончились средства на счёте) — попробуйте позже"
        ) from exc
    except openai.BadRequestError as exc:
        log.warning("Ассистент скриптов: запрос отклонён: %s", exc.message)
        raise AssistError(f"ИИ не принял запрос: {exc.message}") from exc
    except openai.APITimeoutError as exc:
        raise AssistError("ИИ долго не отвечает — попробуйте ещё раз") from exc
    except openai.APIStatusError as exc:
        log.warning("Ассистент скриптов: ошибка API %s: %s", exc.status_code, exc.message)
        raise AssistError("ИИ временно недоступен — попробуйте ещё раз") from exc
    except openai.APIConnectionError as exc:
        raise AssistError("Нет связи с ИИ — попробуйте ещё раз") from exc

    usage = completion.usage
    details = getattr(usage, "prompt_tokens_details", None) if usage else None
    log.info(
        "Ассистент скриптов: model=%s in=%s cached=%s out=%s",
        completion.model,
        usage.prompt_tokens if usage else None,
        getattr(details, "cached_tokens", None),
        usage.completion_tokens if usage else None,
    )

    choice = completion.choices[0]
    if getattr(choice.message, "refusal", None):
        raise AssistError("ИИ отказался отвечать на это сообщение — ответьте по скриптам вручную")
    if choice.finish_reason == "length":
        raise AssistError("ИИ не уложился в ответ — попробуйте сократить сообщение")

    text = (choice.message.content or "").strip()
    try:
        data = json.loads(text)
    except ValueError as exc:
        log.warning("Ассистент скриптов: не JSON: %.300s", text)
        raise AssistError("ИИ ответил в неожиданном формате — попробуйте ещё раз") from exc
    return data
