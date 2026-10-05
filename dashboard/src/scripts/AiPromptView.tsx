/** Настройки ИИ-помощника: промпт — инструкция, по которой ИИ подбирает
 *  скрипт под сообщение клиента или пишет ответ сам.
 *
 *  Кроме промпта ИИ всегда получает каталог скриптов, правила продаж из
 *  «Аналитики» → скрипт продаж и список переменных — их здесь не пишут.
 */
import { useEffect, useState } from "react";
import { AiPrompt, api, fmtWhen } from "../api";
import { Note, Skeleton } from "../components/ui";
import { IconSparkle } from "./AssistDialog";

export default function AiPromptView({ canEdit }: { canEdit: boolean }) {
  const [data, setData] = useState<AiPrompt | null>(null);
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const [verifyText, setVerifyText] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    api
      .aiPrompt()
      .then((res) => {
        setData(res);
        setText(res.prompt);
        setVerifyText(res.verify_prompt);
        setModel(res.model_saved);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  async function save(prompt: string, verify: string) {
    setSaving(true);
    setError("");
    try {
      const res = await api.saveAiPrompt({ prompt, verify_prompt: verify, model: model.trim() });
      setData(res);
      setText(res.prompt);
      setVerifyText(res.verify_prompt);
      setModel(res.model_saved);
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!data) return error ? <Note kind="error">{error}</Note> : <Skeleton count={1} height={320} />;

  const dirty =
    text.trim() !== data.prompt.trim() ||
    verifyText.trim() !== data.verify_prompt.trim() ||
    model.trim() !== data.model_saved;

  return (
    <div className="ai-settings">
      <div className="sheet sheet-pad ai-card">
        <div className="ai-how">
          <span className="ai-how-head">
            <span className="assist-icon"><IconSparkle size={18} white /></span>
            <strong>Как работает ИИ-помощник</strong>
          </span> Сотрудник нажимает «ИИ-помощник» и вставляет сообщение
          клиента. ИИ видит всю базу: скрипты, правила продаж из скрипта продаж «Аналитики» и
          переменные с их значениями из «Подстановки».
          <ol>
            <li>Есть подходящий скрипт — показывает его с «Копировать» на языке клиента.</li>
            <li>
              Нет — пишет ответ, и <strong>отдельный второй запрос</strong> сверяет каждый факт
              ответа (цены, скидки, сроки, условия, обещания) с базой.
            </li>
            <li>Не прошёл проверку — ИИ переписывает с учётом замечаний, ещё одна проверка.</li>
            <li>
              Снова не прошёл или данных нет — ответ <strong>не показывается</strong>: сотрудник
              видит «недостаточно информации» и чего именно не хватает.
            </li>
          </ol>
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
            Промпт ответа{" "}
            {data.is_default && text.trim() === data.prompt.trim() && (
              <span className="muted">· стандартный</span>
            )}
          </span>
          <textarea
            className="ai-prompt"
            value={text}
            rows={16}
            readOnly={!canEdit}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="label">
            Промпт проверки{" "}
            {data.verify_is_default && verifyText.trim() === data.verify_prompt.trim() && (
              <span className="muted">· стандартный</span>
            )}
          </span>
          <textarea
            className="ai-prompt"
            value={verifyText}
            rows={12}
            readOnly={!canEdit}
            spellCheck={false}
            onChange={(e) => setVerifyText(e.target.value)}
          />
        </label>
        {error && <Note kind="error">{error}</Note>}
        <div className="ai-foot">
          <span className="muted">
            {savedAt && !dirty ? ` · сохранено ${fmtWhen(savedAt)}` : dirty ? " · есть несохранённые изменения" : ""}
          </span>
          {canEdit && (
            <span className="actions">
              {(!data.is_default || !data.verify_is_default) && !dirty && (
                <button type="button" className="ghost" disabled={saving}
                  onClick={() => save("", "")}>
                  Вернуть стандартные промпты
                </button>
              )}
              <button type="button" className="ai-primary"
                disabled={saving || !dirty || !text.trim() || !verifyText.trim()}
                onClick={() => save(text, verifyText)}>
                {saving ? "Сохраняем…" : "Сохранить"}
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
