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
    created_at: datetime | None = None
    employee_id: uuid.UUID | None = None
    employee_name: str | None = None
    metric_stats: list["DayMetricStat"] = []
    # Стоимость последней обработки и расход, из которого она получена.
    asr_seconds: float | None = None
    llm_input_tokens: int = 0
    llm_output_tokens: int = 0
    llm_calls: int = 0
    cost_usd: float | None = None

    model_config = {"from_attributes": True}


# --- Employees (managers) ---

class EmployeeOut(BaseModel):
    id: uuid.UUID
    location_id: uuid.UUID
    full_name: str
    role: str
    active: bool

    model_config = {"from_attributes": True}


class EmployeeCreate(BaseModel):
    full_name: str = Field(min_length=2, max_length=255)
    location_id: uuid.UUID | None = None
    role: str = "manager"


class EmployeeUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=2, max_length=255)
    active: bool | None = None


class SegmentUploadedOut(BaseModel):
    id: uuid.UUID
    idx: int


class DayFinishRequest(BaseModel):
    total_segments: int


# --- Analysis metrics ---

class MetricOut(BaseModel):
    id: uuid.UUID
    name: str
    prompt: str
    scale_max: int
    active: bool
    position: int

    model_config = {"from_attributes": True}


class MetricCreate(BaseModel):
    name: str = Field(min_length=2, max_length=255)
    prompt: str = Field(min_length=10)
    scale_max: int = Field(default=10, ge=2, le=10)


class MetricUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=255)
    prompt: str | None = Field(default=None, min_length=10)
    scale_max: int | None = Field(default=None, ge=2, le=10)
    active: bool | None = None
    position: int | None = None


class MetricEvaluationOut(BaseModel):
    metric_id: uuid.UUID
    metric_name: str
    scale_max: int
    applicable: bool
    score: int | None
    good: list[str] = []
    bad: list[str] = []
    comment: str = ""


class DayMetricStat(BaseModel):
    metric_id: uuid.UUID
    name: str
    scale_max: int
    triggered_count: int
    avg_score: float | None


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
    evaluations: list[MetricEvaluationOut] = []

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
    metric_stats: list[DayMetricStat] = []
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


# --- Сводная статистика за период (дашборд) ---

class PeriodTotals(BaseModel):
    """Итоги периода. Конверсия считается по сумме, а не как среднее дневных:
    среднее по дням даёт вес одинаковый и дню с одним разговором, и дню с
    двадцатью."""

    shifts: int = 0
    dialogs: int = 0
    sales: int = 0
    conversion: float | None = None
    speech_seconds: float = 0.0
    cost_usd: float = 0.0


class MetricPeriodStat(BaseModel):
    metric_id: uuid.UUID
    name: str
    scale_max: int
    triggered_count: int = 0
    avg_score: float | None = None
    # Среднее за предыдущий период такой же длины — для стрелки динамики.
    prev_avg_score: float | None = None


class EmployeePeriodStat(BaseModel):
    employee_id: uuid.UUID | None = None
    full_name: str
    totals: PeriodTotals
    metrics: list[MetricPeriodStat] = []


class TrendPoint(BaseModel):
    date: date
    dialogs: int = 0
    sales: int = 0
    conversion: float | None = None
    cost_usd: float = 0.0
    # metric_id (строкой) -> средняя оценка за этот день
    avg_scores: dict[str, float] = {}


class SummaryOut(BaseModel):
    date_from: date
    date_to: date
    prev_date_from: date
    prev_date_to: date
    totals: PeriodTotals
    previous: PeriodTotals
    metrics: list[MetricPeriodStat] = []
    employees: list[EmployeePeriodStat] = []
    trend: list[TrendPoint] = []
