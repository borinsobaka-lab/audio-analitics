"""Stage 0: validate the hypothesis on a real recording WITHOUT any server infra.

Takes a local audio file (any format ffmpeg reads), runs the full pipeline
locally (normalize → VAD → ElevenLabs ASR → Claude analysis) and writes a
markdown report + raw JSON artifacts next to the input file.

Usage (from backend/, with ELEVENLABS_API_KEY and ANTHROPIC_API_KEY in .env):
    python -m cli.stage0 path/to/day_recording.mp3
    python -m cli.stage0 recording.opus --out-dir ./report --skip-llm
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.pipeline import audio_prep  # noqa: E402
from app.pipeline.asr import get_asr  # noqa: E402
from app.pipeline.llm import (  # noqa: E402
    DEFAULT_PROMPTS,
    DEFAULT_SCRIPT_STAGES,
    LlmClient,
)
from app.pipeline.segmentation import (  # noqa: E402
    format_ts,
    render_transcript,
    words_to_turns,
)
from app.pipeline.vad import find_speech_regions  # noqa: E402

ANALYZABLE_TYPES = ("sale", "consultation", "refusal")


def main() -> None:
    parser = argparse.ArgumentParser(description="Stage-0 local pipeline")
    parser.add_argument("audio", help="Path to the recording (mp3/opus/wav/m4a/...)")
    parser.add_argument("--out-dir", default=None, help="Report directory")
    parser.add_argument("--skip-llm", action="store_true", help="Stop after ASR")
    parser.add_argument("--script-file", default=None, help="Sales script text file")
    args = parser.parse_args()

    settings = get_settings()
    audio_path = Path(args.audio)
    out_dir = Path(args.out_dir or audio_path.with_suffix("")).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    script_body = (
        Path(args.script_file).read_text(encoding="utf-8") if args.script_file else ""
    )

    with tempfile.TemporaryDirectory(prefix="stage0_") as tmp_str:
        tmp = Path(tmp_str)

        print("1/5 Normalizing audio...")
        wav = tmp / "day.wav"
        audio_prep.to_wav_16k_mono(str(audio_path), str(wav))
        total_s = audio_prep.probe_duration_s(str(wav))
        print(f"    duration: {format_ts(total_s)}")

        print("2/5 Running VAD (Silero)...")
        regions = find_speech_regions(
            str(wav),
            threshold=settings.vad_threshold,
            min_speech_ms=settings.vad_min_speech_ms,
            min_silence_ms=settings.vad_min_silence_ms,
        )
        speech_s = sum(e - s for s, e in regions)
        print(f"    speech: {format_ts(speech_s)} in {len(regions)} regions "
              f"({100 * speech_s / max(total_s, 1):.0f}% of recording)")
        if not regions:
            print("No speech found — check the microphone/recording.")
            return

        print("3/5 Cutting speech-only audio...")
        speech_wav = tmp / "speech.wav"
        timeline = audio_prep.cut_speech_only(str(wav), regions, str(speech_wav))

        print("4/5 Transcribing (ElevenLabs Scribe)...")
        asr_result = get_asr().transcribe(str(speech_wav))
        for w in asr_result.words:
            w.start = audio_prep.map_to_original_ts(w.start, timeline)
            w.end = audio_prep.map_to_original_ts(w.end, timeline)
        (out_dir / "asr_raw.json").write_text(
            json.dumps(asr_result.raw or {}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        turns = words_to_turns(asr_result.words)
        day_text = render_transcript(turns)
        (out_dir / "transcript.txt").write_text(day_text, encoding="utf-8")
        print(f"    language: {asr_result.language}, turns: {len(turns)}")
        print(f"    transcript saved: {out_dir / 'transcript.txt'}")

        if args.skip_llm:
            print("Skipping LLM analysis (--skip-llm). Done.")
            return

        print("5/5 Analyzing with Claude...")
        llm = LlmClient()
        dialogs_meta = llm.segment_dialogs(
            day_text,
            DEFAULT_PROMPTS["dialog_segmentation"]["content"],
            settings.llm_model_stage1,
        )
        print(f"    dialogs found: {len(dialogs_meta)}")

        analyses = []
        sales = upsells = 0
        scores: list[float] = []
        for i, meta in enumerate(dialogs_meta):
            d_type = meta.get("type", "irrelevant")
            if d_type not in ANALYZABLE_TYPES:
                continue
            d_start, d_end = float(meta.get("start_s", 0)), float(meta.get("end_s", 0))
            d_turns = [t for t in turns if t.start >= d_start - 1 and t.end <= d_end + 1]
            if not d_turns:
                continue
            print(f"    dialog {i + 1}: {d_type} [{format_ts(d_start)}–{format_ts(d_end)}]")
            analysis = llm.analyze_dialog(
                render_transcript(d_turns),
                script_body,
                DEFAULT_SCRIPT_STAGES,
                DEFAULT_PROMPTS["sale_analysis"]["content"],
                settings.llm_model_stage2,
            )
            analyses.append({"start_s": d_start, "end_s": d_end, "type": d_type,
                             "brief": meta.get("brief", ""), **analysis})
            if analysis.get("outcome") == "sale":
                sales += 1
            upsells += int(analysis.get("upsell_count") or 0)
            if analysis.get("manager_effectiveness") is not None:
                scores.append(float(analysis["manager_effectiveness"]))

        relevant = [m for m in dialogs_meta if m.get("type") in ANALYZABLE_TYPES]
        stats = {
            "dialogs_total": len(relevant),
            "sales_count": sales,
            "conversion": round(sales / len(relevant), 3) if relevant else None,
            "upsell_count": upsells,
            "avg_script_score": round(sum(scores) / len(scores), 3) if scores else None,
            "speech_duration_s": speech_s,
        }
        summary = (
            llm.summarize_day(
                analyses, stats,
                DEFAULT_PROMPTS["daily_summary"]["content"],
                settings.llm_model_stage1,
            )
            if analyses
            else None
        )

        (out_dir / "analysis.json").write_text(
            json.dumps(
                {"stats": stats, "dialogs": dialogs_meta, "analyses": analyses,
                 "summary": summary},
                ensure_ascii=False, indent=1,
            ),
            encoding="utf-8",
        )
        (out_dir / "report.md").write_text(
            render_report(stats, dialogs_meta, analyses, summary), encoding="utf-8"
        )
        print(f"\nDone. Report: {out_dir / 'report.md'}")


def render_report(stats, dialogs_meta, analyses, summary) -> str:
    lines = ["# Отчёт за день\n"]
    lines.append("## Сводка\n")
    lines.append(f"- Разговоров с клиентами: **{stats['dialogs_total']}**")
    lines.append(f"- Продаж: **{stats['sales_count']}**")
    if stats["conversion"] is not None:
        lines.append(f"- Конверсия: **{stats['conversion'] * 100:.0f}%**")
    lines.append(f"- Апсейлов: **{stats['upsell_count']}**")
    if stats["avg_script_score"] is not None:
        lines.append(f"- Средний балл по скрипту: **{stats['avg_script_score'] * 100:.0f}%**")
    lines.append(f"- Чистой речи: **{format_ts(stats['speech_duration_s'])}**\n")

    if summary:
        lines.append("## Итоги и рекомендации\n")
        for title, key in (
            ("Главные отклонения", "top_deviations"),
            ("Рекомендации менеджеру", "recommendations"),
            ("Предложения по скрипту", "script_suggestions"),
            ("Удачные моменты", "highlights"),
        ):
            items = summary.get(key) or []
            if items:
                lines.append(f"**{title}:**")
                lines.extend(f"- {item}" for item in items)
                lines.append("")

    lines.append("## Диалоги\n")
    for meta in dialogs_meta:
        ts = f"[{format_ts(float(meta.get('start_s', 0)))}–{format_ts(float(meta.get('end_s', 0)))}]"
        lines.append(f"### {ts} {meta.get('type')} — {meta.get('brief', '')}\n")
        analysis = next(
            (a for a in analyses if a.get("start_s") == meta.get("start_s")), None
        )
        if not analysis:
            continue
        lines.append(f"- Исход: **{analysis.get('outcome', '?')}**"
                     + (f" — «{analysis['outcome_evidence']}»"
                        if analysis.get("outcome_evidence") else ""))
        script = analysis.get("script") or {}
        status_icon = {"done": "✅", "partial": "⚠️", "not_done": "❌"}
        for stage_key, stage_result in script.items():
            icon = status_icon.get(stage_result.get("status", ""), "❔")
            evidence = stage_result.get("evidence")
            cite = f" — «{evidence}»" if evidence else ""
            lines.append(f"- {icon} {stage_key}{cite}")
        for dev in analysis.get("deviations") or []:
            lines.append(f"- Отклонение: {dev}")
        for rec_item in analysis.get("recommendations") or []:
            lines.append(f"- Рекомендация: {rec_item}")
        lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    main()
