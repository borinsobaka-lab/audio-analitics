"""Silero VAD (ONNX) — find speech regions in a 16 kHz mono WAV.

The model file is downloaded once (see download_model) and cached locally.
"""
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf

MODEL_URL = (
    "https://raw.githubusercontent.com/snakers4/silero-vad/master/"
    "src/silero_vad/data/silero_vad.onnx"
)
MODEL_CACHE = Path.home() / ".cache" / "audio-analytics" / "silero_vad.onnx"

SAMPLE_RATE = 16000
WINDOW = 512  # samples per frame at 16 kHz (32 ms)


def download_model(path: Path = MODEL_CACHE) -> Path:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(MODEL_URL, path)
    return path


CONTEXT = 64  # Silero v5: each frame must be prefixed with the previous frame's tail


class SileroVAD:
    def __init__(self, model_path: str | None = None):
        self.session = ort.InferenceSession(
            model_path or str(download_model()),
            providers=["CPUExecutionProvider"],
        )
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros(CONTEXT, dtype=np.float32)

    def frame_prob(self, frame: np.ndarray) -> float:
        """Speech probability for one 512-sample frame.

        The v5 ONNX model expects 512 + 64 samples: the frame prefixed with
        the tail of the previous frame. Feeding a bare 512-sample window makes
        the model output near-zero probabilities even for clear speech.
        """
        frame = frame.astype(np.float32)
        model_input = np.concatenate([self._context, frame]).reshape(1, -1)
        out, self._state = self.session.run(
            None,
            {
                "input": model_input,
                "state": self._state,
                "sr": np.array(SAMPLE_RATE, dtype=np.int64),
            },
        )
        self._context = frame[-CONTEXT:]
        return float(out[0][0])


def find_speech_regions(
    wav_path: str,
    threshold: float = 0.5,
    min_speech_ms: int = 250,
    min_silence_ms: int = 500,
    pad_ms: int = 200,
) -> list[tuple[float, float]]:
    """Return merged [(start_s, end_s)] speech regions."""
    audio, sr = sf.read(wav_path, dtype="float32")
    if sr != SAMPLE_RATE:
        raise ValueError(f"Expected {SAMPLE_RATE} Hz wav, got {sr}")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    vad = SileroVAD()
    frame_s = WINDOW / SAMPLE_RATE

    regions: list[tuple[float, float]] = []
    speech_start: float | None = None
    silence_frames = 0
    min_silence_frames = int(min_silence_ms / 1000 / frame_s)

    n_frames = len(audio) // WINDOW
    for i in range(n_frames):
        frame = audio[i * WINDOW : (i + 1) * WINDOW]
        prob = vad.frame_prob(frame)
        t = i * frame_s
        if prob >= threshold:
            if speech_start is None:
                speech_start = t
            silence_frames = 0
        elif speech_start is not None:
            silence_frames += 1
            if silence_frames >= min_silence_frames:
                end = t - silence_frames * frame_s + frame_s
                regions.append((speech_start, end))
                speech_start = None
                silence_frames = 0
    if speech_start is not None:
        regions.append((speech_start, n_frames * frame_s))

    # Drop too-short bursts, pad edges, merge overlaps.
    pad = pad_ms / 1000
    min_speech = min_speech_ms / 1000
    padded = [
        (max(0.0, s - pad), e + pad) for s, e in regions if (e - s) >= min_speech
    ]
    merged: list[tuple[float, float]] = []
    for s, e in padded:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged
