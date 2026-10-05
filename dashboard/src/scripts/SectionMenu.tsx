/** Меню «⋯» у заголовков на странице скриптов. */
import { ReactNode, useEffect, useRef, useState } from "react";
import type { ScriptSection } from "../api";

const IconDots = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5.5" cy="12" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="18.5" cy="12" r="1.7" />
  </svg>
);

/** Кнопка «⋯» с выпадающим меню: закрывается кликом мимо и Escape.
 *  children получает close — пункты сами решают, закрывать ли меню. */
export function DotsMenu({
  label,
  title,
  onOpenChange,
  children,
}: {
  label: string;
  title: string;
  onOpenChange?: (open: boolean) => void;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    onOpenChange?.(open);
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // onOpenChange — не зависимость: меню реагирует только на открытие.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <span className="section-menu" ref={ref}>
      <button
        type="button"
        className={`section-menu-btn${open ? " on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <IconDots />
      </button>
      {open && (
        <span className="menu" role="menu">
          {children(() => setOpen(false))}
        </span>
      )}
    </span>
  );
}

/** «⋯» справа от названия раздела: название и иконка, порядок в меню,
 *  удаление пустого раздела. Нужно редко — поэтому в меню, а не кнопками
 *  в шапке страницы, где они отвлекали от скриптов. */
export function SectionMenu({
  section,
  isFirst,
  isLast,
  onEdit,
  onMove,
  onDelete,
}: {
  section: ScriptSection;
  isFirst: boolean;
  isLast: boolean;
  onEdit: () => void;
  onMove: (delta: -1 | 1) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <DotsMenu
      label={`Раздел «${section.title}»: действия`}
      title="Название, иконка, порядок"
      onOpenChange={(open) => !open && setConfirmDelete(false)}
    >
      {(close) => (
        <>
          <button type="button" role="menuitem" onClick={() => { close(); onEdit(); }}>
            Название и иконка
          </button>
          {/* Порядок — меню не закрывается: раздел часто двигают на
              несколько позиций подряд. */}
          <button type="button" role="menuitem" disabled={isFirst} onClick={() => onMove(-1)}>
            ↑ Выше в меню
          </button>
          <button type="button" role="menuitem" disabled={isLast} onClick={() => onMove(1)}>
            ↓ Ниже в меню
          </button>
          {/* Раздел со скриптами не удаляется вовсе — сервер откажет, и
              прятать пункт честнее, чем показывать отказ. */}
          {section.items.length === 0 &&
            (confirmDelete ? (
              <button type="button" role="menuitem" className="danger"
                onClick={() => { close(); onDelete(); }}>
                Точно удалить раздел
              </button>
            ) : (
              <button type="button" role="menuitem" className="danger"
                onClick={() => setConfirmDelete(true)}>
                Удалить раздел…
              </button>
            ))}
        </>
      )}
    </DotsMenu>
  );
}
