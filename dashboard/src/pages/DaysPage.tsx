import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, DayRecording, fmtClock, fmtDate, fmtDur } from "../api";
import { Empty, Note, PageHead, Skeleton, StatusLight } from "../components/ui";

// Пока что-то живо, список опрашивается сам: огоньки должны отражать
// реальность без ручного обновления страницы.
const IN_FLIGHT = ["recording", "uploaded", "processing"];

export default function DaysPage() {
  const [days, setDays] = useState<DayRecording[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    api
      .listDays()
      .then((items) => {
        setDays(items);
        setError("");
      })
      .catch((e) => {
        setDays([]);
        setError(String(e));
      });
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (!days?.some((d) => IN_FLIGHT.includes(d.status))) return;
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [days, load]);

  const run = async (id: string, fn: () => Promise<unknown>, message: string) => {
    setBusyId(id);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(message);
      setPendingDelete(null);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const live = days?.filter((d) => d.status === "recording").length ?? 0;

  return (
    <div>
      <PageHead
        title="Смены"
        hint="Каждая строка — один рабочий день у стойки: кто работал, что записалось и как разговоры оценены метриками."
      />

      {live > 0 && (
        <Note kind="info">
          Прямо сейчас пишется {live === 1 ? "одна смена" : `${live} смены`}. Отчёт
          появится после того, как менеджер нажмёт «Завершить день» в приложении.
        </Note>
      )}
      {error && <Note kind="error">{error}</Note>}
      {notice && <Note kind="success">{notice}</Note>}

      {days === null && <Skeleton count={4} height={76} />}

      {days !== null && days.length === 0 && !error && (
        <Empty title="Смен пока нет">
          Запустите запись в десктоп-приложении на ресепшене — смена появится
          здесь сразу после начала записи.
        </Empty>
      )}

      {days !== null && days.length > 0 && (
        <div className="day-list">
          {days.map((d) => {
            const { day, weekday } = fmtDate(d.date);
            const started = fmtClock(d.created_at);
            const openable = d.status === "done";
            return (
              <div key={d.id} className={`day-row ${d.status === "recording" ? "live" : ""}`}>
                <div>
                  <div className="day-date">{day}</div>
                  <div className="day-when">
                    {weekday}
                    {started && ` · с ${started}`}
                  </div>
                </div>

                <div className="day-mid">
                  <div className="day-manager">
                    {d.employee_name ?? <span className="muted">менеджер не указан</span>}
                  </div>
                  <StatusLight status={d.status} />
                  {d.total_duration_s != null && (
                    <span className="muted">
                      {" · "}
                      {fmtDur(d.total_duration_s)} записи, из них речи{" "}
                      {fmtDur(d.speech_duration_s)}
                    </span>
                  )}
                  {d.status_detail && (
                    <div className="day-detail">{d.status_detail.slice(0, 220)}</div>
                  )}
                  {d.metric_stats.length > 0 && (
                    <div className="chips">
                      {d.metric_stats.map((s) => (
                        <span key={s.metric_id} className="chip-score">
                          {s.avg_score != null ? (
                            <b>
                              {s.avg_score}
                              <span className="scale">/{s.scale_max}</span>
                            </b>
                          ) : (
                            <b className="scale">—</b>
                          )}
                          {s.name} · {s.triggered_count}×
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="actions" style={{ justifyContent: "flex-end" }}>
                  {openable && (
                    <button onClick={() => navigate(`/days/${d.id}`)}>Открыть разбор</button>
                  )}
                  {d.status === "recording" && (
                    <button
                      className="secondary"
                      disabled={busyId === d.id}
                      title="Приложение не закрыло смену — например, ноутбук закрыли или программа вылетела. Обработать то, что успело загрузиться."
                      onClick={() =>
                        run(
                          d.id,
                          () => api.forceFinishDay(d.id),
                          "Смена закрыта и отправлена в обработку"
                        )
                      }
                    >
                      Завершить принудительно
                    </button>
                  )}
                  {(d.status === "done" || d.status === "error") && (
                    <button
                      className="secondary"
                      disabled={busyId === d.id}
                      title="Прогнать ту же запись через анализ заново — например, после правки метрик"
                      onClick={() =>
                        run(d.id, () => api.reprocessDay(d.id), "Поставлено в очередь")
                      }
                    >
                      Пересчитать
                    </button>
                  )}
                  {d.status !== "processing" &&
                    (pendingDelete === d.id ? (
                      <>
                        <button
                          className="danger"
                          disabled={busyId === d.id}
                          onClick={() => run(d.id, () => api.deleteDay(d.id), "Смена удалена")}
                        >
                          Удалить навсегда
                        </button>
                        <button className="ghost" onClick={() => setPendingDelete(null)}>
                          Отмена
                        </button>
                      </>
                    ) : (
                      <button
                        className="ghost"
                        title="Удалить смену вместе с аудио и разбором"
                        onClick={() => setPendingDelete(d.id)}
                      >
                        Удалить
                      </button>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {days !== null && days.length > 0 && (
        <p className="muted" style={{ marginTop: 14, maxWidth: "72ch" }}>
          «Пересчитать» прогоняет ту же запись по текущим метрикам — аудио
          заново не загружается. «Завершить принудительно» закрывает смену,
          которую приложение не закрыло само. «Удалить» безвозвратно стирает
          аудио и разбор.
        </p>
      )}
    </div>
  );
}
