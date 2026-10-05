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
import { KIND_LABELS, LANGS } from "./logic";

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
}) {
  const [draft, setDraft] = useState<ScriptItemDraft>(() => clone(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Сохранение правки — в два шага: сначала «что изменили», потом запись.
  const [asking, setAsking] = useState(false);
  const [changeNote, setChangeNote] = useState("");
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

        <label className="field">
          <span className="label">Как использовать — видит только администратор</span>
          <textarea
            {...focusProps("ed-note")}
            value={draft.note}
            rows={rowsFor(draft.note, 2)}
            placeholder="Когда отправлять, что проверить перед этим. Необязательно."
            onChange={(e) => patch({ note: e.target.value })}
          />
        </label>

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
            «Название другого скрипта» в кавычках-ёлочках становится ссылкой.
          </p>
        </div>

        <label className="field">
          <span className="label">Дальше — что сделать после отправки</span>
          <textarea
            {...focusProps("ed-follow")}
            value={draft.follow_up}
            rows={rowsFor(draft.follow_up, 2)}
            placeholder="Например: через 2 дня поставить задачу «Заканчиваем запись»"
            onChange={(e) => patch({ follow_up: e.target.value })}
          />
        </label>

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
          ) : (
            <>
              <button type="button" onClick={requestSave} disabled={saving}>
                {saving ? "Сохраняем…" : isNew ? "Добавить скрипт" : "Сохранить"}
              </button>
              <button type="button" className="ghost" onClick={onCancel} disabled={saving}>
                Отмена
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
