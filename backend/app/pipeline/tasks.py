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
from .asr import AsrResult, Word, get_asr
from .cost import compute_cost
from .llm import DEFAULT_PROMPTS, LlmClient
from .segmentation import (
    render_transcript,
    split_into_blocks,
    words_to_turns,
)
from .vad import find_speech_regions

ANALYZABLE_TYPES = ("sale", "consultation", "refusal")
# Metrics also run on service talks: stage-1 typing is fuzzy (a greeting of a
# new client is easily labeled "service"), and each metric decides
# applicability for itself anyway. Only irrelevant (personal) talk is skipped.
METRIC_TYPES = ("sale", "consultation", "refusal", "service")

# Формат сохранённой расшифровки. Раньше в хранилище лежал сырой ответ
# провайдера с таймкодами по вырезанной речи; теперь — слова с таймкодами уже
# по исходной записи, чтобы пересчёт по новым метрикам не платил за
# распознавание второй раз. Сырой ответ лежит рядом, для отладки.
TRANSCRIPT_FORMAT = 2


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
def process_day_recording(self, recording_id: str, full: bool = False) -> str:
    """Разобрать смену. `full=True` — распознать речь заново даже если
    расшифровка с прошлого раза сохранилась."""
    db = get_sync_db()
    try:
        rec = db.get(DayRecording, recording_id)
        if not rec:
            return f"recording {recording_id} not found"
        rec.set_status("processing", "подготовка аудио")
        db.commit()

        with tempfile.TemporaryDirectory(prefix="day_") as tmp:
            result = _run_pipeline(db, rec, Path(tmp), full=full)

        rec.set_status("done")  # status_detail already carries the run summary
        db.commit()
        return result
    except Exception as e:
        db.rollback()
        rec = db.get(DayRecording, recording_id)
        if rec:
            rec.set_status("error", f"{e}\n{traceback.format_exc()[-1500:]}")
            db.commit()
        raise
    finally:
        db.close()


def _cleanup_previous_results(db, rec: DayRecording, drop_transcript: bool) -> None:
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
    if drop_transcript:
        for tr in db.scalars(select(Transcript).where(Transcript.day_recording_id == rec.id)):
            db.delete(tr)
    db.commit()


def _progress(db, rec: DayRecording, detail: str) -> None:
    """Пояснение статуса видно в админке и заодно подтверждает, что разбор
    жив: по времени последнего изменения отличают зависший разбор."""
    rec.set_status(detail=detail)
    db.commit()


def _load_saved_words(rec: DayRecording, db) -> AsrResult | None:
    """Расшифровка прошлого прогона, если она сохранена в новом формате."""
    transcript = db.scalar(
        select(Transcript)
        .where(Transcript.day_recording_id == rec.id)
        .order_by(Transcript.created_at.desc())
    )
    if not transcript or not transcript.raw_json_uri or not rec.raw_audio_uri:
        return None
    try:
        payload = json.loads(storage.get_bytes(transcript.raw_json_uri))
    except Exception as e:  # noqa: BLE001 — нет расшифровки, распознаём заново
        logger.warning("saved transcript of %s unreadable: %s", rec.id, e)
        return None
    if not isinstance(payload, dict) or payload.get("format") != TRANSCRIPT_FORMAT:
        return None
    words = [
        Word(
            text=str(w.get("text", "")),
            start=float(w.get("start", 0.0)),
            end=float(w.get("end", 0.0)),
            speaker=str(w.get("speaker", "speaker_0")),
        )
        for w in payload.get("words", [])
    ]
    return AsrResult(
        provider=str(payload.get("provider", transcript.asr_provider)),
        language=str(payload.get("language", transcript.language_hint)),
        text=str(payload.get("text", "")),
        words=words,
        raw=payload.get("raw"),
    )


def _transcribe(db, rec: DayRecording, tmp: Path) -> AsrResult | None:
    """Скачать сегменты, склеить, найти речь и распознать её.

    Возвращает None, если речи в записи нет. Таймкоды слов — по исходной
    записи; расшифровка сохраняется в хранилище, чтобы пересчёт по другим
    метрикам не распознавал день заново.
    """
    settings = get_settings()

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
    _progress(db, rec, "поиск речи (VAD)")

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
        rec.asr_seconds = 0.0
        return None
    speech_wav = tmp / "speech.wav"
    timeline = audio_prep.cut_speech_only(str(wav), regions, str(speech_wav))
    rec.speech_duration_s = sum(entry["duration"] for entry in timeline)
    # В ASR уходит только речь, вырезанная VAD, — по ней и считается счёт.
    rec.asr_seconds = rec.speech_duration_s
    _progress(
        db, rec, f"распознавание речи ({rec.speech_duration_s / 60:.0f} мин)"
    )
    # Склеенный день и WAV дальше не нужны; на 12-часовой смене это 1.5 ГБ.
    wav.unlink(missing_ok=True)
    for p in local_paths:
        Path(p).unlink(missing_ok=True)

    # 3. ASR with timestamps mapped back to the original timeline.
    asr_result: AsrResult = get_asr().transcribe(str(speech_wav))
    mapper = audio_prep.TimelineMapper(timeline)
    for w in asr_result.words:
        w.start = mapper.to_original(w.start)
        w.end = max(w.start, mapper.to_original(w.end))

    transcript_uri = storage.transcript_key(str(rec.id))
    storage.upload_bytes(
        transcript_uri,
        json.dumps(
            {
                "format": TRANSCRIPT_FORMAT,
                "provider": asr_result.provider,
                "language": asr_result.language,
                "text": asr_result.text,
                "words": [
                    {"text": w.text, "start": w.start, "end": w.end, "speaker": w.speaker}
                    for w in asr_result.words
                ],
                "raw": asr_result.raw or {},
            },
            ensure_ascii=False,
        ).encode(),
        content_type="application/json",
    )
    db.add(
        Transcript(
            day_recording_id=rec.id,
            asr_provider=asr_result.provider,
            language_hint=asr_result.language,
            raw_json_uri=transcript_uri,
            text=render_transcript(words_to_turns(asr_result.words)),
        )
    )
    db.commit()
    return asr_result


def _run_pipeline(db, rec: DayRecording, tmp: Path, full: bool = False) -> str:
    settings = get_settings()

    saved = None if full else _load_saved_words(rec, db)
    _cleanup_previous_results(db, rec, drop_transcript=saved is None)

    if saved is not None:
        asr_result = saved
        # Распознавание не вызывалось — в стоимость этого прогона оно не входит.
        rec.asr_seconds = 0.0
        reused_note = "расшифровка взята с прошлого разбора"
    else:
        asr_result = _transcribe(db, rec, tmp)
        reused_note = ""
        if asr_result is None:
            rec.set_status(
                detail=(
                    "речь в записи не найдена — проверьте микрофон и уровень сигнала "
                    "в приложении, затем нажмите «Обработать заново»"
                )
            )
            db.commit()
            return "no speech detected"

    turns = words_to_turns(asr_result.words)
    if not turns:
        rec.set_status(detail="распознавание не вернуло ни одного слова")
        db.commit()
        return "empty transcript"

    # 4. LLM stage 1: segment the day into dialogs, block by block.
    llm = LlmClient()
    seg_content, seg_model = load_active_prompt(db, rec.org_id, "dialog_segmentation")
    blocks = split_into_blocks(
        turns, settings.conversation_gap_s, settings.llm_stage1_block_chars
    )
    dialogs_meta: list[dict] = []
    for i, block in enumerate(blocks, start=1):
        _progress(db, rec, f"разбиение на диалоги: блок {i} из {len(blocks)}")
        dialogs_meta.extend(
            llm.segment_dialogs(
                render_transcript(block),
                seg_content,
                seg_model or settings.llm_model_stage1,
                day_duration_s=rec.total_duration_s,
            )
        )
    dialogs_meta.sort(key=lambda d: d["start_s"])

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
    to_evaluate = sum(1 for m in dialogs_meta if m["type"] in METRIC_TYPES)
    evaluated = 0

    for meta in dialogs_meta:
        # Timestamps and type are already validated by normalize_dialogs().
        d_start = meta["start_s"]
        d_end = meta["end_s"]
        d_type = meta["type"]
        # Реплика относится к диалогу, если пересекается с его окном. Модель
        # видит в транскрипте только время НАЧАЛА реплик, поэтому её end_s —
        # это начало последней реплики; требование «реплика закончилась до
        # end_s» выбрасывало последнюю фразу каждого разговора.
        d_turns = [t for t in turns if t.start < d_end + 1 and t.end > d_start - 1]
        if d_turns:
            d_start = min(d_start, d_turns[0].start)
            d_end = max(d_end, max(t.end for t in d_turns))

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
            evaluated += 1
            _progress(db, rec, f"оценка разговоров по метрикам: {evaluated} из {to_evaluate}")
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
        _progress(db, rec, "итоги смены")
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
        parts.append("активных метрик не было — добавьте их и нажмите «Пересчитать»")
    else:
        parts.append(f"метрик: {len(metrics)}")
        parts.append(f"сработало оценок: {evals_applicable} из {evals_done}")
    if failed_evals:
        parts.append(f"ошибок оценки: {failed_evals}")
    if reused_note:
        parts.append(reused_note)
    parts.append(f"стоимость: ${cost.total_usd:.3f}")
    summary_line = ", ".join(parts)
    rec.set_status(detail=summary_line)
    db.commit()
    return summary_line
