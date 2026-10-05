import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AnalysisMetric,
  api,
  fmtDate,
  fmtTs,
  fmtWhen,
  MetricFeedbackItem,
  MetricFeedbackStat,
  plural,
} from "../api";
import { ConfirmAction, Empty, Note, PageHead, Skeleton } from "../components/ui";

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
  const [metrics, setMetrics] = useState<AnalysisMetric[] | null>(null);
  const [votes, setVotes] = useState<MetricFeedbackStat[]>([]);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const load = () => {
    api
      .listMetrics()
      .then(setMetrics)
      .catch((e) => {
        setMetrics([]);
        setError(String(e));
      });
    // Несогласия сотрудников — обратная связь на сами промпты, поэтому
    // читаются здесь же, где промпты правят.
    api.feedbackByMetric().then(setVotes).catch(() => setVotes([]));
  };

  useEffect(load, []);

  const activeCount = metrics?.filter((m) => m.active).length ?? 0;
  const totalDisagreements = votes.reduce((sum, v) => sum + v.disagree_count, 0);

  return (
    <div>
      <PageHead
        title="Метрики и анализ"
        hint="Метрика — это промпт, по которому ИИ разбирает каждый разговор смены: применима ли метрика, оценка по шкале, что сработало и что упущено. Вставляйте прямо в текст свой эталонный скрипт и критерии."
      >
        {!creating && metrics !== null && (
          <button onClick={() => setCreating(true)}>Добавить метрику</button>
        )}
      </PageHead>

      {error && <Note kind="error">{error}</Note>}
      {metrics !== null && metrics.length > 0 && activeCount === 0 && (
        <Note kind="error">
          Все метрики отключены — разборы смен будут пустыми. Включите хотя бы одну.
        </Note>
      )}

      {creating && (
        <MetricEditor
          onDone={() => {
            setCreating(false);
            load();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {metrics === null && <Skeleton count={2} height={140} />}

      {metrics !== null && metrics.length === 0 && !creating && (
        <Empty title="Метрик пока нет">
          Добавьте первую — например «Качество продажи абонемента». Готовые
          эталонные промпты лежат в репозитории, в папке docs/prompts.
        </Empty>
      )}

      {metrics?.map((m) => (
        <MetricCard
          key={m.id}
          metric={m}
          votes={votes.find((v) => v.metric_id === m.id)}
          onChanged={load}
        />
      ))}

      {totalDisagreements > 0 && (
        <p className="muted metrics-foot">
          Всего несогласий: {totalDisagreements}. Это не жалобы, а материал:
          метрика, с оценками которой спорят на разных сменах разные люди,
          почти наверняка сформулирована неточно — правьте промпт и
          пересчитывайте смены.
        </p>
      )}
    </div>
  );
}

/** Список несогласий: когда, у кого, что сказали и куда идти слушать. */
function Disagreements({ items }: { items: MetricFeedbackItem[] }) {
  return (
    <ul className="disagreements">
      {items.map((d) => (
        <li key={d.id}>
          <Link to={`/days/${d.day_recording_id}`} className="disagreement-day">
            {fmtDate(d.day_date).day}
            {d.dialog_start_s != null && ` · ${fmtTs(d.dialog_start_s)}`}
          </Link>
          <span className="disagreement-who">
            {d.subject_name || "менеджер не указан"}
            {d.author_name && ` · возразил ${d.author_name}`}
            {` · ${fmtWhen(d.created_at)}`}
          </span>
          {d.comment && <span className="disagreement-note">{d.comment}</span>}
        </li>
      ))}
    </ul>
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
      if (metric) await api.updateMetric(metric.id, { name, prompt, scale_max: scale });
      else await api.createMetric({ name, prompt, scale_max: scale });
      onDone();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <div className="sheet sheet-pad metric-editor">
      <h4 className="editor-title">
        {metric ? "Редактирование метрики" : "Новая метрика"}
      </h4>

      <div className="field-row">
        <label className="field field-grow">
          <span className="label">Название — видно в отчётах</span>
          <input
            type="text"
            value={name}
            placeholder="Например: Качество продажи абонемента"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="label">Шкала оценки</span>
          <select value={scale} onChange={(e) => setScale(Number(e.target.value))}>
            <option value={5}>5-балльная</option>
            <option value={10}>10-балльная</option>
          </select>
        </label>
      </div>

      <label className="field">
        <span className="label">Промпт — что и как оценивать</span>
        <textarea
          className="prompt-editor"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          spellCheck={false}
        />
      </label>

      {error && <Note kind="error">{error}</Note>}

      <div className="actions">
        <button
          onClick={save}
          disabled={saving || name.trim().length < 2 || prompt.length < 10}
        >
          {saving ? "Сохранение…" : "Сохранить"}
        </button>
        <button className="secondary" onClick={onCancel}>
          Отмена
        </button>
        <span className="muted push">
          Правки применяются к новым разборам. Чтобы пересчитать прошлую смену,
          нажмите «Пересчитать» в её карточке.
        </span>
      </div>
    </div>
  );
}

function MetricCard({
  metric,
  votes,
  onChanged,
}: {
  metric: AnalysisMetric;
  votes?: MetricFeedbackStat;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showVotes, setShowVotes] = useState(false);
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

  const patch = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  };

  const lines = metric.prompt.split("\n").length;

  return (
    <div className={`sheet sheet-pad metric-card ${metric.active ? "" : "is-off"}`}>
      <div className="metric-card-head">
        <strong className="metric-card-name">{metric.name}</strong>
        <span className={`pill ${metric.active ? "sale" : "irrelevant"}`}>
          {metric.active ? "Активна" : "Отключена"}
        </span>
        <span className="muted">
          {metric.scale_max}-балльная · промпт: {lines}{" "}
          {plural(lines, "строка", "строки", "строк")}
        </span>
        <div className="actions push">
          <button className="secondary small" onClick={() => setEditing(true)}>
            Редактировать
          </button>
          <button
            className="ghost small"
            onClick={() => patch(() => api.updateMetric(metric.id, { active: !metric.active }))}
          >
            {metric.active ? "Отключить" : "Включить"}
          </button>
          <ConfirmAction
            small
            label="Удалить"
            confirmLabel="Удалить навсегда"
            title="Удалить метрику и все её оценки в прошлых отчётах"
            onConfirm={() => patch(() => api.deleteMetric(metric.id))}
          />
        </div>
      </div>

      <pre className={`prompt-preview ${expanded ? "open" : ""}`}>
        {metric.prompt}
      </pre>
      {lines > 8 && (
        <button className="ghost small" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Свернуть промпт" : "Показать промпт целиком"}
        </button>
      )}

      {votes && (votes.disagree_count > 0 || votes.agree_count > 0) && (
        <div className="votes">
          <span className="votes-count">
            {votes.disagree_count > 0 ? (
              <b className="disagree">
                {votes.disagree_count}{" "}
                {plural(
                  votes.disagree_count,
                  "несогласие",
                  "несогласия",
                  "несогласий"
                )}
              </b>
            ) : (
              <b className="agree">возражений нет</b>
            )}
            {votes.agree_count > 0 && (
              <span className="muted"> · согласий: {votes.agree_count}</span>
            )}
          </span>
          {votes.disagree_count > 0 && (
            <button className="ghost small" onClick={() => setShowVotes(!showVotes)}>
              {showVotes ? "Свернуть" : "Показать где"}
            </button>
          )}
        </div>
      )}
      {showVotes && votes && <Disagreements items={votes.disagreements} />}

      {error && <Note kind="error">{error}</Note>}
    </div>
  );
}
