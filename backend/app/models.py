"""SQLAlchemy ORM models.

Multi-tenancy: every business table carries org_id; enable RLS policies on
Postgres side (see migrations/001_initial.sql) when serving multiple orgs.
"""
import uuid
from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class UUIDMixin:
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )


class Organization(UUIDMixin, Base):
    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Location(UUIDMixin, Base):
    __tablename__ = "locations"

    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    address: Mapped[str] = mapped_column(String(512), default="")
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Tbilisi")


class Employee(UUIDMixin, Base):
    """A sales manager. Deactivated employees stay in the database so past
    reports keep their author; they just disappear from the app's picker."""

    __tablename__ = "employees"

    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    full_name: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(64), default="manager")
    voiceprint_ref: Mapped[str | None] = mapped_column(String(512), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DayRecording(UUIDMixin, Base):
    """One recording session: normally a whole working day of one location.

    Deliberately NOT unique per (location, date): if the app crashes and the
    manager starts again, that second session becomes its own recording and
    its own report, rather than being merged into a half-broken first one.
    """

    __tablename__ = "day_recordings"

    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    employee_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("employees.id"), nullable=True
    )
    date: Mapped[date] = mapped_column(Date, index=True)
    # recording -> uploaded -> processing -> done -> error
    status: Mapped[str] = mapped_column(String(32), default="recording")
    status_detail: Mapped[str] = mapped_column(Text, default="")
    raw_audio_uri: Mapped[str | None] = mapped_column(String(512), nullable=True)
    total_duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    speech_duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    # Расход на обработку. Хранится вместе с итоговой суммой, потому что
    # тарифы меняются: по минутам и токенам прошлую смену можно пересчитать,
    # по одной сумме — уже нет.
    asr_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    llm_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    llm_output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    llm_calls: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)

    segments: Mapped[list["AudioSegment"]] = relationship(back_populates="day_recording")


class AudioSegment(UUIDMixin, Base):
    """A 5–10 minute chunk uploaded by the desktop client."""

    __tablename__ = "segments"
    __table_args__ = (UniqueConstraint("day_recording_id", "idx", name="uq_segment_idx"),)

    day_recording_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("day_recordings.id"), index=True
    )
    idx: Mapped[int] = mapped_column(Integer)
    audio_uri: Mapped[str] = mapped_column(String(512))
    start_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    end_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    day_recording: Mapped[DayRecording] = relationship(back_populates="segments")


class Transcript(UUIDMixin, Base):
    __tablename__ = "transcripts"

    day_recording_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("day_recordings.id"), index=True
    )
    asr_provider: Mapped[str] = mapped_column(String(64), default="elevenlabs")
    language_hint: Mapped[str] = mapped_column(String(32), default="auto")
    # Full ASR response (words, timestamps, speakers) stored in object storage;
    # merged plain view stored inline for LLM input.
    raw_json_uri: Mapped[str | None] = mapped_column(String(512), nullable=True)
    text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Dialog(UUIDMixin, Base):
    __tablename__ = "dialogs"

    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True)
    day_recording_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("day_recordings.id"), index=True
    )
    start_s: Mapped[float] = mapped_column(Float)
    end_s: Mapped[float] = mapped_column(Float)
    # sale | consultation | refusal | service | irrelevant
    type: Mapped[str] = mapped_column(String(32))
    outcome: Mapped[str | None] = mapped_column(String(32), nullable=True)
    brief: Mapped[str] = mapped_column(Text, default="")
    manager_employee_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("employees.id"), nullable=True
    )
    effectiveness_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    upsell_count: Mapped[int] = mapped_column(Integer, default=0)
    # Stage-2 LLM output verbatim (script evaluation, deviations, recommendations).
    analysis_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    turns: Mapped[list["DialogTurn"]] = relationship(back_populates="dialog")


class DialogTurn(UUIDMixin, Base):
    __tablename__ = "dialog_turns"

    dialog_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("dialogs.id"), index=True)
    speaker_label: Mapped[str] = mapped_column(String(64))
    is_manager: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    start_s: Mapped[float] = mapped_column(Float)
    end_s: Mapped[float] = mapped_column(Float)
    text: Mapped[str] = mapped_column(Text)

    dialog: Mapped[Dialog] = relationship(back_populates="turns")


class ScriptTemplate(UUIDMixin, Base):
    """The sales script broken into stages; referenced by the stage-2 prompt."""

    __tablename__ = "script_templates"

    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    name: Mapped[str] = mapped_column(String(255), default="Скрипт продаж")
    # [{"key": "greeting", "title": "Приветствие", "description": "..."}, ...]
    stages_json: Mapped[list] = mapped_column(JSONB, default=list)
    body: Mapped[str] = mapped_column(Text, default="")  # full script text for the LLM
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PromptTemplate(UUIDMixin, Base):
    """Editable LLM prompts. The pipeline always loads the active version by key.

    Keys used by the pipeline:
      - dialog_segmentation  (stage 1: split day transcript into dialogs)
      - sale_analysis        (stage 2: per-dialog script evaluation)
      - daily_summary        (reduce: aggregate day recommendations)
    """

    __tablename__ = "prompt_templates"
    __table_args__ = (
        UniqueConstraint("org_id", "key", "version", name="uq_prompt_org_key_version"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True)
    key: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    content: Mapped[str] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(String(64), nullable=True)  # override default
    version: Mapped[int] = mapped_column(Integer, default=1)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AnalysisMetric(UUIDMixin, Base):
    """An owner-defined evaluation metric: name + free-form LLM instructions
    + rating scale. Every active metric is applied to every dialog of a day."""

    __tablename__ = "analysis_metrics"

    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    prompt: Mapped[str] = mapped_column(Text)
    scale_max: Mapped[int] = mapped_column(Integer, default=10)  # 5 or 10
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class MetricEvaluation(UUIDMixin, Base):
    """Result of applying one metric to one dialog."""

    __tablename__ = "metric_evaluations"
    __table_args__ = (
        UniqueConstraint("dialog_id", "metric_id", name="uq_metric_eval_dialog"),
    )

    day_recording_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("day_recordings.id"), index=True
    )
    dialog_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("dialogs.id"), index=True)
    metric_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("analysis_metrics.id"), index=True
    )
    applicable: Mapped[bool] = mapped_column(Boolean, default=False)
    score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    good_json: Mapped[list] = mapped_column(JSONB, default=list)
    bad_json: Mapped[list] = mapped_column(JSONB, default=list)
    comment: Mapped[str] = mapped_column(Text, default="")


class MetricsDaily(UUIDMixin, Base):
    """Aggregated result of one recording session (see DayRecording)."""

    __tablename__ = "metrics_daily"
    __table_args__ = (
        UniqueConstraint("day_recording_id", name="uq_metrics_day_recording"),
    )

    day_recording_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("day_recordings.id"), index=True
    )
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"), index=True)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), index=True)
    employee_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("employees.id"), nullable=True
    )
    date: Mapped[date] = mapped_column(Date, index=True)
    dialogs_total: Mapped[int] = mapped_column(Integer, default=0)
    sales_count: Mapped[int] = mapped_column(Integer, default=0)
    conversion: Mapped[float | None] = mapped_column(Float, nullable=True)
    upsell_count: Mapped[int] = mapped_column(Integer, default=0)
    avg_script_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Reduce-stage output: top deviations + recommendations for the day.
    summary_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
