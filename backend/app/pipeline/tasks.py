"""Celery orchestration: the full day-processing pipeline."""
import json
import logging
import tempfile
import traceback
from pathlib import Path

logger = logging.getLogger(__name__)

from sqlalchemy import select

from .. import storage
from ..celery_app import celery
from ..config import get_settings
from ..db import get_sync_db
from ..models import (
    AnalysisMetric,
    AudioSegment,
    DayRecording,
    Dialog,
    DialogTurn,
    MetricEvaluation,
    MetricsDaily,
    PromptTemplate,
    Transcript,
)
from . import audio_prep
from .asr import AsrResult, get_asr
from .cost import compute_cost
from .llm import DEFAULT_PROMPTS, LlmClient
from .segmentation import Turn, group_conversations, render_transcript, words_to_turns
from .vad import find_speech_regions

ANALYZABLE_TYPES = ("sale", "consultation", "refusal")
# Metrics also run on service talks: stage-1 typing is fuzzy (a greeting of a
# new client is easily labeled "service"), and each metric decides
# applicability for itself anyway. Only irrelevant (personal) talk is skipped.
METRIC_TYPES = ("sale", "consultation", "refusal", "service")


def load_active_prompt(db, org_id, key: str) -> tuple[str, str | None]:
    """Return (content, model_override) of the active prompt; fall back to default."""
    prompt = db.scalar(
        select(PromptTemplate)
        .where(
            PromptTemplate.org_id == org_id,
            PromptTemplate.key == key,
            PromptTemplate.active.is_(True),
        )
        .order_by(PromptTemplate.version.desc())
    )
    if prompt:
        return prompt.content, prompt.model
    return DEFAULT_PROMPTS[key]["content"], None


@celery.task(name="pipeline.process_day_recording", bind=True, max_retries=2)
def process_day_recording(self, recording_id: str) -> str:
    db = get_sync_db()
    try:
        rec = db.get(DayRecording, recording_id)
        if not rec:
            return f"recording {recording_id} not found"
        rec.status = "processing"
        rec.status_detail = "preparing audio"
        db.commit()

        with tempfile.TemporaryDirectory(prefix="day_") as tmp:
            result = _run_pipeline(db, rec, Path(tmp))

        rec.status = "done"  # status_detail already carries the run summary
        db.commit()
        return result
    except Exception as e:
        db.rollback()
        rec = db.get(DayRecording, recording_id)
        if rec:
            rec.status = "error"
            rec.status_detail = f"{e}\n{traceback.format_exc()[-1500:]}"
            db.commit()
        raise
    finally:
        db.close()


def _cleanup_previous_results(db, rec: DayRecording) -> None:
    """Make reprocessing idempotent: drop results of earlier runs."""
    old_dialogs = list(db.scalars(select(Dialog).where(Dialog.day_recording_id == rec.id)))
    for ev in db.scalars(
        select(MetricEvaluation).where(MetricEvaluation.day_recording_id == rec.id)
    ):
        db.delete(ev)
    for dialog in old_dialogs:
        for turn in db.scalars(select(DialogTurn).where(DialogTurn.dialog_id == dialog.id)):
            db.delete(turn)
        db.delete(dialog)
    for tr in db.scalars(select(Transcript).where(Transcript.day_recording_id == rec.id)):
        db.delete(tr)
    db.commit()


def _run_pipeline(db, rec: DayRecording, tmp: Path) -> str:
    settings = get_settings()
    _cleanup_previous_results(db, rec)

    # 1. Download and merge segments.
    segments = list(
        db.scalars(
            select(AudioSegment)
            .where(AudioSegment.day_recording_id == rec.id)
            .order_by(AudioSegment.idx)
        )
    )
    if not segments:
        raise RuntimeError("No audio segments uploaded")

    local_paths = []
    for seg in segments:
        p = tmp / f"seg_{seg.idx:05d}.opus"
        storage.download_file(seg.audio_uri, str(p))
        local_paths.append(str(p))

    merged = tmp / "merged.opus"
    audio_prep.merge_segments(local_paths, str(merged))
    merged_uri = storage.merged_key(str(rec.id))
    storage.upload_file(merged_uri, str(merged), content_type="audio/ogg")
    rec.raw_audio_uri = merged_uri
    rec.total_duration_s = audio_prep.probe_duration_s(str(merged))
    rec.status_detail = "running VAD"
    db.commit()

    # 2. VAD → speech-only audio.
    wav = tmp / "day.wav"
    audio_prep.to_wav_16k_mono(str(merged), str(wav))
    regions = find_speech_regions(
        str(wav),
        threshold=settings.vad_threshold,
        min_speech_ms=settings.vad_min_speech_ms,
        min_silence_ms=settings.vad_min_silence_ms,
    )
    if not regions:
        rec.speech_duration_s = 0.0
        rec.status_detail = (
            "речь в записи не найдена — проверьте микрофон и уровень сигнала "
            "в приложении, затем нажмите «Обработать заново»"
        )
        db.commit()
        return "no speech detected"
    rec.speech_duration_s = sum(e - s for s, e in regions)
    # В ASR уходит только речь, вырезанная VAD, — по ней и считается счёт.
    rec.asr_seconds = rec.speech_duration_s
    rec.status_detail = "transcribing"
    db.commit()

    speech_wav = tmp / "speech.wav"
    timeline = audio_prep.cut_speech_only(str(wav), regions, str(speech_wav))

    # 3. ASR with timestamps mapped back to the original timeline.
    asr_result: AsrResult = get_asr().transcribe(str(speech_wav))
    for w in asr_result.words:
        w.start = audio_prep.map_to_original_ts(w.start, timeline)
        w.end = audio_prep.map_to_original_ts(w.end, timeline)

    transcript_uri = storage.transcript_key(str(rec.id))
    storage.upload_bytes(
        transcript_uri,
        json.dumps(asr_result.raw or {}, ensure_ascii=False).encode(),
        content_type="application/json",
    )
    turns = words_to_turns(asr_result.words)
    day_text = render_transcript(turns)
    db.add(
        Transcript(
            day_recording_id=rec.id,
            asr_provider=asr_result.provider,
            language_hint=asr_result.language,
            raw_json_uri=transcript_uri,
            text=day_text,
        )
    )
    rec.status_detail = "analyzing dialogs"
    db.commit()

    # 4. LLM stage 1: segment the day into dialogs (editable prompt).
    llm = LlmClient()
    seg_content, seg_model = load_active_prompt(db, rec.org_id, "dialog_segmentation")
    dialogs_meta = llm.segment_dialogs(
        day_text,
        seg_content,
        seg_model or settings.llm_model_stage1,
        day_duration_s=rec.total_duration_s,
    )

    # 5. LLM stage 2: evaluate every client dialog against every active metric.
    metrics = list(
        db.scalars(
            select(AnalysisMetric)
            .where(AnalysisMetric.org_id == rec.org_id, AnalysisMetric.active.is_(True))
            .order_by(AnalysisMetric.position)
        )
    )

    analyses: list[dict] = []
    sales = 0
    failed_evals = 0
    evals_done = 0
    evals_applicable = 0

    for meta in dialogs_meta:
        # Timestamps and type are already validated by normalize_dialogs().
        d_start = meta["start_s"]
        d_end = meta["end_s"]
        d_type = meta["type"]
        d_turns = [t for t in turns if t.start >= d_start - 1 and t.end <= d_end + 1]

        dialog = Dialog(
            org_id=rec.org_id,
            day_recording_id=rec.id,
            start_s=d_start,
            end_s=d_end,
            type=d_type,
            brief=str(meta.get("brief", "")) if d_type != "irrelevant" else "",
            manager_employee_id=rec.employee_id,
        )
        db.add(dialog)
        db.flush()
        if d_type == "sale":
            dialog.outcome = "sale"
            sales += 1

        # Store turns for analyzable dialogs only — irrelevant (personal) talk
        # is deliberately not persisted per the privacy policy.
        if d_type in METRIC_TYPES:
            for t in d_turns:
                db.add(
                    DialogTurn(
                        dialog_id=dialog.id,
                        speaker_label=t.speaker,
                        start_s=t.start,
                        end_s=t.end,
                        text=t.text,
                    )
                )

        if d_type in METRIC_TYPES and d_turns and metrics:
            dialog_text = render_transcript(d_turns)
            dialog_evals: dict = {}
            for metric in metrics:
                # One failed evaluation must not cost the whole day's report.
                try:
                    result = llm.evaluate_metric(
                        dialog_text,
                        metric.name,
                        metric.prompt,
                        metric.scale_max,
                        settings.llm_model_stage2,
                    )
                except Exception as e:
                    failed_evals += 1
                    logger.warning(
                        "metric '%s' failed on dialog at %.1fs: %s",
                        metric.name, d_start, e,
                    )
                    continue
                db.add(
                    MetricEvaluation(
                        day_recording_id=rec.id,
                        dialog_id=dialog.id,
                        metric_id=metric.id,
                        applicable=result["applicable"],
                        score=result["score"],
                        good_json=result["good"],
                        bad_json=result["bad"],
                        comment=result["comment"],
                    )
                )
                evals_done += 1
                if result["applicable"]:
                    evals_applicable += 1
                    dialog_evals[metric.name] = {
                        "score": result["score"],
                        "scale": metric.scale_max,
                        "bad": result["bad"],
                    }
            if dialog_evals:
                analyses.append(
                    {"start_s": d_start, "type": d_type, "metrics": dialog_evals}
                )

    db.commit()

    # 6. Day stats + daily summary.
    relevant = [m for m in dialogs_meta if m.get("type") in ANALYZABLE_TYPES]
    stats = {
        "date": str(rec.date),
        "dialogs_total": len(relevant),
        "sales_count": sales,
        "conversion": round(sales / len(relevant), 3) if relevant else None,
        "speech_duration_s": rec.speech_duration_s,
    }
    summary = None
    if analyses:
        sum_content, sum_model = load_active_prompt(db, rec.org_id, "daily_summary")
        # The per-dialog analyses are the valuable part; a failed summary must
        # not discard them.
        try:
            summary = llm.summarize_day(
                analyses, stats, sum_content, sum_model or settings.llm_model_stage1
            )
        except Exception as e:
            logger.warning("daily summary failed: %s", e)
            summary = {"error": str(e)[:500]}

    existing = db.scalar(
        select(MetricsDaily).where(MetricsDaily.day_recording_id == rec.id)
    )
    if existing:
        db.delete(existing)
        db.flush()
    db.add(
        MetricsDaily(
            day_recording_id=rec.id,
            org_id=rec.org_id,
            location_id=rec.location_id,
            employee_id=rec.employee_id,
            date=rec.date,
            dialogs_total=stats["dialogs_total"],
            sales_count=sales,
            conversion=stats["conversion"],
            upsell_count=0,
            avg_script_score=None,
            summary_json=summary,
        )
    )
    db.commit()

    # Стоимость последней обработки: расход хранится рядом с суммой, чтобы
    # при смене тарифов прошлые смены можно было пересчитать.
    rec.llm_input_tokens = llm.usage.input_tokens
    rec.llm_output_tokens = llm.usage.output_tokens
    rec.llm_calls = llm.usage.calls
    cost = compute_cost(
        rec.asr_seconds,
        llm.usage.input_tokens,
        llm.usage.output_tokens,
        settings.price_asr_per_hour_usd,
        settings.price_llm_input_per_mtok_usd,
        settings.price_llm_output_per_mtok_usd,
    )
    rec.cost_usd = cost.total_usd
    db.commit()

    # Human-readable summary shown under the "Готово" status in the dashboard,
    # so an empty report explains itself: no metrics? nothing applicable? errors?
    parts = [f"диалогов: {len(dialogs_meta)}"]
    if not metrics:
        parts.append("активных метрик не было — добавьте их и нажмите «Обработать заново»")
    else:
        parts.append(f"метрик: {len(metrics)}")
        parts.append(f"сработало оценок: {evals_applicable} из {evals_done}")
    if failed_evals:
        parts.append(f"ошибок оценки: {failed_evals}")
    parts.append(f"стоимость: ${cost.total_usd:.3f}")
    summary_line = ", ".join(parts)
    rec.status_detail = summary_line
    db.commit()
    return summary_line
