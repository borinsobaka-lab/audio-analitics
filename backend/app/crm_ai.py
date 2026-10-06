"""ИИ-разбор CRM: переписка и движение сделок за день.

Третий продукт админки. Раз в день (или по кнопке) каждая сделка, по
которой за день была переписка или движение по воронке, уходит в модель
вместе с базой знаний студии — каталогом скриптов из «Скриптов», правилами
продаж из «Аналитики» и правилами воронки из настроек CRM. Модель:

- классифицирует переписку (запись, продажа, возражение, сервис…);
- находит ошибки общения (не по скрипту, факты не из базы, нет следующего
  шага, медленный ответ) и ошибки движения сделки (не тот этап, нет задачи);
- ставит оценку по каждому критерию, который владелец завёл в настройках;
- пишет комментарий руководителю.

Здесь — только чистые функции: тексты промптов, сборка базы знаний и блока
сделки, подсчёт скорости ответа по времени сообщений (его считает код, а не
модель) и приведение ответа модели к безопасному виду. Сетью и базой занимается
pipeline/crm_tasks.py — так всё это проверяется тестами без них.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, tzinfo

# Классы переписки — набор фиксирован: по нему строится статистика, и он
# не должен «плыть» от формулировки промпта. Подписи — в админке.
CATEGORIES = (
    "booking",      # запись на пробное
    "sale",         # продажа или продление абонемента
    "objection",    # возражение, сомнения
    "question",     # вопрос клиента
    "reschedule",   # перенос или отмена
    "service",      # сервис действующего клиента
    "no_reply",     # администратор писал, клиент молчит
    "lost",         # отказ
    "spam",         # не клиент
    "other",
)
SEVERITIES = ("ok", "warning", "critical")
PROBLEM_KINDS = ("chat", "pipeline", "speed")

# Сколько сообщений до разбираемого дня показывать модели как контекст.
CONTEXT_MESSAGES = 30
CONTEXT_EVENTS = 6
# Длинное сообщение режется: модели важен смысл, а не вложенный прайс целиком.
MESSAGE_CHARS = 1500

DEFAULT_PROMPT = """Ты проверяешь, как администраторы студии растяжки Lady Stretch (Тбилиси) ведут клиентов в CRM: переписку в мессенджерах и движение сделок по воронке. Цель — вовремя заметить ошибки общения и ошибки работы со сделками, пока клиент не потерян.

Что считать правильной работой с перепиской:
- Ответ клиенту — быстро: в рабочее время (9:00–21:00) в течение 15 минут. Дольше часа — проблема; рабочий день без ответа — критично.
- Администратор отвечает по скриптам студии из базы знаний: тёплый, человеческий тон, по имени, без канцелярита. Факты — цены, условия абонементов, акции, расписание, адреса — только из базы знаний. Цена, скидка или обещание, которых в базе нет, — грубая ошибка.
- Каждый ответ ведёт клиента к следующему шагу: записаться на пробное, подтвердить время, прийти, купить абонемент. Ответ без вопроса или предложения в конце — упущенный шаг.
- Возражения («дорого», «подумаю», «далеко», «нет времени») отрабатываются по скрипту возражений, а не принимаются молча.
- Последнее слово за день — за администратором, если клиент не закрыл вопрос сам. Клиент замолчал — есть договорённость или напоминание, когда написать снова.
- Ответ на языке клиента: русский, английский или грузинский.

Что считать правильной работой со сделкой:
- Сделка стоит на этапе, который соответствует состоянию разговора (см. правила воронки). Записали на пробное — на этапе записи; клиент пришёл — отмечено; отказ — закрыта с причиной, а не висит.
- После каждого разговора в сделке есть следующий шаг: задача с датой или перевод на следующий этап.
- Сделка не брошена: нет сообщений клиента без ответа и просроченных задач.

Что НЕ считать проблемой:
- Короткие ответы действующим клиентам по сервисным вопросам (перенос, расписание) — норма, если по делу и вовремя.
- Отсутствие продажи само по себе: оценивай действия администратора, а не исход.
- Сообщение клиента в нерабочее время (после 21:00 и до 9:00): ответ утром — норма."""

DEFAULT_PIPELINE_RULES = """Этапы воронки по порядку и когда сделка должна на них стоять:
1. Новая заявка — клиент написал или оставил заявку, разговор ещё не начат.
2. В работе — администратор ответил, идёт переписка или звонок, запись ещё не назначена.
3. Записан на пробное — назначены день и время пробного; стоит задача напомнить за день и за час.
4. Пришёл на пробное — клиент был на занятии; после занятия — предложение абонемента.
5. Купил абонемент — продажа состоялась, сделка успешно закрыта.
6. Не пришёл — не явился на пробное; стоит задача перезаписать.
7. Отказ — клиент отказался; закрыта с причиной в заметке.

Правила:
- Сделка переводится на этап в тот же день, когда произошло событие.
- Сделка без ответа клиенту больше суток или без задачи на следующий шаг — ошибка.
- В «Отказ» закрывают только после отработки возражения и попытки перезаписи."""

DEFAULT_SUMMARY_PROMPT = """Итог дня читают владелец и старший администратор утром. Важны повторяющиеся ошибки — один и тот же промах в нескольких сделках или у одного администратора, — потерянные клиенты и то, что нужно обсудить с конкретным человеком сегодня. Не пересказывай каждую сделку: выделяй закономерности и называй имена."""

# Обёртка вокруг инструкций владельца: она закрепляет формат ответа, набор
# классов и правила честности, а владелец пишет только о том, что считать
# ошибкой. Литеральные фигурные скобки удвоены — шаблон собирается .format().
REVIEW_TEMPLATE = """Ты — контролёр качества работы администраторов студии растяжки. Перед тобой одна сделка из CRM и всё, что по ней происходило за {date}: переписка с клиентом и движение по воронке. Разбери работу администратора за этот день.

ИНСТРУКЦИИ ВЛАДЕЛЬЦА — что считать ошибкой и чего ждать от администратора:
{instructions}

КРИТЕРИИ ОЦЕНКИ — заданы владельцем; каждому поставь оценку или скажи, что он не применим:
{criteria}

ПРАВИЛА:
1. Опирайся только на переписку и события ниже и на базу знаний (скрипты, правила продаж, правила воронки). Не выдумывай сообщений, этапов и фактов. Нет цитаты — нет вывода.
2. category — класс переписки за день, ровно одно значение: booking (запись на пробное), sale (продажа или продление абонемента), objection (клиент возражает или сомневается), question (вопрос клиента), reschedule (перенос или отмена), service (сервис действующего клиента), no_reply (администратор писал, клиент молчит), lost (отказ клиента), spam (не клиент), other.
3. problems — существенные проблемы, 0–5 штук. У каждой: kind — chat (ошибка общения: тон, не по скрипту, факт не из базы, нет следующего шага, не ответили), pipeline (ошибка со сделкой: не тот этап, не переведена, нет задачи), speed (медленный ответ); text — что не так, одной-двумя фразами, конкретно; quote — дословная цитата из переписки, если есть, иначе пустая строка. Всё сделано как надо — пустой список.
4. severity: ok — проблем нет; warning — есть что поправить, клиент не потерян; critical — клиент потерян или может быть потерян из-за действий администратора: не ответили, грубость, обещание или цена не из базы, сделка брошена.
5. good — что администратор сделал хорошо, 0–5 пунктов, с цитатой где возможно. recommendations — что сделать по этой сделке дальше или что изменить в работе, 0–3 пункта.
6. scripts.used — названия скриптов из каталога, которыми администратор пользовался (по смыслу текста, не обязательно дословно); scripts.deviations — где отступил от скрипта или ответил не по базе: цены, условия, обещания, которых в базе знаний нет.
7. pipeline — движение сделки по правилам воронки: ok (true, если этап и задачи соответствуют состоянию разговора), expected_stage — на каком этапе сделка должна быть к концу дня, comment — одной фразой.
8. criteria — по каждому критерию из списка: id как в списке; applicable — применим ли он к этой сделке за этот день; score — ЦЕЛОЕ число от 1 до шкалы критерия (шкала — идеально); comment — одной фразой почему. Не применим — score null.
9. summary — 1–2 предложения для руководителя: что происходило со сделкой за день и главный вывод.
10. Пиши по-русски, о действиях, а не о личности.

Ответ — строго JSON без пояснений:
{{"category": "...", "severity": "ok|warning|critical", "summary": "...",
 "problems": [{{"kind": "chat|pipeline|speed", "text": "...", "quote": "..."}}],
 "good": [], "recommendations": [],
 "scripts": {{"used": [], "deviations": []}},
 "pipeline": {{"ok": true, "expected_stage": "...", "comment": "..."}},
 "criteria": [{{"id": "...", "applicable": true, "score": 7, "comment": "..."}}]}}

СДЕЛКА И ЧТО ПО НЕЙ ПРОИСХОДИЛО:
{deal}"""

SUMMARY_TEMPLATE = """Ты — руководитель отдела продаж студии растяжки. Ниже — разборы всех сделок CRM за {date}: по каждой — администратор, класс переписки, серьёзность, проблемы и оценки по критериям.

ИНСТРУКЦИИ ВЛАДЕЛЬЦА:
{instructions}

СТАТИСТИКА ДНЯ:
{stats}

РАЗБОРЫ СДЕЛОК (JSON):
{reviews}

Составь итог дня:
1. top_problems — 3–7 самых частых или критичных ошибок за день, каждая одной фразой: в чём ошибка, в скольких сделках, пример (название сделки).
2. by_manager — по каждому администратору: manager (имя как в разборах) и note — 1–3 предложения: что получалось, что систематически не так, что обсудить.
3. recommendations — 3–5 конкретных действий на завтра: кому и что.
4. highlights — 1–3 удачных момента дня.

Опирайся только на данные разборов. Ответ — строго JSON без пояснений:
{{"top_problems": [], "by_manager": [{{"manager": "", "note": ""}}], "recommendations": [], "highlights": []}}"""


# --- База знаний ------------------------------------------------------------


def build_knowledge(catalog: str, sales_rules: str, pipeline_rules: str, variables: str) -> str:
    """Общий первый блок всех запросов дня: одинаковый байт в байт, чтобы
    кэшироваться у модели. Каталог скриптов — тот же, что у ИИ-помощника."""
    parts = ["# БАЗА ЗНАНИЙ СТУДИИ — единственный источник фактов и эталон общения"]
    if sales_rules.strip():
        parts.append(f"## Правила продаж\n\n{sales_rules.strip()}")
    if pipeline_rules.strip():
        parts.append(
            "## Правила воронки CRM — этапы и когда сделка должна на них стоять\n\n"
            f"{pipeline_rules.strip()}"
        )
    if variables.strip():
        parts.append(
            "## Переменные скриптов и их текущие значения\n"
            "В скриптах пишутся в фигурных скобках; администратор отправляет клиенту уже значение.\n\n"
            f"{variables.strip()}"
        )
    parts.append(
        "## Каталог скриптов — что администратор должен писать клиенту\n\n"
        f"{catalog.strip() or '(скриптов нет)'}"
    )
    return "\n\n".join(parts)


def criteria_block(criteria: list[dict]) -> str:
    """Список критериев для промпта: id, название, шкала и что проверять."""
    if not criteria:
        return "(критериев нет — поле criteria в ответе оставь пустым списком)"
    lines = []
    for c in criteria:
        text = " ".join(str(c.get("prompt") or "").split())
        lines.append(
            f"- id={c['id']} · «{c['name']}» · шкала 1–{int(c.get('scale_max') or 10)}"
            + (f": {text}" if text else "")
        )
    return "\n".join(lines)


# --- Сделка текстом ---------------------------------------------------------


def _clip(text: str) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= MESSAGE_CHARS else text[: MESSAGE_CHARS - 1] + "…"


def _t(at: datetime, tz: tzinfo, with_date: bool) -> str:
    local = at.astimezone(tz)
    return local.strftime("%d.%m %H:%M") if with_date else local.strftime("%H:%M")


def _who(m: dict) -> str:
    if m.get("direction") == "in":
        return "Клиент"
    name = (m.get("author_name") or "").strip()
    return f"Администратор {name}" if name else "Администратор"


def render_message(m: dict, tz: tzinfo, with_date: bool) -> str:
    channel = (m.get("channel") or "").strip()
    tag = f" ({channel})" if channel else ""
    return f"[{_t(m['at'], tz, with_date)}] {_who(m)}{tag}: {_clip(m.get('text'))}"


EVENT_NAMES = {
    "stage_change": "этап",
    "status_change": "статус",
    "note": "заметка",
    "task": "задача",
    "task_done": "задача выполнена",
    "field_change": "поле",
    "call": "звонок",
}


def render_event(e: dict, tz: tzinfo, with_date: bool) -> str:
    who = (e.get("author_name") or "").strip() or "система"
    kind = e.get("kind") or ""
    label = EVENT_NAMES.get(kind, kind)
    frm, to = (e.get("from_value") or "").strip(), (e.get("to_value") or "").strip()
    text = _clip(e.get("text"))
    if kind in ("stage_change", "status_change", "field_change") and (frm or to):
        body = f"{label}: «{frm}» → «{to}»" if frm else f"{label}: «{to}»"
        if text:
            body += f" — {text}"
    else:
        body = f"{label}: {text}" if text else label
    return f"[{_t(e['at'], tz, with_date)}] {who}: {body}"


def render_deal(
    deal: dict,
    messages: list[dict],
    events: list[dict],
    day_start: datetime,
    day_end: datetime,
    tz: tzinfo,
    label: str = "",
) -> str:
    """Карточка сделки, контекст до дня и всё, что было в день разбора."""
    day_label = label or day_start.astimezone(tz).strftime("%d.%m.%Y")
    # Отчётный день, сдвинутый на вечер, захватывает две даты — тогда у
    # сообщений дня пишется и дата, иначе «21:00» и «09:00» не различить.
    spans = day_start.astimezone(tz).date() != (day_end - timedelta(seconds=1)).astimezone(tz).date()
    created = deal.get("created_at_crm")
    head = [
        f"Сделка #{deal.get('external_id', '')}: {deal.get('title') or 'без названия'}",
        f"Контакт: {deal.get('contact_name') or '—'}"
        + (f", {deal['contact_phone']}" if deal.get("contact_phone") else ""),
        f"Источник: {deal.get('source') or '—'} · Воронка: {deal.get('pipeline') or '—'}",
        f"Этап сейчас: {deal.get('stage') or '—'} · Статус: {deal.get('status') or 'open'}",
        f"Ответственный в CRM: {deal.get('manager_name') or '—'}",
        "Создана: " + (_t(created, tz, True) if created else "—")
        + (f" · Бюджет: {deal['budget']:g}" if deal.get("budget") else ""),
    ]

    before_m = [m for m in messages if m["at"] < day_start]
    day_m = [m for m in messages if day_start <= m["at"] < day_end]
    before_e = [e for e in events if e["at"] < day_start and e.get("kind") in ("stage_change", "status_change")]
    day_e = [e for e in events if day_start <= e["at"] < day_end]

    out = ["\n".join(head)]
    if before_m or before_e:
        block = [f"ДО ЭТОГО ДНЯ — контекст, последние {CONTEXT_MESSAGES} сообщений:"]
        block += [render_message(m, tz, True) for m in before_m[-CONTEXT_MESSAGES:]]
        if before_e:
            block.append("Движение по воронке до этого дня:")
            block += [render_event(e, tz, True) for e in before_e[-CONTEXT_EVENTS:]]
        out.append("\n".join(block))
    out.append(
        f"ПЕРЕПИСКА ЗА {day_label}:\n"
        + ("\n".join(render_message(m, tz, spans) for m in day_m) if day_m else "(сообщений за день не было)")
    )
    out.append(
        f"СОБЫТИЯ ПО СДЕЛКЕ ЗА {day_label} — этапы, задачи, заметки:\n"
        + ("\n".join(render_event(e, tz, spans) for e in day_e) if day_e else "(событий за день не было)")
    )
    return "\n\n".join(out)


def review_prompt(
    *, date_label: str, instructions: str, criteria: list[dict], deal_text: str
) -> str:
    return REVIEW_TEMPLATE.format(
        date=date_label,
        instructions=instructions.strip() or DEFAULT_PROMPT,
        criteria=criteria_block(criteria),
        deal=deal_text,
    )


def summary_prompt(*, date_label: str, instructions: str, stats: dict, reviews: list[dict]) -> str:
    return SUMMARY_TEMPLATE.format(
        date=date_label,
        instructions=instructions.strip() or DEFAULT_SUMMARY_PROMPT,
        stats=json.dumps(stats, ensure_ascii=False, indent=1),
        reviews=json.dumps(reviews, ensure_ascii=False, indent=1),
    )


# --- Скорость ответа: считает код, не модель --------------------------------


def reply_stats(messages: list[dict], day_start: datetime, day_end: datetime) -> dict:
    """Сколько клиент ждал ответа в этот день.

    Сообщение клиента «висит», пока после него не напишет администратор.
    first_reply_minutes — ожидание первого ответа за день, max_reply_minutes —
    самое долгое ожидание среди ответов, данных в этот день. unanswered —
    к концу дня последнее слово осталось за клиентом (в том числе если он
    написал ещё вчера, а ответа так и нет).
    """
    ordered = sorted((m for m in messages if m["at"] < day_end), key=lambda m: m["at"])
    pending: datetime | None = None
    delays: list[float] = []
    for m in ordered:
        if m.get("direction") == "in":
            if pending is None:
                pending = m["at"]
            continue
        if pending is not None:
            if m["at"] >= day_start:
                delays.append(round((m["at"] - pending).total_seconds() / 60, 1))
            pending = None
    day = [m for m in ordered if m["at"] >= day_start]
    return {
        "messages_in": sum(1 for m in day if m.get("direction") == "in"),
        "messages_out": sum(1 for m in day if m.get("direction") != "in"),
        "first_reply_minutes": delays[0] if delays else None,
        "max_reply_minutes": max(delays) if delays else None,
        "unanswered": pending is not None,
    }


def day_manager(deal: dict, day_messages: list[dict], day_events: list[dict]) -> tuple[str, str]:
    """Кто вёл сделку в этот день.

    Если за день писал или двигал сделку ровно один сотрудник — он, даже
    если ответственный в CRM другой (подменял). Иначе — ответственный по
    сделке. Возвращает (ключ, имя) как в CRM."""
    seen: dict[str, str] = {}
    for m in day_messages:
        if m.get("direction") != "in" and (m.get("author_key") or "").strip():
            seen.setdefault(m["author_key"].strip(), (m.get("author_name") or "").strip())
    for e in day_events:
        if (e.get("author_key") or "").strip():
            seen.setdefault(e["author_key"].strip(), (e.get("author_name") or "").strip())
    if len(seen) == 1:
        key, name = next(iter(seen.items()))
        return key, name or key
    return (deal.get("manager_key") or "").strip(), (deal.get("manager_name") or "").strip()


def normalize_name(name: str) -> str:
    return " ".join(str(name or "").lower().replace("ё", "е").split())


def resolve_employee(manager_key: str, manager_name: str, manager_map: dict, employees: list[dict]):
    """Сотрудник админки по менеджеру CRM: сначала явное соответствие из
    настроек, потом совпадение имени (полного или первого слова, если оно
    у одного сотрудника). employees — [{"id", "full_name"}]."""
    mapped = (manager_map or {}).get(manager_key) if manager_key else None
    if mapped:
        for e in employees:
            if str(e["id"]) == str(mapped):
                return e["id"]
    name = normalize_name(manager_name)
    if not name:
        return None
    full = {normalize_name(e["full_name"]): e["id"] for e in employees}
    if name in full:
        return full[name]
    first: dict[str, list] = {}
    for e in employees:
        parts = normalize_name(e["full_name"]).split()
        if parts:
            first.setdefault(parts[0], []).append(e["id"])
    head = name.split()[0]
    if len(first.get(head, [])) == 1:
        return first[head][0]
    return None


# --- Ответ модели → безопасный вид ----------------------------------------


def _str_list(value, limit: int = 20) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out = []
    for v in value:
        if isinstance(v, dict):
            v = v.get("text") or v.get("comment") or ""
        text = str(v or "").strip()
        if text:
            out.append(text[:1000])
    return out[:limit]


def _problems(value) -> list[dict]:
    if not isinstance(value, list):
        return []
    out = []
    for p in value:
        if isinstance(p, str):
            p = {"kind": "chat", "text": p}
        if not isinstance(p, dict):
            continue
        text = str(p.get("text") or "").strip()
        if not text:
            continue
        kind = str(p.get("kind") or "").strip().lower()
        out.append(
            {
                "kind": kind if kind in PROBLEM_KINDS else "chat",
                "text": text[:1000],
                "quote": str(p.get("quote") or "").strip()[:600],
            }
        )
    return out[:10]


def normalize_review(raw: dict, criteria: list[dict]) -> dict:
    """Привести разбор сделки к типизированному виду.

    Серьёзность выводится из списка проблем, а не берётся на веру: модель,
    написавшая critical без единой проблемы, или ok при трёх — противоречит
    сама себе, и статистика должна опираться на то, что перечислено."""
    if not isinstance(raw, dict):
        raw = {}
    category = str(raw.get("category") or "").strip().lower()
    if category not in CATEGORIES:
        category = "other"
    problems = _problems(raw.get("problems"))
    severity = str(raw.get("severity") or "").strip().lower()
    if not problems:
        severity = "ok"
    elif severity not in ("warning", "critical"):
        severity = "warning"

    scripts_raw = raw.get("scripts") if isinstance(raw.get("scripts"), dict) else {}
    pipeline_raw = raw.get("pipeline") if isinstance(raw.get("pipeline"), dict) else {}
    pipeline_ok = pipeline_raw.get("ok")
    if not isinstance(pipeline_ok, bool):
        pipeline_ok = not any(p["kind"] == "pipeline" for p in problems)

    by_id: dict[str, dict] = {}
    for item in raw.get("criteria") or []:
        if isinstance(item, dict) and item.get("id") is not None:
            by_id[str(item["id"]).strip()] = item
    scores = []
    for c in criteria:
        item = by_id.get(str(c["id"]), {})
        scale = int(c.get("scale_max") or 10)
        applicable = bool(item.get("applicable"))
        score = None
        if applicable:
            try:
                score = int(round(float(item.get("score"))))
            except (TypeError, ValueError):
                score = None
            if score is not None:
                score = min(scale, max(1, score))
        if score is None:
            applicable = False
        scores.append(
            {
                "criterion_id": c["id"],
                "applicable": applicable,
                "score": score,
                "comment": str(item.get("comment") or "").strip()[:1000] if applicable else "",
            }
        )

    return {
        "category": category,
        "severity": severity,
        "problem": bool(problems),
        "summary": str(raw.get("summary") or "").strip()[:2000],
        "problems": problems,
        "good": _str_list(raw.get("good")),
        "recommendations": _str_list(raw.get("recommendations"), 10),
        "scripts": {
            "used": _str_list(scripts_raw.get("used")),
            "deviations": _str_list(scripts_raw.get("deviations")),
        },
        "pipeline": {
            "ok": pipeline_ok,
            "expected_stage": str(pipeline_raw.get("expected_stage") or "").strip()[:200],
            "comment": str(pipeline_raw.get("comment") or "").strip()[:1000],
        },
        "scores": scores,
    }


def normalize_summary(raw) -> dict:
    if not isinstance(raw, dict):
        raw = {}
    by_manager = []
    for item in raw.get("by_manager") or []:
        if isinstance(item, dict):
            manager = str(item.get("manager") or "").strip()
            note = str(item.get("note") or "").strip()
            if manager or note:
                by_manager.append({"manager": manager[:255], "note": note[:2000]})
    return {
        "top_problems": _str_list(raw.get("top_problems"), 10),
        "by_manager": by_manager[:30],
        "recommendations": _str_list(raw.get("recommendations"), 10),
        "highlights": _str_list(raw.get("highlights"), 10),
    }


def day_stats(reviews: list[dict], criteria: list[dict]) -> dict:
    """Статистика дня, посчитанная кодом, — для итога и для карточки дня.
    reviews — нормализованные разборы с полями manager_name, category,
    severity, unanswered, first_reply_minutes и scores."""
    by_category: dict[str, int] = {}
    by_manager: dict[str, dict] = {}
    by_criterion: dict[str, list[int]] = {}
    names = {str(c["id"]): c["name"] for c in criteria}
    for r in reviews:
        by_category[r["category"]] = by_category.get(r["category"], 0) + 1
        m = by_manager.setdefault(
            r.get("manager_name") or "не указан",
            {"deals": 0, "problems": 0, "critical": 0, "unanswered": 0, "replies": []},
        )
        m["deals"] += 1
        m["problems"] += 1 if r["problem"] else 0
        m["critical"] += 1 if r["severity"] == "critical" else 0
        m["unanswered"] += 1 if r.get("unanswered") else 0
        if r.get("first_reply_minutes") is not None:
            m["replies"].append(r["first_reply_minutes"])
        for s in r.get("scores") or []:
            if s.get("applicable") and s.get("score") is not None:
                by_criterion.setdefault(str(s["criterion_id"]), []).append(int(s["score"]))
    managers = {}
    for name, m in by_manager.items():
        replies = m.pop("replies")
        m["avg_first_reply_minutes"] = round(sum(replies) / len(replies), 1) if replies else None
        managers[name] = m
    return {
        "deals": len(reviews),
        "problems": sum(1 for r in reviews if r["problem"]),
        "critical": sum(1 for r in reviews if r["severity"] == "critical"),
        "unanswered": sum(1 for r in reviews if r.get("unanswered")),
        "by_category": by_category,
        "by_manager": managers,
        "avg_by_criterion": {
            names.get(cid, cid): round(sum(v) / len(v), 1) for cid, v in by_criterion.items() if v
        },
    }


def day_bounds(day, tz: tzinfo, end_hour: int = 0) -> tuple[datetime, datetime]:
    """Границы отчётного дня в виде aware-datetime.

    end_hour = 0 — календарный день студии. Иначе отчётный день D — сутки
    до этого часа: с D−1 end_hour:00 до D end_hour:00. Так разбор в 20:00
    захватывает вечер накануне, и ни одно сообщение не выпадает между
    отчётами.
    """
    midnight = datetime(day.year, day.month, day.day, tzinfo=tz)
    if not end_hour:
        return midnight, midnight + timedelta(days=1)
    end = midnight + timedelta(hours=int(end_hour))
    return end - timedelta(days=1), end


def day_label(day, end_hour: int = 0) -> str:
    """Подпись отчётного дня для промпта: дата и, если день сдвинут, окно."""
    if not end_hour:
        return day.strftime("%d.%m.%Y")
    prev = day - timedelta(days=1)
    return f"{day.strftime('%d.%m.%Y')} (с {prev.strftime('%d.%m')} {end_hour:02d}:00 до {day.strftime('%d.%m')} {end_hour:02d}:00)"


def report_day(at: datetime, tz: tzinfo, end_hour: int = 0):
    """К какому отчётному дню относится момент: при end_hour=20 событие в
    21:00 5-го числа — это уже день 6-го."""
    local = at.astimezone(tz)
    if end_hour and local.hour >= int(end_hour):
        return (local + timedelta(days=1)).date()
    return local.date()
