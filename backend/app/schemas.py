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


class EmployeeUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=2, max_length=255)
    active: bool | None = None
    login: str | None = Field(default=None, max_length=64)
    access_scope: str | None = Field(default=None, pattern="^(own|all)$")
    scripts_access: str | None = Field(default=None, pattern="^(read|edit)$")


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


CallOutcomeTag = Literal["", "booked", "callback", "refused"]
CallOutcome = Literal["", "booked", "callback", "refused", "no_answer"]


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
    # Итог звонка, если разговор дошёл до этого блока: «Запись» — записан,
    # «Перезвоню» — перезвонить. По нему аналитика считает конверсию без
    # лишних кликов администратора.
    outcome: CallOutcomeTag = ""


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
    # «Нет нужного ответа» на этом шаге — что сказал клиент.
    gap: str = Field(default="", max_length=300)


class CallRunIn(BaseModel):
    """Состояние звонка целиком — админка присылает его после каждого шага.
    Повторная отправка того же id перезаписывает звонок: шаг назад убирает
    шаг и в статистике."""

    section_id: uuid.UUID
    studio: str = Field(default="", max_length=120)
    lang: ScriptLangCode = "ru"
    flow_version: datetime | None = None
    path: list[CallRunStep] = Field(min_length=1, max_length=300)
    finished: bool = False
    outcome: CallOutcome = ""
    client_name: str = Field(default="", max_length=120)
    client_phone: str = Field(default="", max_length=40)
    # Только для итога «Перезвонить».
    callback_at: datetime | None = None
    callback_note: str = Field(default="", max_length=500)
    # Звонок по перезвону: завершится — перезвон закроется сам.
    callback_of: uuid.UUID | None = None


class CallStatSection(BaseModel):
    id: uuid.UUID
    title: str
    runs: int = 0
    deleted: bool = False


class CallStatTotals(BaseModel):
    runs: int = 0
    # Идут прямо сейчас — обновлялись последние 30 минут и не завершены.
    live: int = 0
    booked: int = 0
    callback: int = 0
    refused: int = 0
    no_answer: int = 0
    # Брошены без итога: не дошли до конца и итог не отмечен.
    no_outcome: int = 0
    # Записан / дозвонились (все, кроме «не дозвонились»).
    conversion: float | None = None
    avg_seconds: float | None = None
    avg_steps: float | None = None


class CallAnswerCount(BaseModel):
    label: str
    count: int


class CallGapStat(BaseModel):
    """«Нет нужного ответа»: где сценарию не хватает ответа клиенту."""

    node_id: str
    title: str
    count: int = 0
    # Последние случаи — что говорил клиент.
    examples: list[str] = []


class CallVersionStat(BaseModel):
    """Звонки по одной версии сценария (время правки)."""

    version: datetime | None = None
    note: str = ""
    runs: int = 0
    booked: int = 0
    conversion: float | None = None
    avg_steps: float | None = None
    avg_seconds: float | None = None


class CallSliceStat(BaseModel):
    """Звонки в разрезе: студия, час, день недели."""

    key: str
    runs: int = 0
    booked: int = 0
    conversion: float | None = None


class CallFunnelStep(BaseModel):
    """Этап воронки. Считаются только разговоры: «не дозвонились» — не
    разговор, доли — от дозвонившихся."""

    node_id: str
    title: str
    # Сколько звонков дошли до этого этапа.
    reached: int = 0
    # Сколько звонков оборвались на нём без записи.
    ended_here: int = 0
    # Медиана времени на этапе, секунды.
    median_seconds: float | None = None
    answers: list[CallAnswerCount] = []
    # Сколько раз на этапе не нашлось нужного ответа.
    gaps: int = 0


class CallObjectionStat(BaseModel):
    node_id: str
    title: str
    runs: int = 0
    booked: int = 0
    ended_here: int = 0


class CallEndStat(BaseModel):
    node_id: str
    title: str
    group: str = "main"
    count: int = 0
    callback: int = 0
    refused: int = 0
    no_outcome: int = 0


class CallUserStat(BaseModel):
    user_key: str
    name: str = ""
    runs: int = 0
    booked: int = 0
    callback: int = 0
    refused: int = 0
    no_answer: int = 0
    no_outcome: int = 0
    conversion: float | None = None
    avg_steps: float | None = None
    avg_seconds: float | None = None
    # Где чаще всего обрываются его звонки без записи.
    top_drop: CallEndStat | None = None
    # node_id этапа → сколько его разговоров (без «не дозвонились») до него дошли.
    reach: dict[str, int] = {}


class CallStatsOut(BaseModel):
    sections: list[CallStatSection] = []
    section_id: uuid.UUID | None = None
    # Когда сценарий последний раз правили — звонки до и после правки
    # шли по разным текстам.
    flow_changed_at: datetime | None = None
    totals: CallStatTotals = CallStatTotals()
    funnel: list[CallFunnelStep] = []
    objections: list[CallObjectionStat] = []
    ends: list[CallEndStat] = []
    users: list[CallUserStat] = []
    gaps: list[CallGapStat] = []
    versions: list[CallVersionStat] = []
    studios: list[CallSliceStat] = []
    hours: list[CallSliceStat] = []
    weekdays: list[CallSliceStat] = []
    # Цель по конверсии в запись, доля 0–1; None — не задана.
    target: float | None = None
    # Открытых перезвонов по сценарию — на сейчас.
    callbacks_open: int = 0


class CallTargetIn(BaseModel):
    # Процент, 1–100; null — убрать цель.
    target: int | None = Field(default=None, ge=1, le=100)


class CallbackOut(BaseModel):
    id: uuid.UUID
    section_id: uuid.UUID
    section_title: str = ""
    user_name: str = ""
    client_name: str = ""
    client_phone: str = ""
    callback_at: datetime | None = None
    callback_note: str = ""
    started_at: datetime
    last_node_title: str = ""
    # Звонили ли по нему ещё раз (новый звонок не закрыл перезвон).
    attempts: int = 0


class CallbackPatch(BaseModel):
    done: bool = True
    callback_at: datetime | None = None


class CallRunPathStep(BaseModel):
    title: str = ""
    group: str = "main"
    answer: str = ""
    gap: str = ""


class CallRunOut(BaseModel):
    id: uuid.UUID
    section_title: str = ""
    user_name: str = ""
    studio: str = ""
    lang: str = "ru"
    started_at: datetime
    seconds: float | None = None
    steps: int = 0
    last_node_title: str = ""
    outcome: str = ""
    # live — идёт сейчас; ended — завершён; dropped — брошен без итога.
    status: Literal["live", "ended", "dropped"] = "ended"
    path: list[CallRunPathStep] = []
    client_name: str = ""
    client_phone: str = ""
    callback_at: datetime | None = None
    callback_note: str = ""
    callback_done_at: datetime | None = None
    # Запись смены, на которой был этот звонок, и место в ней.
    recording_id: uuid.UUID | None = None
    recording_offset_s: float | None = None


class CallRunsPage(BaseModel):
    items: list[CallRunOut] = []
    next_cursor: str = ""
