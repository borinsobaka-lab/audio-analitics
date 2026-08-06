import { useEffect, useState } from "react";
import { api, PromptTemplate } from "../api";

// Placeholders each prompt may use; shown as a hint under the editor.
const PLACEHOLDERS: Record<string, string[]> = {
  dialog_segmentation: ["{{transcript}}"],
  sale_analysis: ["{{script}}", "{{stages}}", "{{dialog}}"],
  daily_summary: ["{{analyses}}", "{{stats}}"],
};

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [error, setError] = useState("");

  const load = () => {
    api.listPrompts().then(setPrompts).catch((e) => setError(String(e)));
  };

  useEffect(load, []);

  return (
    <div>
      <h2>Промпты анализа</h2>
      <p className="muted">
        Эти промпты управляют LLM-анализом записей. Сохранение создаёт новую
        версию — она применяется к следующему обработанному дню. Историю версий
        можно посмотреть и откатить. Плейсхолдеры вида {"{{transcript}}"}{" "}
        подставляются пайплайном автоматически — не удаляйте их.
      </p>
      {error && <div className="error">{error}</div>}
      {prompts.map((p) => (
        <PromptEditor key={p.id} prompt={p} onSaved={load} />
      ))}
    </div>
  );
}

function PromptEditor({
  prompt,
  onSaved,
}: {
  prompt: PromptTemplate;
  onSaved: () => void;
}) {
  const [content, setContent] = useState(prompt.content);
  const [name, setName] = useState(prompt.name);
  const [model, setModel] = useState(prompt.model ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<PromptTemplate[] | null>(null);

  const dirty =
    content !== prompt.content ||
    name !== prompt.name ||
    (model || null) !== prompt.model;

  const missingPlaceholders = (PLACEHOLDERS[prompt.key] ?? []).filter(
    (ph) => !content.includes(ph)
  );

  const save = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await api.savePrompt(prompt.key, {
        content,
        name,
        model: model || null,
      });
      setMessage(`Сохранено как версия ${prompt.version + 1}`);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const loadHistory = () => {
    if (history) {
      setHistory(null);
      return;
    }
    api.promptHistory(prompt.key).then(setHistory).catch((e) => setError(String(e)));
  };

  const rollback = async (version: number) => {
    setError("");
    try {
      await api.rollbackPrompt(prompt.key, version);
      setMessage(`Версия ${version} восстановлена`);
      setHistory(null);
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="card">
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ fontWeight: 600, maxWidth: 420 }}
        />
        <span className="muted">
          ключ: {prompt.key} · версия {prompt.version}
          {prompt.updated_by ? ` · изменил: ${prompt.updated_by}` : ""}
        </span>
      </div>
      <p className="muted">{prompt.description}</p>

      <textarea
        className="prompt-editor"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10 }}>
        <button onClick={save} disabled={saving || !dirty || content.length < 10}>
          {saving ? "Сохранение…" : "Сохранить новую версию"}
        </button>
        <button className="secondary" onClick={loadHistory}>
          {history ? "Скрыть историю" : "История версий"}
        </button>
        <label className="muted">
          Модель (пусто = по умолчанию):{" "}
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="claude-sonnet-5"
            style={{ width: 220, display: "inline-block" }}
          />
        </label>
      </div>

      {missingPlaceholders.length > 0 && (
        <div className="error">
          Внимание: в тексте нет плейсхолдеров {missingPlaceholders.join(", ")} —
          пайплайн не сможет подставить данные.
        </div>
      )}
      {message && <div className="success">{message}</div>}
      {error && <div className="error">{error}</div>}

      {history && (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Версия</th>
              <th>Дата</th>
              <th>Автор</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td>
                  v{h.version} {h.active && <span className="badge sale">активна</span>}
                </td>
                <td>{new Date(h.created_at).toLocaleString("ru-RU")}</td>
                <td>{h.updated_by ?? "—"}</td>
                <td>
                  {!h.active && (
                    <button className="secondary" onClick={() => rollback(h.version)}>
                      Восстановить
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
