"""ffmpeg-based audio preparation: merge segments, normalize, cut speech-only audio."""
import bisect
import subprocess
from pathlib import Path

import soundfile as sf


def run_ffmpeg(args: list[str]) -> None:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {' '.join(cmd)}\n{proc.stderr[-2000:]}")


def probe_duration_s(path: str) -> float:
    proc = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed for {path}: {proc.stderr[-500:]}")
    return float(proc.stdout.strip())


def merge_segments(segment_paths: list[str], out_path: str) -> None:
    """Concatenate opus segments into one continuous stream.

    Each chunk is its own Ogg stream, and ffmpeg cannot stream-copy a chain of
    them into one file (`-c copy` silently keeps only the first chunk).
    Decoding and re-encoding once produces a single clean stream that both
    ffprobe and browser players handle; the quality cost of an opus→opus pass
    at 32 kbps is negligible for ASR.
    """
    list_file = Path(out_path).with_suffix(".txt")
    list_file.write_text(
        "".join(f"file '{Path(p).resolve()}'\n" for p in segment_paths), encoding="utf-8"
    )
    run_ffmpeg(
        [
            "-f", "concat", "-safe", "0", "-i", str(list_file),
            "-c:a", "libopus", "-b:a", "32k", "-ac", "1",
            out_path,
        ]
    )
    list_file.unlink(missing_ok=True)


def to_wav_16k_mono(in_path: str, out_path: str, loudnorm: bool = True) -> None:
    """Decode to 16 kHz mono WAV for VAD; light loudness normalization."""
    filters = ["dynaudnorm=f=250:g=15"] if loudnorm else []
    args = ["-i", in_path, "-ac", "1", "-ar", "16000"]
    if filters:
        args += ["-af", ",".join(filters)]
    args.append(out_path)
    run_ffmpeg(args)


def cut_speech_only(
    in_path: str,
    regions: list[tuple[float, float]],
    out_path: str,
) -> list[dict]:
    """Cut speech regions from the source and concatenate them into one file.

    Returns a timeline map: for each region, its start offset inside the
    speech-only file and its start in the original recording, so ASR word
    timestamps can be mapped back to the original timeline.

    The cut is done sample by sample, not through ffmpeg's `aselect`. That
    filter keeps whole decoded frames (64 ms), so every region came out ~16 ms
    longer than the timeline assumed; over the two-three thousand regions of a
    working day the mismatch grew to 30–50 seconds, and the «▶» button in the
    evening opened the wrong conversation. Reading exact sample ranges makes
    the timeline exact by construction, and the file is processed in pieces,
    so a twelve-hour day never has to fit in memory.
    """
    if not regions:
        raise ValueError("No speech regions to cut")

    timeline: list[dict] = []
    with sf.SoundFile(in_path) as src:
        sr = src.samplerate
        total = len(src)
        with sf.SoundFile(
            out_path, mode="w", samplerate=sr, channels=1, subtype="PCM_16"
        ) as dst:
            offset_samples = 0
            for start_s, end_s in regions:
                start = min(total, max(0, int(round(start_s * sr))))
                end = min(total, max(start, int(round(end_s * sr))))
                if end <= start:
                    continue
                src.seek(start)
                audio = src.read(end - start, dtype="float32", always_2d=True)
                if audio.shape[1] > 1:
                    audio = audio.mean(axis=1, keepdims=True)
                dst.write(audio)
                timeline.append(
                    {
                        "concat_start": offset_samples / sr,
                        "orig_start": start / sr,
                        "duration": (end - start) / sr,
                    }
                )
                offset_samples += end - start
    if not timeline:
        raise ValueError("Speech regions lie outside the recording")
    return timeline


class TimelineMapper:
    """Fast concat-time → original-time mapping (binary search per lookup).

    A day has tens of thousands of words and thousands of regions; the naive
    linear scan per word took minutes and grew quadratically.
    """

    def __init__(self, timeline: list[dict]):
        if not timeline:
            raise ValueError("Empty timeline")
        self.timeline = timeline
        self._starts = [entry["concat_start"] for entry in timeline]

    def to_original(self, concat_ts: float) -> float:
        idx = bisect.bisect_right(self._starts, concat_ts) - 1
        if idx < 0:
            # Before the first region (negative or rounding noise): its start.
            return self.timeline[0]["orig_start"]
        entry = self.timeline[idx]
        within = concat_ts - entry["concat_start"]
        if within < entry["duration"]:
            return entry["orig_start"] + within
        if idx + 1 < len(self.timeline):
            # Exactly on a boundary belongs to the next region.
            return self.timeline[idx + 1]["orig_start"]
        # Past the last region (rounding at the tail): clamp to the end.
        return entry["orig_start"] + entry["duration"]


def map_to_original_ts(concat_ts: float, timeline: list[dict]) -> float:
    """Map a timestamp in the speech-only file back to the original recording.

    A timestamp exactly on a region boundary belongs to the next region.
    Convenience wrapper; for many lookups build a TimelineMapper once.
    """
    return TimelineMapper(timeline).to_original(concat_ts)
