/** Путь звонка по сценарию — в аналитику («Настройки скриптов» → «Звонки»).
 *
 *  Звонок начинается с первого ответа клиента и шлётся после каждого шага
 *  целиком, под одним id: повторная отправка — обновление, не дубль, а шаг
 *  назад убирает шаг и в статистике. Отправка с задержкой, чтобы быстрые
 *  клики не превращались в пачку запросов, и досылается при уходе со
 *  страницы. Разговор от статистики не зависит: ошибки глотаются.
 */
import { useCallback, useEffect, useRef } from "react";
import { api, CallNode, CallRunIn } from "../api";

export interface CallStep {
  id: string;
  /** Что ответил клиент на этом шаге (кнопка), или «переход» из панели. */
  answer?: string;
  /** Когда открыли блок. */
  at?: string;
}

export function newRunId(): string {
  // randomUUID есть только на https и localhost.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function runBody(sectionId: string, byId: Map<string, CallNode>, path: CallStep[], finished: boolean): CallRunIn {
  const now = new Date().toISOString();
  return {
    section_id: sectionId,
    path: path.map((s) => {
      const node = byId.get(s.id);
      return {
        id: s.id,
        title: (node?.title ?? s.id).slice(0, 120),
        group: node?.group ?? "main",
        answer: (s.answer ?? "").slice(0, 120),
        at: s.at ?? now,
      };
    }),
    finished,
  };
}

/** Следит за путём и шлёт его в аналитику. Возвращает end(): звонок
 *  закончился на текущем блоке — например, нажали «Новый звонок». */
export function useCallRun(
  sectionId: string,
  byId: Map<string, CallNode>,
  path: CallStep[],
  runId: string | undefined,
  atEnd: boolean
): () => void {
  const started = path.length > 1;
  const pending = useRef<{ id: string; body: CallRunIn } | null>(null);
  const timer = useRef<number>();

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (p) api.saveCallRun(p.id, p.body).catch(() => {});
  }, []);

  useEffect(() => {
    if (!started || !runId) return;
    pending.current = { id: runId, body: runBody(sectionId, byId, path, atEnd) };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 400);
  }, [path, started, atEnd, runId, sectionId, byId, flush]);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  return useCallback(() => {
    if (started && runId) {
      pending.current = { id: runId, body: runBody(sectionId, byId, path, true) };
      flush();
    }
  }, [started, runId, sectionId, byId, path, flush]);
}
