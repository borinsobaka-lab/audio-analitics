import { useEffect, useState } from "react";
import { AnalysisMetric, api } from "../api";

const EXAMPLE_PROMPT = `Оцени, насколько качественно менеджер провёл продажу.

Метрика применима, только если в диалоге была попытка продажи.

Эталон успешной продажи (вставьте свой скрипт):
1. Приветствие и знакомство.
2. Выявление потребности клиента.
3. Презентация услуги под потребность.
4. Работа с возражениями (цена, время, сомнения).
5. Закрытие: запись на занятие с конкретной датой.
6. Предложение абонемента / доп. услуг.

Оценка 10 — все этапы пройдены и получено согласие; снижай за каждый
пропущенный этап; 1–3 — менеджер фактически не пытался продавать.`;

export default function MetricsPage() {
  const [metrics, setMetrics] = useState<AnalysisMetric[]>([]);
  const [error, setError] = useState("");
  const [showNew, setShowNew] = useState(false);

  const load = () => {
    api.listMetrics().then(setMetrics).catch((e) => setError(String(e)));
  };

  useEffect(load, []);

  return (
    <div>
      <h2>Метрики и анализ</h2>
      <p className="muted">
        Каждая активная метрика — это отдельный промпт, по которому ИИ оценивает
        каждый разговор рабочего дня: применима ли метрика к разговору, оценка по
        шкале, что сделано хорошо и что плохо. В отчёте дня выводится число
        срабатываний и средняя оценка по каждой метрике. Вставляйте прямо в текст
        промпта свой эталонный скрипт и критерии оценки.
      </p>
      {error && <div className="error">{error}</div>}

      {!showNew ? (
        <button onClick={() => setShowNew(true)} style={{ marginBottom: 16 }}>
          + Добавить метрику
        </button>
      ) : (
        <MetricEditor
          onDone={() => {
            setShowNew(false);
            load();
          }}
          onCancel={() => setShowNew(false)}
        />
      )}

      {metrics.map((m) => (
        <MetricCard key={m.id} metric={m} onChanged={load} />
      ))}
      {metrics.length === 0 && !showNew && (
        <div className="card muted">
          Метрик пока нет. Добавьте первую — например «Качество продажи».
        </div>
      )}
    </div>
  );
}

function MetricEditor({
  metric,
  onDone,
  onCancel,
}: {
  metric?: AnalysisMetric;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(metric?.name ?? "");
  const [prompt, setPrompt] = useState(metric?.prompt ?? EXAMPLE_PROMPT);
  const [scale, setScale] = useState(metric?.scale_max ?? 10);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      if (metric) {
        await api.updateMetric(metric.id, { name, prompt, scale_max: scale });
      } else {
        await api.createMetric({ name, prompt, scale_max: scale });
      }
      onDone();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ borderColor: "#2563eb" }}>
      <h4>{metric ? "Редактирование метрики" : "Новая метрика"}</h4>
      <label>
        Название (видно в отчётах)
        <input
          type="text"
          value={name}
          placeholder="Например: Качество продажи"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label style={{ display: "block", margin: "10px 0" }}>
        Шкала оценки:{" "}
        <select
          value={scale}
          onChange={(e) => setScale(Number(e.target.value))}
          style={{ width: 160, display: "inline-block" }}
        >
          <option value={5}>5-балльная</option>
          <option value={10}>10-балльная</option>
        </select>
      </label>
      <label>
        Промпт: что и как оценивать (вставьте сюда эталонный скрипт)
        <textarea
          className="prompt-editor"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          spellCheck={false}
        />
      </label>
      <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
        <button onClick={save} disabled={saving || name.trim().length < 2 || prompt.length < 10}>
          {saving ? "Сохранение…" : "Сохранить"}
        </button>
        <button className="secondary" onClick={onCancel}>
          Отмена
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function MetricCard({
  metric,
  onChanged,
}: {
  metric: AnalysisMetric;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");

  if (editing) {
    return (
      <MetricEditor
        metric={metric}
        onDone={() => {
          setEditing(false);
          onChanged();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const toggleActive = async () => {
    setError("");
    try {
      await api.updateMetric(metric.id, { active: !metric.active });
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async () => {
    setError("");
    try {
      await api.deleteMetric(metric.id);
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="card" style={{ opacity: metric.active ? 1 : 0.6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <strong style={{ fontSize: 16 }}>{metric.name}</strong>
        <span className="muted">шкала: {metric.scale_max}-балльная</span>
        {metric.active ? (
          <span className="badge sale">Активна</span>
        ) : (
          <span className="badge irrelevant">Отключена</span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="secondary" onClick={() => setEditing(true)}>
            Редактировать
          </button>
          <button className="secondary" onClick={toggleActive}>
            {metric.active ? "Отключить" : "Включить"}
          </button>
          {confirmDelete ? (
            <>
              <button className="danger" onClick={remove}>
                Точно удалить
              </button>
              <button className="secondary" onClick={() => setConfirmDelete(false)}>
                Отмена
              </button>
            </>
          ) : (
            <button
              className="secondary"
              title="Удалить метрику и все её оценки в прошлых отчётах"
              onClick={() => setConfirmDelete(true)}
            >
              Удалить
            </button>
          )}
        </div>
      </div>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          fontFamily: "inherit",
          fontSize: 13,
          color: "#475569",
          marginBottom: 0,
          maxHeight: 180,
          overflowY: "auto",
        }}
      >
        {metric.prompt}
      </pre>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
