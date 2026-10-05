/** Период для статистики: даты по часам браузера (тбилисское время) и
 *  готовые отрезки «сегодня / 7 дней / 30 дней / всё время».
 *
 *  В поле даты — YYYY-MM-DD; серверу уходит ISO начала дня, поэтому
 *  «сегодня» — это тбилисское сегодня, а не UTC.
 */

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
}

/** Начало дня по местному времени — в ISO для сервера; shift=1 — следующий
 *  день, то есть «по дату включительно». */
export function dayStart(value: string, shift = 0): string {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d + shift).toISOString();
}

export interface Period {
  /** Пусто — без нижней границы. */
  from: string;
  to: string;
}

export const PERIOD_PRESETS = [
  { key: "today", label: "Сегодня", from: () => daysAgo(0) },
  { key: "7", label: "7 дней", from: () => daysAgo(6) },
  { key: "30", label: "30 дней", from: () => daysAgo(29) },
  { key: "all", label: "Всё время", from: () => "" },
] as const;

export const DEFAULT_PERIOD: Period = { from: daysAgo(29), to: daysAgo(0) };

/** Какой отрезок выбран сейчас; пусто — даты заданы руками. */
export function activePreset(p: Period): string {
  return PERIOD_PRESETS.find((x) => x.from() === p.from && p.to === daysAgo(0))?.key ?? "";
}

/** Границы периода для запроса к серверу. */
export function periodQuery(p: Period): { from: string; to: string } {
  return { from: p.from ? dayStart(p.from) : "", to: p.to ? dayStart(p.to, 1) : "" };
}
