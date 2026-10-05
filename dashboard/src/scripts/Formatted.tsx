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
 *  Всё остальное — как в тексте скрипта: переменные, [места], ссылки,
 *  «Название скрипта» в ёлочках (старый способ ссылки).
 */
import { ReactNode } from "react";
import { VarResolver } from "./logic";
import RichText from "./RichText";

const INLINE_RE = /\[([^\]\n]+)\]\(script:([0-9a-fA-F-]{36})\)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g;
const LIST_RE = /^\s*[•\-–]\s+/;

interface Ctx {
  terms: string[];
  resolveRef?: (title: string) => (() => void) | null;
  resolveVar?: VarResolver;
  /** Переход к скрипту по id; null — такого скрипта больше нет. */
  resolveId: (id: string) => { open: () => void; title: string } | null;
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
      const target = ctx.resolveId(m[2]);
      nodes.push(
        target ? (
          <button key={i++} type="button" className="ref" title={`Открыть «${target.title}»`}
            onClick={target.open}>
            <Inline text={m[1]} ctx={ctx} />
          </button>
        ) : (
          <span key={i++} className="ref-broken" title="Скрипт, на который вела ссылка, удалён">
            <Inline text={m[1]} ctx={ctx} />
          </span>
        )
      );
    } else if (m[3] !== undefined) {
      nodes.push(
        <strong key={i++}>
          <Inline text={m[3]} ctx={ctx} />
        </strong>
      );
    } else {
      nodes.push(
        <u key={i++}>
          <Inline text={m[4]} ctx={ctx} />
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
