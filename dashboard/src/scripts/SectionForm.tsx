/** Форма раздела: название, иконка в меню и — при создании — тип
 *  (текстовые скрипты или звонок). */
import { useState } from "react";
import { DEFAULT_SECTION_ICON, SECTION_ICONS } from "../components/navIcons";

export default function SectionForm({
  heading,
  submitLabel,
  initialTitle,
  initialIcon,
  withKind = false,
  onSubmit,
  onDone,
}: {
  heading: string;
  submitLabel: string;
  initialTitle: string;
  initialIcon: string;
  /** Выбор типа — только при создании: тип у готового раздела не меняется. */
  withKind?: boolean;
  onSubmit: (body: { title: string; icon: string; kind: "text" | "call" }) => Promise<boolean>;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [icon, setIcon] = useState(initialIcon);
  const [kind, setKind] = useState<"text" | "call">("text");
  const [saving, setSaving] = useState(false);

  return (
    <form
      className="sheet sheet-pad section-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim() || saving) return;
        setSaving(true);
        onSubmit({ title: title.trim(), icon, kind }).then((ok) => {
          setSaving(false);
          if (ok) onDone();
        });
      }}
    >
      <h3>{heading}</h3>
      {withKind && (
        <div className="field">
          <span className="label" id="section-kind-label">Тип раздела</span>
          <div className="kind-choice" role="radiogroup" aria-labelledby="section-kind-label">
            {([
              ["text", "Текстовые скрипты", "Сообщения для чата и звонков: копируются одной кнопкой."],
              ["call", "Звонок", "Один сценарий звонка: читать с экрана и кликать ответы клиента."],
            ] as const).map(([key, label, hint]) => (
              <button key={key} type="button" role="radio" aria-checked={kind === key}
                className={`kind-option${kind === key ? " on" : ""}`}
                onClick={() => {
                  setKind(key);
                  if (key === "call" && icon === DEFAULT_SECTION_ICON) setIcon("phone-calling-rounded");
                }}>
                <strong>{label}</strong>
                <span className="muted">{hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <label className="field">
        <span className="label">Название</span>
        <input
          type="text"
          value={title}
          autoFocus
          placeholder="Например: «Работа с отзывами»"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <div className="field">
        <span className="label" id="section-icon-label">Иконка в меню</span>
        <div className="icon-picker" role="radiogroup" aria-labelledby="section-icon-label">
          {SECTION_ICONS.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={icon === key}
              aria-label={label}
              title={label}
              className={`icon-choice${icon === key ? " on" : ""}`}
              onClick={() => setIcon(key)}
            >
              <Icon size={22} />
            </button>
          ))}
        </div>
      </div>
      <div className="actions">
        <button type="submit" disabled={!title.trim() || saving}>
          {saving ? "Сохраняем…" : submitLabel}
        </button>
        <button type="button" className="ghost" onClick={onDone} disabled={saving}>
          Отмена
        </button>
      </div>
    </form>
  );
}
