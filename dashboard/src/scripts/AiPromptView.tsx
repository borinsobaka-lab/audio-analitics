/** Настройки ИИ-помощника: промпт — инструкция, по которой ИИ подбирает
 *  скрипт под сообщение клиента или пишет ответ сам.
 *
 *  Кроме промпта ИИ всегда получает каталог скриптов, правила продаж из
 *  «Аналитики» → скрипт продаж и список переменных — их здесь не пишут.
 */
import { useEffect, useState } from "react";
import { AiPrompt, api, fmtWhen } from "../api";
import { Note, Skeleton } from "../components/ui";

export default function AiPromptView({ canEdit }: { canEdit: boolean }) {
  const [data, setData] = useState<AiPrompt | null>(null);
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    api
      .aiPrompt()
      .then((res) => {
        setData(res);
        setText(res.prompt);
        setModel(res.model_saved);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  async function save(value: string) {
    setSaving(true);
    setError("");
    try {
      const res = await api.saveAiPrompt({ prompt: value, model: model.trim() });
      setData(res);
      setText(res.prompt);
      setModel(res.model_saved);
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!data) return error ? <Note kind="error">{error}</Note> : <Skeleton count={1} height={320} />;

  const dirty = text.trim() !== data.prompt.trim() || model.trim() !== data.model_saved;

  return (
    <div className="ai-settings">
      <div className="sheet sheet-pad ai-card">
        <div className="ai-how">
          <strong>Как работает.</strong> Сотрудник нажимает «ИИ-помощник» над скриптами и
          вставляет сообщение клиента. ИИ сначала ищет подходящие скрипты — и показывает их с
          кнопкой «Копировать». Если подходящего нет — пишет ответ сам, на языке клиента.
          Кроме промпта ниже ИИ всегда видит все скрипты, правила продаж из скрипта продаж
          «Аналитики» и переменные из «Подстановки».
        </div>
        {!data.configured && (
          <Note kind="error">
            На сервере не задан ключ OpenAI (OPENAI_API_KEY) — ИИ-помощник не ответит, пока
            его не добавят в переменные окружения бэкенда.
          </Note>
        )}
        <label className="field ai-model">
          <span className="label">Модель OpenAI</span>
          <input
            type="text"
            value={model}
            readOnly={!canEdit}
            spellCheck={false}
            placeholder={data.model_default ? `${data.model_default} — с сервера` : "Например, название из кабинета OpenAI"}
            onChange={(e) => setModel(e.target.value)}
          />
          <span className="muted ai-model-hint">
            {data.model
              ? `Сейчас отвечает: ${data.model}${data.model_saved ? "" : " (OPENAI_MODEL с сервера)"}.`
              : "Модель не выбрана — ИИ-помощник не ответит."}{" "}
            Название — точно как в документации OpenAI.
          </span>
        </label>
        <label className="field">
          <span className="label">
            Промпт {data.is_default && !dirty && <span className="muted">· стандартный</span>}
          </span>
          <textarea
            className="ai-prompt"
            value={text}
            rows={18}
            readOnly={!canEdit}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {error && <Note kind="error">{error}</Note>}
        <div className="ai-foot">
          <span className="muted">
            {savedAt && !dirty ? ` · сохранено ${fmtWhen(savedAt)}` : dirty ? " · есть несохранённые изменения" : ""}
          </span>
          {canEdit && (
            <span className="actions">
              {!data.is_default && !dirty && (
                <button type="button" className="ghost" disabled={saving}
                  onClick={() => save("")}>
                  Вернуть стандартный
                </button>
              )}
              <button type="button" disabled={saving || !dirty || !text.trim()}
                onClick={() => save(text)}>
                {saving ? "Сохраняем…" : "Сохранить"}
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
