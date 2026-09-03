"""ASR abstraction. Primary provider: ElevenLabs Scribe (diarization + word
timestamps + auto language detection). Keep the interface narrow so Google
Chirp can be added as a drop-in fallback.
"""
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from ..config import get_settings

logger = logging.getLogger(__name__)


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

    # Расшифровка идёт одним запросом на несколько часов речи: сеть или сервис
    # могут споткнуться на середине, а повторять ради этого весь день (склейку,
    # VAD) незачем. Повторяем только сам запрос — на обрыве соединения и на
    # ответах, которые провайдер сам считает временными.
    RETRY_STATUSES = {408, 409, 425, 429, 500, 502, 503, 504}
    RETRY_DELAYS_S = (30, 90, 180)

    def _post(self, audio_path: str) -> httpx.Response:
        with open(audio_path, "rb") as f:
            files = {"file": (Path(audio_path).name, f, "audio/wav")}
            data = {
                "model_id": self.model_id,
                "diarize": "true",
                "timestamps_granularity": "word",
                "tag_audio_events": "false",
            }
            with httpx.Client(timeout=httpx.Timeout(3600.0, connect=30.0)) as client:
                return client.post(
                    self.url,
                    headers={"xi-api-key": self.api_key},
                    files=files,
                    data=data,
                )

    def transcribe(self, audio_path: str) -> AsrResult:
        attempts = len(self.RETRY_DELAYS_S) + 1
        for attempt in range(attempts):
            try:
                resp = self._post(audio_path)
            except httpx.TransportError as e:
                if attempt == attempts - 1:
                    raise
                logger.warning("ASR transport error (%s), retry %d", e, attempt + 1)
                time.sleep(self.RETRY_DELAYS_S[attempt])
                continue
            if resp.status_code in self.RETRY_STATUSES and attempt < attempts - 1:
                logger.warning(
                    "ASR answered %s, retry %d: %s",
                    resp.status_code, attempt + 1, resp.text[:300],
                )
                time.sleep(self.RETRY_DELAYS_S[attempt])
                continue
            break
        if resp.status_code >= 400:
            raise RuntimeError(
                f"ElevenLabs Scribe ответил {resp.status_code}: {resp.text[:500]}"
            )
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
