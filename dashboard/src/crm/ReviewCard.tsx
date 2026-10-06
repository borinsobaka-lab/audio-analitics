/** Разбор одной сделки за день.
 *
 *  Свёрнутая карточка отвечает на три вопроса до чтения: насколько серьёзно
 *  (цветная метка), что это за разговор (класс) и кто вёл. Проблемы видны
 *  сразу — ради них разбор и затевался; остальное (что хорошо, советы,
 *  скрипты, воронка, оценки по критериям, сама переписка) — по кнопке.
 */
import { useState } from "react";
import { api, CrmReview, CrmReviewDetail, CrmSeverity } from "../api";
import { Panel, Score, scoreZone } from "../components/ui";
import { categoryLabel, fmtMinutes, fmtStamp, PROBLEM_KIND_LABELS, SEVERITY_LABELS } from "./labels";

/** Серьёзность — цветом из набора состояний: зелёный, янтарь, красный. */
const SEVERITY_PILL: Record<CrmSeverity, string> = { ok: "sale", warning: "service", critical: "refusal" };

const EVENT_LABELS: Record<string, string> = {
  stage_change: "Этап",
  status_change: "Статус",
  note: "Заметка",
  task: "Задача",
  task_done: "Задача выполнена",
  field_change: "Поле",
  call: "Звонок",
};

function eventText(e: CrmReviewDetail["events"][number]): string {
  const label = EVENT_LABELS[e.kind] ?? e.kind;
  if ((e.kind === "stage_change" || e.kind === "status_change" || e.kind === "field_change") && (e.from_value || e.to_value)) {
    const move = e.from_value ? `«${e.from_value}» → «${e.to_value}»` : `«${e.to_value}»`;
    return e.text ? `${label}: ${move} — ${e.text}` : `${label}: ${move}`;
  }
  return e.text ? `${label}: ${e.text}` : label;
}

export default function ReviewCard({ review }: { review: CrmReview }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<CrmReviewDetail | null>(null);
  const [error, setError] = useState("");

  const toggle = () => {
    setOpen(!open);
    if (!detail && !open) {
      api
        .crmReview(review.id)
        .then(setDetail)
        .catch((e) => setError(String(e).replace(/^Error:\s*/, "")));
    }
  };

  const deal = review.deal;
  const who = review.employee_name || review.manager_name || "менеджер не указан";
  const applicable = review.scores.filter((s) => s.applicable && s.score != null);
  const waitBad = review.unanswered || (review.max_reply_minutes != null && review.max_reply_minutes > 60);

  return (
    <div className={`dialog crm-review ${review.severity}`}>
      <div className="dialog-head">
        <span className={`pill ${SEVERITY_PILL[review.severity]}`}>{SEVERITY_LABELS[review.severity]}</span>
        <span className="pill">{categoryLabel(review.category)}</span>
        <span className="crm-deal-title">
          {deal.url ? (
            <a href={deal.url} target="_blank" rel="noreferrer" title="Открыть сделку в CRM">
              {deal.title || `Сделка #${deal.external_id}`}
            </a>
          ) : (
            deal.title || `Сделка #${deal.external_id}`
          )}
          {deal.contact_name && <span className="muted"> · {deal.contact_name}</span>}
        </span>
        <span className="muted crm-meta">
          {who}
          {deal.stage && ` · этап: ${deal.stage}`}
          {deal.source && ` · ${deal.source}`}
        </span>
        {review.unanswered ? (
          <span className="crm-wait bad" title="К концу дня последнее сообщение клиента осталось без ответа">
            без ответа
          </span>
        ) : review.first_reply_minutes != null ? (
          <span
            className={`crm-wait${waitBad ? " bad" : ""}`}
            title={`Первый ответ за день — через ${fmtMinutes(review.first_reply_minutes)}; самое долгое ожидание — ${fmtMinutes(review.max_reply_minutes)}`}
          >
            ответ через {fmtMinutes(review.first_reply_minutes)}
          </span>
        ) : null}
        {applicable.map((s) => (
          <span key={s.criterion_id} className={`chip-score ${scoreZone(s.score!, s.scale_max)}`}>
            <b>
              {s.score}
              <span className="scale">/{s.scale_max}</span>
            </b>
            {s.name}
          </span>
        ))}
      </div>

      {review.summary && <p className="dialog-brief">{review.summary}</p>}

      {review.problems.length > 0 && (
        <div className="crm-problems">
          <Panel tone="bad" title="Что не так">
            <ul className="notes bad">
              {review.problems.map((p, i) => (
                <li key={i}>
                  <span className="crm-kind">{PROBLEM_KIND_LABELS[p.kind]}</span> {p.text}
                  {p.quote && <q className="crm-quote">{p.quote}</q>}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}

      <div className="dialog-open">
        <button type="button" className={open ? "secondary" : ""} onClick={toggle}>
          {open ? "Свернуть" : "Смотреть разбор и переписку"}
        </button>
      </div>

      {open && (
        <div className="dialog-body">
          {review.good.length > 0 && (
            <Panel tone="good" title="Что хорошо">
              <ul className="notes good">
                {review.good.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </Panel>
          )}
          {review.recommendations.length > 0 && (
            <Panel tone="info" title="Что сделать">
              <ul className="notes">
                {review.recommendations.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel
            tone={review.pipeline.ok ? "neutral" : "bad"}
            title={review.pipeline.ok ? "Движение по воронке — в порядке" : "Движение по воронке"}
            hint={review.pipeline.expected_stage ? `должна быть на этапе «${review.pipeline.expected_stage}»` : undefined}
          >
            {review.pipeline.comment ? <p className="crm-panel-text">{review.pipeline.comment}</p> : null}
          </Panel>
          {(review.scripts.used.length > 0 || review.scripts.deviations.length > 0) && (
            <Panel tone="neutral" title="Скрипты">
              {review.scripts.used.length > 0 && (
                <p className="crm-panel-text">
                  Использованы: {review.scripts.used.join(", ")}
                </p>
              )}
              {review.scripts.deviations.length > 0 && (
                <ul className="notes bad">
                  {review.scripts.deviations.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          {applicable.length > 0 && (
            <div className="crm-evals">
              {applicable.map((s) => (
                <div key={s.criterion_id} className="eval">
                  <div className="eval-head">
                    <strong>{s.name}</strong>
                    <Score score={s.score!} scale={s.scale_max} />
                  </div>
                  {s.comment && <p className="eval-note">{s.comment}</p>}
                </div>
              ))}
            </div>
          )}

          {error && <p className="muted dialog-note">{error}</p>}
          {detail && (
            <>
              {detail.messages.length > 0 ? (
                <div className="turns crm-turns">
                  {detail.messages.map((m) => (
                    <div key={m.id} className={`turn ${m.direction === "out" ? "manager" : ""}${m.in_day ? "" : " context"}`}>
                      <span className="crm-time num" title={m.in_day ? "" : "До разбираемого дня — контекст"}>
                        {fmtStamp(m.at, !m.in_day)}
                      </span>
                      <span className="who">{m.direction === "out" ? m.author_name || "Администратор" : "Клиент"}:</span>
                      <span>{m.text}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted dialog-note">Сообщений за этот день не было.</p>
              )}
              {detail.events.length > 0 && (
                <div className="crm-events">
                  {detail.events.map((e) => (
                    <div key={e.id} className={`crm-event${e.in_day ? "" : " context"}`}>
                      <span className="crm-time num">{fmtStamp(e.at, !e.in_day)}</span>
                      <span className="who">{e.author_name || "система"}:</span>
                      <span>{eventText(e)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
