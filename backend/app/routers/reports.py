"""Dashboard endpoints (user auth): reports, plus day maintenance actions."""
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .. import storage
from ..auth import UserContext, require_user
from ..db import get_db
from ..models import (
    AudioSegment,
    DayRecording,
    Dialog,
    DialogTurn,
    Employee,
    MetricsDaily,
    Transcript,
)
from ..schemas import DayRecordingOut, DayReportOut, DialogDetailOut, DialogOut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/reports", tags=["reports"])


async def to_day_out(db: AsyncSession, rec: DayRecording) -> DayRecordingOut:
    """Day recording plus the manager's name for display."""
    out = DayRecordingOut.model_validate(rec)
    if rec.employee_id:
        employee = await db.get(Employee, rec.employee_id)
        if employee:
            out.employee_name = employee.full_name
    return out


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
    records = (await db.scalars(q)).all()
    return [await to_day_out(db, rec) for rec in records]


@router.get("/days/{recording_id}", response_model=DayReportOut)
async def day_report(
    recording_id: uuid.UUID,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    rec = await db.get(DayRecording, recording_id)
    if not rec:
        raise HTTPException(404, "Recording not found")

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

    return DayReportOut(
        recording=await to_day_out(db, rec),
        dialogs_total=metrics.dialogs_total if metrics else len(dialogs),
        sales_count=metrics.sales_count if metrics else 0,
        conversion=metrics.conversion if metrics else None,
        upsell_count=metrics.upsell_count if metrics else 0,
        avg_script_score=metrics.avg_script_score if metrics else None,
        summary=metrics.summary_json if metrics else None,
        dialogs=[DialogOut.model_validate(d) for d in dialogs],
    )


@router.post("/days/{recording_id}/force-finish", response_model=DayRecordingOut)
async def force_finish_day(
    recording_id: uuid.UUID,
    user: UserContext = Depends(require_user),
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
    user: UserContext = Depends(require_user),
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
    user: UserContext = Depends(require_user),
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
    out = DialogDetailOut.model_validate(dialog)
    out.turns.sort(key=lambda t: t.start_s)
    return out
