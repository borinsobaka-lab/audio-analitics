/** Сравнение версий скрипта для хронологии: какие поля поменялись и какие
 *  слова в них — удалены или добавлены.
 */
import type { ScriptChange, ScriptSnapshot } from "../api";
import { KIND_LABELS, LANGS } from "./logic";

export interface FieldChange {
  label: string;
  before: string;
  after: string;
}

/** Плоский список «поле → текст» одной версии. Тексты сообщений — по
 *  студии, сообщению и языку: правка одного перевода не тянет за собой
 *  остальные. */
function flatten(s: ScriptSnapshot | null): Map<string, { label: string; text: string }> {
  const out = new Map<string, { label: string; text: string }>();
  if (!s) return out;
  const put = (key: string, label: string, text: string) => out.set(key, { label, text });
  put("title", "Название", s.title ?? "");
  put("kind", "Тип", KIND_LABELS[s.kind] ?? s.kind ?? "");
  put("section", "Раздел", s.section ?? "");
  put("note", "Как использовать", s.note ?? "");
  const variants = s.variants ?? [];
  variants.forEach((v, vi) => {
    (v.messages ?? []).forEach((m, mi) => {
      const parts = ["Текст"];
      if (variants.length > 1 || v.label) parts.push(v.label || `вариант ${vi + 1}`);
      if (m.label) parts.push(m.label);
      else if (v.messages.length > 1) parts.push(`сообщение ${mi + 1}`);
      for (const l of LANGS) {
        put(`v${vi}:m${mi}:${l.key}`, [...parts, l.label].join(" · "), m[l.key] ?? "");
      }
    });
  });
  put("follow_up", "Дальше", s.follow_up ?? "");
  put("keywords", "Слова для поиска", s.keywords ?? "");
  return out;
}

/** Поля, которые различаются, — в порядке карточки. При создании и
 *  удалении сравнивается с пустой версией: видно, что было в скрипте. */
export function fieldChanges(change: ScriptChange): FieldChange[] {
  const a = flatten(change.before);
  const b = flatten(change.after);
  const keys = [...new Set([...b.keys(), ...a.keys()])];
  const out: FieldChange[] = [];
  for (const key of keys) {
    const before = a.get(key)?.text ?? "";
    const after = b.get(key)?.text ?? "";
    if (before.trim() === after.trim()) continue;
    out.push({ label: (b.get(key) ?? a.get(key))!.label, before, after });
  }
  return out;
}

export interface Piece {
  text: string;
  /** Есть только в этой стороне: удалено (в «было») или добавлено (в «стало»). */
  changed: boolean;
}

/** Слова и пробелы — отдельными кусками, чтобы сравнивать по словам. */
function tokens(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/** Длинные тексты сравниваются целиком, без подсветки слов: таблица LCS
 *  растёт как произведение длин. */
const MAX_CELLS = 400_000;

/** Пословное сравнение: в «было» подсвечено удалённое, в «стало» — новое. */
export function wordDiff(before: string, after: string): { before: Piece[]; after: Piece[] } {
  const a = tokens(before);
  const b = tokens(after);
  if (!a.length || !b.length || a.length * b.length > MAX_CELLS) {
    return {
      before: before ? [{ text: before, changed: !after }] : [],
      after: after ? [{ text: after, changed: !before }] : [],
    };
  }
  const n = a.length;
  const m = b.length;
  // lcs[i][j] — длина общей части хвостов a[i:] и b[j:].
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const left: Piece[] = [];
  const right: Piece[] = [];
  const push = (list: Piece[], text: string, changed: boolean) => {
    const last = list[list.length - 1];
    // Пробел между двумя изменёнными словами — тоже изменение: иначе
    // подсветка рвётся на каждом слове.
    if (last && (last.changed === changed || (/^\s+$/.test(text) && last.changed)))
      last.text += text;
    else list.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(left, a[i], false);
      push(right, b[j], false);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) push(left, a[i++], true);
    else push(right, b[j++], true);
  }
  while (i < n) push(left, a[i++], true);
  while (j < m) push(right, b[j++], true);
  return { before: left, after: right };
}
