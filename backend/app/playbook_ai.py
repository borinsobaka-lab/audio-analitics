"""ИИ-помощник скриптов (OpenAI) с двойной проверкой.

Сотрудник вставляет сообщение клиента. Дальше:

1. Генератор видит всю базу — каталог скриптов, правила продаж, переменные
   с их значениями (цены, ссылки — структурированные данные из «Подстановки»)
   — и либо называет подходящие скрипты, либо пишет ответ, либо честно
   говорит, каких данных не хватает.
2. Если ответ написан — отдельный вызов-проверяющий сверяет каждое
   фактическое утверждение (цены, скидки, сроки, условия, обещания) с той же
   базой. Проверяющий ответ не пишет — только находит неподтверждённое.
3. Не прошёл — генератор переписывает с учётом замечаний, проверка ещё раз.
   Не больше двух генераций.
4. Fail closed: ответ, который проверку так и не прошёл, сотруднику не
   показывается — вместо него «недостаточно информации» и что не так.

База целиком, а не поиском по кускам (File Search): скриптов десятки,
это ~10 тыс. токенов — модель видит всё и не пропускает правило, которое
поиск мог бы не найти; и ничего не надо синхронизировать при правке. Тексты
базы идут первым сообщением, одинаковым у генератора и проверяющего, —
OpenAI кэширует общий начальный кусок запросов сам: дешевле и быстрее.
"""
from __future__ import annotations

import json
import logging
import re

import openai

from .config import get_settings

log = logging.getLogger(__name__)

MAX_GENERATIONS = 2

DEFAULT_PROMPT = """Ты — ИИ-помощник администратора студии растяжки Lady Stretch в Тбилиси. Администратор переписывается с клиентами и вставляет тебе сообщение клиента. Помоги ответить быстро и так, чтобы клиент записался и пришёл.

КРИТИЧЕСКОЕ ПРАВИЛО: все фактические утверждения — только из базы знаний выше (каталог скриптов, правила продаж, переменные). К фактам относятся: цены, скидки, проценты, сроки, даты, количество занятий, условия абонементов, акции, продление, заморозка, возвраты, расписание, адреса, услуги, исключения и любые обещания клиенту.

Тебе запрещено:
— додумывать отсутствующую информацию и использовать общие знания;
— предполагать правила студии или вычислять условия, если формула не указана явно;
— переносить правило из похожей ситуации на другую без прямого подтверждения.

Как работать:
1. Определи, что на самом деле хочет клиент.
2. Если в каталоге есть скрипт, который отвечает на сообщение, — выбери его (до трёх, лучший первым) в matches и коротко объясни администратору, почему он подходит. Свой ответ тогда не пиши: reply — пустая строка.
3. Если подходящего скрипта нет, но фактов в базе достаточно — напиши ответ в reply: тепло, по-человечески, от лица администратора, как в скриптах студии; коротко, 2–5 предложений, без канцелярита; ответь на вопрос, сними сомнение, веди к записи или визиту; закончи лёгким вопросом; эмодзи — не больше 1–2. В used_sources перечисли id скриптов, на которые опираешься, и «sales_rules» / «variables», если брал оттуда.
4. Если фактов не хватает для уверенного ответа — не придумывай: status = "needs_clarification", reply пустой, в missing_information — каких данных нет в базе. Место, которое администратор может заполнить сам (например, удобное клиенту время), можно оставить в квадратных скобках: [время].
5. Переменные в фигурных скобках ({админ}, {студия} и другие из списка) оставляй как есть — админка подставит значения сама.
6. Пиши на языке клиента: ru, en или ka — укажи его в language.
7. В comment — одна-две фразы администратору по-русски: что хочет клиент и на что обратить внимание."""

DEFAULT_VERIFY_PROMPT = """Ты — контролёр качества. Ты НЕ пишешь ответ клиенту.

Твоя единственная задача — проверить, подтверждается ли подготовленный ответ базой знаний выше (каталог скриптов, правила продаж, переменные со значениями).

Для КАЖДОГО фактического утверждения в ответе должно быть прямое подтверждение в базе. Особенно строго проверяй: цены, скидки, проценты, сроки, даты, количество занятий, условия акций, продление, заморозку, возвраты, расписание, адреса и любые обещания клиенту.

Запрещено считать утверждение верным только потому, что оно выглядит логичным или вероятным.

Не считай фактами и не отклоняй:
— переменные в фигурных скобках ({админ}, {студия}, {цена_пробного} и т. п.) — их значения подставит админка;
— места в квадратных скобках ([время], [день]) — их заполнит администратор;
— вежливые фразы, приглашение записаться, вопросы клиенту без новых фактов.

Решение:
— хотя бы одно существенное утверждение не подтверждено базой или противоречит ей → verification = "failed", и в issues — каждое такое утверждение (claim) и почему (reason);
— для проверки не хватает данных → verification = "insufficient_context";
— все существенные факты подтверждены → verification = "passed", issues — пустой список.

Пиши claim и reason по-русски."""

# Ответы — строго по схемам: админка показывает найденные скрипты карточками,
# а текст ответа — только после проверки.
GENERATOR_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["ready", "needs_clarification"]},
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
        "used_sources": {"type": "array", "items": {"type": "string"}},
        "missing_information": {"type": "string"},
        "comment": {"type": "string"},
    },
    "required": [
        "status", "language", "matches", "reply", "used_sources", "missing_information", "comment",
    ],
    "additionalProperties": False,
}

VERIFIER_SCHEMA = {
    "type": "object",
    "properties": {
        "verification": {"type": "string", "enum": ["passed", "failed", "insufficient_context"]},
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "claim": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["claim", "reason"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["verification", "issues"],
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


async def call(model: str, knowledge: str, instructions: str, user: str, schema: dict, name: str) -> dict:
    """Один вызов модели со строгим JSON по схеме."""
    try:
        completion = await client().chat.completions.create(
            model=model,
            messages=[
                # База — первым сообщением, одинаковым у генератора и
                # проверяющего: общий начальный кусок кэшируется.
                {"role": "system", "content": knowledge},
                {"role": "system", "content": instructions},
                {"role": "user", "content": user},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {"name": name, "strict": True, "schema": schema},
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
        log.warning("Ассистент скриптов (%s): запрос отклонён: %s", name, exc.message)
        raise AssistError(f"ИИ не принял запрос: {exc.message}") from exc
    except openai.APITimeoutError as exc:
        raise AssistError("ИИ долго не отвечает — попробуйте ещё раз") from exc
    except openai.APIStatusError as exc:
        log.warning("Ассистент скриптов (%s): ошибка API %s: %s", name, exc.status_code, exc.message)
        raise AssistError("ИИ временно недоступен — попробуйте ещё раз") from exc
    except openai.APIConnectionError as exc:
        raise AssistError("Нет связи с ИИ — попробуйте ещё раз") from exc

    usage = completion.usage
    details = getattr(usage, "prompt_tokens_details", None) if usage else None
    log.info(
        "Ассистент скриптов (%s): model=%s in=%s cached=%s out=%s",
        name,
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
        return json.loads(text)
    except ValueError as exc:
        log.warning("Ассистент скриптов (%s): не JSON: %.300s", name, text)
        raise AssistError("ИИ ответил в неожиданном формате — попробуйте ещё раз") from exc


def build_knowledge(catalog: str, sales_rules: str, variables: str) -> str:
    parts = ["# БАЗА ЗНАНИЙ СТУДИИ — единственный источник фактов"]
    if sales_rules:
        parts.append(f"## Правила продаж (id источника: sales_rules)\n\n{sales_rules}")
    if variables:
        parts.append(
            "## Переменные и их текущие значения (id источника: variables)\n"
            "В ответе пишутся в фигурных скобках — админка подставит значение.\n\n"
            f"{variables}"
        )
    parts.append(f"## Каталог скриптов (id источника — id скрипта)\n\n{catalog}")
    return "\n\n".join(parts)


def client_block(message: str, studio: str, lang: str) -> str:
    return "\n".join(
        x for x in (
            f"Студия, выбранная у администратора: {studio}" if studio else "",
            f"Язык, выбранный у администратора: {lang} (язык ответа определяй по сообщению клиента)",
            "",
            "Сообщение клиента:",
            "<client_message>",
            message.strip(),
            "</client_message>",
        ) if x is not None
    )


def clean_issues(raw) -> list[dict]:
    out = []
    for i in raw or []:
        claim = str(i.get("claim", "")).strip()
        reason = str(i.get("reason", "")).strip()
        if claim or reason:
            out.append({"claim": claim, "reason": reason})
    return out


async def ask(
    *,
    model: str,
    prompt: str,
    verify_prompt: str,
    catalog: str,
    sales_rules: str,
    variables: str,
    studio: str,
    lang: str,
    message: str,
) -> dict:
    """Генерация → проверка → (при замечаниях) ещё одна генерация и проверка.

    Возвращает status:
      ready — ответ проверен (или найдены только скрипты — их тексты и есть база);
      needs_clarification — в базе нет данных для ответа (missing_information);
      unverified — ответ так и не прошёл проверку и не показывается (issues).
    """
    settings = get_settings()
    if not settings.openai_api_key:
        raise AssistError("ИИ не настроен: на сервере не задан ключ OpenAI (OPENAI_API_KEY)")
    if not model:
        raise AssistError(
            "ИИ не настроен: не выбрана модель — укажите её в «Настройки» → «ИИ-помощник»"
        )

    knowledge = build_knowledge(catalog, sales_rules, variables)
    request = client_block(message, studio, lang)

    issues: list[dict] = []
    verification = ""
    gen: dict = {}
    for attempt in range(1, MAX_GENERATIONS + 1):
        user = request
        if attempt > 1:
            user += (
                "\n\nПредыдущий ответ отклонён проверкой. Замечания:\n"
                + "\n".join(f"— {i['claim']}: {i['reason']}" for i in issues)
                + "\nПерепиши ответ, используя только подтверждённые базой факты. "
                "Если без этих фактов ответить нельзя — верни status = \"needs_clarification\"."
            )
        gen = await call(model, knowledge, prompt, user, GENERATOR_SCHEMA, "script_assist")
        reply = str(gen.get("reply") or "").strip()

        if gen.get("status") == "needs_clarification" or not reply:
            # Нечего проверять: либо только найденные скрипты (это сама база),
            # либо честное «данных нет».
            status = "needs_clarification" if gen.get("status") == "needs_clarification" else "ready"
            return {**gen, "status": status, "reply": "", "verified": False, "attempts": attempt, "issues": []}

        check = await call(
            model,
            knowledge,
            verify_prompt,
            f"{request}\n\nПодготовленный ответ клиенту:\n<answer>\n{reply}\n</answer>",
            VERIFIER_SCHEMA,
            "script_verify",
        )
        verification = check.get("verification", "")
        issues = clean_issues(check.get("issues"))
        log.info("Ассистент скриптов: попытка %s, проверка: %s, замечаний: %s", attempt, verification, len(issues))
        if verification == "passed":
            return {**gen, "status": "ready", "reply": reply, "verified": True, "attempts": attempt, "issues": []}
        if verification == "insufficient_context":
            break

    # Fail closed: непроверенный ответ сотруднику не отдаём.
    return {
        **gen,
        "status": "unverified",
        "reply": "",
        "verified": False,
        "attempts": attempt,
        "issues": issues
        or [{"claim": "", "reason": "Проверка не подтвердила ответ базой знаний"}],
        "missing_information": gen.get("missing_information") or (
            "В базе не хватает данных, чтобы проверить ответ" if verification == "insufficient_context" else ""
        ),
    }
