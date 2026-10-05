/** Промпт разбора, правила воронки и промпт итога дня — то, что владелец
 *  правит словами. Модель, расписание и лимит — здесь же.
 *
 *  Кроме этого текста модель всегда получает базу знаний: каталог скриптов из
 *  «Скриптов», правила продаж из «Аналитики» и переменные с их значениями —
 *  их здесь не пишут. Формат ответа и набор классов переписки закреплены
 *  сервером: правки промпта их не ломают.
 */
import { useEffect, useState } from "react";
import { api, CrmSettings, CrmSettingsIn, fmtWhen } from "../api";
import { Note, Skeleton } from "../components/ui";

function draftOf(s: CrmSettings): CrmSettingsIn {
  return {
    prompt: s.prompt,
    summary_prompt: s.summary_prompt,
    pipeline_rules: s.pipeline_rules,
    model: s.model_saved,
    timezone: s.timezone,
    auto_run: s.auto_run,
    run_hour: s.run_hour,
    max_deals: s.max_deals,
    manager_map: s.manager_map,
  };
}

export default function PromptView() {
  const [data, setData] = useState<CrmSettings | null>(null);
  const [draft, setDraft] = useState<CrmSettingsIn | null>(null);
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

  if (!data || !draft) return error ? <Note kind="error">{error}</Note> : <Skeleton count={1} height={320} />;

  const set = (fields: Partial<CrmSettingsIn>) => setDraft((d) => (d ? { ...d, ...fields } : d));
  const base = draftOf(data);
  const dirty = (Object.keys(base) as (keyof CrmSettingsIn)[]).some(
    (k) => k !== "manager_map" && String(draft[k]).trim() !== String(base[k]).trim()
  );

  async function save(next: CrmSettingsIn) {
    setSaving(true);
    setError("");
    try {
      const res = await api.saveCrmSettings(next);
      setData(res);
      setDraft(draftOf(res));
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setSaving(false);
    }
  }

  const reset = () =>
    save({ ...draft, prompt: data.default_prompt, pipeline_rules: data.default_pipeline_rules, summary_prompt: data.default_summary_prompt });

  const isDefault = (text: string, def: string) => text.trim() === def.trim();

  return (
    <div className="ai-settings">
      <div className="sheet sheet-pad ai-card">
        <div className="ai-how">
          <strong>Как работает разбор.</strong> Раз в день ИИ получает каждую сделку, по которой
          была переписка или движение: карточку, переписку за день с контекстом, события (этапы,
          задачи, заметки) — и базу знаний: все скрипты из «Скриптов», правила продаж из
          «Аналитики», правила воронки и переменные. По промпту ниже он классифицирует переписку,
          находит ошибки общения и движения сделки, ставит оценки по критериям и пишет комментарий.
          Скорость ответа считается по времени сообщений, а не моделью.
        </div>
        {!data.configured && (
          <Note kind="error">
            На сервере не задан ключ Anthropic (ANTHROPIC_API_KEY) — разбор не запустится, пока его
            не добавят в переменные окружения бэкенда.
          </Note>
        )}

        <label className="field">
          <span className="label">
            Промпт разбора — что считать ошибкой{" "}
            {isDefault(draft.prompt, data.default_prompt) && <span className="muted">· стандартный</span>}
          </span>
          <textarea
            className="ai-prompt"
            value={draft.prompt}
            rows={18}
            spellCheck={false}
            onChange={(e) => set({ prompt: e.target.value })}
          />
        </label>

        <label className="field">
          <span className="label">
            Правила воронки — этапы и когда сделка должна на них стоять{" "}
            {isDefault(draft.pipeline_rules, data.default_pipeline_rules) && <span className="muted">· стандартные</span>}
          </span>
          <textarea
            className="ai-prompt"
            value={draft.pipeline_rules}
            rows={12}
            spellCheck={false}
            onChange={(e) => set({ pipeline_rules: e.target.value })}
          />
          <span className="muted ai-model-hint">
            Названия этапов пишите точно как в вашей CRM — по ним ИИ проверяет, туда ли переведена
            сделка.
          </span>
        </label>

        <label className="field">
          <span className="label">
            Промпт итога дня{" "}
            {isDefault(draft.summary_prompt, data.default_summary_prompt) && <span className="muted">· стандартный</span>}
          </span>
          <textarea
            className="ai-prompt"
            value={draft.summary_prompt}
            rows={5}
            spellCheck={false}
            onChange={(e) => set({ summary_prompt: e.target.value })}
          />
        </label>

        <div className="field-row">
          <label className="field ai-model field-grow">
            <span className="label">Модель Anthropic</span>
            <input
              type="text"
              value={draft.model}
              spellCheck={false}
              placeholder={`${data.model_default} — с сервера`}
              onChange={(e) => set({ model: e.target.value })}
            />
            <span className="muted ai-model-hint">
              Сейчас разбирает: {data.model}
              {data.model_saved ? "" : " (LLM_MODEL_STAGE2 с сервера)"}.
            </span>
          </label>
          <label className="field">
            <span className="label">Лимит сделок за день</span>
            <input
              type="number"
              min={1}
              max={2000}
              value={draft.max_deals}
              onChange={(e) => set({ max_deals: Number(e.target.value) || 1 })}
            />
            <span className="muted ai-model-hint">Предохранитель от счёта.</span>
          </label>
        </div>

        <div className="field-row crm-schedule">
          <label className="toggle">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={draft.auto_run}
              onChange={(e) => set({ auto_run: e.target.checked })}
            />
            <span>
              <span className="toggle-title">Разбирать вчерашний день сам</span>
              <span className="toggle-hint">
                {draft.auto_run
                  ? "Каждое утро, когда наступит выбранный час по времени студии."
                  : "Только по кнопке «Разобрать день»."}
              </span>
            </span>
          </label>
          <label className="field">
            <span className="label">Час запуска</span>
            <select value={draft.run_hour} onChange={(e) => set({ run_hour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Часовой пояс студии</span>
            <input
              type="text"
              value={draft.timezone}
              spellCheck={false}
              placeholder="Asia/Tbilisi"
              onChange={(e) => set({ timezone: e.target.value })}
            />
          </label>
        </div>

        {error && <Note kind="error">{error}</Note>}
        <div className="ai-foot">
          <span className="muted">
            {savedAt && !dirty
              ? `сохранено ${fmtWhen(savedAt)}`
              : dirty
                ? "есть несохранённые изменения"
                : data.updated_at
                  ? `изменено ${fmtWhen(data.updated_at)}${data.updated_by ? ` · ${data.updated_by}` : ""}`
                  : ""}
          </span>
          <span className="actions">
            {(!data.is_default || !data.pipeline_is_default || !data.summary_is_default) && !dirty && (
              <button type="button" className="ghost" disabled={saving} onClick={reset}>
                Вернуть стандартные тексты
              </button>
            )}
            <button
              type="button"
              disabled={saving || !dirty || !draft.prompt.trim()}
              onClick={() => save(draft)}
            >
              {saving ? "Сохраняем…" : "Сохранить"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
