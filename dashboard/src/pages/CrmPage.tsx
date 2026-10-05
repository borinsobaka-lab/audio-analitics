/** CRM — разборы по дням.
 *
 *  Каждая строка — один день: сколько сделок, по которым была переписка или
 *  движение, разобрано и сколько из них с замечаниями. Разбор запускается
 *  сам по расписанию (вчерашний день утром) и по кнопке — за любой день,
 *  за который в CRM есть данные.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, CrmRun, CrmRuns, fmtDate, fmtUsd, fmtWhen, plural, toApiDate } from "../api";
import { ConfirmAction, DateField, Empty, Note, PageHead, Skeleton } from "../components/ui";
import { RUN_STATUS_LABELS } from "../crm/labels";
import { useSession } from "../session";

const IN_FLIGHT = ["queued", "processing"];

/** Огонёк статуса разбора — те же классы, что у смен: очередь и работа
 *  янтарём, готово зелёным, ошибка и зависший разбор красным. */
export function RunStatus({ run }: { run: CrmRun }) {
  if (run.stale) {
    return (
      <span className="status error" title="Статус не менялся несколько часов — разбор потерян. Запустите заново.">
        <span className="dot" />
        Разбор завис
      </span>
    );
  }
  const cls = { queued: "uploaded", processing: "processing", done: "done", error: "error" }[run.status] ?? "";
  return (
    <span className={`status ${cls}`}>
      <span className="dot" />
      {RUN_STATUS_LABELS[run.status] ?? run.status}
    </span>
  );
}

export default function CrmPage() {
  const me = useSession();
  const navigate = useNavigate();
  const [data, setData] = useState<CrmRuns | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [customDay, setCustomDay] = useState(() => toApiDate(new Date()));

  const load = useCallback(() => {
    api
      .crmRuns()
      .then((res) => {
        setData(res);
        setError("");
      })
      .catch((e) => {
        setData((d) => d ?? { runs: [], pending_dates: [], has_data: false, today: toApiDate(new Date()) });
        setError(String(e).replace(/^Error:\s*/, ""));
      });
  }, []);

  useEffect(load, [load]);

  // Пока что-то разбирается, список обновляется сам.
  useEffect(() => {
    if (!data?.runs.some((r) => IN_FLIGHT.includes(r.status) && !r.stale)) return;
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [data, load]);

  const act = async (key: string, fn: () => Promise<unknown>, message: string) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(message);
      load();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(null);
    }
  };

  const start = (day: string) =>
    act(day, () => api.startCrmRun(day), `День ${fmtDate(day).day} поставлен в очередь на разбор`);

  return (
    <div>
      <PageHead
        title="Разборы CRM"
        hint="Каждый день ИИ читает переписку по всем сделкам, которые в этот день двигались, и отмечает ошибки общения и движения по воронке. Вчерашний день разбирается сам утром; любой другой — по кнопке."
      >
        {me.can_manage_crm && (
          <div className="crm-run-any">
            <DateField
              value={customDay}
              max={data?.today}
              onChange={setCustomDay}
              aria-label="День для разбора"
            />
            <button
              type="button"
              className="secondary"
              disabled={!customDay || busy === customDay}
              title="Разобрать этот день — или разобрать заново, если он уже разбирался"
              onClick={() => start(customDay)}
            >
              Разобрать день
            </button>
          </div>
        )}
      </PageHead>

      {error && <Note kind="error">{error}</Note>}
      {notice && <Note kind="success">{notice}</Note>}

      {data && !data.has_data && (
        <Note kind="info">
          Данных из CRM ещё нет.{" "}
          {me.can_manage_crm ? (
            <>
              Подключите интеграцию в{" "}
              <Link to="/crm/settings?tab=integration">настройках</Link>: ключ, формат и импорт
              файла — там.
            </>
          ) : (
            "Когда интеграцию настроят, разборы появятся здесь."
          )}
        </Note>
      )}

      {data && data.pending_dates.length > 0 && me.can_manage_crm && (
        <div className="sheet sheet-pad crm-pending">
          <div className="crm-pending-head">
            <strong>Есть данные, но разбора ещё не было</strong>
            <span className="muted">
              {" "}
              · {data.pending_dates.length}{" "}
              {plural(data.pending_dates.length, "день", "дня", "дней")} за последний месяц
            </span>
          </div>
          <div className="crm-pending-days">
            {data.pending_dates.map((day) => (
              <button
                key={day}
                type="button"
                className="secondary small"
                disabled={busy === day}
                onClick={() => start(day)}
              >
                {fmtDate(day).day} — разобрать
              </button>
            ))}
          </div>
        </div>
      )}

      {data === null && !error && <Skeleton count={4} height={76} />}

      {data !== null && data.runs.length === 0 && data.has_data && (
        <Empty title="Разборов пока нет">
          {me.can_manage_crm
            ? "Выберите день сверху и нажмите «Разобрать день» — или дождитесь утра: вчерашний день разберётся сам."
            : "Первый разбор появится утром, после того как ИИ прочитает вчерашние переписки."}
        </Empty>
      )}

      {data !== null && data.runs.length > 0 && (
        <div className="day-list">
          {data.runs.map((r) => {
            const { day, weekday } = fmtDate(r.date);
            const openable = r.status === "done";
            const mine = !me.can_view_all_crm;
            return (
              <div key={r.id} className="day-row">
                <div>
                  <div className="day-date">{day}</div>
                  <div className="day-when">{weekday}</div>
                </div>
                <div className="day-mid">
                  <div className="day-manager">
                    <RunStatus run={r} />
                    <span className="muted">
                      {" · "}
                      {r.trigger === "schedule" ? "по расписанию" : "вручную"}
                      {r.finished_at && ` · ${fmtWhen(r.finished_at)}`}
                    </span>
                  </div>
                  {r.status === "done" && (
                    <div className="crm-run-counts">
                      <span>
                        {mine ? "моих сделок" : "сделок"}: <b className="num">{r.reviews_done}</b>
                      </span>
                      <span className={r.problems_count ? "crm-count-bad" : ""}>
                        с замечаниями: <b className="num">{r.problems_count}</b>
                      </span>
                      {me.can_manage_crm && r.cost_usd != null && (
                        <span className="muted" title="Стоимость разбора: обращения к модели">
                          обработка {fmtUsd(r.cost_usd)}
                        </span>
                      )}
                    </div>
                  )}
                  {/* У готового разбора цифры уже в строке выше: пояснение
                      показывается, только если в нём есть что-то сверх них —
                      ошибки, пропуски, пустой день. */}
                  {r.status_detail &&
                    me.can_manage_crm &&
                    (r.status !== "done" || /ошибок|пропущено|не было/.test(r.status_detail)) && (
                      <div className="day-detail">{r.status_detail.slice(0, 220)}</div>
                    )}
                </div>
                <div className="actions end">
                  {openable && (
                    <button type="button" onClick={() => navigate(`/crm/days/${r.date}`)}>
                      Открыть разбор
                    </button>
                  )}
                  {me.can_manage_crm && (r.status === "done" || r.status === "error" || r.stale) && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy === r.date}
                      title={
                        r.stale
                          ? "Разбор потерян воркером — поставить в очередь заново"
                          : "Прочитать переписку этого дня заново по текущему промпту и критериям. Платно."
                      }
                      onClick={() => start(r.date)}
                    >
                      {r.stale ? "Запустить заново" : "Разобрать заново"}
                    </button>
                  )}
                  {me.can_manage_crm && (!IN_FLIGHT.includes(r.status) || r.stale) && (
                    <ConfirmAction
                      label="Удалить"
                      confirmLabel="Удалить разбор"
                      title="Стереть разбор этого дня; данные CRM остаются"
                      disabled={busy === r.date}
                      onConfirm={() => act(r.date, () => api.deleteCrmRun(r.date), "Разбор удалён")}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {data !== null && data.runs.length > 0 && me.can_manage_crm && (
        <p className="muted page-note">
          Разбор дня стоит денег: каждая сделка — одно обращение к модели. «Разобрать заново»
          перечитывает тот же день по текущему промпту и критериям и заменяет прошлый разбор.
          Расписание и лимит сделок за день — в настройках.
        </p>
      )}
    </div>
  );
}
