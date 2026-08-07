// Thin API client. In production, set the Supabase session token via setToken().

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string>),
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const resp = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!resp.ok) {
    const body = await resp.text();
    // FastAPI puts the human-readable reason in {"detail": "..."}.
    let message = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.detail === "string") message = parsed.detail;
    } catch {
      /* keep the raw body */
    }
    throw new Error(message);
  }
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

// --- Types mirrored from backend schemas ---

export interface DayRecording {
  id: string;
  location_id: string;
  date: string;
  status: string;
  status_detail: string;
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

export interface Employee {
  id: string;
  location_id: string;
  full_name: string;
  role: string;
  active: boolean;
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

// --- Endpoints ---

export const api = {
  listDays: () => request<DayRecording[]>("/api/reports/days"),
  dayReport: (id: string) => request<DayReport>(`/api/reports/days/${id}`),
  reprocessDay: (id: string) =>
    request<DayRecording>(`/api/reports/days/${id}/reprocess`, { method: "POST" }),
  forceFinishDay: (id: string) =>
    request<DayRecording>(`/api/reports/days/${id}/force-finish`, { method: "POST" }),
  deleteDay: (id: string) =>
    request<void>(`/api/reports/days/${id}`, { method: "DELETE" }),

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

  summary: (params: { date_from: string; date_to: string; employee_id?: string }) => {
    const q = new URLSearchParams({
      date_from: params.date_from,
      date_to: params.date_to,
    });
    if (params.employee_id) q.set("employee_id", params.employee_id);
    return request<Summary>(`/api/analytics/summary?${q}`);
  },

  listEmployees: () => request<Employee[]>("/api/employees"),
  createEmployee: (full_name: string) =>
    request<Employee>("/api/employees", {
      method: "POST",
      body: JSON.stringify({ full_name }),
    }),
  updateEmployee: (id: string, body: { full_name?: string; active?: boolean }) =>
    request<Employee>(`/api/employees/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
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

/** Стоимость: суммы здесь заметно меньше доллара, поэтому центов не хватает. */
export function fmtUsd(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}
