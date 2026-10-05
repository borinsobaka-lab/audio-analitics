import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, DayRecording, fmtClock, fmtDate, fmtDur, fmtUsd, fmtWhen, plural } from "../api";
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
// Статусы, при которых список стоит обновлять сам: что-то ещё происходит.
// «uploaded» сюда не входит намеренно — смена лежит и ждёт, пока её запустят
// руками, обновлять нечего.
const IN_FLIGHT = ["recording", "queued", "processing"];

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
    if (!days?.some((d) => IN_FLIGHT.includes(d.status) && !d.stale)) return;
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

  /** Удаление отчитывается отдельно: важно не «удалено», а что вместе с
   *  разбором ушло и аудио — иначе место копилось бы незаметно. */
  const removeDay = async (id: string) => {
    setBusyId(id);
    setError("");
    setNotice("");
    try {
      const result = await api.deleteDay(id);
      if (result?.warning) setError(result.warning);
      else
        setNotice(
          `Смена удалена, из хранилища стёрто ${result?.files_removed ?? 0} ${plural(
            result?.files_removed ?? 0,
            "файл",
            "файла",
            "файлов"
          )}`
        );
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const live = days?.filter((d) => d.status === "recording").length ?? 0;
  const waiting = days?.filter((d) => d.status === "uploaded").length ?? 0;

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
          Прямо сейчас пишется {live === 1 ? "одна смена" : `${live} смены`}. После
          «Завершить день» в приложении она попадёт сюда со статусом «Ждёт
          разбора».
        </Note>
      )}
      {waiting > 0 && me.can_manage && (
        <Note kind="info">
          {waiting}{" "}
          {plural(waiting, "смена ждёт", "смены ждут", "смен ждут")} разбора.
          Разбор не запускается сам — нажмите «Обработать» на тех сменах,
          которые хотите разобрать, за остальные платить не придётся.
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
                  <StatusLight status={d.status} stale={d.stale} />
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
                  {d.stale && (
                    <div className="day-detail">
                      Статус не менялся с {fmtWhen(d.status_changed_at)} — воркер потерял
                      этот разбор. Запустите его заново.
                    </div>
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
                  {/* Разбор запускается вручную: платить за пустые дни,
                      неудачные дубли и проверки оборудования незачем. */}
                  {me.can_manage && d.status === "uploaded" && (
                    <button
                      disabled={busyId === d.id}
                      title="Распознать речь и разобрать разговоры этой смены"
                      onClick={() =>
                        run(d.id, () => api.processDay(d.id), "Смена поставлена в очередь на разбор")
                      }
                    >
                      Обработать
                    </button>
                  )}
                  {me.can_manage && (d.status === "done" || d.status === "error" || d.stale) && (
                    <button
                      className="secondary"
                      disabled={busyId === d.id}
                      title={
                        d.stale
                          ? "Разбор потерян воркером — поставить его в очередь заново"
                          : "Прогнать ту же запись через анализ заново — например, после правки метрик. Расшифровка берётся с прошлого раза, за распознавание платить не придётся."
                      }
                      onClick={() =>
                        run(d.id, () => api.processDay(d.id), "Поставлено в очередь")
                      }
                    >
                      {d.stale ? "Запустить заново" : "Пересчитать"}
                    </button>
                  )}
                  {me.can_manage && (!IN_FLIGHT.includes(d.status) || d.stale) && (
                    <ConfirmAction
                      label="Удалить"
                      confirmLabel="Удалить навсегда"
                      title="Стереть смену целиком: аудио, расшифровку и разбор"
                      disabled={busyId === d.id}
                      onConfirm={() => removeDay(d.id)}
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
          «Обработать» запускает распознавание и разбор — до нажатия смена
          просто лежит и ничего не стоит. «Пересчитать» прогоняет ту же
          расшифровку по текущим метрикам: речь заново не распознаётся, и
          платить за неё второй раз не нужно. «Завершить принудительно»
          закрывает смену, которую приложение не закрыло само. «Удалить»
          безвозвратно стирает и аудио, и разбор. Разбор, который не двигался
          несколько часов, помечается «завис» и запускается заново.
        </p>
      )}
    </div>
  );
}
