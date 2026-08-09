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
    location_name: str | None = None
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


class DayDeletedOut(BaseModel):
    """Итог удаления смены: сколько файлов ушло из хранилища и что пошло не
    так, если пошло. Молчаливое «204 OK» скрывало бы неосвобождённое место."""

    files_removed: int = 0
    warning: str = ""


# --- Вход в админку ---

class LoginRequest(BaseModel):
    login: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=4, max_length=128)


class MeOut(BaseModel):
    employee_id: uuid.UUID | None = None
    full_name: str = ""
    login: str | None = None
    scope: str = "own"
    can_view_all: bool = False
    can_manage: bool = False
    is_owner: bool = False


class SessionOut(BaseModel):
    token: str
    user: MeOut


# --- Обновление приложения записи ---

class UpdateManifest(BaseModel):
    """Ответ апдейтеру Tauri. Имена полей заданы им, менять нельзя."""

    version: str
    notes: str = ""
    pub_date: datetime
    url: str
    signature: str


class AppReleaseOut(BaseModel):
    id: uuid.UUID
    platform: str
    version: str
    notes: str = ""
    size_bytes: int = 0
    published: bool = True
    created_by_name: str = ""
    created_at: datetime

    model_config = {"from_attributes": True}


# --- Точки продажи (студии) ---

class LocationOut(BaseModel):
    id: uuid.UUID
    name: str
    address: str = ""
    timezone: str = "Asia/Tbilisi"
    active: bool = True
    shifts_count: int = 0

    model_config = {"from_attributes": True}


class LocationCreate(BaseModel):
    name: str = Field(min_length=2, max_length=255)
    address: str = Field(default="", max_length=512)
    timezone: str = "Asia/Tbilisi"


class LocationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=255)
    address: str | None = Field(default=None, max_length=512)
    timezone: str | None = None
    active: bool | None = None


class LocationPickOut(BaseModel):
    """То, что видит приложение на ресепшене в списке «Точка продажи»."""

    id: uuid.UUID
    name: str
    address: str = ""

    model_config = {"from_attributes": True}


# --- Employees (managers) ---

class EmployeeOut(BaseModel):
    id: uuid.UUID
    # Точка, на которой карточку завели. Ни на что не влияет: сотрудник может
    # выйти на любой студии, а смена достаётся той, где стоит компьютер.
    location_id: uuid.UUID
    full_name: str
    role: str
    active: bool
    # Доступ в админку. Пароль наружу не отдаётся никогда — только признак
    # того, что он выдан.
    login: str | None = None
    access_scope: str = "own"
    has_password: bool = False
    last_login_at: datetime | None = None

    model_config = {"from_attributes": True}


class EmployeePickOut(BaseModel):
    """То, что видит приложение на ресепшене: только выбор имени. Логины и
    признаки доступа туда не уходят — устройство их не касается."""

    id: uuid.UUID
    location_id: uuid.UUID
    full_name: str
    role: str
    active: bool

    model_config = {"from_attributes": True}


class EmployeeCreate(BaseModel):
    full_name: str = Field(min_length=2, max_length=255)
    role: str = "manager"
    # Логин необязателен: менеджера можно завести только для приложения.
    login: str | None = Field(default=None, max_length=64)
    access_scope: str = Field(default="own", pattern="^(own|all)$")


class EmployeeUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=2, max_length=255)
    active: bool | None = None
    login: str | None = Field(default=None, max_length=64)
    access_scope: str | None = Field(default=None, pattern="^(own|all)$")


class EmployeeCredentialsOut(BaseModel):
    """Единственный момент, когда пароль виден: сразу после выдачи или
    сброса. В базе лежит только хеш, повторно показать его нельзя."""

    employee: EmployeeOut
    login: str
    password: str


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


# --- Согласие / несогласие с разбором ---

class FeedbackIn(BaseModel):
    dialog_id: uuid.UUID
    # Возражают всегда конкретной оценке: голоса «за разбор целиком» нет.
    metric_id: uuid.UUID
    agree: bool
    comment: str = Field(default="", max_length=2000)


class DialogFeedbackOut(BaseModel):
    id: uuid.UUID
    dialog_id: uuid.UUID
    metric_id: uuid.UUID
    agree: bool
    comment: str = ""
    author_name: str = ""
    subject_name: str = ""
    created_at: datetime
    # Свой ли это голос — по нему кнопка в интерфейсе рисуется нажатой.
    is_mine: bool = False


class MetricFeedbackItem(BaseModel):
    """Одно несогласие в разрезе метрики: где было, у кого и что сказали."""

    id: uuid.UUID
    day_recording_id: uuid.UUID
    day_date: date
    dialog_id: uuid.UUID
    dialog_start_s: float | None = None
    subject_name: str = ""
    author_name: str = ""
    comment: str = ""
    created_at: datetime


class MetricFeedbackStat(BaseModel):
    metric_id: uuid.UUID
    metric_name: str = ""
    agree_count: int = 0
    disagree_count: int = 0
    disagreements: list[MetricFeedbackItem] = []


# --- Договорённости по итогам разбора ---

class AgreementCreate(BaseModel):
    day_recording_id: uuid.UUID
    dialog_id: uuid.UUID | None = None
    text: str = Field(min_length=3, max_length=2000)


class AgreementUpdate(BaseModel):
    text: str | None = Field(default=None, min_length=3, max_length=2000)
    status: str | None = Field(default=None, pattern="^(open|done|missed|cancelled)$")
    resolution_note: str | None = Field(default=None, max_length=2000)
    # Смена, на которой отметили выполнение, — чтобы из карточки договорённости
    # можно было попасть в день, где её проверили.
    resolved_day_recording_id: uuid.UUID | None = None


class AgreementOut(BaseModel):
    id: uuid.UUID
    employee_id: uuid.UUID | None = None
    employee_name: str = ""
    day_recording_id: uuid.UUID
    day_date: date
    dialog_id: uuid.UUID | None = None
    dialog_start_s: float | None = None
    text: str
    status: str
    created_by_name: str = ""
    created_at: datetime
    resolved_at: datetime | None = None
    resolved_by_name: str = ""
    resolved_day_recording_id: uuid.UUID | None = None
    resolution_note: str = ""

    model_config = {"from_attributes": True}


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
    feedback: list[DialogFeedbackOut] = []
    # Договорённости, записанные по итогам этой смены.
    agreements: list[AgreementOut] = []
    # Незакрытые договорённости с прошлых смен того же менеджера: главное,
    # ради чего они заводились, — чтобы проверка всплывала сама.
    carried_agreements: list[AgreementOut] = []


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
