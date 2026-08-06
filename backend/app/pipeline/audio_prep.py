"""ffmpeg-based audio preparation: merge segments, normalize, cut speech-only audio."""
import subprocess
from pathlib import Path


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
    """
    if not regions:
        raise ValueError("No speech regions to cut")

    select_expr = "+".join(f"between(t,{s:.3f},{e:.3f})" for s, e in regions)
    run_ffmpeg(
        [
            "-i", in_path,
            "-af", f"aselect='{select_expr}',asetpts=N/SR/TB",
            "-ac", "1", "-ar", "16000",
            out_path,
        ]
    )

    timeline: list[dict] = []
    offset = 0.0
    for start, end in regions:
        duration = end - start
        timeline.append(
            {"concat_start": offset, "orig_start": start, "duration": duration}
        )
        offset += duration
    return timeline


def map_to_original_ts(concat_ts: float, timeline: list[dict]) -> float:
    """Map a timestamp in the speech-only file back to the original recording.

    A timestamp exactly on a region boundary belongs to the next region.
    """
    for entry in timeline:
        if entry["concat_start"] <= concat_ts < entry["concat_start"] + entry["duration"]:
            return entry["orig_start"] + (concat_ts - entry["concat_start"])
    # Past the last region (rounding at the tail): clamp to the end.
    last = timeline[-1]
    return last["orig_start"] + last["duration"]
