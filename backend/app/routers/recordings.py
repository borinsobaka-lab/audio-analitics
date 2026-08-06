"""Endpoints used by the desktop recorder client (device-key auth)."""
import uuid

from fastapi import APIRouter, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends

from .. import storage
from ..auth import DeviceContext, require_device
from ..db import get_db
from ..models import AudioSegment, DayRecording, Location
from ..schemas import (
    DayFinishRequest,
    DayRecordingOut,
    DayStartRequest,
    SegmentUploadedOut,
)

router = APIRouter(prefix="/api/recordings", tags=["recordings"])


@router.post("/start", response_model=DayRecordingOut)
async def start_day(
    body: DayStartRequest,
    device: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
):
    """Idempotent: returns the existing day recording if already started."""
    location = await db.get(Location, device.location_id)
    if not location:
        raise HTTPException(404, "Location not found")

    existing = await db.scalar(
        select(DayRecording).where(
            DayRecording.location_id == device.location_id,
            DayRecording.date == body.date,
        )
    )
    if existing:
        return existing

    rec = DayRecording(
        org_id=location.org_id,
        location_id=device.location_id,
        employee_id=body.employee_id,
        date=body.date,
        status="recording",
    )
    db.add(rec)
    await db.commit()
    await db.refresh(rec)
    return rec


@router.put("/{recording_id}/segments/{idx}", response_model=SegmentUploadedOut)
async def upload_segment(
    recording_id: uuid.UUID,
    idx: int,
    file: UploadFile,
    device: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
):
    """Idempotent chunk upload: re-uploading the same idx overwrites the object."""
    rec = await db.get(DayRecording, recording_id)
    if not rec or rec.location_id != device.location_id:
        raise HTTPException(404, "Recording not found")
    if rec.status not in ("recording", "uploaded"):
        raise HTTPException(409, f"Recording is in status {rec.status}")

    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    key = storage.segment_key(str(recording_id), idx)
    storage.upload_bytes(key, data, content_type="audio/ogg")

    existing = await db.scalar(
        select(AudioSegment).where(
            AudioSegment.day_recording_id == recording_id, AudioSegment.idx == idx
        )
    )
    if existing:
        return SegmentUploadedOut(id=existing.id, idx=idx)

    seg = AudioSegment(day_recording_id=recording_id, idx=idx, audio_uri=key)
    db.add(seg)
    await db.commit()
    await db.refresh(seg)
    return SegmentUploadedOut(id=seg.id, idx=idx)


@router.post("/{recording_id}/finish", response_model=DayRecordingOut)
async def finish_day(
    recording_id: uuid.UUID,
    body: DayFinishRequest,
    device: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
):
    """Client calls this after all segments are uploaded; queues processing."""
    rec = await db.get(DayRecording, recording_id)
    if not rec or rec.location_id != device.location_id:
        raise HTTPException(404, "Recording not found")

    count = len(
        (
            await db.scalars(
                select(AudioSegment).where(AudioSegment.day_recording_id == recording_id)
            )
        ).all()
    )
    if count < body.total_segments:
        raise HTTPException(
            409, f"Only {count}/{body.total_segments} segments uploaded; retry missing ones"
        )

    rec.status = "uploaded"
    await db.commit()
    await db.refresh(rec)

    # Import here to keep FastAPI importable without Celery configured.
    from ..pipeline.tasks import process_day_recording

    process_day_recording.delay(str(recording_id))
    return rec
