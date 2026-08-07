"""Dashboard endpoints (user auth): reports, plus day maintenance actions."""
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .. import storage
from ..access import scope_days, visible_day
from ..auth import UserContext, require_manage, require_user
from ..db import get_db
from ..models import (
    Agreement,
    AnalysisMetric,
    AudioSegment,
    DayRecording,
    Dialog,
    DialogFeedback,
    DialogTurn,
    Employee,
    Location,
    MetricEvaluation,
    MetricsDaily,
    Transcript,
)
from ..schemas import (
    DayMetricStat,
    DayRecordingOut,
    DayReportOut,
    DialogDetailOut,
    DialogOut,
    MetricEvaluationOut,
)
from .agreements import agreements_of_day, carried_agreements
from .feedback import feedback_for_day

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/reports", tags=["reports"])


async def to_day_out(db: AsyncSession, rec: DayRecording) -> DayRecordingOut:
    """Day recording plus the names of the manager and the studio."""
    out = DayRecordingOut.model_validate(rec)
    if rec.employee_id:
        employee = await db.get(Employee, rec.employee_id)
        if employee:
            out.employee_name = employee.full_name
    location = await db.get(Location, rec.location_id)
    if location:
        out.location_name = location.name
    return out


async def metric_stats_for(db: AsyncSession, recording_id) -> list[DayMetricStat]:
    """Per-metric aggregates of one day: how often it triggered + average score."""
    rows = (
        await db.execute(
            select(
                AnalysisMetric.id,
                AnalysisMetric.name,
                AnalysisMetric.scale_max,
                func.count().filter(MetricEvaluation.applicable.is_(True)),
                func.avg(MetricEvaluation.score).filter(
                    MetricEvaluation.applicable.is_(True)
                ),
            )
            .join(MetricEvaluation, MetricEvaluation.metric_id == AnalysisMetric.id)
            .where(MetricEvaluation.day_recording_id == recording_id)
            .group_by(AnalysisMetric.id, AnalysisMetric.name, AnalysisMetric.scale_max)
            .order_by(AnalysisMetric.name)
        )
    ).all()
    return [
        DayMetricStat(
            metric_id=metric_id,
            name=name,
            scale_max=scale_max,
            triggered_count=triggered or 0,
            avg_score=round(float(avg), 1) if avg is not None else None,
        )
        for metric_id, name, scale_max, triggered, avg in rows
    ]


async def evaluations_for_dialogs(
    db: AsyncSession, recording_id
) -> dict[str, list[MetricEvaluationOut]]:
    """All metric evaluations of a day grouped by dialog id (str)."""
    rows = (
        await db.execute(
            select(MetricEvaluation, AnalysisMetric.name, AnalysisMetric.scale_max)
            .join(AnalysisMetric, AnalysisMetric.id == MetricEvaluation.metric_id)
            .where(MetricEvaluation.day_recording_id == recording_id)
        )
    ).all()
    result: dict[str, list[MetricEvaluationOut]] = {}
    for ev, name, scale_max in rows:
        result.setdefault(str(ev.dialog_id), []).append(
            MetricEvaluationOut(
                metric_id=ev.metric_id,
                metric_name=name,
                scale_max=scale_max,
                applicable=ev.applicable,
                score=ev.score,
                good=ev.good_json or [],
                bad=ev.bad_json or [],
                comment=ev.comment,
            )
        )
    return result


@router.get("/days", response_model=list[DayRecordingOut])
async def list_days(
    location_id: uuid.UUID | None = None,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    q = (
        select(DayRecording)
        .order_by(DayRecording.date.desc(), DayRecording.created_at.desc())
        .limit(120)
    )
    if location_id:
        q = q.where(DayRecording.location_id == location_id)
    q = scope_days(q, user)
    records = (await db.scalars(q)).all()
    result = []
    for rec in records:
        out = await to_day_out(db, rec)
        if rec.status == "done":
            out.metric_stats = await metric_stats_for(db, rec.id)
        result.append(out)
    return result


@router.get("/days/{recording_id}", response_model=DayReportOut)
async def day_report(
    recording_id: uuid.UUID,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    rec = await visible_day(db, recording_id, user)

    dialogs = (
        await db.scalars(
            select(Dialog)
            .where(Dialog.day_recording_id == recording_id)
            .order_by(Dialog.start_s)
        )
    ).all()

    metrics = await db.scalar(
        select(MetricsDaily).where(MetricsDaily.day_recording_id == recording_id)
    )

    evals_by_dialog = await evaluations_for_dialogs(db, recording_id)
    dialog_outs = []
    for d in dialogs:
        out = DialogOut.model_validate(d)
        out.evaluations = evals_by_dialog.get(str(d.id), [])
        dialog_outs.append(out)

    return DayReportOut(
        recording=await to_day_out(db, rec),
        dialogs_total=metrics.dialogs_total if metrics else len(dialogs),
        sales_count=metrics.sales_count if metrics else 0,
        conversion=metrics.conversion if metrics else None,
        upsell_count=metrics.upsell_count if metrics else 0,
        avg_script_score=metrics.avg_script_score if metrics else None,
        summary=metrics.summary_json if metrics else None,
        metric_stats=await metric_stats_for(db, recording_id),
        dialogs=dialog_outs,
        feedback=await feedback_for_day(db, recording_id, user),
        agreements=await agreements_of_day(db, recording_id),
        carried_agreements=await carried_agreements(db, rec),
    )


@router.post("/days/{recording_id}/force-finish", response_model=DayRecordingOut)
async def force_finish_day(
    recording_id: uuid.UUID,
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    """Close a session the app never finished (crash, closed laptop, dead app)
    and process whatever segments did reach the server."""
    rec = await db.get(DayRecording, recording_id)
    if not rec:
        raise HTTPException(404, "Recording not found")
    if rec.status != "recording":
        raise HTTPException(409, f"Запись уже в статусе «{rec.status}»")

    segments = (
        await db.scalars(
            select(AudioSegment).where(AudioSegment.day_recording_id == recording_id)
        )
    ).all()
    if not segments:
        raise HTTPException(
            409, "На сервер не загружено ни одного сегмента — эту запись можно только удалить"
        )

    rec.status = "uploaded"
    rec.status_detail = "завершено вручную из админки"
    await db.commit()
    await db.refresh(rec)

    from ..pipeline.tasks import process_day_recording

    process_day_recording.delay(str(recording_id))
    return await to_day_out(db, rec)


@router.delete("/days/{recording_id}", status_code=204)
async def delete_day(
    recording_id: uuid.UUID,
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    """Delete a recording with its analysis and its audio in object storage.

    Irreversible — the dashboard asks for confirmation before calling this.
    """
    rec = await db.get(DayRecording, recording_id)
    if not rec:
        raise HTTPException(404, "Recording not found")
    if rec.status == "processing":
        raise HTTPException(409, "День сейчас обрабатывается, дождитесь окончания")

    dialog_ids = (
        await db.scalars(select(Dialog.id).where(Dialog.day_recording_id == recording_id))
    ).all()
    # Отзывы и договорённости ссылаются на смену и на разговоры: без их
    # удаления база просто не даст стереть день.
    await db.execute(
        delete(DialogFeedback).where(DialogFeedback.day_recording_id == recording_id)
    )
    await db.execute(delete(Agreement).where(Agreement.day_recording_id == recording_id))
    # Договорённость могли отметить выполненной на этой смене — ссылку
    # снимаем, саму договорённость оставляем: она относится к другому дню.
    await db.execute(
        update(Agreement)
        .where(Agreement.resolved_day_recording_id == recording_id)
        .values(resolved_day_recording_id=None)
    )
    await db.execute(
        delete(MetricEvaluation).where(MetricEvaluation.day_recording_id == recording_id)
    )
    if dialog_ids:
        await db.execute(delete(DialogTurn).where(DialogTurn.dialog_id.in_(dialog_ids)))
    await db.execute(delete(Dialog).where(Dialog.day_recording_id == recording_id))
    await db.execute(delete(Transcript).where(Transcript.day_recording_id == recording_id))
    await db.execute(
        delete(MetricsDaily).where(MetricsDaily.day_recording_id == recording_id)
    )
    await db.execute(
        delete(AudioSegment).where(AudioSegment.day_recording_id == recording_id)
    )
    await db.delete(rec)
    await db.commit()

    # Audio last: losing the DB rows but keeping objects would leave orphans
    # that nothing points at, while the reverse is recoverable.
    try:
        storage.delete_prefix(storage.recording_prefix(str(recording_id)))
    except Exception as e:  # noqa: BLE001 - storage must not block deletion
        logger.warning("failed to delete audio of %s: %s", recording_id, e)
    return None


@router.post("/days/{recording_id}/reprocess", response_model=DayRecordingOut)
async def reprocess_day(
    recording_id: uuid.UUID,
    user: UserContext = Depends(require_manage),
    db: AsyncSession = Depends(get_db),
):
    """Re-run the pipeline for a day: after a failure, or after editing prompts.

    Previous dialogs and transcripts are replaced by the new run.
    """
    rec = await db.get(DayRecording, recording_id)
    if not rec:
        raise HTTPException(404, "Recording not found")
    if rec.status == "processing":
        raise HTTPException(409, "День уже обрабатывается")
    if rec.status == "recording":
        raise HTTPException(409, "Запись ещё не завершена в приложении")

    rec.status = "uploaded"
    rec.status_detail = "поставлен в очередь на повторную обработку"
    await db.commit()
    await db.refresh(rec)

    from ..pipeline.tasks import process_day_recording

    process_day_recording.delay(str(recording_id))
    return await to_day_out(db, rec)


@router.get("/dialogs/{dialog_id}", response_model=DialogDetailOut)
async def dialog_detail(
    dialog_id: uuid.UUID,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    dialog = await db.scalar(
        select(Dialog).where(Dialog.id == dialog_id).options(selectinload(Dialog.turns))
    )
    if not dialog:
        raise HTTPException(404, "Dialog not found")
    # Расшифровка — самое чувствительное, что здесь есть: доступ проверяется
    # по смене, которой принадлежит разговор.
    await visible_day(db, dialog.day_recording_id, user)
    out = DialogDetailOut.model_validate(dialog)
    out.turns.sort(key=lambda t: t.start_s)
    return out
