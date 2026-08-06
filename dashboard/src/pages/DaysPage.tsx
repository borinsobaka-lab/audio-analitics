import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, DayRecording, fmtTs } from "../api";

const STATUS_LABELS: Record<string, string> = {
  recording: "Идёт запись",
  uploaded: "Загружено, в очереди",
  processing: "Обрабатывается",
  done: "Готово",
  error: "Ошибка",
};

export default function DaysPage() {
  const [days, setDays] = useState<DayRecording[]>([]);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    api.listDays().then(setDays).catch((e) => setError(String(e)));
  }, []);

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
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr
                key={d.id}
                className="clickable"
                onClick={() => d.status === "done" && navigate(`/days/${d.id}`)}
              >
                <td>{d.date}</td>
                <td>
                  {STATUS_LABELS[d.status] ?? d.status}
                  {d.status === "error" && (
                    <div className="muted">{d.status_detail.slice(0, 120)}</div>
                  )}
                </td>
                <td>{d.total_duration_s != null ? fmtTs(d.total_duration_s) : "—"}</td>
                <td>{d.speech_duration_s != null ? fmtTs(d.speech_duration_s) : "—"}</td>
              </tr>
            ))}
            {days.length === 0 && !error && (
              <tr>
                <td colSpan={4} className="muted">
                  Записей пока нет. Запустите запись в десктоп-приложении.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
