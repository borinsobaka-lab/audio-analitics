import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, DayRecording, fmtTs } from "../api";

const STATUS_LABELS: Record<string, string> = {
  recording: "Идёт запись",
  uploaded: "Загружено, в очереди",
  processing: "Обрабатывается",
  done: "Готово",
  error: "Ошибка",
};

const IN_FLIGHT = ["uploaded", "processing"];

/** Second confirmation click for destructive actions, kept inside the page. */
type Pending = { id: string; action: "delete" } | null;

export default function DaysPage() {
  const [days, setDays] = useState<DayRecording[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    api
      .listDays()
      .then((items) => {
        setDays(items);
        setError("");
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(load, [load]);

  // Poll while something is being processed so the status updates itself.
  useEffect(() => {
    if (!days.some((d) => IN_FLIGHT.includes(d.status))) return;
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
      setPending(null);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const startedAt = (d: DayRecording) =>
    d.created_at ? new Date(d.created_at).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    }) : "";

  return (
    <div>
      <h2>Отчёты по дням</h2>
      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Дата</th>
              <th>Менеджер</th>
              <th>Статус</th>
              <th>Длительность</th>
              <th>Чистая речь</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.id}>
                <td
                  className={d.status === "done" ? "clickable-cell" : ""}
                  onClick={() => d.status === "done" && navigate(`/days/${d.id}`)}
                >
                  {d.date}
                  {startedAt(d) && <div className="muted">с {startedAt(d)}</div>}
                </td>
                <td>{d.employee_name ?? <span className="muted">не указан</span>}</td>
                <td>
                  {STATUS_LABELS[d.status] ?? d.status}
                  {d.status_detail && (
                    <div className="muted">{d.status_detail.slice(0, 160)}</div>
                  )}
                  {d.metric_stats.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      {d.metric_stats.map((s) => (
                        <div key={s.metric_id} className="metric-chip">
                          {s.name}: {s.triggered_count}
                          {s.avg_score != null && (
                            <> · ★ {s.avg_score}/{s.scale_max}</>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td>{d.total_duration_s != null ? fmtTs(d.total_duration_s) : "—"}</td>
                <td>{d.speech_duration_s != null ? fmtTs(d.speech_duration_s) : "—"}</td>
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                  {d.status === "done" && (
                    <button
                      className="secondary"
                      onClick={() => navigate(`/days/${d.id}`)}
                      style={{ marginRight: 8 }}
                    >
                      Открыть
                    </button>
                  )}
                  {d.status === "recording" && (
                    <button
                      className="secondary"
                      style={{ marginRight: 8 }}
                      disabled={busyId === d.id}
                      title="Приложение не закрыло день (вылет, закрытый ноутбук). Обработать то, что успело загрузиться."
                      onClick={() =>
                        run(
                          d.id,
                          () => api.forceFinishDay(d.id),
                          "Запись закрыта и отправлена в обработку"
                        )
                      }
                    >
                      Завершить принудительно
                    </button>
                  )}
                  {(d.status === "done" || d.status === "error") && (
                    <button
                      className="secondary"
                      style={{ marginRight: 8 }}
                      disabled={busyId === d.id}
                      title="Прогнать запись через анализ заново — например, после правки промптов"
                      onClick={() =>
                        run(d.id, () => api.reprocessDay(d.id), "Поставлено в очередь")
                      }
                    >
                      Обработать заново
                    </button>
                  )}
                  {d.status !== "processing" &&
                    (pending?.id === d.id ? (
                      <>
                        <button
                          className="danger"
                          style={{ marginRight: 8 }}
                          disabled={busyId === d.id}
                          onClick={() =>
                            run(d.id, () => api.deleteDay(d.id), "Запись удалена")
                          }
                        >
                          Точно удалить
                        </button>
                        <button className="secondary" onClick={() => setPending(null)}>
                          Отмена
                        </button>
                      </>
                    ) : (
                      <button
                        className="secondary"
                        title="Удалить запись вместе с аудио и разбором"
                        onClick={() => setPending({ id: d.id, action: "delete" })}
                      >
                        Удалить
                      </button>
                    ))}
                </td>
              </tr>
            ))}
            {days.length === 0 && !error && (
              <tr>
                <td colSpan={6} className="muted">
                  Записей пока нет. Запустите запись в десктоп-приложении.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted">
        «Обработать заново» пересчитывает отчёт из той же аудиозаписи по текущим
        версиям промптов и скрипта продаж. «Завершить принудительно» закрывает
        запись, которую приложение не закрыло само. «Удалить» безвозвратно
        стирает аудио и разбор.
      </p>
    </div>
  );
}
