/** Статистика звонков («Настройки скриптов» → «Звонки»): докуда разговор
 *  доходит по сценарию и где заканчивается.
 *
 *  Каждый звонок, который администратор ведёт по разделу-звонку в
 *  «Скриптах», тихо пишет свой путь по блокам. Здесь он складывается в две
 *  вещи — ровно то, что нужно, чтобы править сценарий:
 *  - воронка: сколько звонков дошли до каждого этапа и сколько на нём
 *    закончились — где сценарий теряет клиентов;
 *  - где заканчивались звонки: последний блок разговора, включая
 *    возражения; конец сценария отмечен отдельно от обрыва.
 *
 *  Все числа видны текстом — полосы только помогают глазу.
 */
import { useEffect, useMemo, useState } from "react";
import { api, CallStats, plural } from "../api";
import { Empty, Note, Section, Skeleton, Stat } from "../components/ui";
import { defaultPeriod, Period, periodQuery } from "./period";
import PeriodFilter from "./PeriodFilter";

function pct(part: number, whole: number): string {
  if (!whole) return "—";
  const v = (part / whole) * 100;
  return `${v < 10 && v > 0 ? v.toFixed(1).replace(".", ",") : Math.round(v)}%`;
}

export default function CallStatsView() {
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const [section, setSection] = useState("");
  const [data, setData] = useState<CallStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const q = useMemo(() => ({ ...periodQuery(period), section }), [period, section]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    api
      .callStats(q)
      .then((res) => alive && setData(res))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [q]);

  return (
    <div className="calls">
      <div className="stats-filters">
        <PeriodFilter value={period} onChange={setPeriod} />
        {data && data.sections.length > 1 && (
          <select className="stats-user" value={data.section_id ?? ""} aria-label="Сценарий"
            onChange={(e) => setSection(e.target.value)}>
            {data.sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
                {s.deleted ? " (удалён)" : ""} · {s.runs}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="muted calls-hint">
        Как звонки проходят сценарий: до какого этапа доходит разговор и на каком блоке заканчивается —
        чтобы видеть, где сценарий теряет клиентов, и править его.
      </p>

      {error && <Note kind="error">{error}</Note>}
      {!data && loading && <Skeleton count={3} height={110} />}

      {data && !data.sections.length && (
        <Empty title="Сценариев звонков пока нет">
          Звонки появятся здесь, когда в «Скриптах» будет раздел-звонок и администраторы начнут вести по нему разговоры.
        </Empty>
      )}

      {data && data.sections.length > 0 && (
        <div className={loading ? "calls-body loading" : "calls-body"}>
          {data.totals.runs === 0 ? (
            <Empty title="За этот период звонков нет">
              Звонок попадает сюда, когда администратор отвечает на первом шаге сценария в «Скриптах».
            </Empty>
          ) : (
            <>
              <div className="stats">
                <Stat lead value={data.totals.runs} label={plural(data.totals.runs, "звонок", "звонка", "звонков")} />
                <Stat
                  value={pct(data.totals.completed, data.totals.runs)}
                  label={`дошли до конца сценария · ${data.totals.completed}`}
                />
                <Stat
                  value={data.totals.avg_steps == null ? "—" : data.totals.avg_steps.toFixed(1).replace(".", ",")}
                  label="шагов сценария в среднем"
                />
              </div>
              <Funnel data={data} />
              <Ends data={data} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* --- Воронка ------------------------------------------------------------- */

function Funnel({ data }: { data: CallStats }) {
  const total = data.totals.runs;
  const endIds = new Set(data.ends.filter((e) => e.script_end).map((e) => e.node_id));
  // Где чаще всего обрываются — среди этапов, которые не конец сценария.
  const drops = data.funnel.filter((s) => s.ended_here && !endIds.has(s.node_id));
  const worst = drops.length ? drops.reduce((a, b) => (b.ended_here > a.ended_here ? b : a)).node_id : "";
  if (!data.funnel.length) return null;
  return (
    <Section title="Воронка по этапам" hint="сколько звонков дошли до этапа и сколько на нём закончились">
      <div className="sheet table-wrap">
        <table className="funnel">
          <thead>
            <tr>
              <th scope="col" className="funnel-n">#</th>
              <th scope="col">Этап</th>
              <th scope="col" className="funnel-bar-col">Доля дошедших</th>
              <th scope="col" className="num-col">Дошли</th>
              <th scope="col" className="num-col">Закончились здесь</th>
            </tr>
          </thead>
          <tbody>
            {data.funnel.map((s, i) => {
              const isEnd = endIds.has(s.node_id);
              const isWorst = worst === s.node_id;
              return (
                <tr key={s.node_id} className={s.reached ? "" : "empty"}
                  title={`${s.title}: дошли ${s.reached} из ${total}, закончились здесь ${s.ended_here}`}>
                  <td className="funnel-n num muted">{i + 1}</td>
                  <td className="funnel-title">{s.title}</td>
                  <td className="funnel-bar-col">
                    <div className="funnel-bar-wrap">
                      <span className="funnel-track">
                        <span className="funnel-bar" style={{ width: `${total ? (s.reached / total) * 100 : 0}%` }} />
                      </span>
                      <span className="funnel-pct num">{pct(s.reached, total)}</span>
                    </div>
                  </td>
                  <td className="num-col funnel-reached" data-label="дошли">{s.reached}</td>
                  <td className={`num-col funnel-ended${isWorst ? " funnel-worst" : ""}`} data-label="закончились">
                    {s.ended_here ? (
                      <>
                        {isWorst && <span className="funnel-tag bad">больше всего обрывов</span>}
                        {isEnd && <span className="funnel-tag">конец сценария</span>}
                        {s.ended_here}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* --- Где заканчивались звонки --------------------------------------------- */

function Ends({ data }: { data: CallStats }) {
  if (!data.ends.length) return null;
  const total = data.totals.runs;
  const max = Math.max(1, ...data.ends.map((e) => e.count));
  return (
    <Section title="Где заканчивались звонки" hint="последний блок разговора — включая возражения">
      <div className="sheet ends">
        {data.ends.map((e) => (
          <div key={e.node_id} className="end-row" title={`${e.title}: ${e.count} из ${total}`}>
            <span className="end-title">
              {e.title}
              {e.script_end ? (
                <span className="funnel-tag">конец сценария</span>
              ) : (
                e.group === "objection" && <span className="funnel-tag objection">возражение</span>
              )}
            </span>
            <span className="end-track">
              <span className={`end-bar${e.script_end ? " done" : ""}`} style={{ width: `${(e.count / max) * 100}%` }} />
            </span>
            <span className="num end-count">{e.count}</span>
            <span className="num muted end-pct">{pct(e.count, total)}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
