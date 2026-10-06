/** Разбор дня CRM: итоги, выводы ИИ и карточки сделок.
 *
 *  Сверху — цифры дня и выводы для руководителя (главные ошибки, по каждому
 *  администратору, что делать завтра), ниже — сделки, проблемные первыми.
 *  Фильтры нужны, когда сделок за день десятки: только с замечаниями,
 *  один администратор, один класс переписки.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, CrmRunReport, fmtDate, fmtUsd, fmtWhen, plural } from "../api";
import { Slider } from "../components/Slider";
import { ConfirmAction, Empty, Note, PageHead, Panel, Section, Skeleton, Stat } from "../components/ui";
import { RunStatus } from "./CrmPage";
import ReviewCard from "../crm/ReviewCard";
import { categoryLabel, CATEGORY_ORDER, fmtMinutes } from "../crm/labels";
import { useSession } from "../session";

type Only = "all" | "problems" | "critical";

export default function CrmDayPage() {
  const { day = "" } = useParams<{ day: string }>();
  const me = useSession();
  const [report, setReport] = useState<CrmRunReport | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [only, setOnly] = useState<Only>("all");
  const [manager, setManager] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    if (!day) return;
    api
      .crmRunReport(day)
      .then((r) => {
        setReport(r);
        setError("");
      })
      .catch((e) => setError(String(e).replace(/^Error:\s*/, "")));
  }, [day]);

  useEffect(load, [load]);

  const inFlight = report && ["queued", "processing"].includes(report.run.status) && !report.run.stale;
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [inFlight, load]);

  const managers = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of report?.reviews ?? []) {
      const key = r.employee_id ?? `crm:${r.manager_key}`;
      map.set(key, r.employee_name || r.manager_name || "не указан");
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"));
  }, [report]);

  const categories = useMemo(() => {
    const present = new Set((report?.reviews ?? []).map((r) => r.category));
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [report]);

  const shown = useMemo(
    () =>
      (report?.reviews ?? []).filter((r) => {
        if (only === "problems" && !r.problem) return false;
        if (only === "critical" && r.severity !== "critical") return false;
        if (manager && (r.employee_id ?? `crm:${r.manager_key}`) !== manager) return false;
        if (category && r.category !== category) return false;
        return true;
      }),
    [report, only, manager, category]
  );

  const rerun = async () => {
    setBusy(true);
    setError("");
    try {
      await api.startCrmRun(day);
      setNotice("Поставлено в очередь: разбор появится через несколько минут и заменит этот.");
      load();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const sendTelegram = async () => {
    setSending(true);
    setError("");
    try {
      const res = await api.notifyCrmRun(day);
      setNotice(`Сводка отправлена в ${res.delivered} ${plural(res.delivered, "чат", "чата", "чатов")}.`);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setSending(false);
    }
  };

  if (error && !report) return <Note kind="error">{error}</Note>;
  if (!report) return <Skeleton count={3} height={92} />;

  const { run, summary, stats } = report;
  const { day: dayLabel, weekday } = fmtDate(run.date);
  const window =
    report.day_end_hour && report.window_from && report.window_to
      ? `с ${fmtWhen(report.window_from)} до ${fmtWhen(report.window_to)}`
      : "";
  const problems = report.reviews.filter((r) => r.problem).length;
  const critical = report.reviews.filter((r) => r.severity === "critical").length;
  const unanswered = report.reviews.filter((r) => r.unanswered).length;
  const replies = report.reviews.map((r) => r.first_reply_minutes).filter((v): v is number => v != null);
  const avgReply = replies.length ? replies.reduce((a, b) => a + b, 0) / replies.length : null;

  return (
    <div>
      <PageHead
        title={`CRM за ${dayLabel}`}
        hint={
          <>
            {weekday}
            {window && ` · отчётный день ${window}`} · <Link to="/crm">все разборы</Link>
            {me.can_view_all_crm && run.status_detail && ` · ${run.status_detail}`}
          </>
        }
      >
        <div className="actions end">
          <RunStatus run={run} />
          {me.can_manage_crm && run.status === "done" && report.telegram_configured && (
            <button
              type="button"
              className="secondary"
              disabled={sending}
              title="Отправить краткую сводку этого разбора в Telegram-чат ещё раз"
              onClick={sendTelegram}
            >
              {sending ? "Отправляем…" : "В Telegram"}
            </button>
          )}
          {me.can_manage_crm && !inFlight && (
            <ConfirmAction
              label="Разобрать заново"
              confirmLabel="Запустить"
              title="Прочитать переписку этого дня заново по текущему промпту и критериям. Платно."
              disabled={busy}
              onConfirm={rerun}
            />
          )}
        </div>
      </PageHead>

      {notice && <Note kind="success">{notice}</Note>}
      {error && <Note kind="error">{error}</Note>}
      {inFlight && (
        <Note kind="info">
          Разбор идёт: {run.status_detail || "в очереди"}. Страница обновится сама.
        </Note>
      )}
      {run.status === "error" && (
        <Note kind="error">Разбор не удался: {run.status_detail.split("\n")[0]}</Note>
      )}

      <div className="stats">
        <Stat
          lead
          value={String(problems)}
          label={`${plural(problems, "сделка", "сделки", "сделок")} с замечаниями из ${report.reviews.length}`}
        />
        <Stat value={String(critical)} label="Критичных" />
        <Stat value={String(unanswered)} label="Без ответа клиенту" />
        <Stat value={fmtMinutes(avgReply)} label="Ответ клиенту в среднем" />
        {me.can_manage_crm && (
          <Stat
            value={fmtUsd(run.cost_usd)}
            label="Обработка"
            title={`${run.llm_calls} ${plural(run.llm_calls, "обращение", "обращения", "обращений")} к модели (${run.llm_input_tokens.toLocaleString("ru-RU")} вх. / ${run.llm_output_tokens.toLocaleString("ru-RU")} исх. токенов)`}
          />
        )}
      </div>

      {summary && !summary.error && (
        <Section title="Выводы дня">
          {summary.top_problems && summary.top_problems.length > 0 && (
            <Panel tone="bad" title="Главные ошибки">
              <ul className="notes bad">
                {summary.top_problems.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </Panel>
          )}
          {summary.by_manager && summary.by_manager.length > 0 && (
            <Panel tone="neutral" title="По администраторам">
              <ul className="notes">
                {summary.by_manager.map((m, i) => (
                  <li key={i}>
                    <b>{m.manager}</b>
                    {m.manager && m.note ? " — " : ""}
                    {m.note}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          {summary.recommendations && summary.recommendations.length > 0 && (
            <Panel tone="info" title="Что сделать завтра">
              <ul className="notes">
                {summary.recommendations.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </Panel>
          )}
          {summary.highlights && summary.highlights.length > 0 && (
            <Panel tone="good" title="Удачные моменты">
              <ul className="notes good">
                {summary.highlights.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </Panel>
          )}
        </Section>
      )}
      {summary?.error && me.can_manage_crm && (
        <Note kind="error">Итог дня не сложился: {summary.error}. Разборы сделок ниже — целы.</Note>
      )}

      {stats && Object.keys(stats.avg_by_criterion).length > 0 && (
        <Section title="Критерии за день" hint="средняя оценка по сделкам, где критерий применим">
          <div className="stats">
            {report.criteria
              .filter((c) => stats.avg_by_criterion[c.name] != null)
              .map((c) => (
                <Stat
                  key={c.id}
                  value={
                    <>
                      {stats.avg_by_criterion[c.name]}
                      <span className="of">/{c.scale_max}</span>
                    </>
                  }
                  bar={{ score: stats.avg_by_criterion[c.name], scale: c.scale_max }}
                  label={c.name}
                />
              ))}
          </div>
        </Section>
      )}

      <Section
        title="Сделки"
        hint={
          report.reviews.length
            ? `${shown.length} из ${report.reviews.length} · проблемные первыми`
            : undefined
        }
      >
        {report.reviews.length > 0 && (
          <div className="filters crm-filters">
            <Slider className="seg" active={only} role="group" aria-label="Какие сделки показывать">
              {(
                [
                  ["all", "Все"],
                  ["problems", "С замечаниями"],
                  ["critical", "Критичные"],
                ] as [Only, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`seg-btn${only === key ? " on" : ""}`}
                  onClick={() => setOnly(key)}
                >
                  {label}
                </button>
              ))}
            </Slider>
            {managers.length > 1 && (
              <label className="filter">
                <span className="label">администратор</span>
                <select value={manager} onChange={(e) => setManager(e.target.value)}>
                  <option value="">все</option>
                  {managers.map(([key, name]) => (
                    <option key={key} value={key}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {categories.length > 1 && (
              <label className="filter">
                <span className="label">переписка</span>
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">любая</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {categoryLabel(c)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        {report.reviews.length === 0 && run.status === "done" && (
          <Empty title="Сделок за этот день нет">
            {me.can_view_all_crm
              ? "В CRM за этот день не было ни переписки, ни движения сделок — или данные за него ещё не пришли."
              : "По вашим сделкам за этот день разборов нет."}
          </Empty>
        )}
        {report.reviews.length > 0 && shown.length === 0 && (
          <Empty title="Под фильтр ничего не попало">Снимите фильтр или выберите другой.</Empty>
        )}
        {shown.map((r) => (
          <ReviewCard key={r.id} review={r} />
        ))}
      </Section>
    </div>
  );
}
