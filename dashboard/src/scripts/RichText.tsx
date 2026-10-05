/** Текст скрипта с разметкой поверх простого текста.
 *
 *  В базе тексты лежат ровно такими, какими уйдут в чат: без звёздочек и
 *  тегов. Разметка добавляется только при показе:
 *  - {админ}, {студия}, свои переменные — подставлены значением на языке
 *    текста; если значения нет, переменная подсвечена и объясняет почему;
 *  - [день], [время] — места, которые надо заполнить перед отправкой;
 *  - ссылки кликабельны (карта, отзывы, приложение — их проверяют глазами);
 *  - «Название скрипта» в пояснениях ведёт к этому скрипту;
 *  - слова поиска подсвечены.
 */
import { ReactNode } from "react";
import { normalize, VARIABLE_RE, VarResolver } from "./logic";

const URL_RE = /https?:\/\/[^\s<>"«»]+/g;
const PLACEHOLDER_RE = /\[[^[\]\n]{1,40}\]/g;
const REF_RE = /«([^«»\n]{1,120})»/g;
const URL_TAIL = /[.,;:!?)\]]+$/;

type Piece =
  | { kind: "text"; value: string }
  | { kind: "url"; value: string }
  | { kind: "placeholder"; value: string }
  | { kind: "var"; key: string; value: string | null; why?: string }
  | { kind: "ref"; value: string; open: () => void };

function splitUrls(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    // Точка или скобка после ссылки — знак препинания предложения, а не
    // часть адреса: с ними ссылка ведёт в никуда.
    const url = match[0].replace(URL_TAIL, "");
    if (start > last) out.push({ kind: "text", value: text.slice(last, start) });
    out.push({ kind: "url", value: url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out;
}

function splitPattern(
  pieces: Piece[],
  re: RegExp,
  make: (match: RegExpMatchArray) => Piece | null
): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    if (piece.kind !== "text") {
      out.push(piece);
      continue;
    }
    let last = 0;
    for (const match of piece.value.matchAll(re)) {
      const made = make(match);
      if (!made) continue;
      const start = match.index ?? 0;
      if (start > last) out.push({ kind: "text", value: piece.value.slice(last, start) });
      out.push(made);
      last = start + match[0].length;
    }
    if (last < piece.value.length) out.push({ kind: "text", value: piece.value.slice(last) });
  }
  return out;
}

/** Подсветка слов поиска. Индексы берутся из нормализованной строки — она
 *  той же длины, что исходная, поэтому режется исходный текст как есть. */
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length || !text) return <>{text}</>;
  const norm = normalize(text);
  const ranges: [number, number][] = [];
  for (const term of terms) {
    let at = norm.indexOf(term);
    while (at !== -1) {
      ranges.push([at, at + term.length]);
      at = norm.indexOf(term, at + term.length);
    }
  }
  if (!ranges.length) return <>{text}</>;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && range[0] <= prev[1]) prev[1] = Math.max(prev[1], range[1]);
    else merged.push([...range]);
  }
  const nodes: ReactNode[] = [];
  let last = 0;
  merged.forEach(([start, end], i) => {
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(
      <mark key={i} className="hit">
        {text.slice(start, end)}
      </mark>
    );
    last = end;
  });
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

export default function RichText({
  text,
  terms = [],
  resolveRef,
  resolveVar,
}: {
  text: string;
  terms?: string[];
  /** Вернуть переход к скрипту с таким названием или null, если его нет. */
  resolveRef?: (title: string) => (() => void) | null;
  /** Подстановка переменных; без неё {…} остаются текстом. */
  resolveVar?: VarResolver;
}) {
  let pieces = splitUrls(text);
  if (resolveVar) {
    pieces = splitPattern(pieces, new RegExp(VARIABLE_RE.source, "g"), (m) => {
      const found = resolveVar(m[1]);
      return found ? { kind: "var", key: m[1], value: found.value, why: found.why } : null;
    });
  }
  pieces = splitPattern(pieces, PLACEHOLDER_RE, (m) => ({ kind: "placeholder", value: m[0] }));
  if (resolveRef) {
    pieces = splitPattern(pieces, REF_RE, (m) => {
      const open = resolveRef(m[1]);
      return open ? { kind: "ref", value: m[1], open } : null;
    });
  }
  return (
    <>
      {pieces.map((piece, i) => {
        switch (piece.kind) {
          case "url":
            return (
              <a key={i} href={piece.value} target="_blank" rel="noreferrer noopener">
                <Highlight text={piece.value} terms={terms} />
              </a>
            );
          case "var":
            return piece.value !== null ? (
              <span key={i} className="var" title={`Подставлено из {${piece.key}}`}>
                <Highlight text={piece.value} terms={terms} />
              </span>
            ) : (
              <span key={i} className="var missing" title={piece.why}>
                {`{${piece.key}}`}
              </span>
            );
          case "placeholder":
            return (
              <span key={i} className="ph" title="Заполнить перед отправкой">
                <Highlight text={piece.value} terms={terms} />
              </span>
            );
          case "ref":
            return (
              <button key={i} type="button" className="ref" onClick={piece.open}>
                «<Highlight text={piece.value} terms={terms} />»
              </button>
            );
          default:
            return <Highlight key={i} text={piece.value} terms={terms} />;
        }
      })}
    </>
  );
}
