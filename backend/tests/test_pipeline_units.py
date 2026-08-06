"""Unit tests for pure pipeline logic (no network, no DB)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from app.pipeline.audio_prep import map_to_original_ts
from app.pipeline.asr import Word
from app.pipeline.llm import extract_json, render_prompt
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
