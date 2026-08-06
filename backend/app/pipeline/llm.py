"""LLM analysis on Claude. All prompts are editable: the pipeline loads the
active PromptTemplate by key from the DB and renders {{placeholders}}.

Placeholders available per prompt key:
  dialog_segmentation: {{transcript}}
  sale_analysis:       {{script}}, {{stages}}, {{dialog}}
  daily_summary:       {{analyses}}, {{stats}}
"""
import json
import re

import anthropic

from ..config import get_settings

# --- Default prompt contents (seeded into DB; editable in the dashboard) ---

DEFAULT_PROMPTS: dict[str, dict] = {
    "dialog_segmentation": {
        "name": "Этап 1 — Сегментация дня на диалоги",
        "description": (
            "Вход: транскрипт рабочего дня с таймкодами и спикерами. "
            "Выход: список отдельных взаимодействий с классификацией. "
            "Плейсхолдеры: {{transcript}}"
        ),
        "content": """Ты — аналитик продаж студии растяжки. Вход: транскрипт рабочего дня \
с таймкодами и метками спикеров (языки: русский/грузинский/английский, возможно смешение).

Раздели поток на отдельные взаимодействия (диалоги). Для каждого диалога определи тип:
- sale — состоялась продажа (клиент согласился купить/записаться, обсуждали оплату/запись)
- consultation — консультация без покупки
- refusal — клиент отказался
- service — сервисный вопрос действующего клиента (перенос, оплата, расписание)
- irrelevant — нерелевантный разговор (личный, между сотрудниками, телефон не по делу)

Правила:
- Опирайся ТОЛЬКО на текст транскрипта, ничего не выдумывай.
- Если сомневаешься между sale и consultation — ставь consultation.
- Личные разговоры сотрудников помечай irrelevant и не пересказывай их содержание в brief.

Ответ — строго JSON-массив без пояснений:
[{"start_s": число, "end_s": число, "type": "sale|consultation|refusal|service|irrelevant",
  "participants": ["speaker_0", ...], "brief": "1-2 предложения о сути"}]

Транскрипт дня:
{{transcript}}""",
    },
    "sale_analysis": {
        "name": "Этап 2 — Разбор диалога по скрипту продаж",
        "description": (
            "Оценка одного диалога по этапам скрипта с цитатами-доказательствами. "
            "Плейсхолдеры: {{script}}, {{stages}}, {{dialog}}"
        ),
        "content": """Оцени диалог менеджера студии растяжки с клиентом по скрипту продаж.

СКРИПТ ПРОДАЖ СТУДИИ:
{{script}}

ЭТАПЫ ДЛЯ ОЦЕНКИ (ключ — название):
{{stages}}

По каждому этапу верни status (done|partial|not_done), evidence (дословная цитата из
транскрипта, подтверждающая оценку) и evidence_ts (таймкод начала цитаты в секундах).

ЖЁСТКИЕ ПРАВИЛА:
- Нет цитаты-доказательства → status=not_done и evidence=null. НЕ придумывай цитаты.
- Цитата должна быть дословной подстрокой транскрипта.
- Если что-то невозможно определить — пиши "unknown", не выдумывай.

Затем определи:
- outcome: sale|consultation|refusal (sale только при явных маркерах: согласие купить,
  обсуждение оплаты, запись на занятие)
- outcome_evidence: цитата-доказательство исхода
- upsell_count: сколько раз менеджер предложил дополнительную/новую услугу
  (абонемент большего объёма, доп. занятия, сопутствующие услуги)
- manager_effectiveness: число 0..1 (доля выполненных этапов с поправкой на исход)
- deviations: список отклонений от скрипта (кратко)
- recommendations: список конкретных рекомендаций менеджеру

Ответ — строго JSON без пояснений:
{"script": {"<ключ этапа>": {"status": "...", "evidence": "...", "evidence_ts": 0}, ...},
 "outcome": "...", "outcome_evidence": "...", "upsell_count": 0,
 "manager_effectiveness": 0.0, "deviations": [], "recommendations": []}

ДИАЛОГ (с таймкодами и спикерами):
{{dialog}}""",
    },
    "daily_summary": {
        "name": "Итог дня — Сводка и рекомендации",
        "description": (
            "Reduce-этап: агрегирует разборы всех диалогов дня в общие выводы. "
            "Плейсхолдеры: {{analyses}}, {{stats}}"
        ),
        "content": """Ты — руководитель отдела продаж студии растяжки. Ниже — статистика дня
и разборы всех диалогов с клиентами за день.

СТАТИСТИКА ДНЯ:
{{stats}}

РАЗБОРЫ ДИАЛОГОВ (JSON):
{{analyses}}

Составь итог дня:
1. top_deviations — 3-5 самых частых/критичных отклонений от скрипта за день
2. recommendations — конкретные рекомендации менеджеру (что менять завтра)
3. script_suggestions — предложения по улучшению самого скрипта продаж, если разборы
   показывают систематическую проблему (иначе пустой список)
4. highlights — 1-3 удачных момента дня (что менеджер сделал хорошо)

Опирайся только на данные разборов. Ответ — строго JSON без пояснений:
{"top_deviations": [], "recommendations": [], "script_suggestions": [], "highlights": []}""",
    },
}

DEFAULT_SCRIPT_STAGES = [
    {"key": "greeting", "title": "Приветствие", "description": "Поздороваться, представиться, узнать имя клиента"},
    {"key": "needs_discovery", "title": "Выявление потребности", "description": "Узнать цель клиента: гибкость, осанка, спорт, здоровье; опыт занятий"},
    {"key": "presentation", "title": "Презентация услуги", "description": "Рассказать о студии и подходящем формате занятий под цель клиента"},
    {"key": "objection_handling", "title": "Работа с возражениями", "description": "Отработать возражения: цена, время, сомнения, 'подумаю'"},
    {"key": "closing", "title": "Закрытие", "description": "Предложить запись на пробное/первое занятие, договориться о конкретном времени"},
    {"key": "upsell", "title": "Апсейл", "description": "Предложить абонемент, дополнительные услуги или больший пакет"},
]


def render_prompt(content: str, **variables: str) -> str:
    result = content
    for key, value in variables.items():
        result = result.replace("{{" + key + "}}", str(value))
    return result


def extract_json(text: str):
    """Parse JSON from an LLM reply, tolerating markdown fences and prose."""
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Fall back to the outermost JSON value: try whichever bracket opens first,
    # so an array nested inside an object is not extracted instead of the object.
    obj_pos = text.find("{")
    arr_pos = text.find("[")
    pairs = [("{", "}"), ("[", "]")]
    if arr_pos != -1 and (obj_pos == -1 or arr_pos < obj_pos):
        pairs.reverse()
    for open_ch, close_ch in pairs:
        start = text.find(open_ch)
        end = text.rfind(close_ch)
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                continue
    raise ValueError(f"LLM reply is not valid JSON: {text[:500]}")


def parse_timestamp(value, default: float | None = None) -> float | None:
    """Coerce an LLM-supplied timestamp to seconds.

    Prompts ask for plain seconds, but models sometimes answer with
    "00:12:34", "12:34", "125s" or null. Anything unparsable yields `default`
    instead of crashing the whole day's processing.
    """
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", ".")
    if not text:
        return default
    if text.endswith("s") and text[:-1].replace(".", "", 1).isdigit():
        text = text[:-1]
    if ":" in text:
        parts = text.split(":")
        if len(parts) > 3:
            return default
        seconds = 0.0
        for part in parts:
            try:
                seconds = seconds * 60 + float(part or 0)
            except ValueError:
                return default
        return seconds
    try:
        return float(text)
    except ValueError:
        return default


def normalize_dialogs(items: list, day_duration_s: float | None = None) -> list[dict]:
    """Validate stage-1 output: coerce timestamps, drop unusable entries.

    A malformed dialog is skipped rather than aborting the day — one bad
    entry should not cost the whole report.
    """
    valid_types = {"sale", "consultation", "refusal", "service", "irrelevant"}
    result: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        start = parse_timestamp(item.get("start_s"))
        end = parse_timestamp(item.get("end_s"))
        if start is None:
            continue
        if end is None or end <= start:
            # Missing or nonsensical end: keep the dialog with a short window
            # so its turns can still be collected.
            end = start + 60.0
        if day_duration_s:
            start = max(0.0, min(start, day_duration_s))
            end = max(start, min(end, day_duration_s))
        dialog_type = str(item.get("type", "")).strip().lower()
        if dialog_type not in valid_types:
            dialog_type = "irrelevant"
        result.append(
            {
                **item,
                "start_s": start,
                "end_s": end,
                "type": dialog_type,
                "brief": str(item.get("brief", "") or ""),
            }
        )
    result.sort(key=lambda d: d["start_s"])
    return result


# Internal wrapper around an owner-defined metric prompt. The owner writes only
# the instructions (what to evaluate, the reference script, what counts as
# good); this template pins down applicability, the scale and the JSON shape.
METRIC_EVAL_TEMPLATE = """Ты — контролёр качества студии растяжки. Оцени диалог менеджера \
с клиентом по метрике «{name}».

ИНСТРУКЦИИ МЕТРИКИ (заданы владельцем студии):
{prompt}

ПРАВИЛА:
1. Сначала реши, применима ли метрика к этому диалогу (applicable). Метрика применима,
   только если в диалоге реально была ситуация, которую она оценивает. Если нет —
   applicable=false, score=null, списки пустые.
2. Если применима — поставь score: ЦЕЛОЕ число от 1 до {scale} ({scale} — идеально по инструкциям).
3. good — что менеджер сделал хорошо по этой метрике (каждый пункт с дословной цитатой).
4. bad — что сделано плохо или упущено (каждый пункт с пояснением, при возможности с цитатой).
5. comment — итог в 1–2 предложениях.
6. Опирайся ТОЛЬКО на транскрипт. Не выдумывай цитат и фактов.

Ответ — строго JSON без пояснений:
{{"applicable": true|false, "score": число|null, "good": [], "bad": [], "comment": ""}}

ДИАЛОГ (с таймкодами и спикерами):
{dialog}"""


def normalize_metric_eval(raw: dict, scale_max: int) -> dict:
    """Coerce a metric evaluation from the LLM into a safe, typed shape."""
    applicable = bool(raw.get("applicable"))

    score = None
    if applicable:
        try:
            score = int(round(float(raw.get("score"))))
        except (TypeError, ValueError):
            score = None
        if score is not None:
            score = min(scale_max, max(1, score))
    if score is None:
        applicable_score_missing = applicable
        # An "applicable" verdict without a usable score is worthless for
        # averages — treat it as not triggered rather than skewing stats.
        if applicable_score_missing:
            applicable = False

    def as_str_list(value) -> list[str]:
        if isinstance(value, list):
            return [str(v) for v in value if v][:20]
        return [str(value)] if value else []

    return {
        "applicable": applicable,
        "score": score if applicable else None,
        "good": as_str_list(raw.get("good")) if applicable else [],
        "bad": as_str_list(raw.get("bad")) if applicable else [],
        "comment": str(raw.get("comment") or "")[:2000],
    }


def normalize_analysis(analysis: dict) -> dict:
    """Validate stage-2 output: coerce numbers and per-stage evidence timestamps."""
    valid_statuses = {"done", "partial", "not_done"}
    script = {}
    for key, raw in (analysis.get("script") or {}).items():
        if not isinstance(raw, dict):
            continue
        status = str(raw.get("status", "")).strip().lower()
        script[str(key)] = {
            "status": status if status in valid_statuses else "not_done",
            "evidence": raw.get("evidence") or None,
            "evidence_ts": parse_timestamp(raw.get("evidence_ts")),
        }

    outcome = str(analysis.get("outcome", "")).strip().lower()
    if outcome not in {"sale", "consultation", "refusal"}:
        outcome = None

    try:
        upsell_count = max(0, int(float(analysis.get("upsell_count") or 0)))
    except (TypeError, ValueError):
        upsell_count = 0

    effectiveness = analysis.get("manager_effectiveness")
    try:
        effectiveness = min(1.0, max(0.0, float(effectiveness)))
    except (TypeError, ValueError):
        effectiveness = None

    def as_str_list(value) -> list[str]:
        if isinstance(value, list):
            return [str(v) for v in value if v]
        return [str(value)] if value else []

    return {
        **analysis,
        "script": script,
        "outcome": outcome,
        "upsell_count": upsell_count,
        "manager_effectiveness": effectiveness,
        "deviations": as_str_list(analysis.get("deviations")),
        "recommendations": as_str_list(analysis.get("recommendations")),
    }


class LlmClient:
    def __init__(self, api_key: str | None = None):
        settings = get_settings()
        self.settings = settings
        self.client = anthropic.Anthropic(api_key=api_key or settings.anthropic_api_key)

    def complete_json(self, prompt: str, model: str, system: str | None = None):
        """One request → parsed JSON.

        Deliberately passes no sampling parameters: `temperature`, `top_p` and
        `top_k` are rejected with a 400 by current Claude models (Sonnet 5,
        Opus 5 and newer). Determinism is steered by the prompts themselves
        ("строго JSON без пояснений") plus extract_json() below.

        Streaming is used because these models think before answering: a long
        day transcript can keep the connection open past the non-streaming
        request limit.
        """
        with self.client.messages.stream(
            model=model,
            max_tokens=self.settings.llm_max_tokens,
            system=system or anthropic.NOT_GIVEN,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            message = stream.get_final_message()

        text = "".join(block.text for block in message.content if block.type == "text")
        if not text.strip():
            # With thinking enabled by default, max_tokens caps thinking and
            # the answer together — an exhausted budget yields no text at all.
            raise ValueError(
                f"модель {model} не вернула текст (stop_reason={message.stop_reason}); "
                "увеличьте LLM_MAX_TOKENS"
            )
        return extract_json(text)

    def segment_dialogs(
        self,
        transcript: str,
        prompt_content: str,
        model: str,
        day_duration_s: float | None = None,
    ) -> list[dict]:
        prompt = render_prompt(prompt_content, transcript=transcript)
        result = self.complete_json(prompt, model)
        # Tolerate a model that wraps the array in an object.
        if isinstance(result, dict):
            for key in ("dialogs", "interactions", "items", "result"):
                if isinstance(result.get(key), list):
                    result = result[key]
                    break
        if not isinstance(result, list):
            raise ValueError("dialog_segmentation prompt must return a JSON array")
        return normalize_dialogs(result, day_duration_s)

    def analyze_dialog(
        self,
        dialog_text: str,
        script_body: str,
        stages: list[dict],
        prompt_content: str,
        model: str,
    ) -> dict:
        stages_text = "\n".join(
            f"- {s['key']} — {s.get('title', s['key'])}: {s.get('description', '')}"
            for s in stages
        )
        prompt = render_prompt(
            prompt_content, script=script_body, stages=stages_text, dialog=dialog_text
        )
        result = self.complete_json(prompt, model)
        if not isinstance(result, dict):
            raise ValueError("sale_analysis prompt must return a JSON object")
        return normalize_analysis(result)

    def evaluate_metric(
        self, dialog_text: str, metric_name: str, metric_prompt: str,
        scale_max: int, model: str,
    ) -> dict:
        prompt = METRIC_EVAL_TEMPLATE.format(
            name=metric_name, prompt=metric_prompt, scale=scale_max, dialog=dialog_text
        )
        result = self.complete_json(prompt, model)
        if not isinstance(result, dict):
            raise ValueError("metric evaluation must return a JSON object")
        return normalize_metric_eval(result, scale_max)

    def summarize_day(
        self, analyses: list[dict], stats: dict, prompt_content: str, model: str
    ) -> dict:
        prompt = render_prompt(
            prompt_content,
            analyses=json.dumps(analyses, ensure_ascii=False, indent=1),
            stats=json.dumps(stats, ensure_ascii=False, indent=1),
        )
        result = self.complete_json(prompt, model)
        if not isinstance(result, dict):
            raise ValueError("daily_summary prompt must return a JSON object")
        return result
