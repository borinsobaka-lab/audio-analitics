/** Правка скрипта — тем, кому открыты настройки (доступ «все смены»).
 *
 *  Форма повторяет устройство карточки: пояснение, варианты по студиям,
 *  сообщения на трёх языках, «что дальше». Пишется прямо на месте карточки,
 *  чтобы правка не уводила со страницы, где видно соседние скрипты.
 */
import { useRef, useState } from "react";
import {
  ScriptItemDraft,
  ScriptKind,
  ScriptLang,
  ScriptMessage,
  ScriptSection,
  ScriptVariant,
} from "../api";
import { Note } from "../components/ui";
import { KIND_LABELS, LANGS, normalize } from "./logic";

const emptyMessage = (): ScriptMessage => ({ label: "", ru: "", en: "", ka: "" });

export function emptyDraft(sectionId: string): ScriptItemDraft {
  return {
    section_id: sectionId,
    title: "",
    kind: "chat",
    keywords: "",
    note: "",
    follow_up: "",
    variants: [{ label: "", messages: [emptyMessage()] }],
  };
}

/** Панель форматирования над подсказкой: жирный, подчёркнутый, список и
 *  ссылка на другой скрипт. Кнопки вставляют разметку прямо в текст
 *  (**…**, __…__, «• », [фраза](script:id)) — её видно и можно поправить
 *  руками, а в карточке она превращается в оформление. */
function FormatBar({
  targetId,
  value,
  onChange,
  sections,
}: {
  targetId: string;
  value: string;
  onChange: (value: string) => void;
  sections: ScriptSection[];
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  // Выделение запоминается до открытия выбора скрипта: поиск забирает фокус.
  const saved = useRef<[number, number]>([0, 0]);

  function area(): HTMLTextAreaElement | null {
    return document.getElementById(targetId) as HTMLTextAreaElement | null;
  }

  function apply(next: string, selStart: number, selEnd: number) {
    onChange(next);
    requestAnimationFrame(() => {
      const el = area();
      if (!el) return;
      el.focus();
      el.setSelectionRange(selStart, selEnd);
    });
  }

  function wrap(marker: string, placeholder: string) {
    const el = area();
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const inner = value.slice(start, end) || placeholder;
    const next = value.slice(0, start) + marker + inner + marker + value.slice(end);
    apply(next, start + marker.length, start + marker.length + inner.length);
  }

  function toggleList() {
    const el = area();
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const nl = value.indexOf("\n", end);
    const lineEnd = nl === -1 ? value.length : nl;
    const lines = value.slice(lineStart, lineEnd).split("\n");
    const marked = /^\s*[•\-–]\s+/;
    const allMarked = lines.every((l) => !l.trim() || marked.test(l));
    const changed = lines
      .map((l) => (!l.trim() ? l : allMarked ? l.replace(marked, "") : marked.test(l) ? l : `• ${l}`))
      .join("\n");
    const block = changed || "• ";
    apply(value.slice(0, lineStart) + block + value.slice(lineEnd), lineStart, lineStart + block.length);
  }

  function openPicker() {
    const el = area();
    saved.current = [el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length];
    setQuery("");
    setPicking(true);
  }

  function link(id: string, title: string) {
    const [start, end] = saved.current;
    const text = value.slice(start, end).trim() || title;
    const token = `[${text}](script:${id})`;
    setPicking(false);
    apply(value.slice(0, start) + token + value.slice(end), start + token.length, start + token.length);
  }

  const q = normalize(query.trim());
  const options = sections
    .flatMap((s) => s.items.map((i) => ({ id: i.id, title: i.title, section: s.title })))
    .filter((o) => !q || normalize(`${o.title} ${o.section}`).includes(q))
    .slice(0, 8);

  return (
    <div className="format-bar">
      <div className="format-buttons" role="toolbar" aria-label="Оформление подсказки">
        {/* mousedown не уводит фокус из текста — выделение остаётся. */}
        <button type="button" className="fmt-btn" title="Жирный: выделите текст и нажмите"
          onMouseDown={(e) => e.preventDefault()} onClick={() => wrap("**", "жирный текст")}>
          <strong>Ж</strong>
        </button>
        <button type="button" className="fmt-btn" title="Подчёркнутый: выделите текст и нажмите"
          onMouseDown={(e) => e.preventDefault()} onClick={() => wrap("__", "подчёркнутый текст")}>
          <u>П</u>
        </button>
        <button type="button" className="fmt-btn wide" title="Пункты с новой строки: выделите строки и нажмите"
          onMouseDown={(e) => e.preventDefault()} onClick={toggleList}>
          • Список
        </button>
        <button type="button" className="fmt-btn wide" title="Выделите фразу и выберите скрипт — фраза станет ссылкой на него"
          onMouseDown={(e) => e.preventDefault()} onClick={openPicker}>
          ↗ Ссылка на скрипт
        </button>
      </div>
      {picking && (
        <div className="script-picker">
          <input
            type="text"
            autoFocus
            value={query}
            placeholder="Найти скрипт по названию или разделу"
            aria-label="Найти скрипт для ссылки"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPicking(false);
              if (e.key === "Enter" && options[0]) {
                e.preventDefault();
                link(options[0].id, options[0].title);
              }
            }}
          />
          <ul>
            {options.map((o) => (
              <li key={o.id}>
                <button type="button" onClick={() => link(o.id, o.title)}>
                  <span className="picker-title">{o.title}</span>
                  <span className="picker-section">{o.section}</span>
                </button>
              </li>
            ))}
            {!options.length && <li className="muted picker-empty">Ничего не нашлось</li>}
          </ul>
          <p className="muted picker-hint">
            {saved.current[0] !== saved.current[1]
              ? "Выделенная фраза станет ссылкой на выбранный скрипт."
              : "Ничего не выделено — вставим название скрипта ссылкой."}
          </p>
          <button type="button" className="ghost small" onClick={() => setPicking(false)}>
            Отмена
          </button>
        </div>
      )}
    </div>
  );
}

function rowsFor(value: string, min = 3): number {
  return Math.min(18, Math.max(min, value.split("\n").length + 1));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export default function ScriptEditor({
  initial,
  sections,
  studios,
  isNew,
  variables,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: ScriptItemDraft;
  sections: ScriptSection[];
  /** Названия студий, под которые можно разделить текст. */
  studios: string[];
  isNew: boolean;
  /** Переменные, которые можно вставить в текст: {админ}, {студия}, свои. */
  variables: { key: string; description: string }[];
  onSave: (draft: ScriptItemDraft, changeNote: string) => Promise<void>;
  onCancel: () => void;
  /** Удаление — только у существующего скрипта. */
  onDelete?: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<ScriptItemDraft>(() => clone(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Сохранение правки — в два шага: сначала «что изменили», потом запись.
  const [asking, setAsking] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  // Удаление — после двух подтверждений: 0 — кнопка, 1 — первый вопрос,
  // 2 — последний. Скрипт пропадает у всех сразу и не восстанавливается.
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);

  async function remove() {
    if (!onDelete) return;
    setSaving(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
      setDeleteStep(0);
    }
  }
  // Поле, в котором стоял курсор: туда вставляется переменная по кнопке.
  const lastField = useRef<string | null>(null);
  const byStudio = draft.variants.length > 1;

  /** Вставить {переменную} туда, где стоял курсор, — в текст сообщения,
   *  пояснение или «Дальше». */
  function insertVariable(key: string) {
    const id = lastField.current;
    const el = id ? (document.getElementById(id) as HTMLTextAreaElement | null) : null;
    if (!id || !el) {
      setError("Поставьте курсор в текст сообщения, а потом нажмите на переменную");
      return;
    }
    setError(null);
    const token = `{${key}}`;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    const m = /^msg-(\d+)-(\d+)-(ru|en|ka)$/.exec(id);
    if (m) setMessage(Number(m[1]), Number(m[2]), { [m[3]]: next } as Partial<ScriptMessage>);
    else if (id === "ed-note") patch({ note: next });
    else if (id === "ed-follow") patch({ follow_up: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  const focusProps = (id: string) => ({
    id,
    onFocus: () => {
      lastField.current = id;
    },
  });

  function patch(fields: Partial<ScriptItemDraft>) {
    setDraft((d) => ({ ...d, ...fields }));
  }

  function setVariants(fn: (variants: ScriptVariant[]) => ScriptVariant[]) {
    setDraft((d) => ({ ...d, variants: fn(clone(d.variants)) }));
  }

  function setMessage(vi: number, mi: number, fields: Partial<ScriptMessage>) {
    setVariants((vs) => {
      vs[vi].messages[mi] = { ...vs[vi].messages[mi], ...fields };
      return vs;
    });
  }

  function moveMessage(vi: number, mi: number, delta: -1 | 1) {
    setVariants((vs) => {
      const list = vs[vi].messages;
      const [m] = list.splice(mi, 1);
      list.splice(mi + delta, 0, m);
      return vs;
    });
  }

  /** Разделить по студиям: тексты копируются в каждый вариант — обычно
   *  отличается только адрес и дорога, остальное править не придётся. */
  function splitByStudio() {
    setVariants((vs) => {
      const labels = studios.length >= 2 ? studios : ["Студия 1", "Студия 2"];
      return labels.map((label) => ({ label, messages: clone(vs[0].messages) }));
    });
  }

  function removeVariant(vi: number) {
    setVariants((vs) => {
      vs.splice(vi, 1);
      if (vs.length === 1) vs[0].label = "";
      return vs;
    });
  }

  function validate(): string | null {
    if (!draft.title.trim()) return "Дайте скрипту название — по нему его будут искать";
    const labels = draft.variants.map((v) => v.label.trim());
    if (byStudio && labels.some((l) => !l)) return "У каждого варианта должно быть название студии";
    if (new Set(labels).size !== labels.length) return "Названия вариантов повторяются";
    for (const v of draft.variants) {
      const hasText = v.messages.some((m) => LANGS.some((l) => m[l.key].trim()));
      if (!hasText)
        return v.label
          ? `В варианте «${v.label}» нет ни одного текста`
          : "Добавьте текст хотя бы на одном языке";
    }
    return null;
  }

  /** Первый шаг: проверить форму и спросить, что изменили. Новый скрипт
   *  сохраняется сразу — «что изменили» у него одно: «Новый скрипт». */
  function requestSave() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    if (isNew) commit("Новый скрипт");
    else setAsking(true);
  }

  async function commit(note: string) {
    if (!note.trim()) {
      setError("Опишите в двух словах, что изменили, — это увидят все на карточке скрипта");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(draft, note.trim());
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="script editing">
      <div className="script-editor">
        <h3>{isNew ? "Новый скрипт" : "Правка скрипта"}</h3>

        <div className="editor-row">
          <label className="field grow">
            <span className="label">Название</span>
            <input
              type="text"
              value={draft.title}
              autoFocus={isNew}
              placeholder="Например: «Где мы?» или «Дорого»"
              onChange={(e) => patch({ title: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="label">Тип</span>
            <select
              value={draft.kind}
              onChange={(e) => patch({ kind: e.target.value as ScriptKind })}
            >
              {(Object.keys(KIND_LABELS) as ScriptKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Раздел</span>
            <select
              value={draft.section_id}
              onChange={(e) => patch({ section_id: e.target.value })}
            >
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="field">
          <label className="label" htmlFor="ed-note">
            Как использовать — подсказка всем сотрудникам, клиенту не копируется
          </label>
          <FormatBar
            targetId="ed-note"
            value={draft.note}
            onChange={(note) => patch({ note })}
            sections={sections}
          />
          <textarea
            {...focusProps("ed-note")}
            value={draft.note}
            rows={rowsFor(draft.note, 2)}
            placeholder="Когда отправлять, что проверить перед этим. Видят все, кто открывает скрипты. Необязательно."
            onChange={(e) => patch({ note: e.target.value })}
          />
        </div>

        {draft.variants.map((variant, vi) => (
          <div className={byStudio ? "editor-variant" : "editor-plain"} key={vi}>
            {byStudio && (
              <div className="editor-variant-head">
                <label className="field grow">
                  <span className="label">Студия</span>
                  <input
                    type="text"
                    value={variant.label}
                    onChange={(e) =>
                      setVariants((vs) => {
                        vs[vi].label = e.target.value;
                        return vs;
                      })
                    }
                  />
                </label>
                <button type="button" className="ghost small" onClick={() => removeVariant(vi)}>
                  Убрать вариант
                </button>
              </div>
            )}

            {variant.messages.map((message, mi) => (
              <div className="editor-msg" key={mi}>
                <div className="editor-msg-head">
                  <input
                    type="text"
                    className="editor-msg-label"
                    value={message.label}
                    placeholder={
                      variant.messages.length > 1
                        ? `Сообщение ${mi + 1} — подпись, например «Если выбирают…»`
                        : "Подпись сообщения — необязательно"
                    }
                    onChange={(e) => setMessage(vi, mi, { label: e.target.value })}
                  />
                  <div className="actions">
                    <button type="button" className="ghost small" disabled={mi === 0}
                      onClick={() => moveMessage(vi, mi, -1)} aria-label="Сообщение выше" title="Сообщение выше">
                      ↑
                    </button>
                    <button type="button" className="ghost small"
                      disabled={mi === variant.messages.length - 1}
                      onClick={() => moveMessage(vi, mi, 1)} aria-label="Сообщение ниже" title="Сообщение ниже">
                      ↓
                    </button>
                    <button type="button" className="ghost small"
                      disabled={variant.messages.length === 1}
                      onClick={() =>
                        setVariants((vs) => {
                          vs[vi].messages.splice(mi, 1);
                          return vs;
                        })
                      }>
                      Удалить
                    </button>
                  </div>
                </div>
                {LANGS.map((l) => (
                  <label className="lang-field" key={l.key}>
                    <span className="lang-tag">{l.label}</span>
                    <textarea
                      {...focusProps(`msg-${vi}-${mi}-${l.key}`)}
                      value={message[l.key]}
                      lang={l.key}
                      rows={rowsFor(message[l.key])}
                      placeholder={`Текст на ${l.inName}${l.key === "ru" ? "" : " — если есть"}`}
                      onChange={(e) =>
                        setMessage(vi, mi, { [l.key]: e.target.value } as Record<ScriptLang, string>)
                      }
                    />
                  </label>
                ))}
              </div>
            ))}

            <button
              type="button"
              className="secondary small"
              onClick={() =>
                setVariants((vs) => {
                  vs[vi].messages.push(emptyMessage());
                  return vs;
                })
              }
            >
              + Сообщение
            </button>
          </div>
        ))}

        <div className="actions">
          {byStudio ? (
            <button
              type="button"
              className="ghost small"
              onClick={() =>
                setVariants((vs) => [...vs, { label: "", messages: clone(vs[0].messages) }])
              }
            >
              + Вариант для студии
            </button>
          ) : (
            <button type="button" className="ghost small" onClick={splitByStudio}>
              Разделить по студиям
            </button>
          )}
        </div>
        <div className="editor-vars">
          <span className="label">Вставить переменную — туда, где курсор</span>
          <div className="var-chips">
            {variables.map((v) => (
              <button
                key={v.key}
                type="button"
                className="var-chip"
                title={v.description || undefined}
                // mousedown не уводит фокус из текста — курсор остаётся там,
                // куда вставлять.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertVariable(v.key)}
              >
                {`{${v.key}}`}
              </button>
            ))}
          </div>
          <p className="muted editor-hint">
            {"{переменные}"} в фигурных скобках подставляются сами — имя вошедшего,
            студия, значения из настроек — на языке текста. [день], [время] в
            квадратных скобках — места, которые администратор заполняет руками.
            Тексты сообщений не форматируются — они копируются клиенту в чат.
          </p>
        </div>

        <div className="field">
          <label className="label" htmlFor="ed-follow">
            Дальше — что сделать после отправки
          </label>
          <FormatBar
            targetId="ed-follow"
            value={draft.follow_up}
            onChange={(follow_up) => patch({ follow_up })}
            sections={sections}
          />
          <textarea
            {...focusProps("ed-follow")}
            value={draft.follow_up}
            rows={rowsFor(draft.follow_up, 2)}
            placeholder="Например: через 2 дня поставить задачу — выделите название и нажмите «Ссылка на скрипт»"
            onChange={(e) => patch({ follow_up: e.target.value })}
          />
        </div>

        <label className="field">
          <span className="label">Слова для поиска</span>
          <input
            type="text"
            value={draft.keywords}
            placeholder="Чего нет в тексте, но по чему будут искать: цена, прайс, адрес"
            onChange={(e) => patch({ keywords: e.target.value })}
          />
        </label>

        {asking && (
          <div className="change-ask">
            <label className="field">
              <span className="label">Что изменили? Это увидят все на карточке скрипта</span>
              <input
                type="text"
                value={changeNote}
                autoFocus
                maxLength={500}
                placeholder="Например: обновили цену пробного, добавили ветку для EN"
                onChange={(e) => setChangeNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit(changeNote);
                  if (e.key === "Escape") setAsking(false);
                }}
              />
            </label>
          </div>
        )}

        {error && <Note kind="error">{error}</Note>}

        <div className="actions">
          {asking ? (
            <>
              <button type="button" onClick={() => commit(changeNote)} disabled={saving || !changeNote.trim()}>
                {saving ? "Сохраняем…" : "Сохранить изменения"}
              </button>
              <button type="button" className="ghost" onClick={() => setAsking(false)} disabled={saving}>
                Назад к правке
              </button>
            </>
          ) : deleteStep === 0 ? (
            <>
              <button type="button" onClick={requestSave} disabled={saving}>
                {saving ? "Сохраняем…" : isNew ? "Добавить скрипт" : "Сохранить"}
              </button>
              <button type="button" className="ghost" onClick={onCancel} disabled={saving}>
                Отмена
              </button>
              {onDelete && (
                <button
                  type="button"
                  className="danger delete-start"
                  onClick={() => setDeleteStep(1)}
                  disabled={saving}
                >
                  Удалить
                </button>
              )}
            </>
          ) : (
            <div className="delete-confirm" role="alertdialog" aria-live="assertive">
              <span className="delete-question">
                {deleteStep === 1
                  ? `Удалить скрипт «${draft.title || initial.title}»?`
                  : "Точно удалить? Скрипт пропадёт у всех, вернуть его будет нельзя."}
              </span>
              <button
                type="button"
                className="danger"
                autoFocus
                disabled={saving}
                onClick={() => (deleteStep === 1 ? setDeleteStep(2) : remove())}
              >
                {deleteStep === 1 ? "Да, удалить" : saving ? "Удаляем…" : "Удалить навсегда"}
              </button>
              <button type="button" className="ghost" disabled={saving} onClick={() => setDeleteStep(0)}>
                Не удалять
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
