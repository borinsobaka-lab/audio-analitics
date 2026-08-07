/** Дашборд: то, ради чего метрики вообще копятся.
 *
 *  Разбор смены отвечает на вопрос «как прошёл этот день». Здесь другой
 *  вопрос — растёт менеджер или проседает, — поэтому любой показатель стоит
 *  рядом со своим значением за предыдущий период такой же длины.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addDays,
  api,
  Employee,
  fmtDur,
  fmtUsd,
  MetricPeriodStat,
  plural,
  Summary,
  toApiDate,
} from "../api";
import { TrendChart } from "../components/TrendChart";
import { Empty, Note, PageHead, ScoreBar, Skeleton, scoreZone } from "../components/ui";

type Preset = { key: string; label: string; range: () => [Date, Date] };

const today = () => new Date();
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);

const PRESETS: Preset[] = [
  { key: "7", label: "7 дней", range: () => [addDays(today(), -6), today()] },
  { key: "30", label: "30 дней", range: () => [addDays(today(), -29), today()] },
  { key: "month", label: "Этот месяц", range: () => [startOfMonth(today()), today()] },
  {
    key: "prev-month",
    label: "Прошлый месяц",
    range: () => {
      const prev = new Date(today().getFullYear(), today().getMonth() - 1, 1);
      return [prev, endOfMonth(prev)];
    },
  },
];

export default function DashboardPage() {
  const [preset, setPreset] = useState("30");
  const [range, setRange] = useState<[string, string]>(() => {
    const [a, b] = PRESETS[1].range();
    return [toApiDate(a), toApiDate(b)];
  });
  const [employeeId, setEmployeeId] = useState("");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.listEmployees().then(setEmployees).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setData(null);
    api
      .summary({
        date_from: range[0],
        date_to: range[1],
        employee_id: employeeId || undefined,
      })
      .then((s) => {
        setData(s);
        setError("");
      })
      .catch((e) => setError(String(e)));
  }, [range, employeeId]);

  useEffect(load, [load]);

  const applyPreset = (p: Preset) => {
    const [a, b] = p.range();
    setPreset(p.key);
    setRange([toApiDate(a), toApiDate(b)]);
  };

  const setCustom = (index: 0 | 1, value: string) => {
    if (!value) return;
    setPreset("custom");
    setRange((r) => (index === 0 ? [value, r[1]] : [r[0], value]));
  };

  // Панели динамики: конверсия и каждая метрика — по одной на панель, потому
  // что шкалы у них разные и общей оси быть не может.
  const panels = useMemo(() => {
    if (!data) return [];
    const list = [
      {
        key: "conversion",
        title: "Конверсия",
        max: 100,
        format: (v: number) => `${Math.round(v)}%`,
        points: data.trend.map((t) => ({
          date: t.date,
          value: t.conversion == null ? null : t.conversion * 100,
        })),
      },
    ];
    for (const m of data.metrics) {
      list.push({
        key: m.metric_id,
        title: m.name,
        max: m.scale_max,
        format: (v: number) => `${v.toFixed(1)} из ${m.scale_max}`,
        points: data.trend.map((t) => ({
          date: t.date,
          value: t.avg_scores[m.metric_id] ?? null,
        })),
      });
    }
    return list;
  }, [data]);

  return (
    <div>
      <PageHead
        title="Дашборд"
        hint="Показатели за период рядом со значениями за предыдущий период такой же длины — видно не только «сколько», но и «в какую сторону»."
      />

      <div className="filters">
        <div className="seg">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              className={`seg-btn ${preset === p.key ? "on" : ""}`}
              onClick={() => applyPreset(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="filter">
          <span className="label">с</span>
          <input type="date" value={range[0]} max={range[1]} onChange={(e) => setCustom(0, e.target.value)} />
        </label>
        <label className="filter">
          <span className="label">по</span>
          <input type="date" value={range[1]} min={range[0]} onChange={(e) => setCustom(1, e.target.value)} />
        </label>
        <label className="filter">
          <span className="label">менеджер</span>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">все</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <Note kind="error">{error}</Note>}
      {!data && !error && <Skeleton count={2} height={110} />}

      {data && (
        <>
          <div className="stats">
            <Kpi
              lead
              value={data.totals.conversion != null ? `${Math.round(data.totals.conversion * 100)}%` : "—"}
              label="Конверсия"
              delta={deltaPercent(data.totals.conversion, data.previous.conversion)}
            />
            <Kpi
              value={String(data.totals.shifts)}
              label={plural(data.totals.shifts, "смена", "смены", "смен")}
              delta={deltaCount(data.totals.shifts, data.previous.shifts)}
            />
            <Kpi
              value={String(data.totals.dialogs)}
              label="Разговоров"
              delta={deltaCount(data.totals.dialogs, data.previous.dialogs)}
            />
            <Kpi
              value={String(data.totals.sales)}
              label="Продаж"
              delta={deltaCount(data.totals.sales, data.previous.sales)}
            />
            <Kpi
              value={fmtUsd(data.totals.cost_usd)}
              label="Обработка"
              delta={deltaCost(data.totals.cost_usd, data.previous.cost_usd)}
            />
          </div>
          <p className="muted" style={{ marginTop: 10 }}>
            Сравнение с периодом {data.prev_date_from} — {data.prev_date_to}. Чистой
            речи разобрано: {fmtDur(data.totals.speech_seconds)}.
          </p>

          {data.totals.shifts === 0 ? (
            <div className="section">
              <Empty title="За этот период смен нет">
                Выберите другой период или снимите фильтр по менеджеру.
              </Empty>
            </div>
          ) : (
            <>
              <div className="section">
                <div className="section-head">
                  <h3>Динамика по дням</h3>
                  <span className="count">
                    каждый показатель на своей шкале — общей оси у них быть не может
                  </span>
                </div>
                <div className="charts">
                  {panels.map((p) => (
                    <TrendChart
                      key={p.key}
                      title={p.title}
                      points={p.points}
                      max={p.max}
                      format={p.format}
                    />
                  ))}
                </div>
              </div>

              <div className="section">
                <div className="section-head">
                  <h3>Менеджеры</h3>
                  <span className="count">оценки — среднее за период, стрелка — к прошлому</span>
                </div>
                <div className="sheet table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Менеджер</th>
                        <th className="num-col">Смен</th>
                        <th className="num-col">Разговоров</th>
                        <th className="num-col">Продаж</th>
                        <th className="num-col">Конверсия</th>
                        <th>Метрики</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.employees.map((row) => (
                        <tr key={row.employee_id ?? "none"}>
                          <td>
                            <strong>{row.full_name}</strong>
                          </td>
                          <td className="num-col">{row.totals.shifts}</td>
                          <td className="num-col">{row.totals.dialogs}</td>
                          <td className="num-col">{row.totals.sales}</td>
                          <td className="num-col">
                            {row.totals.conversion != null
                              ? `${Math.round(row.totals.conversion * 100)}%`
                              : "—"}
                          </td>
                          <td>
                            <div className="metric-lines">
                              {row.metrics.length === 0 && (
                                <span className="score-empty">метрики не срабатывали</span>
                              )}
                              {row.metrics.map((m) => (
                                <MetricLine key={m.metric_id} metric={m} />
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="section">
                <div className="section-head">
                  <h3>Метрики за период</h3>
                </div>
                <div className="sheet table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Метрика</th>
                        <th className="num-col">Срабатываний</th>
                        <th>Средняя оценка</th>
                        <th className="num-col">К прошлому периоду</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.metrics.map((m) => (
                        <tr key={m.metric_id}>
                          <td>
                            <strong>{m.name}</strong>
                          </td>
                          <td className="num-col">{m.triggered_count}</td>
                          <td style={{ width: "40%" }}>
                            {m.avg_score != null ? (
                              <span className="score">
                                <span className={`score-val ${scoreZone(m.avg_score, m.scale_max)}`}>
                                  {m.avg_score}
                                  <span className="of">/{m.scale_max}</span>
                                </span>
                                <ScoreBar score={m.avg_score} scale={m.scale_max} />
                              </span>
                            ) : (
                              <span className="score-empty">не срабатывала</span>
                            )}
                          </td>
                          <td className="num-col">
                            <Delta value={scoreDelta(m)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* --- Дельты ------------------------------------------------------------- */

/** Направление и оценка — разные вещи, и путать их нельзя. Стрелка всегда
 *  показывает, куда сдвинулось число; цвет — хорошо это или плохо. У расходов
 *  они расходятся: снижение затрат — стрелка вниз, но зелёная. */
type DeltaValue = {
  text: string;
  dir: "up" | "down" | "flat";
  good: boolean | null;
} | null;

function direction(diff: number, epsilon = 0): "up" | "down" | "flat" {
  if (Math.abs(diff) <= epsilon) return "flat";
  return diff > 0 ? "up" : "down";
}

/** Разница в процентных пунктах: конверсию сравнивают так, а не «на сколько
 *  процентов выросли проценты». */
function deltaPercent(current: number | null, prev: number | null): DeltaValue {
  if (current == null || prev == null) return null;
  const diff = Math.round((current - prev) * 100);
  const dir = direction(diff);
  if (dir === "flat") return { text: "без изменений", dir, good: null };
  return { text: `${diff > 0 ? "+" : ""}${diff} п.п.`, dir, good: diff > 0 };
}

function deltaCount(current: number, prev: number): DeltaValue {
  if (!prev) return null;
  const diff = current - prev;
  const dir = direction(diff);
  if (dir === "flat") return { text: "без изменений", dir, good: null };
  return { text: `${diff > 0 ? "+" : ""}${diff}`, dir, good: diff > 0 };
}

/** Рост расходов — не достижение: стрелка вверх, но красная. */
function deltaCost(current: number, prev: number): DeltaValue {
  if (!prev) return null;
  const diff = current - prev;
  const dir = direction(diff, 0.0005);
  if (dir === "flat") return { text: "без изменений", dir, good: null };
  return {
    text: `${diff > 0 ? "+" : "−"}${fmtUsd(Math.abs(diff))}`,
    dir,
    good: diff < 0,
  };
}

function scoreDelta(m: MetricPeriodStat): DeltaValue {
  if (m.avg_score == null || m.prev_avg_score == null) return null;
  const diff = Math.round((m.avg_score - m.prev_avg_score) * 10) / 10;
  const dir = direction(diff);
  if (dir === "flat") return { text: "без изменений", dir, good: null };
  return { text: `${diff > 0 ? "+" : ""}${diff.toFixed(1)}`, dir, good: diff > 0 };
}

const ARROW = { up: "↑ ", down: "↓ ", flat: "" };

function Delta({ value }: { value: DeltaValue }) {
  if (!value) return <span className="delta none">—</span>;
  const tone = value.good == null ? "flat" : value.good ? "up" : "down";
  return (
    <span className={`delta ${tone}`}>
      {ARROW[value.dir]}
      {value.text}
    </span>
  );
}

function Kpi({
  value,
  label,
  delta,
  lead,
}: {
  value: string;
  label: string;
  delta: DeltaValue;
  lead?: boolean;
}) {
  return (
    <div className={`stat ${lead ? "lead" : ""}`}>
      <div className="v display">{value}</div>
      <div className="label">{label}</div>
      <Delta value={delta} />
    </div>
  );
}

function MetricLine({ metric }: { metric: MetricPeriodStat }) {
  return (
    <div className="metric-line compact">
      {metric.avg_score != null ? (
        <span className="score">
          <span className={`score-val ${scoreZone(metric.avg_score, metric.scale_max)}`}>
            {metric.avg_score}
            <span className="of">/{metric.scale_max}</span>
          </span>
          <ScoreBar score={metric.avg_score} scale={metric.scale_max} />
        </span>
      ) : (
        <span className="score-empty">—</span>
      )}
      <span className="metric-name">
        {metric.name}
        <Delta value={scoreDelta(metric)} />
      </span>
    </div>
  );
}
