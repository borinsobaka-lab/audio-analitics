/** Карточка скрипта.
 *
 *  Всегда раскрыта — по просьбе владельца сворачивания нет: всё, что было в
 *  документе вокруг текста, видно сразу — когда отправлять, ветки «если
 *  выбирают…», варианты по студиям и что сделать после отправки. Каждое
 *  сообщение — целиком, на подложке и с кнопкой «Копировать».
 *
 *  Внизу всегда полоса: кто, когда и что изменил в последний раз. Скрипт
 *  меняется у всех сразу, и у стойки должно быть видно, почему текст другой.
 */
import { useEffect, useRef, useState } from "react";
import { fmtWhen, ScriptItem, ScriptLang, ScriptMessage, ScriptSection } from "../api";
import {
  copyText,
  KIND_LABELS,
  langInfo,
  messageText,
  pickVariant,
  resolveText,
  VarResolver,
} from "./logic";
import RichText, { Highlight } from "./RichText";

const IconCopy = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
    <path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" />
  </svg>
);

const IconCheck = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.5 12.5l5 5 10-11" />
  </svg>
);

/** «Копировать» с ответом прямо на кнопке: всплывашка вдали от пальца
 *  остаётся незамеченной, а сомнение «скопировалось ли» гонит копировать
 *  второй раз. */
export function CopyButton({ text, label = "Копировать" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const timer = useRef<number>();

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    const ok = await copyText(text);
    setState(ok ? "done" : "fail");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  }

  return (
    <button
      type="button"
      className={`secondary small copy-btn${state === "done" ? " copied" : ""}`}
      onClick={copy}
      disabled={!text.trim()}
      aria-live="polite"
      title={label}
    >
      {state === "done" ? <IconCheck /> : <IconCopy />}
      <span className="copy-label">
        {state === "done" ? "Скопировано" : state === "fail" ? "Не вышло" : label}
      </span>
    </button>
  );
}

/** Одно сообщение: подпись, «Копировать» и текст на подложке-пузыре. */
function MessageBlock({
  message,
  index,
  total,
  lang,
  terms,
  resolveVar,
}: {
  message: ScriptMessage;
  index: number;
  total: number;
  lang: ScriptLang;
  terms: string[];
  resolveVar: VarResolver;
}) {
  const shown = messageText(message, lang);
  return (
    <div className="script-msg">
      <div className="script-msg-head">
        <span className="script-msg-label">
          {message.label || (total > 1 ? `Сообщение ${index + 1}` : "Текст")}
        </span>
        <CopyButton text={resolveText(shown.text, resolveVar)} />
      </div>
      {shown.fallback && (
        <p className="script-missing">
          Текста на {langInfo(lang).inName} нет — показан {langInfo(shown.lang).name}.
        </p>
      )}
      <div className="script-text" lang={shown.lang}>
        <RichText text={shown.text} terms={terms} resolveVar={resolveVar} />
      </div>
    </div>
  );
}

export default function ScriptCard({
  item,
  section,
  showSection,
  terms,
  lang,
  studio,
  onStudio,
  resolveRef,
  resolveVar,
  flash,
  canEdit,
  onEdit,
  onMove,
  isFirst,
  isLast,
}: {
  item: ScriptItem;
  section: ScriptSection;
  showSection: boolean;
  terms: string[];
  lang: ScriptLang;
  studio: string;
  onStudio: (label: string) => void;
  resolveRef: (title: string) => (() => void) | null;
  resolveVar: VarResolver;
  flash: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onMove: (delta: -1 | 1) => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const variant = pickVariant(item, studio);
  const messages = variant.messages;

  return (
    <article id={`script-${item.id}`} className={`script${flash ? " flash" : ""}`}>
      <header className="script-top">
        <div className="script-head">
          {/* Тип — цветной меткой справа от названия: отдельная строка под
              метку съедала высоту каждой карточки. */}
          {/* Шапка — всегда одна строка: название, тип и (в поиске) раздел.
              Студию здесь не пишем — её выбирают вкладками под шапкой, а
              вторая строка делала шапки разной высоты. */}
          <span className="script-title-row">
            <h3 className="script-title">
              <Highlight text={item.title} terms={terms} />
            </h3>
            <span className={`kind kind-${item.kind}`}>{KIND_LABELS[item.kind]}</span>
            {showSection && <span className="script-section">{section.title}</span>}
          </span>
        </div>
      </header>

      <div className="script-body">
        {item.note && (
          <div className="script-note">
            <span className="script-note-title">Как использовать</span>
            <p>
              <RichText text={item.note} terms={terms} resolveRef={resolveRef} resolveVar={resolveVar} />
            </p>
          </div>
        )}

        {item.variants.length > 1 && (
          <div className="script-variants">
            <span className="label">Студия</span>
            <div className="seg" role="group" aria-label="Вариант для студии">
              {item.variants.map((v) => (
                <button
                  key={v.label}
                  type="button"
                  className={`seg-btn${v === variant ? " on" : ""}`}
                  aria-pressed={v === variant}
                  onClick={() => onStudio(v.label)}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message, i) => (
          <MessageBlock
            key={i}
            message={message}
            index={i}
            total={messages.length}
            lang={lang}
            terms={terms}
            resolveVar={resolveVar}
          />
        ))}

        {item.follow_up && (
          <div className="script-after">
            <span className="script-after-title">❗ Дальше</span>
            <p>
              <RichText text={item.follow_up} terms={terms} resolveRef={resolveRef} resolveVar={resolveVar} />
            </p>
          </div>
        )}
      </div>

      {/* Полоса истории — на любой карточке, и в свёрнутом виде тоже. */}
      <footer className="script-foot">
        <span className="script-history">
          {item.updated_at && <span className="num">{fmtWhen(item.updated_at)}</span>}
          {item.updated_by && <span>{item.updated_by}</span>}
          {item.change_note && <span className="script-change">{item.change_note}</span>}
        </span>
        {canEdit && (
          <span className="script-actions">
            <button type="button" className="ghost small" disabled={isFirst}
              onClick={() => onMove(-1)} aria-label="Выше" title="Выше">
              ↑
            </button>
            <button type="button" className="ghost small" disabled={isLast}
              onClick={() => onMove(1)} aria-label="Ниже" title="Ниже">
              ↓
            </button>
            {/* Удаление — в правке, рядом с «Сохранить», с двойным
                подтверждением: здесь оно было бы в одном промахе от «Изменить». */}
            <button type="button" className="ghost small" onClick={onEdit}>
              Изменить
            </button>
          </span>
        )}
      </footer>
    </article>
  );
}
