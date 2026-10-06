"""Pydantic schemas for the API."""
import uuid
from datetime import date, datetime

from typing import Literal

from pydantic import model_validator, BaseModel, Field, field_validator


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
    status_changed_at: datetime | None = None
    # Смена «в очереди» или «обрабатывается», но статус не двигался дольше
    # положенного — воркер её потерял. Админке это нужно, чтобы снова показать
    # «Пересчитать» и «Удалить».
    stale: bool = False
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
    can_edit_scripts: bool = False
    # Право в продукте «CRM»: own — свои сделки, all — все и настройка.
    crm_scope: str = "own"
    can_view_all_crm: bool = False
    can_manage_crm: bool = False
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
    scripts_access: str = "read"
    crm_access: str = "own"
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
    scripts_access: str = Field(default="read", pattern="^(read|edit)$")
    crm_access: str = Field(default="own", pattern="^(own|all)$")


class EmployeeUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=2, max_length=255)
    active: bool | None = None
    login: str | None = Field(default=None, max_length=64)
    access_scope: str | None = Field(default=None, pattern="^(own|all)$")
    scripts_access: str | None = Field(default=None, pattern="^(read|edit)$")
    crm_access: str | None = Field(default=None, pattern="^(own|all)$")


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


# --- Скрипты администраторов ---

PLAYBOOK_LANGS = ("ru", "en", "ka")


class PlaybookMessage(BaseModel):
    """Одно сообщение на трёх языках. Пустая строка — перевода нет: админка
    скажет об этом прямо, а не подставит молча русский текст в английский чат."""

    label: str = Field(default="", max_length=200)
    ru: str = Field(default="", max_length=20000)
    en: str = Field(default="", max_length=20000)
    ka: str = Field(default="", max_length=20000)

    def has_text(self) -> bool:
        return any(getattr(self, lang).strip() for lang in PLAYBOOK_LANGS)


class PlaybookVariant(BaseModel):
    label: str = Field(default="", max_length=120)
    messages: list[PlaybookMessage] = Field(min_length=1, max_length=30)


PlaybookKind = Literal["chat", "call", "task", "info"]


class PlaybookItemIn(BaseModel):
    section_id: uuid.UUID
    title: str = Field(min_length=1, max_length=255)
    kind: PlaybookKind = "chat"
    keywords: str = Field(default="", max_length=1000)
    note: str = Field(default="", max_length=5000)
    follow_up: str = Field(default="", max_length=5000)
    variants: list[PlaybookVariant] = Field(min_length=1, max_length=12)
    # Что изменили — обязательно при правке, при создании подставляется
    # «Новый скрипт». Хранится только последний.
    change_note: str = Field(default="", max_length=500)

    @field_validator("title")
    @classmethod
    def title_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Название скрипта не может быть пустым")
        return value

    @field_validator("variants")
    @classmethod
    def something_to_send(cls, variants: list[PlaybookVariant]) -> list[PlaybookVariant]:
        """Скрипт без единого текста — пустая карточка, которую найдут поиском
        и не смогут ничего скопировать."""
        for variant in variants:
            if not any(m.has_text() for m in variant.messages):
                name = f"«{variant.label}»" if variant.label else "скрипта"
                raise ValueError(f"В варианте {name} нет ни одного текста")
        return variants


class PlaybookItemOut(BaseModel):
    id: uuid.UUID
    section_id: uuid.UUID
    title: str
    kind: PlaybookKind
    keywords: str = ""
    note: str = ""
    follow_up: str = ""
    variants: list[PlaybookVariant] = []
    position: int = 0
    updated_at: datetime | None = None
    updated_by: str = ""
    change_note: str = ""

    model_config = {"from_attributes": True}


ICON_KEY = r"^[a-z0-9-]{0,40}$"


class CallText(BaseModel):
    """Реплика администратора на трёх языках; пустой язык — показывается
    русский с пометкой."""

    ru: str = Field(default="", max_length=6000)
    en: str = Field(default="", max_length=6000)
    ka: str = Field(default="", max_length=6000)


class CallAnswer(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    # id блока, куда ведёт ответ.
    to: str = Field(pattern=r"^[a-z0-9_-]{1,40}$")


class CallNode(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9_-]{1,40}$")
    title: str = Field(min_length=1, max_length=120)
    # main — этап разговора; objection — возражение или вопрос клиента:
    # они всегда под рукой справа, к ним прыгают из любого места.
    group: Literal["main", "objection"] = "main"
    text: CallText = CallText()
    hint: str = Field(default="", max_length=2000)
    client: str = Field(default="", max_length=300)
    answers: list[CallAnswer] = Field(default=[], max_length=12)


class CallFlow(BaseModel):
    start: str
    nodes: list[CallNode] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def links_are_valid(self) -> "CallFlow":
        ids = [n.id for n in self.nodes]
        if len(set(ids)) != len(ids):
            raise ValueError("У двух блоков одинаковый id")
        known = set(ids)
        if self.start not in known:
            raise ValueError("Первый блок звонка не найден")
        for n in self.nodes:
            for a in n.answers:
                if a.to not in known:
                    raise ValueError(f"Ответ «{a.label}» в блоке «{n.title}» ведёт в удалённый блок")
        return self


class CallFlowIn(BaseModel):
    flow: CallFlow
    change_note: str = Field(default="", max_length=500)


class PlaybookSectionIn(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    icon: str = Field(default="", pattern=ICON_KEY)
    # text — раздел текстовых скриптов; call — раздел-звонок с одним сценарием.
    kind: Literal["text", "call"] = "text"


class PlaybookSectionPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    icon: str | None = Field(default=None, pattern=ICON_KEY)


class PlaybookSectionOut(BaseModel):
    id: uuid.UUID
    title: str
    icon: str = ""
    position: int = 0
    kind: Literal["text", "call"] = "text"
    items: list[PlaybookItemOut] = []
    # Только у звонка.
    flow: CallFlow | None = None
    flow_updated_at: datetime | None = None
    flow_updated_by: str = ""
    flow_change_note: str = ""


class PlaybookOut(BaseModel):
    sections: list[PlaybookSectionOut] = []


class PlaybookOrder(BaseModel):
    ids: list[uuid.UUID] = Field(max_length=500)


# --- Настройки скриптов: студии, имена администраторов, переменные ---

VARIABLE_KEY = r"^[0-9A-Za-zА-Яа-яЁё_]{1,40}$"
# Имена, которые админка подставляет сама; своей переменной их не назвать.
BUILTIN_VARIABLES = ("админ", "студия")


class LangText(BaseModel):
    ru: str = Field(default="", max_length=200)
    en: str = Field(default="", max_length=200)
    ka: str = Field(default="", max_length=200)


class PlaybookVariable(BaseModel):
    """Своя переменная. text — значения на трёх языках; date — дата «через
    N дней от сегодня», считается при показе и подставляется как ДД.ММ на
    любом языке («есть свободные места на 12.06 и 13.06»)."""

    key: str = Field(pattern=VARIABLE_KEY)
    type: Literal["text", "date"] = "text"
    description: str = Field(default="", max_length=300)
    ru: str = Field(default="", max_length=2000)
    en: str = Field(default="", max_length=2000)
    ka: str = Field(default="", max_length=2000)
    offset_days: int = Field(default=0, ge=-365, le=365)


class PlaybookSettingsIn(BaseModel):
    # location_id -> названия; employee_id -> имена.
    studios: dict[uuid.UUID, LangText] = {}
    admins: dict[uuid.UUID, LangText] = {}
    variables: list[PlaybookVariable] = Field(default=[], max_length=100)

    @field_validator("variables")
    @classmethod
    def unique_keys(cls, variables: list[PlaybookVariable]) -> list[PlaybookVariable]:
        seen: set[str] = set()
        for v in variables:
            key = v.key.lower()
            if key in BUILTIN_VARIABLES:
                raise ValueError(f"{{{v.key}}} подставляется автоматически — выберите другое имя")
            if key in seen:
                raise ValueError(f"Переменная {{{v.key}}} задана дважды")
            seen.add(key)
        return variables


class StudioNamesOut(LangText):
    location_id: uuid.UUID
    location_name: str
    active: bool = True


class AdminNamesOut(LangText):
    employee_id: uuid.UUID
    full_name: str
    has_login: bool = False


class PlaybookSettingsOut(BaseModel):
    """Настройки, уже собранные с людьми и студиями: у кого имя не задано,
    приходит имя по умолчанию — русское из карточки сотрудника или точки."""

    studios: list[StudioNamesOut] = []
    admins: list[AdminNamesOut] = []
    variables: list[PlaybookVariable] = []
    updated_at: datetime | None = None
    updated_by: str = ""


# --- Хронология и предложения ---

class PlaybookChangeOut(BaseModel):
    id: uuid.UUID
    item_id: uuid.UUID | None = None
    item_title: str = ""
    action: Literal["created", "updated", "deleted"]
    before: dict | None = None
    after: dict | None = None
    change_note: str = ""
    author: str = ""
    created_at: datetime

    model_config = {"from_attributes": True}


class PlaybookChangesPage(BaseModel):
    items: list[PlaybookChangeOut] = []
    # Курсор следующей порции; пусто — дальше ничего нет.
    next_cursor: str = ""


class PlaybookSuggestionIn(BaseModel):
    text: str = Field(min_length=3, max_length=3000)
    # Скрипт, на карточке которого нажали «Предложить изменения».
    item_id: uuid.UUID | None = None


class PlaybookSuggestionOut(BaseModel):
    id: uuid.UUID
    author_name: str = ""
    item_id: uuid.UUID | None = None
    item_title: str = ""
    text: str
    status: Literal["open", "done"] = "open"
    created_at: datetime
    resolved_at: datetime | None = None
    resolved_by: str = ""
    # Новое для того, кто смотрит: пришло после его прошлого просмотра.
    unread: bool = False

    model_config = {"from_attributes": True}


class PlaybookSuggestionsPage(BaseModel):
    items: list[PlaybookSuggestionOut] = []
    next_cursor: str = ""


class PlaybookSuggestionPatch(BaseModel):
    status: Literal["open", "done"]


class UnreadOut(BaseModel):
    count: int = 0


# --- Статистика копирований ---

ScriptLangCode = Literal["ru", "en", "ka"]


class PlaybookCopyIn(BaseModel):
    item_id: uuid.UUID
    lang: ScriptLangCode
    studio: str = Field(default="", max_length=120)
    source: Literal["card", "assist"] = "card"


class LangCounts(BaseModel):
    total: int = 0
    ru: int = 0
    en: int = 0
    ka: int = 0


class CopyStatItem(LangCounts):
    item_id: uuid.UUID | None = None
    title: str = ""
    section: str = ""
    # Скрипт удалён — в статистике остаётся под последним названием.
    deleted: bool = False


class CopyStatUser(LangCounts):
    user_key: str
    name: str = ""


class CopyStatsOut(BaseModel):
    totals: LangCounts
    items: list[CopyStatItem] = []
    users: list[CopyStatUser] = []


# --- ИИ-помощник ---

class AssistIn(BaseModel):
    message: str = Field(min_length=2, max_length=4000)
    # Язык, выбранный вверху скриптов, и студия — подсказка ИИ; язык
    # ответа он определяет по сообщению клиента.
    lang: ScriptLangCode = "ru"
    studio: str = Field(default="", max_length=120)


class AssistMatch(BaseModel):
    item_id: uuid.UUID
    title: str
    section: str = ""
    why: str = ""


class AssistIssue(BaseModel):
    claim: str = ""
    reason: str = ""


class AssistSource(BaseModel):
    # Скрипт — с id и названием; правила продаж и переменные — только меткой.
    item_id: uuid.UUID | None = None
    title: str
    section: str = ""


class AssistOut(BaseModel):
    # ready — показываем; needs_clarification — данных в базе нет;
    # unverified — ответ не прошёл проверку и не показывается.
    status: Literal["ready", "needs_clarification", "unverified"]
    language: ScriptLangCode
    matches: list[AssistMatch] = []
    # Только проверенный ответ: непроверенный сюда не попадает.
    reply: str = ""
    verified: bool = False
    attempts: int = 1
    sources: list[AssistSource] = []
    missing_information: str = ""
    issues: list[AssistIssue] = []
    comment: str = ""


class AiPromptOut(BaseModel):
    prompt: str
    default_prompt: str
    is_default: bool
    # Промпт проверяющего — второго, независимого вызова.
    verify_prompt: str
    default_verify_prompt: str
    verify_is_default: bool
    # Модель, которой ИИ-помощник отвечает сейчас: заданная в админке или,
    # если там пусто, OPENAI_MODEL с сервера.
    model: str
    model_saved: str = ""
    model_default: str = ""
    # На сервере задан OPENAI_API_KEY.
    configured: bool


class AiPromptIn(BaseModel):
    # Пусто — вернуть стандартный.
    prompt: str = Field(default="", max_length=20000)
    verify_prompt: str = Field(default="", max_length=20000)
    # Пусто — модель с сервера (OPENAI_MODEL).
    model: str = Field(default="", max_length=120)


# --- Аналитика звонков ---

class CallRunStep(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9_-]{1,40}$")
    title: str = Field(default="", max_length=120)
    group: Literal["main", "objection"] = "main"
    # Что ответил клиент на этом шаге (кнопка) или «→ переход» из панели.
    answer: str = Field(default="", max_length=120)
    at: datetime


class CallRunIn(BaseModel):
    """Путь звонка по сценарию целиком — админка присылает его после каждого
    шага. Повторная отправка того же id перезаписывает звонок: шаг назад
    убирает шаг и в статистике."""

    section_id: uuid.UUID
    path: list[CallRunStep] = Field(min_length=1, max_length=300)
    # Дошли до конца сценария или нажали «Новый звонок».
    finished: bool = False


class CallStatSection(BaseModel):
    id: uuid.UUID
    title: str
    runs: int = 0
    deleted: bool = False


class CallStatTotals(BaseModel):
    runs: int = 0
    # Дошли до конца сценария — до блока без ответов.
    completed: int = 0
    avg_steps: float | None = None


class CallFunnelStep(BaseModel):
    node_id: str
    title: str
    # Сколько звонков дошли до этого этапа.
    reached: int = 0
    # Сколько звонков на нём закончились.
    ended_here: int = 0


class CallEndStat(BaseModel):
    """Где заканчивались звонки — по последнему блоку."""

    node_id: str
    title: str
    group: str = "main"
    # Блок без ответов — нормальный конец сценария, а не обрыв.
    script_end: bool = False
    count: int = 0


class CallStatsOut(BaseModel):
    sections: list[CallStatSection] = []
    section_id: uuid.UUID | None = None
    totals: CallStatTotals = CallStatTotals()
    funnel: list[CallFunnelStep] = []
    ends: list[CallEndStat] = []


# --- CRM: разбор переписок и движения сделок --------------------------------

CrmScope = Literal["own", "all"]


class CrmCriterionOut(BaseModel):
    id: uuid.UUID
    name: str
    prompt: str = ""
    scale_max: int = 10
    active: bool = True
    position: int = 0

    model_config = {"from_attributes": True}


class CrmCriterionCreate(BaseModel):
    name: str = Field(min_length=2, max_length=255)
    prompt: str = Field(default="", max_length=10000)
    scale_max: int = Field(default=10, ge=2, le=10)


class CrmCriterionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=255)
    prompt: str | None = Field(default=None, max_length=10000)
    scale_max: int | None = Field(default=None, ge=2, le=10)
    active: bool | None = None
    position: int | None = None


class CrmManagerOut(BaseModel):
    """Менеджер, встретившийся в данных CRM: ключ и имя как в CRM, сколько
    сделок за ним и какому сотруднику админки он сопоставлен."""

    key: str
    name: str = ""
    deals: int = 0
    employee_id: uuid.UUID | None = None
    # Сопоставлен явно в настройках (иначе — по совпадению имени или никак).
    mapped: bool = False


class CrmSettingsOut(BaseModel):
    prompt: str
    default_prompt: str
    is_default: bool
    summary_prompt: str
    default_summary_prompt: str
    summary_is_default: bool
    pipeline_rules: str
    default_pipeline_rules: str
    pipeline_is_default: bool
    # Модель, которой идёт разбор: заданная в админке или LLM_MODEL_STAGE2.
    model: str
    model_saved: str = ""
    model_default: str = ""
    timezone: str = "Asia/Tbilisi"
    auto_run: bool = True
    run_hour: int = 20
    max_deals: int = 400
    integration_key: str = ""
    ingest_url: str = ""
    manager_map: dict[str, uuid.UUID | None] = {}
    known_managers: list[CrmManagerOut] = []
    # На сервере задан ANTHROPIC_API_KEY.
    configured: bool = False
    # Сводка в Telegram: на сервере заданы TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID.
    telegram_configured: bool = False
    dashboard_url: str = ""
    updated_at: datetime | None = None
    updated_by: str = ""


class CrmSettingsIn(BaseModel):
    # Пусто — стандартный текст.
    prompt: str = Field(default="", max_length=30000)
    summary_prompt: str = Field(default="", max_length=10000)
    pipeline_rules: str = Field(default="", max_length=30000)
    # Пусто — модель с сервера.
    model: str = Field(default="", max_length=120)
    timezone: str = Field(default="Asia/Tbilisi", max_length=64)
    auto_run: bool = True
    run_hour: int = Field(default=20, ge=0, le=23)
    max_deals: int = Field(default=400, ge=1, le=2000)
    manager_map: dict[str, uuid.UUID | None] = {}

    @field_validator("timezone")
    @classmethod
    def known_timezone(cls, value: str) -> str:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        value = value.strip() or "Asia/Tbilisi"
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError(f"Неизвестный часовой пояс: {value}") from None
        return value


class CrmDealOut(BaseModel):
    id: uuid.UUID
    external_id: str
    title: str = ""
    contact_name: str = ""
    contact_phone: str = ""
    contact_key: str = ""
    pipeline: str = ""
    stage: str = ""
    status: str = "open"
    source: str = ""
    manager_key: str = ""
    manager_name: str = ""
    employee_id: uuid.UUID | None = None
    url: str = ""
    budget: float | None = None
    created_at_crm: datetime | None = None
    last_activity_at: datetime | None = None

    model_config = {"from_attributes": True}


class CrmProblem(BaseModel):
    kind: Literal["chat", "pipeline", "speed"] = "chat"
    text: str
    quote: str = ""


class CrmScriptsCheck(BaseModel):
    used: list[str] = []
    deviations: list[str] = []


class CrmPipelineCheck(BaseModel):
    ok: bool = True
    expected_stage: str = ""
    comment: str = ""


class CrmScoreOut(BaseModel):
    criterion_id: uuid.UUID
    name: str = ""
    scale_max: int = 10
    applicable: bool = False
    score: int | None = None
    comment: str = ""


class CrmReviewOut(BaseModel):
    id: uuid.UUID
    run_id: uuid.UUID
    date: date
    deal: CrmDealOut
    employee_id: uuid.UUID | None = None
    employee_name: str = ""
    manager_key: str = ""
    manager_name: str = ""
    category: str = "other"
    severity: Literal["ok", "warning", "critical"] = "ok"
    problem: bool = False
    summary: str = ""
    problems: list[CrmProblem] = []
    good: list[str] = []
    recommendations: list[str] = []
    scripts: CrmScriptsCheck = CrmScriptsCheck()
    pipeline: CrmPipelineCheck = CrmPipelineCheck()
    messages_in: int = 0
    messages_out: int = 0
    events_count: int = 0
    first_reply_minutes: float | None = None
    max_reply_minutes: float | None = None
    unanswered: bool = False
    scores: list[CrmScoreOut] = []


class CrmMessageOut(BaseModel):
    id: uuid.UUID
    direction: str
    channel: str = ""
    author_name: str = ""
    text: str = ""
    at: datetime
    # Внутри разбираемого дня; иначе — контекст до него.
    in_day: bool = True


class CrmEventOut(BaseModel):
    id: uuid.UUID
    kind: str
    from_value: str = ""
    to_value: str = ""
    text: str = ""
    author_name: str = ""
    at: datetime
    in_day: bool = True


class CrmReviewDetailOut(CrmReviewOut):
    messages: list[CrmMessageOut] = []
    events: list[CrmEventOut] = []


class CrmRunOut(BaseModel):
    id: uuid.UUID
    date: date
    status: str
    status_detail: str = ""
    # В очереди или обрабатывается, но статус давно не двигался — воркер
    # потерял разбор; «Разобрать заново» снова доступна.
    stale: bool = False
    trigger: str = "manual"
    deals_total: int = 0
    reviews_done: int = 0
    problems_count: int = 0
    llm_input_tokens: int = 0
    llm_output_tokens: int = 0
    llm_calls: int = 0
    cost_usd: float | None = None
    created_at: datetime
    finished_at: datetime | None = None


class CrmRunsOut(BaseModel):
    runs: list[CrmRunOut] = []
    # Дни с перепиской или движением, которые ещё не разбирали.
    pending_dates: list[date] = []
    # В базе есть хоть одна сделка — интеграция присылает данные.
    has_data: bool = False
    # Отчётный день, который идёт сейчас (его ещё можно разобрать частично).
    today: date
    # Час окончания отчётного дня; 0 — календарный день.
    day_end_hour: int = 0


class CrmRunReportOut(BaseModel):
    run: CrmRunOut
    summary: dict | None = None
    stats: dict | None = None
    reviews: list[CrmReviewOut] = []
    criteria: list[CrmCriterionOut] = []
    # Границы отчётного дня — при часе окончания 20:00 он захватывает две даты.
    window_from: datetime | None = None
    window_to: datetime | None = None
    day_end_hour: int = 0
    telegram_configured: bool = False


class CrmNotifyOut(BaseModel):
    delivered: int = 0
    chats: int = 0
    preview: str = ""


# --- Статистика CRM за период ---

class CrmTotals(BaseModel):
    deals: int = 0
    problems: int = 0
    critical: int = 0
    unanswered: int = 0
    problem_share: float | None = None
    avg_first_reply_minutes: float | None = None
    # Дней с разбором и их стоимость — только в общих итогах.
    runs: int = 0
    cost_usd: float = 0.0


class CrmCriterionStat(BaseModel):
    criterion_id: uuid.UUID
    name: str
    scale_max: int = 10
    count: int = 0
    avg_score: float | None = None
    prev_avg_score: float | None = None


class CrmCategoryStat(BaseModel):
    category: str
    count: int = 0
    problems: int = 0


class CrmManagerStat(BaseModel):
    employee_id: uuid.UUID | None = None
    manager_key: str = ""
    name: str
    totals: CrmTotals
    previous: CrmTotals
    criteria: list[CrmCriterionStat] = []
    categories: list[CrmCategoryStat] = []


class CrmTrendPoint(BaseModel):
    date: date
    deals: int = 0
    problems: int = 0
    problem_share: float | None = None
    # criterion_id (строкой) -> средняя оценка за день
    avg_scores: dict[str, float] = {}


class CrmStatsOut(BaseModel):
    date_from: date
    date_to: date
    prev_date_from: date
    prev_date_to: date
    totals: CrmTotals
    previous: CrmTotals
    criteria: list[CrmCriterionStat] = []
    managers: list[CrmManagerStat] = []
    categories: list[CrmCategoryStat] = []
    trend: list[CrmTrendPoint] = []


# --- Приём данных из CRM ---

class CrmDealIn(BaseModel):
    """Сделка как её присылает интеграция. Поля, кроме id, необязательны:
    то, чего в пакете нет, в базе не трогается — можно прислать только
    смену этапа."""

    id: str = Field(min_length=1, max_length=64)
    title: str | None = Field(default=None, max_length=255)
    contact_name: str | None = Field(default=None, max_length=255)
    contact_phone: str | None = Field(default=None, max_length=64)
    # id контакта в CRM — чтобы сообщение без сделки нашло её по контакту.
    contact_id: str | None = Field(default=None, max_length=64)
    pipeline: str | None = Field(default=None, max_length=120)
    stage: str | None = Field(default=None, max_length=120)
    # open | won | lost; чужие названия статусов приводятся к этим трём
    # (success → won, failed → lost, остальное — open), а не роняют пакет.
    status: str | None = Field(default=None, max_length=32)
    source: str | None = Field(default=None, max_length=120)
    manager_id: str | None = Field(default=None, max_length=64)
    manager_name: str | None = Field(default=None, max_length=255)
    url: str | None = Field(default=None, max_length=512)
    budget: float | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class CrmMessageIn(BaseModel):
    id: str | None = Field(default=None, max_length=64)
    deal_id: str = Field(min_length=1, max_length=64)
    # in — от клиента, out — от администратора.
    direction: Literal["in", "out"]
    channel: str = Field(default="", max_length=40)
    author_id: str = Field(default="", max_length=64)
    author_name: str = Field(default="", max_length=255)
    text: str = Field(default="", max_length=20000)
    at: datetime


class CrmEventIn(BaseModel):
    id: str | None = Field(default=None, max_length=64)
    deal_id: str = Field(min_length=1, max_length=64)
    # stage_change | status_change | note | task | task_done | field_change | call
    kind: str = Field(min_length=1, max_length=32)
    from_value: str = Field(default="", max_length=255, alias="from")
    to_value: str = Field(default="", max_length=255, alias="to")
    text: str = Field(default="", max_length=20000)
    author_id: str = Field(default="", max_length=64)
    author_name: str = Field(default="", max_length=255)
    at: datetime

    model_config = {"populate_by_name": True}


class CrmIngestIn(BaseModel):
    deals: list[CrmDealIn] = Field(default=[], max_length=2000)
    messages: list[CrmMessageIn] = Field(default=[], max_length=5000)
    events: list[CrmEventIn] = Field(default=[], max_length=5000)


class CrmIngestOut(BaseModel):
    deals_created: int = 0
    deals_updated: int = 0
    # Сообщение или событие пришло по сделке, которой ещё нет: заведена
    # заглушка с этим id, чтобы ничего не потерять.
    deals_stubbed: int = 0
    messages_added: int = 0
    messages_skipped: int = 0
    events_added: int = 0
    events_skipped: int = 0


# --- amoCRM ---

class AmoPipelineOut(BaseModel):
    id: str
    name: str
    stages: list[str] = []


class AmoStatusOut(BaseModel):
    connected: bool = False
    enabled: bool = True
    subdomain: str = ""
    domain: str = "amocrm.ru"
    account_name: str = ""
    # token — долгосрочный токен; oauth — код авторизации с обновлением.
    auth: str = ""
    token_hint: str = ""
    token_expires_at: str | None = None
    sync_every_minutes: int = 15
    lookback_days: int = 7
    last_sync_at: str | None = None
    last_sync_result: str = ""
    last_error: str = ""
    last_error_at: str | None = None
    last_webhook_at: str | None = None
    webhooks_received: int = 0
    webhook_url: str = ""
    webhook_events: list[str] = []
    pipelines: list[AmoPipelineOut] = []
    users: int = 0


class AmoConnectIn(BaseModel):
    subdomain: str = Field(min_length=1, max_length=200)
    domain: Literal["amocrm.ru", "kommo.com", "amocrm.com"] = "amocrm.ru"
    # Долгосрочный токен приватной интеграции — самый простой способ.
    token: str = Field(default="", max_length=4000)
    # Или код авторизации OAuth с реквизитами интеграции.
    client_id: str = Field(default="", max_length=120)
    client_secret: str = Field(default="", max_length=400)
    redirect_uri: str = Field(default="", max_length=512)
    code: str = Field(default="", max_length=4000)
    enabled: bool = True
    sync_every_minutes: int = Field(default=15, ge=5, le=240)
    lookback_days: int = Field(default=7, ge=1, le=60)


class AmoSyncOut(BaseModel):
    result: str = ""
    applied: CrmIngestOut = CrmIngestOut()

