/** Статистика CRM по менеджерам за период.
 *
 *  Разбор дня говорит «что было вчера»; здесь видно, кто из администраторов
 *  системно теряет клиентов в переписке и в какую сторону это движется: каждый
 *  показатель стоит рядом со значением за предыдущий период такой же длины,
 *  как на дашборде аналитики.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { addDays, api, CrmCriterionStat, CrmStats, fmtDate, fmtUsd, plural, toApiDate } from "../api";
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
import { categoryLabel, fmtMinutes } from "../crm/labels";
import { useSession } from "../session";

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

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export default function CrmStatsPage() {
  const me = useSession();
  const [preset, setPreset] = useState("30");
  const [range, setRange] = useState<[string, string]>(() => {
    const [a, b] = PRESETS[1].range();
    return [toApiDate(a), toApiDate(b)];
  });
  const [data, setData] = useState<CrmStats | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setData(null);
    api
      .crmStats({ date_from: range[0], date_to: range[1] })
      .then((s) => {
        setData(s);
        setError("");
      })
      .catch((e) => setError(String(e).replace(/^Error:\s*/, "")));
  }, [range]);

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

  const panels = useMemo(() => {
    if (!data) return [];
    const list = [
      {
        key: "problems",
        title: "Доля сделок с замечаниями",
        max: 100,
        format: (v: number) => `${Math.round(v)}%`,
        points: data.trend.map((t) => ({
          date: t.date,
          value: t.problem_share == null ? null : t.problem_share * 100,
        })),
      },
    ];
    for (const c of data.criteria) {
      list.push({
        key: c.criterion_id,
        title: c.name,
        max: c.scale_max,
        format: (v: number) => `${v.toFixed(1)} из ${c.scale_max}`,
        points: data.trend.map((t) => ({ date: t.date, value: t.avg_scores[c.criterion_id] ?? null })),
      });
    }
    return list;
  }, [data]);

  return (
    <div>
      <PageHead
        title="Статистика CRM"
        hint={
          me.can_view_all_crm
            ? "По каждому администратору: сколько сделок вёл, в скольких были замечания, как быстро отвечал и как оценён по критериям — рядом со значениями за предыдущий период."
            : "Ваши сделки за период: сколько с замечаниями, как быстро отвечали клиентам и оценки по критериям — рядом с предыдущим периодом."
        }
      />

      <div className="filters">
        <div className="seg">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className={`seg-btn ${preset === p.key ? "on" : ""}`} onClick={() => applyPreset(p)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="filter">
          <span className="label">период</span>
          <div className="range">
            <DateField value={range[0]} max={range[1]} onChange={(v) => setCustom(0, v)} aria-label="Начало периода" />
            <span className="range-dash">—</span>
            <DateField value={range[1]} min={range[0]} onChange={(v) => setCustom(1, v)} aria-label="Конец периода" />
          </div>
        </div>
      </div>

      {error && <Note kind="error">{error}</Note>}
      {!data && !error && <Skeleton count={2} height={110} />}

      {data && (
        <>
          <div className="stats">
            <Stat
              lead
              value={pct(data.totals.problem_share)}
              label="сделок с замечаниями"
              delta={deltaShare(data.totals.problem_share, data.previous.problem_share)}
            />
            <Stat
              value={String(data.totals.deals)}
              label={plural(data.totals.deals, "сделка разобрана", "сделки разобраны", "сделок разобрано")}
              delta={deltaCount(data.totals.deals, data.previous.deals, null)}
            />
            <Stat
              value={String(data.totals.critical)}
              label="Критичных"
              delta={deltaCount(data.totals.critical, data.previous.critical, false)}
            />
            <Stat
              value={String(data.totals.unanswered)}
              label="Без ответа клиенту"
              delta={deltaCount(data.totals.unanswered, data.previous.unanswered, false)}
            />
            <Stat
              value={fmtMinutes(data.totals.avg_first_reply_minutes)}
              label="Ответ клиенту в среднем"
              delta={deltaMinutes(data.totals.avg_first_reply_minutes, data.previous.avg_first_reply_minutes)}
            />
            {me.can_manage_crm && (
              <Stat
                value={fmtUsd(data.totals.cost_usd)}
                label={`Обработка · ${data.totals.runs} ${plural(data.totals.runs, "день", "дня", "дней")}`}
                delta={deltaCost(data.totals.cost_usd, data.previous.cost_usd)}
              />
            )}
          </div>
          <p className="muted dashboard-note">
            Сравнение с периодом {fmtDate(data.prev_date_from).day} — {fmtDate(data.prev_date_to).day}.
          </p>

          {data.totals.deals === 0 ? (
            <Section>
              <Empty title="За этот период разборов нет">Выберите другой период или разберите дни в «Разборах».</Empty>
            </Section>
          ) : (
            <>
              <Section title="Динамика по дням" hint="каждый показатель на своей шкале">
                <div className="charts">
                  {panels.map((p) => (
                    <TrendChart key={p.key} title={p.title} points={p.points} max={p.max} format={p.format} />
                  ))}
                </div>
              </Section>

              <Section title="Администраторы" hint="оценки — среднее за период, стрелка — к прошлому">
                <TableCard
                  columns={[
                    { label: "Администратор" },
                    { label: "Сделок", num: true },
                    { label: "С замечаниями", num: true },
                    { label: "Критичных", num: true },
                    { label: "Без ответа", num: true },
                    { label: "Ответ", num: true },
                    { label: "Критерии" },
                  ]}
                >
                  {data.managers.map((m) => (
                    <tr key={m.employee_id ?? `crm:${m.manager_key}`}>
                      <td>
                        <strong>{m.name}</strong>
                        {!m.employee_id && me.can_manage_crm && (
                          <span className="muted crm-unmapped" title="Этот менеджер CRM не сопоставлен сотруднику админки — настройки → интеграция">
                            {" "}
                            · не сопоставлен
                          </span>
                        )}
                      </td>
                      <td className="num-col">{m.totals.deals}</td>
                      <td className="num-col">
                        {m.totals.problems} <span className="muted">({pct(m.totals.problem_share)})</span>
                        <Delta value={deltaShare(m.totals.problem_share, m.previous.problem_share)} />
                      </td>
                      <td className="num-col">{m.totals.critical}</td>
                      <td className="num-col">{m.totals.unanswered}</td>
                      <td className="num-col">{fmtMinutes(m.totals.avg_first_reply_minutes)}</td>
                      <td>
                        <div className="metric-lines">
                          {m.criteria.length === 0 && <span className="score-empty">—</span>}
                          {m.criteria.map((c) => (
                            <MetricLine
                              key={c.criterion_id}
                              name={c.name}
                              score={c.avg_score}
                              scale={c.scale_max}
                              delta={scoreDelta(c)}
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

              {data.criteria.length > 0 && (
                <Section title="Критерии за период">
                  <TableCard
                    columns={[
                      { label: "Критерий" },
                      { label: "Оценок", num: true },
                      { label: "Средняя оценка", className: "col-score" },
                      { label: "К прошлому периоду", num: true },
                    ]}
                  >
                    {data.criteria.map((c) => (
                      <tr key={c.criterion_id}>
                        <td>
                          <strong>{c.name}</strong>
                        </td>
                        <td className="num-col">{c.count}</td>
                        <td className="col-score">
                          {c.avg_score != null ? <Score score={c.avg_score} scale={c.scale_max} /> : <span className="score-empty">не применялся</span>}
                        </td>
                        <td className="num-col">
                          <Delta value={scoreDelta(c)} />
                        </td>
                      </tr>
                    ))}
                  </TableCard>
                </Section>
              )}

              <Section title="О чём переписки" hint="класс разговора за день и сколько из них с замечаниями">
                <TableCard columns={[{ label: "Переписка" }, { label: "Сделок", num: true }, { label: "С замечаниями", num: true }]}>
                  {data.categories.map((c) => (
                    <tr key={c.category}>
                      <td>{categoryLabel(c.category)}</td>
                      <td className="num-col">{c.count}</td>
                      <td className="num-col">
                        {c.problems} <span className="muted">({pct(c.count ? c.problems / c.count : null)})</span>
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

/* --- Дельты: направление и оценка — разные каналы ----------------------- */

function direction(diff: number, epsilon = 0): "up" | "down" | "flat" {
  if (Math.abs(diff) <= epsilon) return "flat";
  return diff > 0 ? "up" : "down";
}

/** Доля проблемных сделок: рост — плохо. */
function deltaShare(current: number | null, prev: number | null): DeltaValue {
  if (current == null || prev == null) return null;
  const diff = Math.round((current - prev) * 100);
  const dir = direction(diff);
  if (dir === "flat") return { text: "без изменений", dir, good: null };
  return { text: `${diff > 0 ? "+" : ""}${diff} п.п.`, dir, good: diff < 0 };
}

/** goodWhenUp: true — рост хорош, false — плох, null — просто число. */
function deltaCount(current: number, prev: number, goodWhenUp: boolean | null): DeltaValue {
  if (!prev && !current) return null;
  const diff = current - prev;
  const dir = direction(diff);
  if (dir === "flat") return { text: "без изменений", dir, good: null };
  return { text: `${diff > 0 ? "+" : ""}${diff}`, dir, good: goodWhenUp == null ? null : diff > 0 === goodWhenUp };
}

function deltaMinutes(current: number | null, prev: number | null): DeltaValue {
  if (current == null || prev == null) return null;
  const diff = Math.round(current - prev);
  const dir = direction(diff);
  if (dir === "flat") return { text: "без изменений", dir, good: null };
  return { text: `${diff > 0 ? "+" : "−"}${fmtMinutes(Math.abs(diff))}`, dir, good: diff < 0 };
}

function deltaCost(current: number, prev: number): DeltaValue {
  if (!prev) return null;
  const diff = current - prev;
  const dir = direction(diff, 0.0005);
  if (dir === "flat") return { text: "без изменений", dir, good: null };
  return { text: `${diff > 0 ? "+" : "−"}${fmtUsd(Math.abs(diff))}`, dir, good: diff < 0 };
}

function scoreDelta(c: CrmCriterionStat): DeltaValue {
  if (c.avg_score == null || c.prev_avg_score == null) return null;
  const diff = Math.round((c.avg_score - c.prev_avg_score) * 10) / 10;
  const dir = direction(diff);
  if (dir === "flat") return { text: "без изменений", dir, good: null };
  return { text: `${diff > 0 ? "+" : ""}${diff.toFixed(1)}`, dir, good: diff > 0 };
}
