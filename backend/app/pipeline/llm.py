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


class LlmClient:
    def __init__(self, api_key: str | None = None):
        settings = get_settings()
        self.settings = settings
        self.client = anthropic.Anthropic(api_key=api_key or settings.anthropic_api_key)

    def complete_json(self, prompt: str, model: str, system: str | None = None):
        message = self.client.messages.create(
            model=model,
            max_tokens=self.settings.llm_max_tokens,
            temperature=0.0,
            system=system or anthropic.NOT_GIVEN,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(block.text for block in message.content if block.type == "text")
        return extract_json(text)

    def segment_dialogs(self, transcript: str, prompt_content: str, model: str) -> list[dict]:
        prompt = render_prompt(prompt_content, transcript=transcript)
        result = self.complete_json(prompt, model)
        if not isinstance(result, list):
            raise ValueError("dialog_segmentation prompt must return a JSON array")
        return result

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
        return result

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
