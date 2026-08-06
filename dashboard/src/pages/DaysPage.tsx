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

export default function DaysPage() {
  const [days, setDays] = useState<DayRecording[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
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

  const reprocess = async (id: string) => {
    setBusyId(id);
    setError("");
    try {
      await api.reprocessDay(id);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <h2>Отчёты по дням</h2>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Дата</th>
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
                </td>
                <td>
                  {STATUS_LABELS[d.status] ?? d.status}
                  {d.status_detail && (
                    <div className="muted">{d.status_detail.slice(0, 160)}</div>
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
                  {(d.status === "done" || d.status === "error") && (
                    <button
                      className="secondary"
                      disabled={busyId === d.id}
                      title="Прогнать запись через анализ заново — например, после правки промптов"
                      onClick={() => reprocess(d.id)}
                    >
                      {busyId === d.id ? "Запуск…" : "Обработать заново"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {days.length === 0 && !error && (
              <tr>
                <td colSpan={5} className="muted">
                  Записей пока нет. Запустите запись в десктоп-приложении.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted">
        «Обработать заново» пересчитывает отчёт из той же аудиозаписи по текущим
        версиям промптов и скрипта продаж. Прежний разбор дня заменяется новым.
      </p>
    </div>
  );
}
