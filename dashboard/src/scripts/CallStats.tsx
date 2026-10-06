/** Статистика звонков («Настройки скриптов» → «Звонки»): докуда разговор
 *  доходит по сценарию и где заканчивается — у всех или у одного
 *  администратора.
 *
 *  Каждый звонок, который администратор ведёт по разделу-звонку в
 *  «Скриптах», тихо пишет свой путь по блокам (тестовые прогоны — нет).
 *  Два вида:
 *  - «Сводка»: воронка — сколько звонков дошли до каждого этапа и сколько
 *    на нём закончились, и блоки, на которых звонки заканчивались; конец
 *    сценария отмечен отдельно от обрыва;
 *  - «Звонки»: история — каждый звонок с датой и временем, кто звонил,
 *    до какого этапа дошёл и на каком блоке закончился, весь путь по клику.
 *
 *  Все числа видны текстом — полосы только помогают глазу.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, CallRun, CallStats, fmtWhen, plural } from "../api";
import { Slider } from "../components/Slider";
import { usePaged } from "./paged";
import { Empty, Note, Section, Skeleton, Stat } from "../components/ui";
import { defaultPeriod, Period, periodQuery } from "./period";
import PeriodFilter from "./PeriodFilter";

function pct(part: number, whole: number): string {
  if (!whole) return "—";
  const v = (part / whole) * 100;
  return `${v < 10 && v > 0 ? v.toFixed(1).replace(".", ",") : Math.round(v)}%`;
}

type View = "summary" | "calls";

export default function CallStatsView() {
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const [section, setSection] = useState("");
  const [user, setUser] = useState("");
  const [view, setView] = useState<View>("summary");
  const [data, setData] = useState<CallStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const q = useMemo(() => ({ ...periodQuery(period), section, user }), [period, section, user]);

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
        {/* Выбирать есть из кого — только тому, кто видит звонки всех. */}
        {data && (data.users.length > 1 || user) && (
          <select className="stats-user" value={user} aria-label="Администратор"
            onChange={(e) => setUser(e.target.value)}>
            <option value="">Все администраторы</option>
            {data.users.map((u) => (
              <option key={u.key} value={u.key}>
                {u.name} · {u.runs}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="calls-view">
        <Slider className="seg" active={view} role="tablist" aria-label="Вид">
          <button type="button" role="tab" aria-selected={view === "summary"}
            className={`seg-btn${view === "summary" ? " on" : ""}`} onClick={() => setView("summary")}>
            Сводка
          </button>
          <button type="button" role="tab" aria-selected={view === "calls"}
            className={`seg-btn${view === "calls" ? " on" : ""}`} onClick={() => setView("calls")}>
            Звонки
          </button>
        </Slider>
        <p className="muted calls-hint">
          {view === "summary"
            ? "До какого этапа доходит разговор и на каком блоке заканчивается — где сценарий теряет клиентов."
            : "Каждый звонок: когда, кто, до какого этапа дошёл и где закончился. Нажмите — весь путь."}
        </p>
      </div>

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
          ) : view === "calls" ? (
            <CallHistory key={JSON.stringify({ ...q, section: data.section_id })}
              query={{ ...q, section: data.section_id ?? "" }} />
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

/* --- История звонков ------------------------------------------------------ */

/** Длительность: «2 мин 15 с», «40 с». */
function dur(seconds: number | null): string {
  if (seconds == null || seconds < 1) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s} с`;
  const rest = s % 60;
  return rest ? `${Math.floor(s / 60)} мин ${rest} с` : `${Math.floor(s / 60)} мин`;
}

function CallHistory({ query }: { query: { from: string; to: string; section: string; user: string } }) {
  const load = useCallback((cursor: string) => api.callRuns({ ...query, cursor }), [query]);
  const { items, loading, error, done, more, sentinel } = usePaged(load);
  const [open, setOpen] = useState("");

  if (!items.length && loading) return <Skeleton count={4} height={56} />;
  if (!items.length && error) return <Note kind="error">{error}</Note>;
  if (!items.length) return <Empty title="Звонков нет" />;

  return (
    <div className="sheet call-history">
      {items.map((r) => (
        <CallRow key={r.id} run={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? "" : r.id)} />
      ))}
      {error && <Note kind="error">{error}</Note>}
      {!done && (
        <div ref={sentinel} className="list-more">
          <button type="button" className="secondary small" disabled={loading} onClick={more}>
            {loading ? "Загружаем…" : "Показать ещё"}
          </button>
        </div>
      )}
    </div>
  );
}

function CallRow({ run: r, open, onToggle }: { run: CallRun; open: boolean; onToggle: () => void }) {
  const meta = [`${r.steps} ${plural(r.steps, "шаг", "шага", "шагов")}`, dur(r.seconds)].filter(Boolean).join(" · ");
  return (
    <div className={`ch-item${open ? " open" : ""}`}>
      <button type="button" className="ch-row" aria-expanded={open} onClick={onToggle}>
        <span className="ch-when num">{fmtWhen(r.started_at)}</span>
        <span className="ch-who">{r.user_name}</span>
        <span className="ch-progress" title={`Дошёл до этапа ${r.reached} из ${r.stages}`}>
          <span className="funnel-track">
            <span className="funnel-bar" style={{ width: `${r.stages ? (r.reached / r.stages) * 100 : 0}%` }} />
          </span>
          <span className="ch-progress-text">
            <span className="num">{r.reached}/{r.stages}</span> {r.reached_title}
          </span>
        </span>
        <span className="ch-end">
          <span className="muted">{r.live ? "сейчас на" : "закончил на"}</span> {r.last_title}
          {r.live ? (
            <span className="funnel-tag live">идёт сейчас</span>
          ) : r.script_end ? (
            <span className="funnel-tag">конец сценария</span>
          ) : (
            r.last_group === "objection" && <span className="funnel-tag objection">возражение</span>
          )}
        </span>
        <span className="ch-meta muted num">{meta}</span>
      </button>
      {open && (
        <ol className="ch-path">
          {r.path.map((p, i) => (
            <li key={i} className={p.group === "objection" ? "objection" : ""}>
              <span className="ch-step">{p.title}</span>
              {p.answer && <span className="ch-answer">{p.answer}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
