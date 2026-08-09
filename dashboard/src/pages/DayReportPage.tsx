import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  DayReport,
  Dialog,
  DialogDetail,
  DialogFeedback,
  fmtDate,
  fmtDur,
  fmtTs,
  fmtUsd,
  MetricEvaluation,
} from "../api";
import { CarriedAgreements, DayAgreements } from "../components/Agreements";
import { Deck, DeckHandle } from "../components/Deck";
import { FeedbackControl } from "../components/Feedback";
import {
  Empty,
  IconPlay,
  Note,
  Panel,
  Score,
  Section,
  Skeleton,
  Stat,
  scoreZone,
} from "../components/ui";
import { useSession } from "../session";

const TYPE_LABELS: Record<string, string> = {
  sale: "Продажа",
  consultation: "Консультация",
  refusal: "Отказ",
  service: "Сервис",
  irrelevant: "Нерелевантно",
};

export default function DayReportPage() {
  const { id } = useParams<{ id: string }>();
  const me = useSession();
  const [report, setReport] = useState<DayReport | null>(null);
  const [feedback, setFeedback] = useState<DialogFeedback[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reprocessing, setReprocessing] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const deck = useRef<DeckHandle>(null);

  const load = useCallback(() => {
    if (!id) return;
    api
      .dayReport(id)
      .then((r) => {
        setReport(r);
        setFeedback(r.feedback);
      })
      .catch((e) => setError(String(e)));
  }, [id]);

  useEffect(() => {
    load();
    if (id) api.dayAudioUrl(id).then((r) => setAudioUrl(r.url)).catch(() => {});
  }, [id, load]);

  const seek = (seconds: number) => deck.current?.seek(seconds);

  const reprocess = async () => {
    if (!id || reprocessing) return;
    setReprocessing(true);
    setError("");
    try {
      await api.processDay(id);
      setNotice(
        "Поставлено в очередь: разбор появится через несколько минут — обновите страницу."
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
        {me.can_manage && (
          <button
            className="secondary"
            onClick={reprocess}
            disabled={reprocessing}
            title="Прогнать ту же запись через анализ заново — например, после правки метрик"
          >
            {reprocessing
              ? "Запуск…"
              : recording.status === "done"
                ? "Пересчитать"
                : "Обработать"}
          </button>
        )}
      </header>

      {notice && <Note kind="success">{notice}</Note>}
      {error && <Note kind="error">{error}</Note>}

      {/* Разбор начинается с проверки того, о чём договорились в прошлый раз,
          поэтому блок стоит выше цифр этого дня. */}
      <CarriedAgreements
        items={report.carried_agreements}
        currentDayId={recording.id}
        canManage={me.can_manage}
        onChanged={load}
      />

      <div className="stats">
        <Stat lead value={conversion} label="Конверсия" />
        <Stat value={report.sales_count} label="Продаж" />
        <Stat value={report.dialogs_total} label="Разговоров с клиентами" />
        <Stat value={fmtDur(recording.speech_duration_s)} label="Чистой речи" />
        {me.can_manage && (
          <Stat
            value={fmtUsd(recording.cost_usd)}
            label="Обработка"
            title={
              recording.cost_usd != null
                ? `Распознавание ${fmtDur(recording.asr_seconds)} речи + ` +
                  `${recording.llm_calls} обращений к модели ` +
                  `(${recording.llm_input_tokens.toLocaleString("ru-RU")} вх. / ` +
                  `${recording.llm_output_tokens.toLocaleString("ru-RU")} исх. токенов). ` +
                  "Это стоимость последней обработки: «Пересчитать» тратит заново."
                : undefined
            }
          />
        )}
      </div>

      {report.metric_stats.length > 0 && (
        <Section title="Метрики за смену" hint="средняя оценка и сколько раз сработала">
          <div className="stats">
            {report.metric_stats.map((s) => (
              <Stat
                key={s.metric_id}
                value={
                  s.avg_score != null ? (
                    <>
                      {s.avg_score}
                      <span className="of">/{s.scale_max}</span>
                    </>
                  ) : (
                    "—"
                  )
                }
                /* Полоса под цифрой отвечает на «хорошо или плохо» цветом,
                   до того как прочитано само число. */
                bar={
                  s.avg_score != null
                    ? { score: s.avg_score, scale: s.scale_max }
                    : undefined
                }
                label={`${s.name} · ${s.triggered_count}×`}
              />
            ))}
          </div>
        </Section>
      )}

      {summary && (
        <Section title="Итоги смены">
          {/* Выводы дня разложены по подложкам: провалы, удачи и советы —
              это разные разговоры с менеджером, а не один список. */}
          <SummaryList
            title="Главные отклонения"
            items={summary.top_deviations}
            tone="bad"
          />
          <SummaryList
            title="Удачные моменты"
            items={summary.highlights}
            tone="good"
          />
          <SummaryList
            title="Рекомендации менеджеру"
            items={summary.recommendations}
            tone="info"
          />
          <SummaryList
            title="Предложения по скрипту"
            items={summary.script_suggestions}
            tone="neutral"
          />
        </Section>
      )}

      <Section
        title="Договорённости"
        hint="всплывут в следующей смене этого менеджера"
      >
        <DayAgreements
          items={report.agreements}
          dayId={recording.id}
          dialogs={shown}
          canManage={me.can_manage}
          onChanged={load}
        />
      </Section>

      <Section
        title="Разговоры"
        hint={shown.length > 0 ? `${shown.length} на ленте смены` : "ничего не распознано"}
      >

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
          <DialogCard
            key={d.id}
            dialog={d}
            onSeek={seek}
            feedback={feedback}
            onFeedback={setFeedback}
          />
        ))}
      </Section>

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
  tone,
}: {
  title: string;
  items?: string[];
  tone: "good" | "bad" | "info" | "neutral";
}) {
  if (!items || items.length === 0) return null;
  return (
    <Panel tone={tone} title={title}>
      <ul className={`notes ${tone === "good" || tone === "bad" ? tone : ""}`}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </Panel>
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

function Evaluation({
  ev,
  dialogId,
  onSeek,
  feedback,
  onFeedback,
}: {
  ev: MetricEvaluation;
  dialogId: string;
  onSeek: (s: number) => void;
  feedback: DialogFeedback[];
  onFeedback: (items: DialogFeedback[]) => void;
}) {
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
        <Panel tone="good" title="Сработало">
          <ul className="notes good">
            {ev.good.map((item, i) => (
              <li key={i}>
                <WithCues text={item} onSeek={onSeek} />
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {ev.bad.length > 0 && (
        <Panel tone="bad" title="Упущено">
          <ul className="notes bad">
            {ev.bad.map((item, i) => (
              <li key={i}>
                <WithCues text={item} onSeek={onSeek} />
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {/* Отзыв стоит у самой оценки: возражают именно ей, и именно по ней
          несогласия потом собираются в разделе метрик. */}
      <FeedbackControl
        dialogId={dialogId}
        metricId={ev.metric_id}
        items={feedback}
        onChanged={onFeedback}
        label="Оценка справедлива?"
      />
    </div>
  );
}

function DialogCard({
  dialog,
  onSeek,
  feedback,
  onFeedback,
}: {
  dialog: Dialog;
  onSeek: (s: number) => void;
  feedback: DialogFeedback[];
  onFeedback: (items: DialogFeedback[]) => void;
}) {
  const [detail, setDetail] = useState<DialogDetail | null>(null);
  const [open, setOpen] = useState(false);

  const toggle = () => {
    setOpen(!open);
    if (!detail) api.dialogDetail(dialog.id).then(setDetail).catch(() => {});
  };

  const evals = dialog.evaluations.filter((e) => e.applicable);
  const disagreed = feedback.some(
    (f) => f.dialog_id === dialog.id && !f.agree
  );

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
        {/* Метка на свёрнутой карточке: спорные разборы должны быть видны,
            не открывая каждый. */}
        {disagreed && <span className="pill refusal">есть несогласие</span>}
      </div>
      {dialog.brief && <p className="dialog-brief">{dialog.brief}</p>}

      {/* Главное действие карточки стоит внизу по центру: в углу шапки, среди
          меток и оценок, его не находили. */}
      <div className="dialog-open">
        <button className={open ? "secondary" : ""} onClick={toggle}>
          {open ? "Свернуть разбор" : "Смотреть разбор"}
        </button>
      </div>

      {open && (
        <div className="dialog-body">
          {evals.length > 0 ? (
            evals.map((ev) => (
              <Evaluation
                key={ev.metric_id}
                ev={ev}
                dialogId={dialog.id}
                onSeek={onSeek}
                feedback={feedback}
                onFeedback={onFeedback}
              />
            ))
          ) : (
            <p className="muted dialog-note">
              Ни одна метрика не сработала на этом разговоре.
            </p>
          )}

          <FeedbackControl
            dialogId={dialog.id}
            items={feedback}
            onChanged={onFeedback}
            label="Согласны с разбором разговора?"
          />

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
