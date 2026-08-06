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

export function fmtTs(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
