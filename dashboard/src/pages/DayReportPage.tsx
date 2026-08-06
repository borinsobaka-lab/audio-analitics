import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  DayReport,
  Dialog,
  DialogDetail,
  fmtDate,
  fmtDur,
  fmtTs,
  MetricEvaluation,
} from "../api";
import { Deck, DeckHandle } from "../components/Deck";
import {
  Empty,
  IconPlay,
  Note,
  Score,
  ScoreBar,
  Skeleton,
  scoreZone,
} from "../components/ui";

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
  const deck = useRef<DeckHandle>(null);

  useEffect(() => {
    if (!id) return;
    api.dayReport(id).then(setReport).catch((e) => setError(String(e)));
    api.dayAudioUrl(id).then((r) => setAudioUrl(r.url)).catch(() => {});
  }, [id]);

  const seek = (seconds: number) => deck.current?.seek(seconds);

  const reprocess = async () => {
    if (!id || reprocessing) return;
    setReprocessing(true);
    setError("");
    try {
      await api.reprocessDay(id);
      setNotice(
        "Поставлено в очередь: разбор пересчитается по текущим метрикам. Обновите страницу через пару минут."
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setReprocessing(false);
    }
  };

  if (error && !report) return <Note kind="error">{error}</Note>;
  if (!report) return <Skeleton count={3} height={92} />;

  const { recording, summary } = report;
  const { day, weekday } = fmtDate(recording.date);
  const shown = report.dialogs.filter((d) => d.type !== "irrelevant");
  const conversion =
    report.conversion != null ? `${Math.round(report.conversion * 100)}%` : "—";

  return (
    <div>
      <header className="page-head">
        <div className="grow">
          <h1 className="display">Смена {day}</h1>
          <p>
            {weekday} · менеджер{" "}
            <strong>{recording.employee_name ?? "не указан"}</strong> ·{" "}
            {fmtDur(recording.total_duration_s)} записи
          </p>
        </div>
        <button
          className="secondary"
          onClick={reprocess}
          disabled={reprocessing}
          title="Прогнать ту же запись через анализ заново — например, после правки метрик"
        >
          {reprocessing ? "Запуск…" : "Пересчитать"}
        </button>
      </header>

      {notice && <Note kind="success">{notice}</Note>}
      {error && <Note kind="error">{error}</Note>}

      <div className="stats">
        <div className="stat lead">
          <div className="v">{conversion}</div>
          <div className="label">Конверсия</div>
        </div>
        <div className="stat">
          <div className="v">{report.sales_count}</div>
          <div className="label">Продаж</div>
        </div>
        <div className="stat">
          <div className="v">{report.dialogs_total}</div>
          <div className="label">Разговоров с клиентами</div>
        </div>
        <div className="stat">
          <div className="v">{fmtDur(recording.speech_duration_s)}</div>
          <div className="label">Чистой речи</div>
        </div>
      </div>

      {report.metric_stats.length > 0 && (
        <div className="section">
          <div className="section-head">
            <h3>Метрики за смену</h3>
            <span className="count">средняя оценка и сколько раз сработала</span>
          </div>
          <div className="stats">
            {report.metric_stats.map((s) => (
              <div className="stat" key={s.metric_id}>
                <div className="v display">
                  {s.avg_score != null ? (
                    <>
                      {s.avg_score}
                      <span className="of">/{s.scale_max}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </div>
                {/* Полоса под цифрой отвечает на «хорошо или плохо» цветом,
                    до того как прочитано само число. */}
                {s.avg_score != null && (
                  <ScoreBar score={s.avg_score} scale={s.scale_max} />
                )}
                <div className="label">
                  {s.name} · {s.triggered_count}×
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {summary && (
        <div className="section">
          <div className="section-head">
            <h3>Итоги смены</h3>
          </div>
          <div className="sheet sheet-pad">
            <SummaryList title="Главные отклонения" items={summary.top_deviations} kind="bad" />
            <SummaryList title="Рекомендации менеджеру" items={summary.recommendations} />
            <SummaryList title="Предложения по скрипту" items={summary.script_suggestions} />
            <SummaryList title="Удачные моменты" items={summary.highlights} kind="good" />
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <h3>Разговоры</h3>
          <span className="count">
            {shown.length > 0
              ? `${shown.length} на ленте смены`
              : "ничего не распознано"}
          </span>
        </div>

        {report.dialogs.length === 0 && (
          <Empty title="Разговоров не найдено">
            Либо в записи не было речи, либо смена обработана до последнего
            обновления — нажмите «Пересчитать».
          </Empty>
        )}
        {report.dialogs.length > 0 && shown.length === 0 && (
          <Empty title="Все разговоры отмечены как нерелевантные">
            Найдено разговоров: {report.dialogs.length}, но все они
            классифицированы как личные или служебные — метрики к таким не
            применяются. Короткие тестовые записи часто попадают в эту
            категорию: попробуйте «Пересчитать».
          </Empty>
        )}
        {shown.map((d) => (
          <DialogCard key={d.id} dialog={d} onSeek={seek} />
        ))}
      </div>

      {audioUrl && (
        <Deck
          ref={deck}
          src={audioUrl}
          dialogs={report.dialogs}
          totalDuration={recording.total_duration_s}
        />
      )}
    </div>
  );
}

function SummaryList({
  title,
  items,
  kind,
}: {
  title: string;
  items?: string[];
  kind?: "good" | "bad";
}) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div className={`notes-title ${kind ?? ""}`}>{title}</div>
      <ul className={`notes ${kind ?? ""}`}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** Совпадает с [ЧЧ:ММ:СС] и [ММ:СС] — форматом, который промпты просят у модели. */
const TS_PATTERN = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

function tsToSeconds(stamp: string): number {
  return stamp.split(":").map(Number).reduce((acc, part) => acc * 60 + part, 0);
}

/** Текст разбора, в котором метки времени превращены в кнопки прослушивания. */
function WithCues({ text, onSeek }: { text: string; onSeek: (s: number) => void }) {
  const nodes: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(TS_PATTERN)) {
    const at = match.index ?? 0;
    if (at > lastIndex) nodes.push(text.slice(lastIndex, at));
    const seconds = tsToSeconds(match[1]);
    nodes.push(
      <button
        key={`${at}-${match[1]}`}
        className="cue"
        title="Слушать с этого места"
        onClick={() => onSeek(seconds)}
      >
        <IconPlay size={9} />
        {match[1]}
      </button>
    );
    lastIndex = at + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return <>{nodes}</>;
}

function Evaluation({ ev, onSeek }: { ev: MetricEvaluation; onSeek: (s: number) => void }) {
  return (
    <div className="eval">
      <div className="eval-head">
        <strong>{ev.metric_name}</strong>
        {ev.score != null && <Score score={ev.score} scale={ev.scale_max} />}
      </div>
      {ev.comment && (
        <p className="eval-note">
          <WithCues text={ev.comment} onSeek={onSeek} />
        </p>
      )}
      {ev.good.length > 0 && (
        <>
          <div className="notes-title good">Сработало</div>
          <ul className="notes good">
            {ev.good.map((item, i) => (
              <li key={i}>
                <WithCues text={item} onSeek={onSeek} />
              </li>
            ))}
          </ul>
        </>
      )}
      {ev.bad.length > 0 && (
        <>
          <div className="notes-title bad">Упущено</div>
          <ul className="notes bad">
            {ev.bad.map((item, i) => (
              <li key={i}>
                <WithCues text={item} onSeek={onSeek} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function DialogCard({ dialog, onSeek }: { dialog: Dialog; onSeek: (s: number) => void }) {
  const [detail, setDetail] = useState<DialogDetail | null>(null);
  const [open, setOpen] = useState(false);

  const toggle = () => {
    setOpen(!open);
    if (!detail) api.dialogDetail(dialog.id).then(setDetail).catch(() => {});
  };

  const evals = dialog.evaluations.filter((e) => e.applicable);

  return (
    <div className="dialog">
      <div className="dialog-head">
        <span className={`pill ${dialog.type}`}>
          {TYPE_LABELS[dialog.type] ?? dialog.type}
        </span>
        <button className="cue" onClick={() => onSeek(dialog.start_s)} title="Слушать разговор">
          <IconPlay size={9} />
          {fmtTs(dialog.start_s)}–{fmtTs(dialog.end_s)}
        </button>
        {evals.map((ev) =>
          ev.score != null ? (
            // Цифра окрашена по той же зоне, что и полосы: в свёрнутом виде
            // сразу видно, какой разговор просел.
            <span
              key={ev.metric_id}
              className={`chip-score ${scoreZone(ev.score, ev.scale_max)}`}
            >
              <b>
                {ev.score}
                <span className="scale">/{ev.scale_max}</span>
              </b>
              {ev.metric_name}
            </span>
          ) : null
        )}
        <button className="ghost small" style={{ marginLeft: "auto" }} onClick={toggle}>
          {open ? "Свернуть" : "Разбор"}
        </button>
      </div>
      {dialog.brief && <p className="dialog-brief">{dialog.brief}</p>}

      {open && (
        <div className="dialog-body">
          {evals.length > 0 ? (
            evals.map((ev) => <Evaluation key={ev.metric_id} ev={ev} onSeek={onSeek} />)
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Ни одна метрика не сработала на этом разговоре.
            </p>
          )}

          {detail && detail.turns.length > 0 && (
            <div className="turns">
              {detail.turns.map((t, i) => (
                <div key={i} className={`turn ${t.is_manager ? "manager" : ""}`}>
                  <button className="cue quiet" onClick={() => onSeek(t.start_s)}>
                    {fmtTs(t.start_s)}
                  </button>
                  <span className="who">
                    {t.is_manager === true
                      ? "Менеджер"
                      : t.is_manager === false
                        ? "Клиент"
                        : t.speaker_label}
                    :
                  </span>
                  <span>{t.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
