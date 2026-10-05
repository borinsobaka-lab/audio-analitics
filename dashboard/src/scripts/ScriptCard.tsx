/** Карточка скрипта.
 *
 *  Свёрнутая — название, начало текста и кнопка «Копировать»: опытному
 *  администратору этого хватает, раскрывать ничего не нужно. Раскрытая —
 *  всё, что было в документе вокруг текста: когда отправлять, ветки «если
 *  выбирают…», варианты по студиям и что сделать после отправки.
 */
import { useEffect, useRef, useState } from "react";
import { fmtWhen, ScriptItem, ScriptLang, ScriptSection } from "../api";
import { ConfirmAction } from "../components/ui";
import {
  copyText,
  KIND_LABELS,
  langInfo,
  messageText,
  pickVariant,
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

const IconChevron = ({ open }: { open: boolean }) => (
  <svg className={`chev${open ? " open" : ""}`} width="16" height="16" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
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

export default function ScriptCard({
  item,
  section,
  showSection,
  terms,
  expanded,
  onToggle,
  lang,
  studio,
  onStudio,
  resolveRef,
  flash,
  canEdit,
  onEdit,
  onMove,
  onDelete,
  isFirst,
  isLast,
}: {
  item: ScriptItem;
  section: ScriptSection;
  showSection: boolean;
  terms: string[];
  expanded: boolean;
  onToggle: () => void;
  lang: ScriptLang;
  studio: string;
  onStudio: (label: string) => void;
  resolveRef: (title: string) => (() => void) | null;
  flash: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const variant = pickVariant(item, studio);
  const messages = variant.messages.map((m) => ({ message: m, shown: messageText(m, lang) }));
  const first = messages[0]?.shown;
  const single = messages.length === 1 ? first : null;
  const bodyId = `script-body-${item.id}`;

  return (
    <article id={`script-${item.id}`} className={`script${expanded ? " open" : ""}${flash ? " flash" : ""}`}>
      <div className="script-top">
        <button
          type="button"
          className="script-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="script-meta">
            <span className="kind">{KIND_LABELS[item.kind]}</span>
            {showSection && <span className="script-section">{section.title}</span>}
            {variant.label && item.variants.length > 1 && (
              <span className="script-section">{variant.label}</span>
            )}
          </span>
          <span className="script-title">
            <Highlight text={item.title} terms={terms} />
          </span>
          {!expanded && first && (
            <span className="script-preview">
              {/* Превью — одной строкой: переносы из письма здесь только
                  съели бы две отведённые строки пустотой. */}
              <RichText text={first.text.replace(/\s*\n\s*/g, " ")} terms={terms} />
            </span>
          )}
        </button>
        <div className="script-quick">
          {/* Быстрое копирование — только когда сообщение одно: из скрипта
              с ветками «если выбирают…» нечего копировать вслепую. */}
          {single && !expanded && <CopyButton text={single.text} />}
          <button
            type="button"
            className="ghost small icon-btn"
            onClick={onToggle}
            aria-label={expanded ? "Свернуть" : "Развернуть"}
            aria-expanded={expanded}
            aria-controls={bodyId}
          >
            <IconChevron open={expanded} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="script-body" id={bodyId}>
          {item.note && (
            <div className="script-note">
              <span className="label">Как использовать</span>
              <p>
                <RichText text={item.note} terms={terms} resolveRef={resolveRef} />
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

          {messages.map(({ message, shown }, i) => (
            <div className="script-msg" key={i}>
              <div className="script-msg-head">
                <span className="script-msg-label">
                  {message.label ||
                    (messages.length > 1 ? `Сообщение ${i + 1}` : "Текст")}
                </span>
                <CopyButton text={shown.text} />
              </div>
              {shown.fallback && (
                <p className="script-missing">
                  Текста на {langInfo(lang).inName} нет — показан{" "}
                  {langInfo(shown.lang).name}.
                </p>
              )}
              <div className="script-text" lang={shown.lang}>
                <RichText text={shown.text} terms={terms} />
              </div>
            </div>
          ))}

          {item.follow_up && (
            <div className="script-after">
              <span className="script-after-title">Дальше</span>
              <p>
                <RichText text={item.follow_up} terms={terms} resolveRef={resolveRef} />
              </p>
            </div>
          )}
        </div>
      )}

      {expanded && canEdit && (
        <div className="script-foot">
          <span className="muted">
            {item.updated_by ? `${item.updated_by} · ` : ""}
            {item.updated_at ? fmtWhen(item.updated_at) : ""}
          </span>
          <div className="actions">
            <button type="button" className="ghost small" disabled={isFirst}
              onClick={() => onMove(-1)} aria-label="Выше" title="Выше">
              ↑
            </button>
            <button type="button" className="ghost small" disabled={isLast}
              onClick={() => onMove(1)} aria-label="Ниже" title="Ниже">
              ↓
            </button>
            <button type="button" className="secondary small" onClick={onEdit}>
              Изменить
            </button>
            <ConfirmAction small label="Удалить" confirmLabel="Удалить скрипт" onConfirm={onDelete} />
          </div>
        </div>
      )}
    </article>
  );
}
