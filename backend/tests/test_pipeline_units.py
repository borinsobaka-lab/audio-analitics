"""Unit tests for pure pipeline logic (no network, no DB)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from app.pipeline.audio_prep import map_to_original_ts
from app.pipeline.asr import Word
from app.pipeline.llm import (
    extract_json,
    normalize_analysis,
    normalize_dialogs,
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
