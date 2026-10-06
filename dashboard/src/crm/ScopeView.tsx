/** «Что разбирать»: рабочее время студии и то, что из разбора исключено.
 *
 *  Рабочее время — основа скорости ответа: ночь и выходные студии не
 *  считаются ожиданием, а «без ответа» — это клиент, ждущий дольше нормы
 *  именно рабочего времени. Исключения — воронки, этапы и менеджеры, чьи
 *  сделки разбирать не нужно: рассылки, сопровождение после продажи,
 *  стажёр. Исключённые сделки не тратят ни деньги, ни лимит сделок.
 */
import { useEffect, useMemo, useState } from "react";
import { api, CrmSettings, CrmSettingsIn, CrmStageRef, fmtWhen, plural } from "../api";
import { Note, Section, Skeleton } from "../components/ui";

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const TIMES = Array.from({ length: 49 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
const SLOW = [15, 30, 45, 60, 90, 120, 180, 240];

type Draft = Pick<
  CrmSettingsIn,
  "work_start" | "work_end" | "work_days" | "slow_reply_minutes" | "exclude_pipelines" | "exclude_stages" | "exclude_managers"
>;

function draftOf(s: CrmSettings): Draft {
  return {
    work_start: s.work_start,
    work_end: s.work_end,
    work_days: [...s.work_days].sort(),
    slow_reply_minutes: s.slow_reply_minutes,
    exclude_pipelines: [...s.exclude_pipelines],
    exclude_stages: s.exclude_stages.map((x) => ({ ...x })),
    exclude_managers: [...s.exclude_managers],
  };
}

const sameStage = (a: CrmStageRef, b: CrmStageRef) => a.pipeline === b.pipeline && a.stage === b.stage;

function toggle<T>(list: T[], item: T, eq: (a: T, b: T) => boolean = (a, b) => a === b): T[] {
  return list.some((x) => eq(x, item)) ? list.filter((x) => !eq(x, item)) : [...list, item];
}

export default function ScopeView() {
  const [data, setData] = useState<CrmSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    api
      .crmSettings()
      .then((s) => {
        setData(s);
        setDraft(draftOf(s));
      })
      .catch((e) => setError(String(e).replace(/^Error:\s*/, "")));
  }, []);

  const dirty = useMemo(
    () => (data && draft ? JSON.stringify(draftOf(data)) !== JSON.stringify(draft) : false),
    [data, draft]
  );

  if (!data || !draft) return error ? <Note kind="error">{error}</Note> : <Skeleton count={2} height={180} />;

  const set = (fields: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...fields } : d));
  const invalid = draft.work_end <= draft.work_start ? "Конец рабочего дня должен быть позже начала" : draft.work_days.length === 0 ? "Отметьте хотя бы один рабочий день" : "";

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await api.saveCrmSettings(draft);
      setData(res);
      setDraft(draftOf(res));
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setSaving(false);
    }
  };

  const excludedCount =
    draft.exclude_pipelines.length + draft.exclude_stages.length + draft.exclude_managers.length;

  return (
    <div className="crm-scope">
      <Section title="Рабочее время студии" hint="по нему считается скорость ответа клиенту">
        <div className="sheet sheet-pad crm-scope-card">
          <div className="field-row crm-hours">
            <label className="field">
              <span className="label">С</span>
              <select value={draft.work_start} onChange={(e) => set({ work_start: e.target.value })}>
                {TIMES.slice(0, -1).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="label">До</span>
              <select value={draft.work_end} onChange={(e) => set({ work_end: e.target.value })}>
                {TIMES.slice(1).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="crm-days">
              <legend className="label">Рабочие дни</legend>
              {DAYS.map((name, i) => (
                <label key={name} className={`crm-day${draft.work_days.includes(i) ? " on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={draft.work_days.includes(i)}
                    onChange={() => set({ work_days: toggle(draft.work_days, i).sort() })}
                  />
                  {name}
                </label>
              ))}
            </fieldset>
            <label className="field">
              <span className="label">Медленный ответ — дольше</span>
              <select
                value={draft.slow_reply_minutes}
                onChange={(e) => set({ slow_reply_minutes: Number(e.target.value) })}
              >
                {SLOW.map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} мин` : `${m / 60} ч`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted form-hint no-margin">
            Ночь и выходные студии не считаются ожиданием: клиент написал в 22:00, ответили в 9:30 —
            это 30 минут, а не одиннадцать с половиной часов. «Без ответа» — клиент к концу дня ждёт
            дольше нормы рабочего времени; сообщение, пришедшее за пять минут до разбора, ещё не
            ошибка — если его не закроют, оно попадёт в следующий разбор.
          </p>
        </div>
      </Section>

      <Section
        title="Не разбирать"
        hint={excludedCount ? `исключено: ${excludedCount}` : "рассылки, сопровождение после продажи, стажёры"}
      >
        <div className="sheet sheet-pad crm-scope-card">
          <h4 className="crm-amo-title">Воронки и этапы</h4>
          {data.known_pipelines.length === 0 ? (
            <p className="muted no-margin">
              Воронки появятся здесь после первой синхронизации с amoCRM или первого пакета данных.
            </p>
          ) : (
            <div className="crm-pipelines">
              {data.known_pipelines.map((p) => {
                const whole = draft.exclude_pipelines.includes(p.name);
                return (
                  <div key={p.name || "—"} className="crm-pipeline">
                    {p.name ? (
                      <label className="crm-check strong">
                        <input
                          type="checkbox"
                          checked={whole}
                          onChange={() => set({ exclude_pipelines: toggle(draft.exclude_pipelines, p.name) })}
                        />
                        Воронка «{p.name}» целиком
                      </label>
                    ) : (
                      <span className="muted">Без воронки</span>
                    )}
                    {!whole && p.stages.length > 0 && (
                      <div className="crm-stages">
                        {p.stages.map((stage) => {
                          const ref = { pipeline: p.name, stage };
                          return (
                            <label key={stage} className="crm-check">
                              <input
                                type="checkbox"
                                checked={draft.exclude_stages.some((x) => sameStage(x, ref))}
                                onChange={() => set({ exclude_stages: toggle(draft.exclude_stages, ref, sameStage) })}
                              />
                              {stage}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <p className="muted form-hint">
            Этап берётся на конец отчётного дня: сделка, переведённая в «Рассылку» вечером, в разбор
            этого дня уже не попадёт.
          </p>

          <h4 className="crm-amo-title crm-scope-sub">Менеджеры</h4>
          {data.known_managers.length === 0 ? (
            <p className="muted no-margin">Менеджеры появятся после первых данных из CRM.</p>
          ) : (
            <div className="crm-stages">
              {data.known_managers.map((m) => (
                <label key={m.key} className="crm-check">
                  <input
                    type="checkbox"
                    checked={draft.exclude_managers.includes(m.key)}
                    onChange={() => set({ exclude_managers: toggle(draft.exclude_managers, m.key) })}
                  />
                  {m.name || `id ${m.key}`}
                  <span className="muted"> · {m.deals} {plural(m.deals, "сделка", "сделки", "сделок")}</span>
                </label>
              ))}
            </div>
          )}
          <p className="muted form-hint no-margin">
            Сделка менеджера, отмеченного здесь, не разбирается в те дни, когда её вёл он.
          </p>
        </div>
      </Section>

      {error && <Note kind="error">{error}</Note>}
      <div className="ai-foot crm-scope-foot">
        <span className="muted">
          {invalid
            ? invalid
            : savedAt && !dirty
              ? `сохранено ${fmtWhen(savedAt)} · применится к следующему разбору`
              : dirty
                ? "есть несохранённые изменения"
                : ""}
        </span>
        <span className="actions">
          <button type="button" disabled={saving || !dirty || Boolean(invalid)} onClick={save}>
            {saving ? "Сохраняем…" : "Сохранить"}
          </button>
        </span>
      </div>
    </div>
  );
}
