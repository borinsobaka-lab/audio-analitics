/** Форматированный текст подсказок «Как использовать» и «Дальше».
 *
 *  Тексты сообщений клиенту остаются простыми — они копируются в чат, и
 *  любая разметка там превратилась бы в мусор. А подсказки сотрудникам
 *  читаются только в админке, и в них нужно выделять главное.
 *
 *  Разметка — простая и видимая в тексте, её ставят кнопки редактора:
 *    **жирный**   __подчёркнутый__   • пункт списка (строка с «• » или «- »)
 *    [фраза](script:<id>) — ссылка на другой скрипт; по id, а не по названию,
 *    поэтому переживает переименование.
 *    [[текст]] — текст с кнопкой «Копировать» справа: название следующего
 *    скрипта для поиска, текст задачи для CRM и т. п.
 *  Всё остальное — как в тексте скрипта: переменные, [места], ссылки,
 *  «Название скрипта» в ёлочках (старый способ ссылки).
 */
import { ReactNode, useEffect, useRef, useState } from "react";
import { copyText, resolveText, stripMarkup, VarResolver } from "./logic";
import RichText from "./RichText";

const INLINE_RE =
  /\[\[([^\]\n]+?)\]\]|\[([^\]\n]+)\]\(script:([0-9a-fA-F-]{36})\)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g;
const LIST_RE = /^\s*[•\-–]\s+/;

interface Ctx {
  terms: string[];
  resolveRef?: (title: string) => (() => void) | null;
  resolveVar?: VarResolver;
  /** Переход к скрипту по id; null — такого скрипта больше нет. */
  resolveId: (id: string) => { open: () => void; title: string } | null;
}

/** Значок «Копировать» в строке подсказки — отвечает галочкой на месте. */
function MiniCopy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={`mini-copy${done ? " done" : ""}`}
      title={done ? "Скопировано" : `Копировать: ${text}`}
      aria-label={done ? "Скопировано" : "Копировать"}
      onClick={async () => {
        const ok = await copyText(text);
        if (!ok) return;
        setDone(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4.5 12.5l5 5 10-11" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
          <path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" />
        </svg>
      )}
    </button>
  );
}

function Inline({ text, ctx }: { text: string; ctx: Ctx }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index ?? 0;
    if (start > last) {
      nodes.push(
        <RichText key={i++} text={text.slice(last, start)} terms={ctx.terms}
          resolveRef={ctx.resolveRef} resolveVar={ctx.resolveVar} />
      );
    }
    if (m[1] !== undefined) {
      // Копируется то, что видно: без разметки, с подставленными переменными.
      const plain = stripMarkup(m[1]);
      const copy = ctx.resolveVar ? resolveText(plain, ctx.resolveVar) : plain;
      nodes.push(
        <span key={i++} className="copyable">
          <span className="copyable-text">
            <Inline text={m[1]} ctx={ctx} />
          </span>
          <MiniCopy text={copy} />
        </span>
      );
    } else if (m[2] !== undefined) {
      const target = ctx.resolveId(m[3]);
      nodes.push(
        target ? (
          <button key={i++} type="button" className="ref" title={`Открыть «${target.title}»`}
            onClick={target.open}>
            <Inline text={m[2]} ctx={ctx} />
          </button>
        ) : (
          <span key={i++} className="ref-broken" title="Скрипт, на который вела ссылка, удалён">
            <Inline text={m[2]} ctx={ctx} />
          </span>
        )
      );
    } else if (m[4] !== undefined) {
      nodes.push(
        <strong key={i++}>
          <Inline text={m[4]} ctx={ctx} />
        </strong>
      );
    } else {
      nodes.push(
        <u key={i++}>
          <Inline text={m[5]} ctx={ctx} />
        </u>
      );
    }
    last = start + m[0].length;
  }
  if (last < text.length) {
    nodes.push(
      <RichText key={i++} text={text.slice(last)} terms={ctx.terms}
        resolveRef={ctx.resolveRef} resolveVar={ctx.resolveVar} />
    );
  }
  return <>{nodes}</>;
}

export default function Formatted({ text, ...ctx }: { text: string } & Ctx) {
  // Строки собираются в блоки: подряд идущие пункты — в один список,
  // остальное — абзацами с сохранёнными переносами.
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    const list = LIST_RE.test(line);
    const prev = blocks[blocks.length - 1];
    if (prev && prev.list === list) prev.lines.push(list ? line.replace(LIST_RE, "") : line);
    else blocks.push({ list, lines: [list ? line.replace(LIST_RE, "") : line] });
  }
  return (
    <div className="fmt">
      {blocks.map((b, bi) =>
        b.list ? (
          <ul key={bi}>
            {b.lines.map((l, li) => (
              <li key={li}>
                <Inline text={l} ctx={ctx} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={bi}>
            {b.lines.map((l, li) => (
              <span key={li}>
                {li > 0 && <br />}
                <Inline text={l} ctx={ctx} />
              </span>
            ))}
          </p>
        )
      )}
    </div>
  );
}
