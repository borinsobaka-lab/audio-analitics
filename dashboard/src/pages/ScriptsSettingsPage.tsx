/** Настройки скриптов: то, что подставляется в тексты само.
 *
 *  В скрипте пишут {админ}, {студия} или свою {переменную}, а администратор
 *  у стойки видит и копирует уже готовый текст: своё имя, свою студию,
 *  нужные значения — на языке переписки. Меньше мест, которые надо помнить
 *  и заполнять руками, — меньше «Меня зовут Анастасия» от имени Марии.
 *
 *  Всё на одной странице и сохраняется одной кнопкой: это одна форма, а не
 *  три независимых списка.
 */
import { useEffect, useMemo, useState } from "react";
import {
  AdminNames,
  api,
  fmtWhen,
  LangText,
  PlaybookSettings,
  ScriptVariable,
  StudioNames,
} from "../api";
import { Empty, Note, PageHead, Section, Skeleton } from "../components/ui";
import { BUILTIN_VARIABLES, dateAfter, dateAfterLabel, LANGS } from "../scripts/logic";
import { usePlaybook } from "../scripts/store";
import { useSession } from "../session";

const KEY_RE = /^[0-9A-Za-zА-Яа-яЁё_]{1,40}$/;

function LangInputs({
  value,
  onChange,
  placeholders,
  multiline = false,
}: {
  value: LangText;
  onChange: (value: LangText) => void;
  placeholders?: Partial<LangText>;
  multiline?: boolean;
}) {
  return (
    <>
      {LANGS.map((l) =>
        multiline ? (
          <textarea
            key={l.key}
            lang={l.key}
            rows={Math.min(6, Math.max(1, value[l.key].split("\n").length))}
            value={value[l.key]}
            aria-label={l.name}
            placeholder={placeholders?.[l.key] ?? l.label}
            onChange={(e) => onChange({ ...value, [l.key]: e.target.value })}
          />
        ) : (
          <input
            key={l.key}
            type="text"
            lang={l.key}
            value={value[l.key]}
            aria-label={l.name}
            placeholder={placeholders?.[l.key] ?? l.label}
            onChange={(e) => onChange({ ...value, [l.key]: e.target.value })}
          />
        )
      )}
    </>
  );
}

/** Дата «через N дней»: число дней и сразу значение на сегодня — видно,
 *  что подставится в скрипт и не выпадает ли день на выходной. */
function DateOffset({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return (
    <div className="var-date">
      <label className="var-date-days">
        <span>через</span>
        <input
          type="number"
          min={-365}
          max={365}
          value={days}
          aria-label="Через сколько дней от сегодня"
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            onChange(Number.isFinite(n) ? Math.max(-365, Math.min(365, n)) : 0);
          }}
        />
        <span>{days === 0 ? "дней — сегодня" : "дн. от сегодня"}</span>
      </label>
      <span className="var-date-preview">
        На сегодня: <strong>{dateAfterLabel(days)}</strong> — в скрипте будет{" "}
        <span className="var">{dateAfter(days)}</span> на всех языках
      </span>
    </div>
  );
}

function GridHead({ first }: { first: string }) {
  return (
    <div className="names-row names-head" aria-hidden="true">
      <span className="label">{first}</span>
      {LANGS.map((l) => (
        <span key={l.key} className="label">
          {l.label} · {l.name}
        </span>
      ))}
    </div>
  );
}

export default function ScriptsSettingsPage() {
  const me = useSession();
  const { setSettings } = usePlaybook();
  const [saved, setSaved] = useState<PlaybookSettings | null>(null);
  const [studios, setStudios] = useState<StudioNames[]>([]);
  const [admins, setAdmins] = useState<AdminNames[]>([]);
  const [variables, setVariables] = useState<ScriptVariable[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  function take(data: PlaybookSettings) {
    // Переменные, сохранённые до появления дат, приходят без типа — это текст.
    const variables = data.variables.map((v) => ({
      ...v,
      type: v.type ?? "text",
      offset_days: v.offset_days ?? 0,
    }));
    setSaved({ ...data, variables });
    setStudios(data.studios);
    setAdmins(data.admins);
    setVariables(variables);
  }

  useEffect(() => {
    api
      .playbookSettings()
      .then(take)
      .catch((e) => setError((e as Error).message));
  }, []);

  const dirty = useMemo(
    () =>
      saved !== null &&
      JSON.stringify([studios, admins, variables]) !==
        JSON.stringify([saved.studios, saved.admins, saved.variables]),
    [saved, studios, admins, variables]
  );

  const problem = useMemo(() => {
    const keys = new Set<string>();
    for (const v of variables) {
      if (!KEY_RE.test(v.key))
        return `Имя переменной «${v.key || "без имени"}» — только буквы, цифры и _, без пробелов`;
      const k = v.key.toLowerCase();
      if (BUILTIN_VARIABLES.some((b) => b.key === k))
        return `{${v.key}} подставляется автоматически — выберите другое имя`;
      if (keys.has(k)) return `Переменная {${v.key}} задана дважды`;
      keys.add(k);
    }
    return "";
  }, [variables]);

  async function save() {
    if (problem || saving) return;
    setSaving(true);
    setError("");
    setDone(false);
    try {
      const pick = ({ ru, en, ka }: LangText) => ({ ru, en, ka });
      const result = await api.savePlaybookSettings({
        studios: Object.fromEntries(studios.map((s) => [s.location_id, pick(s)])),
        admins: Object.fromEntries(admins.map((a) => [a.employee_id, pick(a)])),
        variables,
      });
      take(result);
      // Скрипты на соседней странице подставят новые значения сразу.
      setSettings(result);
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!me.can_edit_scripts) {
    return (
      <>
        <PageHead title="Настройки скриптов" />
        <Empty title="Нет доступа">
          Настройки меняют те, кому выдано «Скрипты: чтение и правка».
        </Empty>
      </>
    );
  }

  return (
    <div className="settings-page">
      <PageHead
        title="Настройки скриптов"
        hint="В тексте скрипта пишут {админ}, {студия} или свою {переменную} — администратор видит и копирует уже готовый текст: своё имя, свою студию, нужные значения, на языке переписки."
      />

      {error && <Note kind="error">{error}</Note>}
      {!saved && !error && <Skeleton count={3} height={120} />}

      {saved && (
        <>
          <Section title="Студии" hint="{студия} — студия, выбранная вверху страницы скриптов">
            <div className="sheet sheet-pad names-grid">
              <GridHead first="Точка продажи" />
              {studios.map((s, i) => (
                <div className="names-row" key={s.location_id}>
                  <span className="names-who">
                    {s.location_name}
                    {!s.active && <span className="muted"> · закрыта</span>}
                  </span>
                  <LangInputs
                    value={s}
                    placeholders={{ en: "латиницей", ka: "по-грузински" }}
                    onChange={(v) =>
                      setStudios((list) => list.map((x, j) => (j === i ? { ...x, ...v } : x)))
                    }
                  />
                </div>
              ))}
              {!studios.length && (
                <p className="muted">Точки продажи заводятся в «Аналитике» → «Точки продажи».</p>
              )}
            </div>
          </Section>

          <Section
            title="Имена администраторов"
            hint="{админ} — имя того, кто вошёл; так, как его пишут клиенту"
          >
            <div className="sheet sheet-pad names-grid">
              <GridHead first="Сотрудник" />
              {admins.map((a, i) => (
                <div className="names-row" key={a.employee_id}>
                  <span className="names-who">
                    {a.full_name}
                    {!a.has_login && <span className="muted"> · без входа</span>}
                  </span>
                  <LangInputs
                    value={a}
                    placeholders={{ en: "латиницей", ka: "по-грузински" }}
                    onChange={(v) =>
                      setAdmins((list) => list.map((x, j) => (j === i ? { ...x, ...v } : x)))
                    }
                  />
                </div>
              ))}
              {!admins.length && (
                <p className="muted">Сотрудники заводятся в разделе «Сотрудники» внизу меню.</p>
              )}
            </div>
          </Section>

          <Section
            title="Переменные"
            hint="текст на трёх языках — цены, ссылки, реквизиты; дата — через сколько дней от сегодня"
          >
            <div className="sheet sheet-pad vars-card">
              <div className="vars-builtin">
                {BUILTIN_VARIABLES.map((b) => (
                  <span key={b.key} className="vars-builtin-item">
                    <code className="var-chip static">{`{${b.key}}`}</code>
                    <span className="muted">{b.description}</span>
                  </span>
                ))}
              </div>

              {variables.length > 0 && <GridHead first="Переменная" />}
              {variables.map((v, i) => (
                <div className="names-row var-row" key={i}>
                  <span className="var-key">
                    <span className="var-key-input">
                      <span aria-hidden="true">{"{"}</span>
                      <input
                        type="text"
                        value={v.key}
                        aria-label="Имя переменной"
                        placeholder="цена_пробного"
                        spellCheck={false}
                        onChange={(e) =>
                          setVariables((list) =>
                            list.map((x, j) => (j === i ? { ...x, key: e.target.value.trim() } : x))
                          )
                        }
                      />
                      <span aria-hidden="true">{"}"}</span>
                    </span>
                    <input
                      type="text"
                      className="var-desc"
                      value={v.description}
                      aria-label="Что это"
                      placeholder="Что это — подсказка в редакторе"
                      onChange={(e) =>
                        setVariables((list) =>
                          list.map((x, j) => (j === i ? { ...x, description: e.target.value } : x))
                        )
                      }
                    />
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => setVariables((list) => list.filter((_, j) => j !== i))}
                    >
                      Удалить
                    </button>
                  </span>
                  {v.type === "date" ? (
                    <DateOffset
                      days={v.offset_days ?? 0}
                      onChange={(days) =>
                        setVariables((list) =>
                          list.map((x, j) => (j === i ? { ...x, offset_days: days } : x))
                        )
                      }
                    />
                  ) : (
                    <LangInputs
                      multiline
                      value={v}
                      onChange={(val) =>
                        setVariables((list) => list.map((x, j) => (j === i ? { ...x, ...val } : x)))
                      }
                    />
                  )}
                </div>
              ))}

              <div className="actions">
                <button
                  type="button"
                  className="secondary small"
                  onClick={() =>
                    setVariables((list) => [
                      ...list,
                      { key: "", type: "text", description: "", ru: "", en: "", ka: "", offset_days: 0 },
                    ])
                  }
                >
                  + Текст
                </button>
                <button
                  type="button"
                  className="secondary small"
                  onClick={() =>
                    setVariables((list) => [
                      ...list,
                      {
                        key: "",
                        type: "date",
                        description: "",
                        ru: "",
                        en: "",
                        ka: "",
                        offset_days: 1,
                      },
                    ])
                  }
                >
                  + Дата
                </button>
              </div>
            </div>
          </Section>

          <div className="settings-bar">
            <span className="muted">
              {problem
                ? problem
                : dirty
                  ? "Есть несохранённые изменения"
                  : done
                    ? "Сохранено — скрипты уже подставляют новые значения"
                    : saved.updated_at
                      ? `Сохранено ${fmtWhen(saved.updated_at)}${saved.updated_by ? ` · ${saved.updated_by}` : ""}`
                      : "Пока не сохранялось — показаны имена по умолчанию"}
            </span>
            <button type="button" onClick={save} disabled={saving || Boolean(problem) || !dirty}>
              {saving ? "Сохраняем…" : "Сохранить настройки"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
