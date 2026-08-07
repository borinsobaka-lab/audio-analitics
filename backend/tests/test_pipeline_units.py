"""Unit tests for pure pipeline logic (no network, no DB)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from app.pipeline.audio_prep import map_to_original_ts
from app.pipeline.asr import Word
from app.pipeline.llm import (
    LlmClient,
    LlmUsage,
    extract_json,
    normalize_analysis,
    normalize_dialogs,
    normalize_metric_eval,
    parse_timestamp,
    render_prompt,
)
from app.pipeline.segmentation import (
    format_ts,
    group_conversations,
    render_transcript,
    words_to_turns,
)


# --- timeline mapping ---

def make_timeline():
    # Two speech regions: 10–20s and 100–130s of the original recording.
    return [
        {"concat_start": 0.0, "orig_start": 10.0, "duration": 10.0},
        {"concat_start": 10.0, "orig_start": 100.0, "duration": 30.0},
    ]


def test_map_inside_first_region():
    assert map_to_original_ts(5.0, make_timeline()) == pytest.approx(15.0)


def test_map_inside_second_region():
    assert map_to_original_ts(25.0, make_timeline()) == pytest.approx(115.0)


def test_map_at_boundary():
    assert map_to_original_ts(10.0, make_timeline()) == pytest.approx(100.0, abs=0.01)


def test_map_past_end_clamps():
    assert map_to_original_ts(999.0, make_timeline()) == pytest.approx(130.0)


# --- turns & conversations ---

def make_words():
    return [
        Word("Здравствуйте", 0.0, 0.5, "speaker_0"),
        Word("хочу", 0.7, 0.9, "speaker_0"),
        Word("записаться", 1.0, 1.6, "speaker_0"),
        Word("Конечно", 2.0, 2.4, "speaker_1"),
        # long gap → new conversation
        Word("Добрый", 120.0, 120.4, "speaker_0"),
        Word("день", 120.5, 120.8, "speaker_0"),
    ]


def test_words_to_turns_groups_same_speaker():
    turns = words_to_turns(make_words())
    assert len(turns) == 3
    assert turns[0].text == "Здравствуйте хочу записаться"
    assert turns[1].speaker == "speaker_1"


def test_group_conversations_splits_on_gap():
    turns = words_to_turns(make_words())
    convs = group_conversations(turns, gap_s=30.0)
    assert len(convs) == 2
    assert len(convs[0].turns) == 2
    assert convs[1].start == pytest.approx(120.0)


def test_render_transcript_format():
    turns = words_to_turns(make_words())
    text = render_transcript(turns)
    assert "[00:00:00] speaker_0: Здравствуйте хочу записаться" in text
    assert "[00:02:00] speaker_0: Добрый день" in text


def test_format_ts():
    assert format_ts(3661.5) == "01:01:01"


# --- LLM helpers ---

def test_render_prompt_replaces_placeholders():
    result = render_prompt("A {{x}} B {{y}}", x="1", y="2")
    assert result == "A 1 B 2"


def test_extract_json_plain():
    assert extract_json('{"a": 1}') == {"a": 1}


def test_extract_json_fenced():
    assert extract_json('Вот ответ:\n```json\n[{"a": 1}]\n```') == [{"a": 1}]


def test_extract_json_with_prose():
    assert extract_json('Результат: {"a": [1, 2]} — готово') == {"a": [1, 2]}


def test_extract_json_invalid_raises():
    with pytest.raises(ValueError):
        extract_json("не json вообще")


# --- timestamp coercion (LLM output is not trustworthy) ---

@pytest.mark.parametrize(
    "value,expected",
    [
        (123, 123.0),
        (12.5, 12.5),
        ("125", 125.0),
        ("125.5", 125.5),
        ("125,5", 125.5),
        ("125s", 125.0),
        ("02:05", 125.0),
        ("00:12:34", 754.0),
        ("1:00:00", 3600.0),
    ],
)
def test_parse_timestamp_accepts_common_formats(value, expected):
    assert parse_timestamp(value) == pytest.approx(expected)


@pytest.mark.parametrize("value", [None, "", "скоро", "1:2:3:4", {}])
def test_parse_timestamp_returns_default_on_garbage(value):
    assert parse_timestamp(value) is None
    assert parse_timestamp(value, default=0.0) == 0.0


# --- stage-1 normalization ---

def test_normalize_dialogs_coerces_and_sorts():
    raw = [
        {"start_s": "00:02:00", "end_s": "00:03:00", "type": "SALE", "brief": "b"},
        {"start_s": 10, "end_s": 20, "type": "consultation"},
    ]
    result = normalize_dialogs(raw)
    assert [d["start_s"] for d in result] == [10.0, 120.0]
    assert result[1]["type"] == "sale"
    assert result[1]["end_s"] == 180.0


def test_normalize_dialogs_skips_unusable_entries():
    raw = [{"end_s": 20, "type": "sale"}, "не объект", {"start_s": 5, "type": "sale"}]
    result = normalize_dialogs(raw)
    assert len(result) == 1
    assert result[0]["start_s"] == 5.0
    assert result[0]["end_s"] == 65.0  # missing end gets a 60s window


def test_normalize_dialogs_clamps_to_recording_length():
    result = normalize_dialogs([{"start_s": 50, "end_s": 9999, "type": "sale"}], 100.0)
    assert result[0]["end_s"] == 100.0


def test_normalize_dialogs_unknown_type_becomes_irrelevant():
    result = normalize_dialogs([{"start_s": 1, "end_s": 2, "type": "продажа"}])
    assert result[0]["type"] == "irrelevant"


# --- stage-2 normalization ---

def test_normalize_analysis_coerces_fields():
    raw = {
        "script": {
            "greeting": {"status": "done", "evidence": "Здравствуйте", "evidence_ts": "00:00:05"},
            "closing": {"status": "выполнен", "evidence": None},
        },
        "outcome": "Sale",
        "upsell_count": "2",
        "manager_effectiveness": "0.8",
        "deviations": "не отработал цену",
        "recommendations": None,
    }
    result = normalize_analysis(raw)
    assert result["script"]["greeting"]["evidence_ts"] == 5.0
    assert result["script"]["closing"]["status"] == "not_done"
    assert result["outcome"] == "sale"
    assert result["upsell_count"] == 2
    assert result["manager_effectiveness"] == pytest.approx(0.8)
    assert result["deviations"] == ["не отработал цену"]
    assert result["recommendations"] == []


def test_normalize_analysis_clamps_effectiveness_and_bad_outcome():
    result = normalize_analysis({"manager_effectiveness": 7, "outcome": "продажа"})
    assert result["manager_effectiveness"] == 1.0
    assert result["outcome"] is None
    assert result["upsell_count"] == 0


# --- metric evaluation normalization ---

def test_metric_eval_applicable_with_score():
    result = normalize_metric_eval(
        {"applicable": True, "score": "7", "good": ["a"], "bad": ["b"], "comment": "ok"},
        10,
    )
    assert result == {
        "applicable": True, "score": 7, "good": ["a"], "bad": ["b"], "comment": "ok"
    }


def test_metric_eval_score_clamped_to_scale():
    assert normalize_metric_eval({"applicable": True, "score": 12}, 10)["score"] == 10
    assert normalize_metric_eval({"applicable": True, "score": 0}, 5)["score"] == 1


def test_metric_eval_not_applicable_clears_everything():
    result = normalize_metric_eval(
        {"applicable": False, "score": 5, "good": ["x"], "bad": ["y"]}, 10
    )
    assert result["applicable"] is False
    assert result["score"] is None
    assert result["good"] == [] and result["bad"] == []


def test_metric_eval_applicable_without_score_becomes_not_triggered():
    result = normalize_metric_eval({"applicable": True, "score": "не знаю"}, 10)
    assert result["applicable"] is False
    assert result["score"] is None


# --- LLM request shape ---

class _FakeBlock:
    def __init__(self, text):
        self.type = "text"
        self.text = text


class _FakeUsage:
    def __init__(self, inp, out):
        self.input_tokens = inp
        self.output_tokens = out


class _FakeMessage:
    def __init__(self, text, stop_reason="end_turn", usage=(100, 20)):
        self.content = [_FakeBlock(text)] if text else []
        self.stop_reason = stop_reason
        self.usage = _FakeUsage(*usage)


class _FakeStream:
    def __init__(self, message):
        self._message = message

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        return self._message


class _FakeMessages:
    def __init__(self, message):
        self._message = message
        self.calls = []

    def stream(self, **kwargs):
        self.calls.append(kwargs)
        return _FakeStream(self._message)


def make_llm(text, stop_reason="end_turn"):
    """An LlmClient whose Anthropic client is replaced by a recording fake."""
    client = LlmClient.__new__(LlmClient)
    client.settings = type("S", (), {"llm_max_tokens": 16000})()
    client.usage = LlmUsage()
    client.client = type("C", (), {})()
    client.client.messages = _FakeMessages(_FakeMessage(text, stop_reason))
    return client


def test_complete_json_sends_no_sampling_params():
    # Current Claude models reject temperature/top_p/top_k with a 400 — this
    # test is the guard against reintroducing them.
    llm = make_llm('{"ok": true}')
    assert llm.complete_json("prompt", "claude-sonnet-5") == {"ok": True}
    call = llm.client.messages.calls[0]
    assert "temperature" not in call
    assert "top_p" not in call and "top_k" not in call
    assert call["model"] == "claude-sonnet-5"
    assert call["max_tokens"] == 16000


def test_complete_json_reports_empty_answer_clearly():
    # Thinking and the answer share max_tokens: an exhausted budget yields no
    # text, which must not surface as an opaque JSON parse error.
    llm = make_llm("", stop_reason="max_tokens")
    with pytest.raises(ValueError, match="LLM_MAX_TOKENS"):
        llm.complete_json("prompt", "claude-sonnet-5")


# --- стоимость обработки ---

from app.pipeline.cost import compute_cost  # noqa: E402


def test_cost_splits_asr_and_llm():
    # час распознавания по $0.40 + 1M входных по $3 + 0.5M выходных по $15
    cost = compute_cost(3600, 1_000_000, 500_000, 0.40, 3.00, 15.00)
    assert cost.asr_usd == pytest.approx(0.40)
    assert cost.llm_usd == pytest.approx(3.00 + 7.50)
    assert cost.total_usd == pytest.approx(10.90)


def test_cost_handles_missing_usage():
    # смена без речи: ASR не вызывался, модель не вызывалась
    cost = compute_cost(None, 0, 0, 0.40, 3.00, 15.00)
    assert cost.total_usd == 0.0


def test_cost_keeps_sub_cent_precision():
    # разбор одной смены дешевле цента — округление до копеек обнулило бы всё
    cost = compute_cost(60, 1000, 500, 0.40, 3.00, 15.00)
    assert cost.total_usd > 0


# --- сводная статистика ---

from app.routers.analytics import ScoreGroup, ShiftRow, totals_of  # noqa: E402


def make_shift(dialogs, sales, day="2026-08-05", cost=0.1):
    from datetime import date as _date

    y, m, d = (int(x) for x in day.split("-"))
    return ShiftRow(
        date=_date(y, m, d),
        employee_id=None,
        dialogs=dialogs,
        sales=sales,
        speech_seconds=600.0,
        cost_usd=cost,
    )


def test_totals_conversion_is_weighted_not_averaged():
    # день с одним разговором и продажей (100%) и день с двадцатью и двумя (10%):
    # среднее дневных дало бы 55%, правильный ответ — 3 из 21
    shifts = [make_shift(1, 1), make_shift(20, 2)]
    totals = totals_of(shifts)
    assert totals.dialogs == 21
    assert totals.sales == 3
    assert totals.conversion == pytest.approx(round(3 / 21, 3))


def test_totals_without_dialogs_has_no_conversion():
    assert totals_of([make_shift(0, 0)]).conversion is None
    assert totals_of([]).shifts == 0


def test_score_group_averages_by_weight():
    # 3 оценки в сумме 24 (среднее 8) и 1 оценка 4 → 28/4 = 7, а не (8+4)/2 = 6
    group = ScoreGroup()
    group.add(24.0, 3)
    group.add(4.0, 1)
    assert group.avg == pytest.approx(7.0)


def test_score_group_empty_has_no_average():
    assert ScoreGroup().avg is None


def test_complete_json_accumulates_usage_across_calls():
    # стоимость смены складывается из всех вызовов, а не только последнего
    llm = make_llm('{"ok": true}')
    llm.complete_json("prompt", "claude-sonnet-5")
    llm.complete_json("prompt", "claude-sonnet-5")
    assert llm.usage.calls == 2
    assert llm.usage.input_tokens == 200
    assert llm.usage.output_tokens == 40
