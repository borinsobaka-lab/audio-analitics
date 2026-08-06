"""Dashboard read endpoints (user auth)."""
import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..auth import UserContext, require_user
from ..db import get_db
from ..models import DayRecording, Dialog, MetricsDaily
from ..schemas import DayRecordingOut, DayReportOut, DialogDetailOut, DialogOut

router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.get("/days", response_model=list[DayRecordingOut])
async def list_days(
    location_id: uuid.UUID | None = None,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    q = select(DayRecording).order_by(DayRecording.date.desc()).limit(90)
    if location_id:
        q = q.where(DayRecording.location_id == location_id)
    return (await db.scalars(q)).all()


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
        select(MetricsDaily).where(
            MetricsDaily.location_id == rec.location_id, MetricsDaily.date == rec.date
        )
    )

    return DayReportOut(
        recording=DayRecordingOut.model_validate(rec),
        dialogs_total=metrics.dialogs_total if metrics else len(dialogs),
        sales_count=metrics.sales_count if metrics else 0,
        conversion=metrics.conversion if metrics else None,
        upsell_count=metrics.upsell_count if metrics else 0,
        avg_script_score=metrics.avg_script_score if metrics else None,
        summary=metrics.summary_json if metrics else None,
        dialogs=[DialogOut.model_validate(d) for d in dialogs],
    )


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
