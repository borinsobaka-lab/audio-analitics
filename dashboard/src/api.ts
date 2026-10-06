// Тонкий клиент API. Токен — либо сессия сотрудника (логин и пароль), либо
// владельческий ADMIN_API_TOKEN; заголовок в обоих случаях один и тот же.

const BASE = import.meta.env.VITE_API_URL || "";

const TOKEN_KEY = "aa_access_token";

let authToken: string | null = localStorage.getItem(TOKEN_KEY);

export function setToken(token: string | null) {
  authToken = token;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getToken(): string | null {
  return authToken;
}

/** Сессию мог отозвать администратор — сбросом пароля или отключением. Тогда
 *  токен в браузере уже мусор, и держать его значит показывать пользователю
 *  ошибку на каждой странице вместо формы входа. */
type Listener = () => void;
const expiredListeners = new Set<Listener>();

export function onSessionExpired(fn: Listener): () => void {
  expiredListeners.add(fn);
  return () => {
    expiredListeners.delete(fn);
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string>),
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const resp = await fetch(`${BASE}${path}`, { ...init, headers });
  if (resp.status === 401 && authToken) {
    setToken(null);
    expiredListeners.forEach((fn) => fn());
  }
  if (!resp.ok) {
    const body = await resp.text();
    // FastAPI puts the human-readable reason in {"detail": "..."}.
    let message = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.detail === "string") message = parsed.detail;
      // Ошибка проверки полей приходит списком; человеку нужен текст, а не JSON.
      else if (Array.isArray(parsed.detail))
        message = parsed.detail
          .map((d: { msg?: string }) => String(d.msg ?? "").replace(/^Value error, /, ""))
          .filter(Boolean)
          .join("; ");
    } catch {
      /* keep the raw body */
    }
    throw new Error(message);
  }
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

/** Загрузка файла: Content-Type не ставим — браузер сам добавит границу
 *  multipart, а наш заголовок её затёр бы. */
async function upload<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const resp = await fetch(`${BASE}${path}`, { method: "POST", headers, body: form });
  if (!resp.ok) {
    const body = await resp.text();
    let message = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.detail === "string") message = parsed.detail;
    } catch {
      /* keep the raw body */
    }
    throw new Error(message);
  }
  return resp.json() as Promise<T>;
}

// --- Types mirrored from backend schemas ---

export interface DayRecording {
  id: string;
  location_id: string;
  location_name: string | null;
  date: string;
  status: string;
  status_detail: string;
  status_changed_at: string | null;
  // Разбор числится идущим, но статус не двигался несколько часов: воркер
  // его потерял. Кнопки «Пересчитать» и «Удалить» при этом снова доступны.
  stale: boolean;
  total_duration_s: number | null;
  speech_duration_s: number | null;
  created_at: string | null;
  employee_id: string | null;
  employee_name: string | null;
  metric_stats: MetricStat[];
  asr_seconds: number | null;
  llm_input_tokens: number;
  llm_output_tokens: number;
  llm_calls: number;
  cost_usd: number | null;
}

export interface MetricStat {
  metric_id: string;
  name: string;
  scale_max: number;
  triggered_count: number;
  avg_score: number | null;
}

export interface AnalysisMetric {
  id: string;
  name: string;
  prompt: string;
  scale_max: number;
  active: boolean;
  position: number;
}

export interface MetricEvaluation {
  metric_id: string;
  metric_name: string;
  scale_max: number;
  applicable: boolean;
  score: number | null;
  good: string[];
  bad: string[];
  comment: string;
}

export interface AppRelease {
  id: string;
  platform: string;
  version: string;
  notes: string;
  size_bytes: number;
  published: boolean;
  created_by_name: string;
  created_at: string;
}

export interface Location {
  id: string;
  name: string;
  address: string;
  timezone: string;
  active: boolean;
  shifts_count: number;
}

export type ScriptsAccess = "read" | "edit";
export type CrmAccess = "own" | "all";

export interface Employee {
  id: string;
  /** Точка, где карточку завели. Ни на что не влияет: сотрудник работает на
   *  любой студии, а смена достаётся той, где стоит компьютер. */
  location_id: string;
  full_name: string;
  role: string;
  active: boolean;
  /** Логин в админку. Пусто — сотрудник есть только в приложении записи. */
  login: string | null;
  /** Аналитика: own — видит свои смены; all — видит все и настраивает систему. */
  access_scope: "own" | "all";
  /** Скрипты: read — читает и копирует; edit — правит тексты и разделы. */
  scripts_access: ScriptsAccess;
  /** CRM: own — видит разборы по своим сделкам; all — все сделки и настройки. */
  crm_access: CrmAccess;
  has_password: boolean;
  last_login_at: string | null;
}

/** Пароль приходит ровно один раз — при выдаче доступа или сбросе. */
export interface EmployeeCredentials {
  employee: Employee;
  login: string;
  password: string;
}

export interface Me {
  employee_id: string | null;
  full_name: string;
  login: string | null;
  scope: "own" | "all";
  can_view_all: boolean;
  can_manage: boolean;
  can_edit_scripts: boolean;
  /** CRM: own — разборы своих сделок; all — все сделки и настройка продукта. */
  crm_scope: "own" | "all";
  can_view_all_crm: boolean;
  can_manage_crm: boolean;
  is_owner: boolean;
}

export interface DialogFeedback {
  id: string;
  dialog_id: string;
  metric_id: string;
  agree: boolean;
  comment: string;
  author_name: string;
  subject_name: string;
  created_at: string;
  is_mine: boolean;
}

export interface MetricFeedbackItem {
  id: string;
  day_recording_id: string;
  day_date: string;
  dialog_id: string;
  dialog_start_s: number | null;
  subject_name: string;
  author_name: string;
  comment: string;
  created_at: string;
}

export interface MetricFeedbackStat {
  metric_id: string;
  metric_name: string;
  agree_count: number;
  disagree_count: number;
  disagreements: MetricFeedbackItem[];
}

export type AgreementStatus = "open" | "done" | "missed" | "cancelled";

export interface Agreement {
  id: string;
  employee_id: string | null;
  employee_name: string;
  day_recording_id: string;
  day_date: string;
  dialog_id: string | null;
  dialog_start_s: number | null;
  text: string;
  status: AgreementStatus;
  created_by_name: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by_name: string;
  resolved_day_recording_id: string | null;
  resolution_note: string;
}

export interface Dialog {
  id: string;
  start_s: number;
  end_s: number;
  type: string;
  outcome: string | null;
  brief: string;
  effectiveness_score: number | null;
  upsell_count: number;
  analysis_json: Record<string, unknown> | null;
  evaluations: MetricEvaluation[];
}

export interface DialogTurn {
  speaker_label: string;
  is_manager: boolean | null;
  start_s: number;
  end_s: number;
  text: string;
}

export interface DialogDetail extends Dialog {
  turns: DialogTurn[];
}

export interface DayReport {
  recording: DayRecording;
  dialogs_total: number;
  sales_count: number;
  conversion: number | null;
  upsell_count: number;
  avg_script_score: number | null;
  summary: {
    top_deviations?: string[];
    recommendations?: string[];
    script_suggestions?: string[];
    highlights?: string[];
  } | null;
  metric_stats: MetricStat[];
  dialogs: Dialog[];
  feedback: DialogFeedback[];
  agreements: Agreement[];
  carried_agreements: Agreement[];
}

export interface PromptTemplate {
  id: string;
  key: string;
  name: string;
  description: string;
  content: string;
  model: string | null;
  version: number;
  active: boolean;
  updated_by: string | null;
  created_at: string;
}

export interface ScriptStage {
  key: string;
  title: string;
  description: string;
}

export interface ScriptTemplate {
  id: string;
  name: string;
  version: number;
  stages_json: ScriptStage[];
  body: string;
  active: boolean;
}

// --- Скрипты администраторов ---

export type ScriptLang = "ru" | "en" | "ka";
export type ScriptKind = "chat" | "call" | "task" | "info";

export interface ScriptMessage {
  label: string;
  ru: string;
  en: string;
  ka: string;
}

export interface ScriptVariant {
  label: string;
  messages: ScriptMessage[];
}

export interface ScriptItem {
  id: string;
  section_id: string;
  title: string;
  kind: ScriptKind;
  keywords: string;
  note: string;
  follow_up: string;
  variants: ScriptVariant[];
  position: number;
  updated_at: string | null;
  updated_by: string;
  /** Что изменили при последней правке — показывается внизу карточки. */
  change_note: string;
}

/** Ответ клиента в сценарии звонка — кнопка, ведущая к следующему блоку. */
export interface CallAnswer {
  label: string;
  /** id блока, куда ведёт ответ. */
  to: string;
}

/** Блок сценария звонка: что говорит администратор и куда дальше. */
export interface CallNode {
  id: string;
  title: string;
  /** main — этап разговора; objection — возражение или вопрос клиента. */
  group: "main" | "objection";
  /** Реплика администратора на трёх языках. */
  text: LangText;
  /** Подсказка администратору — клиенту не говорится. */
  hint: string;
  /** Чего ждать от клиента. */
  client: string;
  answers: CallAnswer[];
}

/** Шаг звонка по сценарию — для аналитики. */
export interface CallRunStep {
  id: string;
  title: string;
  group: "main" | "objection";
  answer: string;
  at: string;
}

export interface CallRunIn {
  section_id: string;
  path: CallRunStep[];
  /** Дошли до конца сценария или нажали «Новый звонок». */
  finished: boolean;
}

export interface CallStats {
  sections: { id: string; title: string; runs: number; deleted: boolean }[];
  section_id: string | null;
  totals: { runs: number; completed: number; avg_steps: number | null };
  funnel: { node_id: string; title: string; reached: number; ended_here: number }[];
  ends: { node_id: string; title: string; group: string; script_end: boolean; count: number }[];
  /** Кто звонил по сценарию за период. */
  users: { key: string; name: string; runs: number }[];
}

/** Один звонок в истории: когда, кто, докуда дошёл и где закончился. */
export interface CallRun {
  id: string;
  user_name: string;
  started_at: string;
  seconds: number | null;
  live: boolean;
  steps: number;
  reached: number;
  stages: number;
  reached_title: string;
  last_title: string;
  last_group: string;
  script_end: boolean;
  path: { title: string; group: string; answer: string }[];
}

export interface CallStatsQuery {
  from?: string;
  to?: string;
  section?: string;
  /** Ключ администратора; пусто — все. */
  user?: string;
}

export interface CallFlow {
  start: string;
  nodes: CallNode[];
}

export interface ScriptSection {
  id: string;
  title: string;
  /** Ключ иконки в меню из набора navIcons; пусто — иконка по умолчанию. */
  icon: string;
  position: number;
  /** text — текстовые скрипты; call — звонок с одним сценарием. Старый
   *  сервер поля не присылает — это текстовый раздел. */
  kind?: "text" | "call";
  items: ScriptItem[];
  flow?: CallFlow | null;
  flow_updated_at?: string | null;
  flow_updated_by?: string;
  flow_change_note?: string;
}

export interface Playbook {
  sections: ScriptSection[];
}

export type ScriptItemDraft = Omit<
  ScriptItem,
  "id" | "position" | "updated_at" | "updated_by" | "change_note"
>;

export interface LangText {
  ru: string;
  en: string;
  ka: string;
}

export interface ScriptVariable extends LangText {
  key: string;
  /** text — значения на языках; date — «через N дней от сегодня», ДД.ММ.
   *  Сохранённые до появления дат приходят без поля — это text. */
  type?: "text" | "date";
  description: string;
  offset_days?: number;
}

export interface StudioNames extends LangText {
  location_id: string;
  location_name: string;
  active: boolean;
}

export interface AdminNames extends LangText {
  employee_id: string;
  full_name: string;
  has_login: boolean;
}

/** Настройки скриптов: из них подставляются {админ}, {студия} и свои
 *  переменные — на выбранном языке. */
export interface PlaybookSettings {
  studios: StudioNames[];
  admins: AdminNames[];
  variables: ScriptVariable[];
  updated_at: string | null;
  updated_by: string;
}

/** Версия скрипта в хронологии — всё, что видно в карточке. */
export interface ScriptSnapshot {
  title: string;
  /** У сценария звонка — "call", дальше вместо текстов — flow. */
  kind: ScriptKind | "call";
  flow?: CallFlow;
  section: string;
  keywords: string;
  note: string;
  follow_up: string;
  variants: ScriptVariant[];
}

export interface ScriptChange {
  id: string;
  item_id: string | null;
  item_title: string;
  action: "created" | "updated" | "deleted";
  before: ScriptSnapshot | null;
  after: ScriptSnapshot | null;
  change_note: string;
  author: string;
  created_at: string;
}

export interface ScriptSuggestion {
  id: string;
  author_name: string;
  /** Скрипт, к которому предложение; название — на момент отправки. */
  item_id: string | null;
  item_title: string;
  text: string;
  status: "open" | "done";
  created_at: string;
  resolved_at: string | null;
  resolved_by: string;
  unread: boolean;
}

export interface LangCounts {
  total: number;
  ru: number;
  en: number;
  ka: number;
}

export interface CopyStatItem extends LangCounts {
  item_id: string | null;
  title: string;
  section: string;
  deleted: boolean;
}

export interface CopyStatUser extends LangCounts {
  user_key: string;
  name: string;
}

export interface CopyStats {
  totals: LangCounts;
  items: CopyStatItem[];
  users: CopyStatUser[];
}

export interface AiPrompt {
  prompt: string;
  default_prompt: string;
  is_default: boolean;
  verify_prompt: string;
  default_verify_prompt: string;
  verify_is_default: boolean;
  /** Модель, которой ИИ отвечает сейчас. */
  model: string;
  /** Заданная в админке; пусто — берётся model_default с сервера. */
  model_saved: string;
  model_default: string;
  /** На сервере задан OPENAI_API_KEY. */
  configured: boolean;
}

export interface AssistResult {
  /** ready — показываем; needs_clarification — данных в базе нет;
   *  unverified — ответ не прошёл проверку и не показывается. */
  status: "ready" | "needs_clarification" | "unverified";
  language: ScriptLang;
  matches: { item_id: string; title: string; section: string; why: string }[];
  /** Только проверенный ответ. */
  reply: string;
  verified: boolean;
  attempts: number;
  sources: { item_id: string | null; title: string; section: string }[];
  missing_information: string;
  issues: { claim: string; reason: string }[];
  comment: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string;
}

// --- CRM: разбор переписок и движения сделок ---

export type CrmSeverity = "ok" | "warning" | "critical";
export type CrmProblemKind = "chat" | "pipeline" | "speed";

export interface CrmCriterion {
  id: string;
  name: string;
  prompt: string;
  scale_max: number;
  active: boolean;
  position: number;
}

export interface CrmManager {
  key: string;
  name: string;
  deals: number;
  employee_id: string | null;
  /** Сопоставлен явно в настройках, а не по совпадению имени. */
  mapped: boolean;
}

export interface CrmSettings {
  prompt: string;
  default_prompt: string;
  is_default: boolean;
  summary_prompt: string;
  default_summary_prompt: string;
  summary_is_default: boolean;
  pipeline_rules: string;
  default_pipeline_rules: string;
  pipeline_is_default: boolean;
  /** Модель, которой идёт разбор сейчас. */
  model: string;
  model_saved: string;
  model_default: string;
  timezone: string;
  auto_run: boolean;
  run_hour: number;
  max_deals: number;
  /** Рабочее время студии «HH:MM»: по нему считается скорость ответа. */
  work_start: string;
  work_end: string;
  /** 0 — понедельник … 6 — воскресенье. */
  work_days: number[];
  slow_reply_minutes: number;
  exclude_pipelines: string[];
  exclude_stages: CrmStageRef[];
  exclude_managers: string[];
  /** Воронки и этапы из данных и словарей amoCRM — для выбора. */
  known_pipelines: { name: string; stages: string[] }[];
  integration_key: string;
  ingest_url: string;
  manager_map: Record<string, string | null>;
  known_managers: CrmManager[];
  /** На сервере задан ANTHROPIC_API_KEY. */
  configured: boolean;
  /** Сводка в Telegram: на сервере заданы TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID. */
  telegram_configured: boolean;
  dashboard_url: string;
  updated_at: string | null;
  updated_by: string;
}

export interface CrmStageRef {
  pipeline: string;
  stage: string;
}

/** Сохраняются только присланные поля — каждая вкладка шлёт своё. */
export interface CrmSettingsIn {
  prompt: string;
  summary_prompt: string;
  pipeline_rules: string;
  model: string;
  timezone: string;
  auto_run: boolean;
  run_hour: number;
  max_deals: number;
  manager_map: Record<string, string | null>;
  work_start: string;
  work_end: string;
  work_days: number[];
  slow_reply_minutes: number;
  exclude_pipelines: string[];
  exclude_stages: CrmStageRef[];
  exclude_managers: string[];
}

export interface CrmDeal {
  id: string;
  external_id: string;
  title: string;
  contact_name: string;
  contact_phone: string;
  pipeline: string;
  stage: string;
  status: "open" | "won" | "lost" | string;
  source: string;
  manager_key: string;
  manager_name: string;
  employee_id: string | null;
  url: string;
  budget: number | null;
  created_at_crm: string | null;
  last_activity_at: string | null;
}

export interface CrmProblem {
  kind: CrmProblemKind;
  text: string;
  quote: string;
}

export interface CrmScore {
  criterion_id: string;
  name: string;
  scale_max: number;
  applicable: boolean;
  score: number | null;
  comment: string;
}

export interface CrmReview {
  id: string;
  run_id: string;
  date: string;
  deal: CrmDeal;
  employee_id: string | null;
  employee_name: string;
  manager_key: string;
  manager_name: string;
  category: string;
  severity: CrmSeverity;
  problem: boolean;
  summary: string;
  problems: CrmProblem[];
  good: string[];
  recommendations: string[];
  scripts: { used: string[]; deviations: string[] };
  pipeline: { ok: boolean; expected_stage: string; comment: string };
  messages_in: number;
  messages_out: number;
  events_count: number;
  first_reply_minutes: number | null;
  max_reply_minutes: number | null;
  unanswered: boolean;
  scores: CrmScore[];
}

export interface CrmMessage {
  id: string;
  direction: "in" | "out";
  channel: string;
  author_name: string;
  text: string;
  at: string;
  /** Внутри разбираемого дня; иначе — контекст до него. */
  in_day: boolean;
}

export interface CrmEvent {
  id: string;
  kind: string;
  from_value: string;
  to_value: string;
  text: string;
  author_name: string;
  at: string;
  in_day: boolean;
}

export interface CrmReviewDetail extends CrmReview {
  messages: CrmMessage[];
  events: CrmEvent[];
}

export interface CrmRun {
  id: string;
  date: string;
  status: "queued" | "processing" | "done" | "error" | string;
  status_detail: string;
  stale: boolean;
  trigger: "manual" | "schedule" | string;
  deals_total: number;
  reviews_done: number;
  problems_count: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  llm_calls: number;
  cost_usd: number | null;
  created_at: string;
  finished_at: string | null;
}

export interface CrmRuns {
  runs: CrmRun[];
  /** Дни с данными из CRM, которые ещё не разбирали. */
  pending_dates: string[];
  has_data: boolean;
  /** Отчётный день, который идёт сейчас. */
  today: string;
  /** Час окончания отчётного дня; 0 — календарный день. */
  day_end_hour: number;
}

export interface CrmDaySummary {
  top_problems?: string[];
  by_manager?: { manager: string; note: string }[];
  recommendations?: string[];
  highlights?: string[];
  error?: string;
}

export interface CrmDayStats {
  deals: number;
  problems: number;
  critical: number;
  unanswered: number;
  by_category: Record<string, number>;
  by_manager: Record<
    string,
    { deals: number; problems: number; critical: number; unanswered: number; avg_first_reply_minutes: number | null }
  >;
  avg_by_criterion: Record<string, number>;
}

export interface CrmRunReport {
  run: CrmRun;
  summary: CrmDaySummary | null;
  stats: CrmDayStats | null;
  reviews: CrmReview[];
  criteria: CrmCriterion[];
  /** Границы отчётного дня: при часе окончания 20:00 — две даты. */
  window_from: string | null;
  window_to: string | null;
  day_end_hour: number;
  telegram_configured: boolean;
  /** Ответ дольше — медленный, рабочих минут. */
  slow_reply_minutes: number;
  work_hours: string;
  amo_connected: boolean;
  /** Задачи в amoCRM, уже поставленные по этому дню: id сделки → id задачи. */
  amo_tasks: Record<string, string>;
  amo_tasks_error: string;
}

export interface AmoTasksResult {
  created: number;
  already: number;
  below: number;
  no_user: number;
  not_amo: number;
  errors: string[];
}

export interface CrmNotifyResult {
  delivered: number;
  chats: number;
  preview: string;
}

export interface CrmTotals {
  deals: number;
  problems: number;
  critical: number;
  unanswered: number;
  problem_share: number | null;
  avg_first_reply_minutes: number | null;
  runs: number;
  cost_usd: number;
}

export interface CrmCriterionStat {
  criterion_id: string;
  name: string;
  scale_max: number;
  count: number;
  avg_score: number | null;
  prev_avg_score: number | null;
}

export interface CrmCategoryStat {
  category: string;
  count: number;
  problems: number;
}

export interface CrmManagerStat {
  employee_id: string | null;
  manager_key: string;
  name: string;
  totals: CrmTotals;
  previous: CrmTotals;
  criteria: CrmCriterionStat[];
  categories: CrmCategoryStat[];
}

export interface CrmTrendPoint {
  date: string;
  deals: number;
  problems: number;
  problem_share: number | null;
  avg_scores: Record<string, number>;
}

export interface CrmStats {
  date_from: string;
  date_to: string;
  prev_date_from: string;
  prev_date_to: string;
  totals: CrmTotals;
  previous: CrmTotals;
  criteria: CrmCriterionStat[];
  managers: CrmManagerStat[];
  categories: CrmCategoryStat[];
  trend: CrmTrendPoint[];
}

export interface CrmIngestResult {
  deals_created: number;
  deals_updated: number;
  deals_stubbed: number;
  messages_added: number;
  messages_skipped: number;
  events_added: number;
  events_skipped: number;
}

// --- amoCRM ---

export interface AmoPipeline {
  id: string;
  name: string;
  stages: string[];
}

export interface AmoStatus {
  connected: boolean;
  enabled: boolean;
  subdomain: string;
  domain: string;
  account_name: string;
  /** token — долгосрочный токен; oauth — код авторизации с обновлением. */
  auth: string;
  token_hint: string;
  token_expires_at: string | null;
  sync_every_minutes: number;
  lookback_days: number;
  last_sync_at: string | null;
  last_sync_result: string;
  last_error: string;
  last_error_at: string | null;
  last_webhook_at: string | null;
  webhooks_received: number;
  webhook_url: string;
  webhook_events: string[];
  pipelines: AmoPipeline[];
  users: number;
  tasks_enabled: boolean;
  tasks_min_severity: "warning" | "critical";
  tasks_due_hours: number;
}

export interface AmoConnectIn {
  subdomain: string;
  domain: "amocrm.ru" | "kommo.com" | "amocrm.com";
  token: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  code: string;
  enabled: boolean;
  sync_every_minutes: number;
  lookback_days: number;
  tasks_enabled: boolean;
  tasks_min_severity: "warning" | "critical";
  tasks_due_hours: number;
}

export interface AmoSyncResult {
  result: string;
  applied: CrmIngestResult;
}

/* Ответы ИИ-помощника — с запасом на рассинхрон версий: админка
 * обновляется сама, а бэкенд — по Redeploy. Поле, которого старый сервер
 * не знает, получает значение по умолчанию, а не роняет страницу. */
function normalizeAiPrompt(raw: Partial<AiPrompt>): AiPrompt {
  return {
    prompt: raw.prompt ?? "",
    default_prompt: raw.default_prompt ?? raw.prompt ?? "",
    is_default: raw.is_default ?? true,
    verify_prompt: raw.verify_prompt ?? raw.default_verify_prompt ?? "",
    default_verify_prompt: raw.default_verify_prompt ?? raw.verify_prompt ?? "",
    verify_is_default: raw.verify_is_default ?? true,
    model: raw.model ?? "",
    model_saved: raw.model_saved ?? "",
    model_default: raw.model_default ?? "",
    configured: raw.configured ?? false,
  };
}

function normalizeAssist(raw: Partial<AssistResult>): AssistResult {
  return {
    status: raw.status ?? "ready",
    language: raw.language ?? "ru",
    matches: raw.matches ?? [],
    reply: raw.reply ?? "",
    verified: raw.verified ?? false,
    attempts: raw.attempts ?? 1,
    sources: raw.sources ?? [],
    missing_information: raw.missing_information ?? "",
    issues: raw.issues ?? [],
    comment: raw.comment ?? "",
  };
}

// --- Endpoints ---

/** ?a=1&b=2 из непустых значений. */
function query(q: object): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, String(v));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const api = {
  authState: () => request<{ has_logins: boolean }>("/api/auth/state"),
  login: (login: string, password: string) =>
    request<{ token: string; user: Me }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ login, password }),
    }),
  me: () => request<Me>("/api/auth/me"),

  listDays: (locationIds: string[] = []) => {
    // Параметр повторяется по одному на студию: ?location_id=…&location_id=…
    const q = new URLSearchParams();
    locationIds.forEach((id) => q.append("location_id", id));
    const tail = q.toString();
    return request<DayRecording[]>(`/api/reports/days${tail ? `?${tail}` : ""}`);
  },
  dayReport: (id: string) => request<DayReport>(`/api/reports/days/${id}`),
  /** `full` — распознать речь заново, а не взять расшифровку прошлого разбора. */
  processDay: (id: string, opts: { full?: boolean } = {}) =>
    request<DayRecording>(
      `/api/reports/days/${id}/process${opts.full ? "?full=true" : ""}`,
      { method: "POST" }
    ),
  forceFinishDay: (id: string) =>
    request<DayRecording>(`/api/reports/days/${id}/force-finish`, { method: "POST" }),
  deleteDay: (id: string) =>
    request<{ files_removed: number; warning: string }>(
      `/api/reports/days/${id}`,
      { method: "DELETE" }
    ),

  listMetrics: () => request<AnalysisMetric[]>("/api/metrics"),
  createMetric: (body: { name: string; prompt: string; scale_max: number }) =>
    request<AnalysisMetric>("/api/metrics", { method: "POST", body: JSON.stringify(body) }),
  updateMetric: (
    id: string,
    body: { name?: string; prompt?: string; scale_max?: number; active?: boolean }
  ) =>
    request<AnalysisMetric>(`/api/metrics/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteMetric: (id: string) =>
    request<void>(`/api/metrics/${id}`, { method: "DELETE" }),

  summary: (params: {
    date_from: string;
    date_to: string;
    employee_id?: string;
    location_ids?: string[];
  }) => {
    const q = new URLSearchParams({
      date_from: params.date_from,
      date_to: params.date_to,
    });
    if (params.employee_id) q.set("employee_id", params.employee_id);
    (params.location_ids ?? []).forEach((id) => q.append("location_id", id));
    return request<Summary>(`/api/analytics/summary?${q}`);
  },

  listReleases: () => request<AppRelease[]>("/api/app/releases"),
  uploadRelease: (form: FormData) => upload<AppRelease>("/api/app/releases", form),
  updateRelease: (id: string, params: { published?: boolean }) => {
    const q = new URLSearchParams();
    if (params.published !== undefined) q.set("published", String(params.published));
    return request<AppRelease>(`/api/app/releases/${id}?${q}`, { method: "PATCH" });
  },
  deleteRelease: (id: string) =>
    request<void>(`/api/app/releases/${id}`, { method: "DELETE" }),

  listLocations: () => request<Location[]>("/api/locations"),
  createLocation: (body: { name: string; address?: string }) =>
    request<Location>("/api/locations", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateLocation: (
    id: string,
    body: { name?: string; address?: string; active?: boolean }
  ) =>
    request<Location>(`/api/locations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteLocation: (id: string) =>
    request<void>(`/api/locations/${id}`, { method: "DELETE" }),

  listEmployees: () => request<Employee[]>("/api/employees"),
  createEmployee: (body: {
    full_name: string;
    login?: string | null;
    access_scope?: "own" | "all";
    scripts_access?: ScriptsAccess;
    crm_access?: CrmAccess;
  }) =>
    request<EmployeeCredentials>("/api/employees", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateEmployee: (
    id: string,
    body: {
      full_name?: string;
      active?: boolean;
      login?: string | null;
      access_scope?: "own" | "all";
      scripts_access?: ScriptsAccess;
      crm_access?: CrmAccess;
    }
  ) =>
    request<EmployeeCredentials>(`/api/employees/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  resetEmployeePassword: (id: string) =>
    request<EmployeeCredentials>(`/api/employees/${id}/reset-password`, {
      method: "POST",
    }),
  deleteEmployee: (id: string) =>
    request<void>(`/api/employees/${id}`, { method: "DELETE" }),

  leaveFeedback: (body: {
    dialog_id: string;
    metric_id: string;
    agree: boolean;
    comment?: string;
  }) =>
    request<DialogFeedback>("/api/feedback", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  withdrawFeedback: (id: string) =>
    request<void>(`/api/feedback/${id}`, { method: "DELETE" }),
  feedbackByMetric: () => request<MetricFeedbackStat[]>("/api/feedback/by-metric"),

  listAgreements: (params?: { status?: AgreementStatus; employee_id?: string }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.employee_id) q.set("employee_id", params.employee_id);
    const tail = q.toString();
    return request<Agreement[]>(`/api/agreements${tail ? `?${tail}` : ""}`);
  },
  createAgreement: (body: {
    day_recording_id: string;
    dialog_id?: string | null;
    text: string;
  }) =>
    request<Agreement>("/api/agreements", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgreement: (
    id: string,
    body: {
      text?: string;
      status?: AgreementStatus;
      resolution_note?: string;
      resolved_day_recording_id?: string | null;
    }
  ) =>
    request<Agreement>(`/api/agreements/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgreement: (id: string) =>
    request<void>(`/api/agreements/${id}`, { method: "DELETE" }),
  dialogDetail: (id: string) => request<DialogDetail>(`/api/reports/dialogs/${id}`),
  dayAudioUrl: (id: string) =>
    request<{ url: string; expires_in_s: number }>(`/api/audio/day/${id}`),

  listPrompts: () => request<PromptTemplate[]>("/api/prompts"),
  promptHistory: (key: string) =>
    request<PromptTemplate[]>(`/api/prompts/${key}/versions`),
  savePrompt: (
    key: string,
    body: { content: string; name?: string; description?: string; model?: string | null }
  ) => request<PromptTemplate>(`/api/prompts/${key}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }),
  rollbackPrompt: (key: string, version: number) =>
    request<PromptTemplate>(`/api/prompts/${key}/rollback/${version}`, { method: "POST" }),

  getScript: () => request<ScriptTemplate>("/api/script"),
  saveScript: (body: { name?: string; stages?: ScriptStage[]; body?: string }) =>
    request<ScriptTemplate>("/api/script", { method: "PUT", body: JSON.stringify(body) }),

  playbook: () => request<Playbook>("/api/playbook"),
  createScriptSection: (body: { title: string; icon: string; kind?: "text" | "call" }) =>
    request<ScriptSection>("/api/playbook/sections", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateScriptSection: (id: string, body: { title?: string; icon?: string }) =>
    request<ScriptSection>(`/api/playbook/sections/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** Звонок по сценарию — после каждого шага. keepalive: последний шаг
   *  дойдёт, даже если вкладку закрыли сразу после клика. */
  saveCallRun: (id: string, body: CallRunIn) =>
    request<void>(`/api/playbook/call-runs/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
      keepalive: true,
    }),
  callStats: (q: CallStatsQuery) => request<CallStats>(`/api/playbook/call-stats${query(q)}`),
  callRuns: (q: CallStatsQuery & { section: string; cursor?: string }) =>
    request<Page<CallRun>>(`/api/playbook/call-runs${query(q)}`),
  saveCallFlow: (sectionId: string, flow: CallFlow, changeNote: string) =>
    request<ScriptSection>(`/api/playbook/sections/${sectionId}/flow`, {
      method: "PUT",
      body: JSON.stringify({ flow, change_note: changeNote }),
    }),
  deleteScriptSection: (id: string) =>
    request<void>(`/api/playbook/sections/${id}`, { method: "DELETE" }),
  orderScriptSections: (ids: string[]) =>
    request<void>("/api/playbook/sections/order", {
      method: "PUT",
      body: JSON.stringify({ ids }),
    }),
  orderScripts: (sectionId: string, ids: string[]) =>
    request<void>(`/api/playbook/sections/${sectionId}/order`, {
      method: "PUT",
      body: JSON.stringify({ ids }),
    }),
  createScript: (body: ScriptItemDraft & { change_note?: string }) =>
    request<ScriptItem>("/api/playbook/items", { method: "POST", body: JSON.stringify(body) }),
  updateScript: (id: string, body: ScriptItemDraft & { change_note: string }) =>
    request<ScriptItem>(`/api/playbook/items/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteScript: (id: string) =>
    request<void>(`/api/playbook/items/${id}`, { method: "DELETE" }),
  scriptChanges: (cursor = "") =>
    request<Page<ScriptChange>>(
      `/api/playbook/changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
    ),
  suggestScript: (text: string, itemId: string | null) =>
    request<ScriptSuggestion>("/api/playbook/suggestions", {
      method: "POST",
      body: JSON.stringify({ text, item_id: itemId }),
    }),
  scriptSuggestions: (cursor = "") =>
    request<Page<ScriptSuggestion>>(
      `/api/playbook/suggestions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
    ),
  setSuggestionStatus: (id: string, status: "open" | "done") =>
    request<ScriptSuggestion>(`/api/playbook/suggestions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  unreadSuggestions: () => request<{ count: number }>("/api/playbook/suggestions/unread"),
  markSuggestionsSeen: () =>
    request<{ count: number }>("/api/playbook/suggestions/seen", { method: "POST" }),
  /** Отметка копирования — для статистики; ответа не ждём. */
  logCopy: (body: { item_id: string; lang: ScriptLang; studio: string; source?: "card" | "assist" }) =>
    request<void>("/api/playbook/copies", { method: "POST", body: JSON.stringify(body) }),
  copyStats: (q: { from?: string; to?: string; user?: string; lang?: string }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
    const qs = params.toString();
    return request<CopyStats>(`/api/playbook/stats${qs ? `?${qs}` : ""}`);
  },
  aiPrompt: () => request<Partial<AiPrompt>>("/api/playbook/ai").then(normalizeAiPrompt),
  saveAiPrompt: (body: { prompt: string; verify_prompt: string; model: string }) =>
    request<Partial<AiPrompt>>("/api/playbook/ai", { method: "PUT", body: JSON.stringify(body) }).then(
      normalizeAiPrompt
    ),
  assist: (body: { message: string; lang: ScriptLang; studio: string }) =>
    request<Partial<AssistResult>>("/api/playbook/assist", {
      method: "POST",
      body: JSON.stringify(body),
    }).then(normalizeAssist),
  // --- CRM ---
  crmSettings: () => request<CrmSettings>("/api/crm/settings"),
  saveCrmSettings: (body: Partial<CrmSettingsIn>) =>
    request<CrmSettings>("/api/crm/settings", { method: "PUT", body: JSON.stringify(body) }),
  rotateCrmKey: () =>
    request<CrmSettings>("/api/crm/settings/rotate-key", { method: "POST" }),
  listCrmCriteria: () => request<CrmCriterion[]>("/api/crm/criteria"),
  createCrmCriterion: (body: { name: string; prompt: string; scale_max: number }) =>
    request<CrmCriterion>("/api/crm/criteria", { method: "POST", body: JSON.stringify(body) }),
  updateCrmCriterion: (
    id: string,
    body: { name?: string; prompt?: string; scale_max?: number; active?: boolean; position?: number }
  ) =>
    request<CrmCriterion>(`/api/crm/criteria/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteCrmCriterion: (id: string) =>
    request<void>(`/api/crm/criteria/${id}`, { method: "DELETE" }),
  crmRuns: () => request<CrmRuns>("/api/crm/runs"),
  /** Разобрать день (или заново): прошлый разбор заменяется. */
  startCrmRun: (day: string) => request<CrmRun>(`/api/crm/runs/${day}`, { method: "POST" }),
  deleteCrmRun: (day: string) => request<void>(`/api/crm/runs/${day}`, { method: "DELETE" }),
  crmRunReport: (day: string) => request<CrmRunReport>(`/api/crm/runs/${day}`),
  /** Сводка по разбору в Telegram — руками; по расписанию уходит сама. */
  notifyCrmRun: (day: string) =>
    request<CrmNotifyResult>(`/api/crm/runs/${day}/notify`, { method: "POST" }),
  testCrmNotify: () => request<CrmNotifyResult>("/api/crm/notify/test", { method: "POST" }),
  crmReview: (id: string) => request<CrmReviewDetail>(`/api/crm/reviews/${id}`),
  crmStats: (params: { date_from: string; date_to: string; employee_id?: string }) =>
    request<CrmStats>(`/api/crm/stats${query(params)}`),
  /** Импорт файла выгрузки — тот же формат, что принимает интеграция. */
  importCrm: (body: unknown) =>
    request<CrmIngestResult>("/api/crm/import", { method: "POST", body: JSON.stringify(body) }),
  amoStatus: () => request<AmoStatus>("/api/crm/amo"),
  connectAmo: (body: AmoConnectIn) =>
    request<AmoStatus>("/api/crm/amo", { method: "PUT", body: JSON.stringify(body) }),
  syncAmo: () => request<AmoSyncResult>("/api/crm/amo/sync", { method: "POST" }),
  disconnectAmo: () => request<AmoStatus>("/api/crm/amo", { method: "DELETE" }),
  /** Задачи менеджерам в amoCRM по разбору дня; уже поставленные не дублируются. */
  amoTasks: (day: string) => request<AmoTasksResult>(`/api/crm/amo/tasks/${day}`, { method: "POST" }),
  playbookSettings: () => request<PlaybookSettings>("/api/playbook/settings"),
  savePlaybookSettings: (body: {
    studios: Record<string, LangText>;
    admins: Record<string, LangText>;
    variables: ScriptVariable[];
  }) =>
    request<PlaybookSettings>("/api/playbook/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};

/** Позиция в записи: всегда ЧЧ:ММ:СС — смена длиннее часа, и обрезанный
 *  формат сбивал бы с толку на коротких тестовых записях. */
export function fmtTs(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Длительность для чтения человеком: «11 ч 40 мин», «48 мин», «< 1 мин». */
export function fmtDur(seconds: number | null): string {
  if (seconds == null) return "—";
  const total = Math.floor(seconds / 60);
  if (total < 1) return "< 1 мин";
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
const WEEKDAYS = [
  "воскресенье", "понедельник", "вторник", "среда",
  "четверг", "пятница", "суббота",
];

/** "2026-08-05" → { day: "5 августа", weekday: "среда" }. Собирается вручную,
 *  чтобы формат не зависел от локали браузера. */
export function fmtDate(iso: string): { day: string; weekday: string } {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return { day: iso, weekday: "" };
  const date = new Date(Date.UTC(y, m - 1, d));
  return {
    day: `${d} ${MONTHS[m - 1] ?? ""}`,
    weekday: WEEKDAYS[date.getUTCDay()] ?? "",
  };
}

/** Русское согласование числительного: 1 строка, 2 строки, 5 строк. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Время начала записи в часовом поясе браузера. */
export function fmtClock(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** Момент в прошлом: «5 авг, 14:20». Для отзывов, входов и договорённостей —
 *  день без времени врёт («сегодня» о вчерашнем вечере), время без дня
 *  бесполезно. */
export function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// --- Сводная статистика за период (дашборд) ---

export interface PeriodTotals {
  shifts: number;
  dialogs: number;
  sales: number;
  conversion: number | null;
  speech_seconds: number;
  cost_usd: number;
}

export interface MetricPeriodStat {
  metric_id: string;
  name: string;
  scale_max: number;
  triggered_count: number;
  avg_score: number | null;
  prev_avg_score: number | null;
}

export interface EmployeePeriodStat {
  employee_id: string | null;
  full_name: string;
  totals: PeriodTotals;
  metrics: MetricPeriodStat[];
}

export interface TrendPoint {
  date: string;
  dialogs: number;
  sales: number;
  conversion: number | null;
  cost_usd: number;
  avg_scores: Record<string, number>;
}

export interface Summary {
  date_from: string;
  date_to: string;
  prev_date_from: string;
  prev_date_to: string;
  totals: PeriodTotals;
  previous: PeriodTotals;
  metrics: MetricPeriodStat[];
  employees: EmployeePeriodStat[];
  trend: TrendPoint[];
}

/** Дата в формате API (YYYY-MM-DD) в местном времени, а не UTC:
 *  toISOString() у пользователя восточнее Гринвича сдвигает день назад. */
export function toApiDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** Размер файла для человека: «24,3 МБ». */
export function fmtSize(bytes: number): string {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} КБ`;
  return `${mb.toFixed(1).replace(".", ",")} МБ`;
}

/** Стоимость: суммы здесь заметно меньше доллара, поэтому центов не хватает. */
export function fmtUsd(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}
