import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, DayRecording, fmtClock, fmtDate, fmtDur, fmtUsd } from "../api";
import { useSession, useStudio } from "../session";
import {
  ConfirmAction,
  Empty,
  MetricLine,
  Note,
  PageHead,
  Skeleton,
  StatusLight,
} from "../components/ui";

// Пока что-то живо, список опрашивается сам: огоньки должны отражать
// реальность без ручного обновления страницы.
const IN_FLIGHT = ["recording", "uploaded", "processing"];

export default function DaysPage() {
  const me = useSession();
  const { locationIds, locations } = useStudio();
  const [days, setDays] = useState<DayRecording[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    api
      .listDays(locationIds)
      .then((items) => {
        setDays(items);
        setError("");
      })
      .catch((e) => {
        setDays([]);
        setError(String(e));
      });
  }, [locationIds]);

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
      >
        {/* Какие студии сейчас показаны — видно из шапки, а не только из
            переключателя внизу меню. */}
        {locationIds.map((id) => (
          <span key={id} className="pill sale">
            {locations.find((l) => l.id === id)?.name ?? "студия"}
          </span>
        ))}
      </PageHead>

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
          {locationIds.length
            ? "На выбранных студиях записей ещё не было — поменяйте выбор внизу меню или запустите запись на ресепшене."
            : "Запустите запись в десктоп-приложении на ресепшене — смена появится здесь сразу после начала записи."}
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
                    {/* Студию подписываем, только когда смотрим все сразу:
                        внутри одной студии это был бы повтор в каждой строке. */}
                    {locationIds.length !== 1 && d.location_name && (
                      <span className="muted"> · {d.location_name}</span>
                    )}
                  </div>
                  <StatusLight status={d.status} />
                  {d.total_duration_s != null && (
                    <span className="muted">
                      {" · "}
                      {fmtDur(d.total_duration_s)} записи, из них речи{" "}
                      {fmtDur(d.speech_duration_s)}
                      {d.cost_usd != null && (
                        <span title="Стоимость последней обработки: распознавание плюс анализ">
                          {" · обработка "}
                          {fmtUsd(d.cost_usd)}
                        </span>
                      )}
                    </span>
                  )}
                  {d.status_detail && (
                    <div className="day-detail">{d.status_detail.slice(0, 220)}</div>
                  )}
                  {/* Средние по метрикам — не просто «7.3 из 10»: полоса
                      отвечает на «хорошо или плохо» цветом, до чтения цифры,
                      и сразу видно, какая метрика проседает. */}
                  {d.metric_stats.length > 0 && (
                    <div className="metric-lines">
                      {d.metric_stats.map((s) => (
                        <MetricLine
                          key={s.metric_id}
                          name={s.name}
                          score={s.avg_score}
                          scale={s.scale_max}
                          meta={`· ${s.triggered_count}×`}
                        />
                      ))}
                    </div>
                  )}
                </div>

                <div className="actions end">
                  {openable && (
                    <button onClick={() => navigate(`/days/${d.id}`)}>Открыть разбор</button>
                  )}
                  {/* Обслуживание смены — дело администратора: пересчёт
                      тратит деньги, удаление необратимо. Менеджеру эти
                      кнопки не показываются, сервер их всё равно отклонит. */}
                  {me.can_manage && d.status === "recording" && (
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
                  {me.can_manage && (d.status === "done" || d.status === "error") && (
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
                  {me.can_manage && d.status !== "processing" && (
                    <ConfirmAction
                      label="Удалить"
                      confirmLabel="Удалить навсегда"
                      title="Удалить смену вместе с аудио и разбором"
                      disabled={busyId === d.id}
                      onConfirm={() =>
                        run(d.id, () => api.deleteDay(d.id), "Смена удалена")
                      }
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {days !== null && days.length > 0 && me.can_manage && (
        <p className="muted page-note">
          «Пересчитать» прогоняет ту же запись по текущим метрикам — аудио
          заново не загружается. «Завершить принудительно» закрывает смену,
          которую приложение не закрыло само. «Удалить» безвозвратно стирает
          аудио и разбор.
        </p>
      )}
    </div>
  );
}
