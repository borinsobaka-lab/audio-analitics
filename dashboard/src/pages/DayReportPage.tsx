import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  DayReport,
  Dialog,
  DialogDetail,
  fmtTs,
  MetricEvaluation,
} from "../api";

const TYPE_LABELS: Record<string, string> = {
  sale: "Продажа",
  consultation: "Консультация",
  refusal: "Отказ",
  service: "Сервис",
  irrelevant: "Нерелевантно",
};

export default function DayReportPage() {
  const { id } = useParams<{ id: string }>();
  const [report, setReport] = useState<DayReport | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reprocessing, setReprocessing] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!id) return;
    api.dayReport(id).then(setReport).catch((e) => setError(String(e)));
    api.dayAudioUrl(id).then((r) => setAudioUrl(r.url)).catch(() => {});
  }, [id]);

  const seekTo = (seconds: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = seconds;
    el.play();
  };

  const reprocess = async () => {
    if (!id || reprocessing) return;
    setReprocessing(true);
    setError("");
    try {
      await api.reprocessDay(id);
      setNotice(
        "Поставлено в очередь: отчёт пересчитается по текущим метрикам. Обновите страницу через пару минут."
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setReprocessing(false);
    }
  };

  if (error && !report) return <div className="error">{error}</div>;
  if (!report) return <div className="muted">Загрузка…</div>;

  const { recording, summary } = report;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ marginRight: "auto" }}>
          <h2 style={{ marginBottom: 4 }}>Отчёт за {recording.date}</h2>
          <div className="muted">
            Менеджер: {recording.employee_name ?? "не указан"}
          </div>
        </div>
        <button
          className="secondary"
          onClick={reprocess}
          disabled={reprocessing}
          title="Прогнать ту же запись через анализ заново — например, после правки метрик"
        >
          {reprocessing ? "Запуск…" : "Обработать заново"}
        </button>
      </div>
      {notice && <div className="success">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <div className="stat-row">
        <Stat value={report.dialogs_total} label="Разговоров" />
        <Stat value={report.sales_count} label="Продаж" />
        <Stat
          value={report.conversion != null ? `${Math.round(report.conversion * 100)}%` : "—"}
          label="Конверсия"
        />
        <Stat
          value={
            recording.speech_duration_s != null ? fmtTs(recording.speech_duration_s) : "—"
          }
          label="Чистая речь"
        />
      </div>

      {report.metric_stats.length > 0 && (
        <div className="stat-row">
          {report.metric_stats.map((s) => (
            <div className="stat" key={s.metric_id}>
              <div className="value">
                {s.avg_score != null ? (
                  <>
                    ★ {s.avg_score}
                    <span style={{ fontSize: 15, color: "#64748b" }}>/{s.scale_max}</span>
                  </>
                ) : (
                  "—"
                )}
              </div>
              <div className="label">
                {s.name} · срабатываний: {s.triggered_count}
              </div>
            </div>
          ))}
        </div>
      )}

      {summary && (
        <div className="card">
          <h3>Итоги дня</h3>
          <SummaryList title="Главные отклонения" items={summary.top_deviations} />
          <SummaryList title="Рекомендации менеджеру" items={summary.recommendations} />
          <SummaryList title="Предложения по скрипту" items={summary.script_suggestions} />
          <SummaryList title="Удачные моменты" items={summary.highlights} />
        </div>
      )}

      <h3>Диалоги</h3>
      {report.dialogs
        .filter((d) => d.type !== "irrelevant")
        .map((d) => (
          <DialogCard key={d.id} dialog={d} onSeek={seekTo} />
        ))}

      {audioUrl && (
        <div className="audio-bar">
          <audio ref={audioRef} controls src={audioUrl} preload="none" />
        </div>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number | string | JSX.Element; label: string }) {
  return (
    <div className="stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

function SummaryList({ title, items }: { title: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <strong>{title}:</strong>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Stars({ score, scale }: { score: number; scale: number }) {
  return (
    <span className="score" title={`${score} из ${scale}`}>
      {"★".repeat(score)}
      <span style={{ color: "#cbd5e1" }}>{"★".repeat(Math.max(0, scale - score))}</span>{" "}
      {score}/{scale}
    </span>
  );
}

function EvaluationBlock({ ev }: { ev: MetricEvaluation }) {
  if (!ev.applicable) return null;
  return (
    <div className="eval-block">
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <strong>{ev.metric_name}</strong>
        {ev.score != null && <Stars score={ev.score} scale={ev.scale_max} />}
      </div>
      {ev.comment && <p style={{ margin: "6px 0" }}>{ev.comment}</p>}
      {ev.good.length > 0 && (
        <div>
          <span className="eval-good">Хорошо:</span>
          <ul style={{ margin: "4px 0" }}>
            {ev.good.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {ev.bad.length > 0 && (
        <div>
          <span className="eval-bad">Плохо / упущено:</span>
          <ul style={{ margin: "4px 0" }}>
            {ev.bad.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DialogCard({ dialog, onSeek }: { dialog: Dialog; onSeek: (s: number) => void }) {
  const [detail, setDetail] = useState<DialogDetail | null>(null);
  const [open, setOpen] = useState(false);

  const toggle = () => {
    setOpen(!open);
    if (!detail) {
      api.dialogDetail(dialog.id).then(setDetail).catch(() => {});
    }
  };

  const applicableEvals = dialog.evaluations.filter((e) => e.applicable);

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span className={`badge ${dialog.type}`}>{TYPE_LABELS[dialog.type] ?? dialog.type}</span>
        <span
          className="ts-link"
          onClick={() => onSeek(dialog.start_s)}
          title="Слушать с начала диалога"
        >
          ▶ {fmtTs(dialog.start_s)}–{fmtTs(dialog.end_s)}
        </span>
        {applicableEvals.map((ev) =>
          ev.score != null ? (
            <span key={ev.metric_id} className="metric-chip">
              {ev.metric_name}: ★ {ev.score}/{ev.scale_max}
            </span>
          ) : null
        )}
        <button className="secondary" style={{ marginLeft: "auto" }} onClick={toggle}>
          {open ? "Свернуть" : "Подробнее"}
        </button>
      </div>
      <p style={{ marginBottom: 0 }}>{dialog.brief}</p>

      {open && applicableEvals.map((ev) => <EvaluationBlock key={ev.metric_id} ev={ev} />)}
      {open && applicableEvals.length === 0 && (
        <p className="muted">Ни одна метрика не сработала на этом диалоге.</p>
      )}

      {open && detail && detail.turns.length > 0 && (
        <>
          <h4>Транскрипт</h4>
          <div className="turns">
            {detail.turns.map((t, i) => (
              <div key={i} className={`turn ${t.is_manager ? "manager" : ""}`}>
                <span className="ts-link" onClick={() => onSeek(t.start_s)}>
                  {fmtTs(t.start_s)}
                </span>{" "}
                <span className="speaker">{t.speaker_label}:</span>
                {t.text}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
