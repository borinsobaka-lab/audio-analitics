"""ASR abstraction. Primary provider: ElevenLabs Scribe (diarization + word
timestamps + auto language detection). Keep the interface narrow so Google
Chirp can be added as a drop-in fallback.
"""
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from ..config import get_settings


@dataclass
class Word:
    text: str
    start: float
    end: float
    speaker: str


@dataclass
class AsrResult:
    provider: str
    language: str
    text: str
    words: list[Word] = field(default_factory=list)
    raw: dict | None = None


class ElevenLabsASR:
    provider = "elevenlabs"
    url = "https://api.elevenlabs.io/v1/speech-to-text"

    def __init__(self, api_key: str | None = None, model_id: str | None = None):
        settings = get_settings()
        self.api_key = api_key or settings.elevenlabs_api_key
        self.model_id = model_id or settings.elevenlabs_model_id
        if not self.api_key:
            raise RuntimeError("ELEVENLABS_API_KEY is not configured")

    def transcribe(self, audio_path: str) -> AsrResult:
        with open(audio_path, "rb") as f:
            files = {"file": (Path(audio_path).name, f, "audio/wav")}
            data = {
                "model_id": self.model_id,
                "diarize": "true",
                "timestamps_granularity": "word",
                "tag_audio_events": "false",
            }
            with httpx.Client(timeout=httpx.Timeout(3600.0, connect=30.0)) as client:
                resp = client.post(
                    self.url,
                    headers={"xi-api-key": self.api_key},
                    files=files,
                    data=data,
                )
        resp.raise_for_status()
        payload = resp.json()

        words = [
            Word(
                text=w.get("text", ""),
                start=float(w.get("start", 0.0)),
                end=float(w.get("end", 0.0)),
                speaker=str(w.get("speaker_id", "speaker_0")),
            )
            for w in payload.get("words", [])
            if w.get("type", "word") == "word"
        ]
        return AsrResult(
            provider=self.provider,
            language=payload.get("language_code", "unknown"),
            text=payload.get("text", ""),
            words=words,
            raw=payload,
        )


def get_asr() -> ElevenLabsASR:
    return ElevenLabsASR()
