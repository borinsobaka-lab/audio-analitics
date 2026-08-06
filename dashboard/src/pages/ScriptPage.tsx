import { useEffect, useState } from "react";
import { api, ScriptStage, ScriptTemplate } from "../api";

export default function ScriptPage() {
  const [script, setScript] = useState<ScriptTemplate | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [stages, setStages] = useState<ScriptStage[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getScript()
      .then((s) => {
        setScript(s);
        setName(s.name);
        setBody(s.body);
        setStages(s.stages_json);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const updateStage = (i: number, field: keyof ScriptStage, value: string) => {
    setStages(stages.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)));
  };

  const addStage = () =>
    setStages([...stages, { key: `stage_${stages.length + 1}`, title: "", description: "" }]);

  const removeStage = (i: number) => setStages(stages.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const saved = await api.saveScript({ name, stages, body });
      setScript(saved);
      setMessage(`Сохранено как версия ${saved.version}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!script && !error) return <div className="muted">Загрузка…</div>;

  return (
    <div>
      <h2>Скрипт продаж</h2>
      <p className="muted">
        Текст скрипта и этапы подставляются в промпт «Разбор диалога» как{" "}
        {"{{script}}"} и {"{{stages}}"}. По этапам LLM ставит оценки
        done/partial/not_done с цитатами.
      </p>
      {error && <div className="error">{error}</div>}

      {script && (
        <>
          <div className="card">
            <label>
              Название
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <h4>Полный текст скрипта (для LLM)</h4>
            <textarea
              className="prompt-editor"
              style={{ minHeight: 200 }}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>

          <div className="card">
            <h4>Этапы оценки</h4>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 160 }}>Ключ (латиницей)</th>
                  <th style={{ width: 220 }}>Название</th>
                  <th>Описание (что считается выполнением)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {stages.map((s, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        type="text"
                        value={s.key}
                        onChange={(e) => updateStage(i, "key", e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={s.title}
                        onChange={(e) => updateStage(i, "title", e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={s.description}
                        onChange={(e) => updateStage(i, "description", e.target.value)}
                      />
                    </td>
                    <td>
                      <button className="secondary" onClick={() => removeStage(i)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 10, display: "flex", gap: 12 }}>
              <button className="secondary" onClick={addStage}>
                + Добавить этап
              </button>
              <button onClick={save} disabled={saving}>
                {saving ? "Сохранение…" : "Сохранить новую версию"}
              </button>
            </div>
            {message && <div className="success">{message}</div>}
          </div>
        </>
      )}
    </div>
  );
}
