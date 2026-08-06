import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, DayReport, Dialog, DialogDetail, fmtTs } from "../api";

const TYPE_LABELS: Record<string, string> = {
  sale: "Продажа",
  consultation: "Консультация",
  refusal: "Отказ",
  service: "Сервис",
  irrelevant: "Нерелевантно",
};

const STAGE_ICONS: Record<string, string> = {
  done: "✅",
  partial: "⚠️",
  not_done: "❌",
};

interface StageResult {
  status?: string;
  evidence?: string | null;
  evidence_ts?: number | null;
}

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
    if (!id) return;
    if (
      !confirm(
        "Пересчитать отчёт по текущим промптам и скрипту? Прежний разбор дня будет заменён."
      )
    )
      return;
    setReprocessing(true);
    setError("");
    try {
      await api.reprocessDay(id);
      setNotice("Поставлено в очередь. Обновите страницу через пару минут.");
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
        <h2 style={{ marginRight: "auto" }}>Отчёт за {recording.date}</h2>
        <button
          className="secondary"
          onClick={reprocess}
          disabled={reprocessing}
          title="Прогнать ту же запись через анализ заново — например, после правки промптов"
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
        <Stat value={report.upsell_count} label="Апсейлов" />
        <Stat
          value={
            report.avg_script_score != null
              ? `${Math.round(report.avg_script_score * 100)}%`
              : "—"
          }
          label="Балл по скрипту"
        />
        <Stat
          value={recording.speech_duration_s != null ? fmtTs(recording.speech_duration_s) : "—"}
          label="Чистая речь"
        />
      </div>

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

function Stat({ value, label }: { value: number | string; label: string }) {
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

function DialogCard({ dialog, onSeek }: { dialog: Dialog; onSeek: (s: number) => void }) {
  const [detail, setDetail] = useState<DialogDetail | null>(null);
  const [open, setOpen] = useState(false);

  const toggle = () => {
    setOpen(!open);
    if (!detail) {
      api.dialogDetail(dialog.id).then(setDetail).catch(() => {});
    }
  };

  const analysis = dialog.analysis_json as {
    script?: Record<string, StageResult>;
    deviations?: string[];
    recommendations?: string[];
    outcome_evidence?: string;
  } | null;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className={`badge ${dialog.type}`}>{TYPE_LABELS[dialog.type] ?? dialog.type}</span>
        <span
          className="ts-link"
          onClick={() => onSeek(dialog.start_s)}
          title="Слушать с этого места"
        >
          ▶ {fmtTs(dialog.start_s)}–{fmtTs(dialog.end_s)}
        </span>
        {dialog.effectiveness_score != null && (
          <span className="muted">
            эффективность {Math.round(dialog.effectiveness_score * 100)}%
          </span>
        )}
        {dialog.upsell_count > 0 && (
          <span className="muted">апсейлов: {dialog.upsell_count}</span>
        )}
        <button className="secondary" style={{ marginLeft: "auto" }} onClick={toggle}>
          {open ? "Свернуть" : "Подробнее"}
        </button>
      </div>
      <p style={{ marginBottom: 0 }}>{dialog.brief}</p>

      {open && analysis?.script && (
        <>
          <h4>Скрипт продаж</h4>
          <ul className="checklist">
            {Object.entries(analysis.script).map(([stage, result]) => (
              <li key={stage}>
                {STAGE_ICONS[result.status ?? ""] ?? "❔"} <strong>{stage}</strong>
                {result.evidence && (
                  <>
                    {" — "}
                    <span className="evidence">«{result.evidence}»</span>{" "}
                    {result.evidence_ts != null && (
                      <span className="ts-link" onClick={() => onSeek(result.evidence_ts!)}>
                        ▶ {fmtTs(result.evidence_ts)}
                      </span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
          {analysis.deviations && analysis.deviations.length > 0 && (
            <SummaryList title="Отклонения" items={analysis.deviations} />
          )}
          {analysis.recommendations && analysis.recommendations.length > 0 && (
            <SummaryList title="Рекомендации" items={analysis.recommendations} />
          )}
        </>
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
