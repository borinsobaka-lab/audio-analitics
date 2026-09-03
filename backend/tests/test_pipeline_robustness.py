"""Тесты устойчивости пайплайна на длинной смене: точность таймкодов при
вырезании речи, разбиение дня на блоки, повтор при плохом ответе модели."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pytest
import soundfile as sf

from app.pipeline.audio_prep import TimelineMapper, cut_speech_only
from app.pipeline.llm import LlmClient, LlmUsage
from app.pipeline.segmentation import Turn, render_transcript, split_into_blocks
from app.pipeline.vad import WINDOW, iter_frames, regions_from_probs
from tests.test_pipeline_units import _FakeMessage, _FakeStream


# --- вырезание речи: длина файла равна сумме длительностей карты ---

def test_cut_speech_only_is_sample_exact(tmp_path):
    sr = 16000
    audio = np.zeros(sr * 60, dtype=np.float32)
    # Границы регионов не кратны ни кадру ffmpeg, ни секунде.
    regions = [(1.2345, 3.4567), (10.0001, 10.9999), (40.5, 59.99)]
    for s, e in regions:
        audio[int(s * sr) : int(e * sr)] = 0.5
    src = tmp_path / "day.wav"
    sf.write(src, audio, sr, subtype="PCM_16")

    out = tmp_path / "speech.wav"
    timeline = cut_speech_only(str(src), regions, str(out))

    info = sf.info(str(out))
    assumed = sum(entry["duration"] for entry in timeline)
    assert info.frames / sr == pytest.approx(assumed, abs=1e-9)
    # Ошибка на регион не накапливается: карта построена по реальным сэмплам.
    for (s, e), entry in zip(regions, timeline):
        assert entry["orig_start"] == pytest.approx(s, abs=1 / sr)
        assert entry["duration"] == pytest.approx(e - s, abs=1 / sr)


def test_cut_speech_only_clamps_regions_to_file(tmp_path):
    sr = 16000
    sf.write(tmp_path / "d.wav", np.zeros(sr * 2, dtype=np.float32), sr, subtype="PCM_16")
    timeline = cut_speech_only(
        str(tmp_path / "d.wav"), [(-0.5, 0.5), (1.5, 5.0)], str(tmp_path / "s.wav")
    )
    assert timeline[0]["orig_start"] == 0.0
    assert timeline[-1]["orig_start"] + timeline[-1]["duration"] == pytest.approx(2.0)


# --- обратный маппинг: бинарный поиск даёт те же ответы, что линейный ---

def test_timeline_mapper_matches_naive_scan():
    timeline = []
    offset = 0.0
    for i in range(500):
        duration = 1.0 + (i % 7) * 0.371
        timeline.append(
            {"concat_start": offset, "orig_start": i * 20.0, "duration": duration}
        )
        offset += duration
    mapper = TimelineMapper(timeline)

    def naive(ts):
        for entry in timeline:
            if entry["concat_start"] <= ts < entry["concat_start"] + entry["duration"]:
                return entry["orig_start"] + (ts - entry["concat_start"])
        last = timeline[-1]
        return last["orig_start"] + last["duration"]

    for ts in np.linspace(0, offset + 5, 4000):
        assert mapper.to_original(float(ts)) == pytest.approx(naive(float(ts)), abs=1e-9)


def test_timeline_mapper_boundary_belongs_to_next_region():
    mapper = TimelineMapper(
        [
            {"concat_start": 0.0, "orig_start": 10.0, "duration": 10.0},
            {"concat_start": 10.0, "orig_start": 100.0, "duration": 30.0},
        ]
    )
    assert mapper.to_original(10.0) == pytest.approx(100.0)
    assert mapper.to_original(-1.0) == pytest.approx(10.0)


# --- VAD: регионы из вероятностей ---

def test_regions_from_probs_merges_and_pads():
    frame_s = 512 / 16000
    probs = [0.0] * 10 + [0.9] * 40 + [0.0] * 10 + [0.9] * 40 + [0.0] * 100
    regions = regions_from_probs(
        iter(probs), threshold=0.5, min_speech_ms=250, min_silence_ms=500, pad_ms=200
    )
    # Пауза в 10 кадров (320 мс) короче min_silence — регионы сливаются в один.
    assert len(regions) == 1
    start, end = regions[0]
    assert start == pytest.approx(10 * frame_s - 0.2, abs=frame_s)
    assert end > 90 * frame_s


def test_iter_frames_streams_whole_file_in_512_sample_frames(tmp_path):
    sr = 16000
    # Длина не кратна ни кадру, ни блоку чтения: хвост короче кадра отбрасывается.
    audio = np.arange(WINDOW * 4321 + 100, dtype=np.float32) / 1e9
    sf.write(tmp_path / "d.wav", audio, sr, subtype="FLOAT")
    frames = list(iter_frames(str(tmp_path / "d.wav")))
    assert len(frames) == 4321
    assert all(len(f) == WINDOW for f in frames)
    # Кадры идут подряд, без пропусков и повторов на границах блоков.
    joined = np.concatenate(frames)
    assert np.allclose(joined, audio[: WINDOW * 4321])


def test_iter_frames_rejects_wrong_rate(tmp_path):
    sf.write(tmp_path / "d.wav", np.zeros(48000, dtype=np.float32), 48000)
    with pytest.raises(ValueError):
        list(iter_frames(str(tmp_path / "d.wav")))


def test_regions_from_probs_drops_short_bursts():
    probs = [0.0] * 10 + [0.9] * 3 + [0.0] * 100
    assert regions_from_probs(iter(probs), 0.5, 250, 500, 200) == []


# --- разбиение дня на блоки для сегментации ---

def make_turns(n, gap=1.0, every=10, big_gap=60.0):
    turns = []
    t = 0.0
    for i in range(n):
        turns.append(Turn("speaker_0", t, t + 3.0, f"реплика номер {i} " * 5))
        t += 3.0 + (big_gap if (i + 1) % every == 0 else gap)
    return turns


def test_split_into_blocks_respects_budget_and_pauses():
    turns = make_turns(100)
    blocks = split_into_blocks(turns, gap_s=30.0, max_chars=2500)
    assert sum(len(b) for b in blocks) == 100
    assert [t.text for b in blocks for t in b] == [t.text for t in turns]
    for block in blocks:
        assert len(render_transcript(block)) <= 2500
    # Границы блоков проходят только по длинным паузам.
    for a, b in zip(blocks, blocks[1:]):
        assert b[0].start - a[-1].end > 30.0


def test_split_into_blocks_splits_endless_conversation_at_longest_pause():
    # 40 реплик без единой длинной паузы: ни одной естественной границы.
    turns = []
    t = 0.0
    for i in range(40):
        turns.append(Turn("speaker_1", t, t + 2.0, "слово " * 20))
        t += 2.0 + (5.0 if i == 19 else 0.5)
    blocks = split_into_blocks(turns, gap_s=30.0, max_chars=3000)
    assert len(blocks) >= 2
    assert sum(len(b) for b in blocks) == 40
    # Первый разрез — по самой длинной паузе, после 20-й реплики.
    assert any(b[0].start == turns[20].start for b in blocks)


def test_split_into_blocks_single_request_when_day_is_short():
    turns = make_turns(5)
    assert len(split_into_blocks(turns, 30.0, 40_000)) == 1


def test_split_into_blocks_empty():
    assert split_into_blocks([], 30.0, 1000) == []


# --- повтор запроса к модели при не-JSON ответе ---

class _SequenceMessages:
    def __init__(self, messages):
        self._messages = list(messages)
        self.calls = []

    def stream(self, **kwargs):
        self.calls.append(kwargs)
        return _FakeStream(self._messages.pop(0))


def make_llm_seq(messages):
    client = LlmClient.__new__(LlmClient)
    client.settings = type("S", (), {"llm_max_tokens": 16000})()
    client.usage = LlmUsage()
    client.client = type("C", (), {})()
    client.client.messages = _SequenceMessages(messages)
    return client


def test_complete_json_retries_once_on_prose():
    llm = make_llm_seq([_FakeMessage("Вот что получилось, без JSON"), _FakeMessage('{"a": 1}')])
    assert llm.complete_json("p", "m") == {"a": 1}
    assert len(llm.client.messages.calls) == 2
    # Токены обоих запросов учтены в стоимости.
    assert llm.usage.calls == 2


def test_complete_json_gives_up_after_second_bad_reply():
    llm = make_llm_seq([_FakeMessage("нет"), _FakeMessage("снова нет")])
    with pytest.raises(ValueError):
        llm.complete_json("p", "m")


def test_complete_json_does_not_retry_truncated_reply():
    llm = make_llm_seq([_FakeMessage('[{"start_s": 1', stop_reason="max_tokens")])
    with pytest.raises(ValueError, match="max_tokens"):
        llm.complete_json("p", "m")
    assert len(llm.client.messages.calls) == 1
