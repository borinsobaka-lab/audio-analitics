/** Подписи для разбора CRM: классы переписки, серьёзность, виды проблем.
 *
 *  Набор классов закреплён на сервере (crm_ai.CATEGORIES): по нему строится
 *  статистика, и он не меняется от формулировки промпта. Неизвестный ключ
 *  показывается как «Другое», а не ломает страницу.
 */
import type { CrmProblemKind, CrmSeverity } from "../api";

export const CATEGORY_LABELS: Record<string, string> = {
  booking: "Запись на пробное",
  sale: "Продажа абонемента",
  objection: "Возражение",
  question: "Вопрос клиента",
  reschedule: "Перенос или отмена",
  service: "Сервис",
  no_reply: "Клиент молчит",
  lost: "Отказ",
  spam: "Не клиент",
  other: "Другое",
};

export const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

export function categoryLabel(key: string): string {
  return CATEGORY_LABELS[key] ?? CATEGORY_LABELS.other;
}

export const SEVERITY_LABELS: Record<CrmSeverity, string> = {
  ok: "Без замечаний",
  warning: "Есть замечания",
  critical: "Критично",
};

export const PROBLEM_KIND_LABELS: Record<CrmProblemKind, string> = {
  chat: "Общение",
  pipeline: "Сделка",
  speed: "Скорость",
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "В очереди",
  processing: "Разбирается",
  done: "Готово",
  error: "Ошибка",
};

/** «Клиент ждал 20 мин», «1 ч 30 мин», «2 дн 3 ч». */
export function fmtMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  const m = Math.round(minutes);
  if (m < 1) return "< 1 мин";
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest ? `${h} ч ${rest} мин` : `${h} ч`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d} дн ${hr} ч` : `${d} дн`;
}

/** Дата и время сообщения по часам браузера: «4 окт, 10:05». */
export function fmtStamp(iso: string, withDate: boolean): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", {
    ...(withDate ? { day: "numeric", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  });
}
