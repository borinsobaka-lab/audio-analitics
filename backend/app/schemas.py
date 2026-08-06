"""Pydantic schemas for the API."""
import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field


# --- Recordings / segments ---

class DayStartRequest(BaseModel):
    date: date
    employee_id: uuid.UUID | None = None


class DayRecordingOut(BaseModel):
    id: uuid.UUID
    location_id: uuid.UUID
    date: date
    status: str
    status_detail: str = ""
    total_duration_s: float | None = None
    speech_duration_s: float | None = None

    model_config = {"from_attributes": True}


class SegmentUploadedOut(BaseModel):
    id: uuid.UUID
    idx: int


class DayFinishRequest(BaseModel):
    total_segments: int


# --- Dialogs / reports ---

class DialogTurnOut(BaseModel):
    speaker_label: str
    is_manager: bool | None
    start_s: float
    end_s: float
    text: str

    model_config = {"from_attributes": True}


class DialogOut(BaseModel):
    id: uuid.UUID
    start_s: float
    end_s: float
    type: str
    outcome: str | None
    brief: str
    effectiveness_score: float | None
    upsell_count: int
    analysis_json: dict | None

    model_config = {"from_attributes": True}


class DialogDetailOut(DialogOut):
    turns: list[DialogTurnOut] = []


class DayReportOut(BaseModel):
    recording: DayRecordingOut
    dialogs_total: int
    sales_count: int
    conversion: float | None
    upsell_count: int
    avg_script_score: float | None
    summary: dict | None
    dialogs: list[DialogOut]


# --- Prompt templates ---

class PromptTemplateOut(BaseModel):
    id: uuid.UUID
    key: str
    name: str
    description: str
    content: str
    model: str | None
    version: int
    active: bool
    updated_by: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class PromptTemplateUpdate(BaseModel):
    """Saving creates a new version and makes it active (history is preserved)."""

    content: str = Field(min_length=10)
    name: str | None = None
    description: str | None = None
    model: str | None = None


# --- Script templates ---

class ScriptStage(BaseModel):
    key: str
    title: str
    description: str = ""


class ScriptTemplateOut(BaseModel):
    id: uuid.UUID
    name: str
    version: int
    stages_json: list
    body: str
    active: bool

    model_config = {"from_attributes": True}


class ScriptTemplateUpdate(BaseModel):
    name: str | None = None
    stages: list[ScriptStage] | None = None
    body: str | None = None


class AudioUrlOut(BaseModel):
    url: str
    expires_in_s: int
