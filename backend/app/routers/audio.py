"""Presigned playback URLs for the dashboard audio player."""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from .. import storage
from ..auth import UserContext, require_user
from ..config import get_settings
from ..db import get_db
from ..models import DayRecording
from ..schemas import AudioUrlOut

router = APIRouter(prefix="/api/audio", tags=["audio"])
settings = get_settings()


@router.get("/day/{recording_id}", response_model=AudioUrlOut)
async def day_audio_url(
    recording_id: uuid.UUID,
    user: UserContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """URL of the merged day audio; the player seeks to dialog timestamps."""
    rec = await db.get(DayRecording, recording_id)
    if not rec or not rec.raw_audio_uri:
        raise HTTPException(404, "Merged audio not available")
    url = storage.presigned_get_url(rec.raw_audio_uri)
    return AudioUrlOut(url=url, expires_in_s=settings.presigned_url_ttl_s)
