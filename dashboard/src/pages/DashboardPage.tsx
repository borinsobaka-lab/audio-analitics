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
  fmtDate,
  fmtDur,
  fmtUsd,
  MetricPeriodStat,
  plural,
  Summary,
  toApiDate,
} from "../api";
import { TrendChart } from "../components/TrendChart";
import {
  DateField,
  Delta,
  DeltaValue,
  Empty,
  MetricLine,
  Note,
  PageHead,
  Score,
  Section,
  Skeleton,
  Stat,
  TableCard,
} from "../components/ui";

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
        <div className="filter">
          <span className="label">период</span>
          {/* Две даты — один период, поэтому они стоят в общей оправе. */}
          <div className="range">
            <DateField
              value={range[0]}
              max={range[1]}
              onChange={(v) => setCustom(0, v)}
              aria-label="Начало периода"
            />
            <span className="range-dash">—</span>
            <DateField
              value={range[1]}
              min={range[0]}
              onChange={(v) => setCustom(1, v)}
              aria-label="Конец периода"
            />
          </div>
        </div>
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
            <Stat
              lead
              value={data.totals.conversion != null ? `${Math.round(data.totals.conversion * 100)}%` : "—"}
              label="Конверсия"
              delta={deltaPercent(data.totals.conversion, data.previous.conversion)}
            />
            <Stat
              value={String(data.totals.shifts)}
              label={plural(data.totals.shifts, "смена", "смены", "смен")}
              delta={deltaCount(data.totals.shifts, data.previous.shifts)}
            />
            <Stat
              value={String(data.totals.dialogs)}
              label="Разговоров"
              delta={deltaCount(data.totals.dialogs, data.previous.dialogs)}
            />
            <Stat
              value={String(data.totals.sales)}
              label="Продаж"
              delta={deltaCount(data.totals.sales, data.previous.sales)}
            />
            <Stat
              value={fmtUsd(data.totals.cost_usd)}
              label="Обработка"
              delta={deltaCost(data.totals.cost_usd, data.previous.cost_usd)}
            />
          </div>
          <p className="muted dashboard-note">
            Сравнение с периодом {fmtDate(data.prev_date_from).day} —{" "}
            {fmtDate(data.prev_date_to).day}. Чистой речи разобрано:{" "}
            {fmtDur(data.totals.speech_seconds)}.
          </p>

          {data.totals.shifts === 0 ? (
            <Section>
              <Empty title="За этот период смен нет">
                Выберите другой период или снимите фильтр по менеджеру.
              </Empty>
            </Section>
          ) : (
            <>
              <Section
                title="Динамика по дням"
                hint="каждый показатель на своей шкале — общей оси у них быть не может"
              >
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
              </Section>

              <Section
                title="Менеджеры"
                hint="оценки — среднее за период, стрелка — к прошлому"
              >
                <TableCard
                  columns={[
                    { label: "Менеджер" },
                    { label: "Смен", num: true },
                    { label: "Разговоров", num: true },
                    { label: "Продаж", num: true },
                    { label: "Конверсия", num: true },
                    { label: "Метрики" },
                  ]}
                >
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
                            <MetricLine
                              key={m.metric_id}
                              name={m.name}
                              score={m.avg_score}
                              scale={m.scale_max}
                              delta={scoreDelta(m)}
                              tone
                              compact
                              emptyLabel="—"
                            />
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </TableCard>
              </Section>

              <Section title="Метрики за период">
                <TableCard
                  columns={[
                    { label: "Метрика" },
                    { label: "Срабатываний", num: true },
                    { label: "Средняя оценка", className: "col-score" },
                    { label: "К прошлому периоду", num: true },
                  ]}
                >
                  {data.metrics.map((m) => (
                    <tr key={m.metric_id}>
                      <td>
                        <strong>{m.name}</strong>
                      </td>
                      <td className="num-col">{m.triggered_count}</td>
                      <td className="col-score">
                        {m.avg_score != null ? (
                          <Score score={m.avg_score} scale={m.scale_max} tone />
                        ) : (
                          <span className="score-empty">не срабатывала</span>
                        )}
                      </td>
                      <td className="num-col">
                        <Delta value={scoreDelta(m)} />
                      </td>
                    </tr>
                  ))}
                </TableCard>
              </Section>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* --- Дельты ------------------------------------------------------------- */

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
