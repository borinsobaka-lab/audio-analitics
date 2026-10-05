/** Звонки: как проходят звонки по сценарию.
 *
 *  Каждый звонок, который администратор ведёт по разделу-звонку в
 *  «Скриптах», пишется по ходу разговора: какие этапы прошёл, что отвечал
 *  клиент, чем закончилось. Здесь это складывается в ответы на вопросы:
 *  - сколько звонков и с каким итогом — у всех или у одного администратора;
 *  - воронка: до какого этапа доходят звонки и на каком обрываются без
 *    записи — это и есть место, где «отваливаются» клиенты;
 *  - возражения: какие звучат чаще и записываются ли после них;
 *  - администраторы: у кого конверсия выше и докуда кто доводит разговор;
 *  - что отвечают клиенты на этапах (чего хотят, какую студию выбирают);
 *  - журнал: сами звонки, чтобы провалиться из цифры в конкретный разговор.
 *
 *  Все числа видны текстом — полосы и цвета только помогают глазу.
 */
import { Fragment, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addDays,
  api,
  CallEndStat,
  CallFunnelStep,
  CallOutcome,
  CallRun,
  CallStats,
  CallStatsQuery,
  CallUserStat,
  fmtWhen,
  OUTCOME_LABELS,
  plural,
  toApiDate,
} from "../api";
import { usePaged } from "../scripts/paged";
import { useSession } from "../session";
import { DateField, Empty, Note, PageHead, Section, Skeleton, Stat } from "../components/ui";

/* --- Период -------------------------------------------------------------- */

const today = () => new Date();
const PRESETS = [
  { key: "today", label: "Сегодня", range: () => [today(), today()] },
  { key: "7", label: "7 дней", range: () => [addDays(today(), -6), today()] },
  { key: "30", label: "30 дней", range: () => [addDays(today(), -29), today()] },
  {
    key: "month",
    label: "Этот месяц",
    range: () => [new Date(today().getFullYear(), today().getMonth(), 1), today()],
  },
] as const;

/** Начало дня по часам браузера (тбилисское время) — в ISO для сервера. */
function dayStart(value: string, shift = 0): string {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d + shift).toISOString();
}

/* --- Форматирование ------------------------------------------------------ */

function pct(part: number, whole: number): string {
  if (!whole) return "—";
  const v = (part / whole) * 100;
  return `${v < 10 && v > 0 ? v.toFixed(1).replace(".", ",") : Math.round(v)}%`;
}

function share(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

/** Длительность звонка: «2 мин 15 с», «40 с». */
function dur(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} мин ${rest} с` : `${m} мин`;
}

function steps(v: number | null): string {
  return v == null ? "—" : v.toFixed(1).replace(".", ",");
}

/* --- Подсказка при наведении --------------------------------------------- */

/** Одна подсказка на страницу: у курсора при наведении, у элемента — при
 *  фокусе с клавиатуры. Подсказка дополняет, а не заменяет: все числа и
 *  так видны в строке. */
function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  const bind = useCallback(
    (body: ReactNode) => ({
      onMouseMove: (e: React.MouseEvent) => setTip({ x: e.clientX, y: e.clientY, body }),
      onMouseLeave: () => setTip(null),
      onFocus: (e: React.FocusEvent) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setTip({ x: r.left + Math.min(r.width / 2, 160), y: r.top, body });
      },
      onBlur: () => setTip(null),
    }),
    []
  );
  const node = tip && (
    <div
      className="chart-tip"
      role="tooltip"
      style={{
        left: Math.min(tip.x + 14, window.innerWidth - 260),
        top: Math.max(tip.y - 12, 8),
      }}
    >
      {tip.body}
    </div>
  );
  return { bind, node };
}

/* --- Страница ------------------------------------------------------------ */

export default function CallsPage() {
  const me = useSession();
  const [preset, setPreset] = useState<string>("30");
  const [range, setRange] = useState<[string, string]>(() => {
    const [a, b] = PRESETS[2].range();
    return [toApiDate(a), toApiDate(b)];
  });
  const [section, setSection] = useState("");
  const [user, setUser] = useState("");
  const [data, setData] = useState<CallStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Имена выбранных раньше — чтобы выбранный не пропал из списка, если в
  // новом периоде он не звонил.
  const [knownUsers, setKnownUsers] = useState<Record<string, string>>({});
  const { bind, node: tipNode } = useTip();

  const q: CallStatsQuery = useMemo(
    () => ({
      from: range[0] ? dayStart(range[0]) : "",
      to: range[1] ? dayStart(range[1], 1) : "",
      section,
      user,
    }),
    [range, section, user]
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    api
      .callStats(q)
      .then((res) => {
        if (!alive) return;
        setData(res);
        setKnownUsers((known) => {
          const next = { ...known };
          for (const u of res.users) next[u.user_key] = u.name;
          return next;
        });
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [q]);

  // Фильтр журнала: звонки, оборвавшиеся на этом блоке.
  const [dropAt, setDropAt] = useState<{ id: string; title: string } | null>(null);
  const journalRef = useRef<HTMLDivElement>(null);
  const showDrops = (id: string, title: string) => {
    setDropAt({ id, title });
    requestAnimationFrame(() => journalRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  useEffect(() => setDropAt(null), [q]);

  const applyPreset = (key: string) => {
    const p = PRESETS.find((x) => x.key === key)!;
    const [a, b] = p.range();
    setPreset(key);
    setRange([toApiDate(a), toApiDate(b)]);
  };
  const setCustom = (index: 0 | 1, value: string) => {
    if (!value) return;
    setPreset("custom");
    setRange((r) => (index === 0 ? [value, r[1]] : [r[0], value]));
  };

  const activeSection = data?.sections.find((s) => s.id === data.section_id);
  const userName = user ? knownUsers[user] || "сотрудник" : "";
  const changedInPeriod =
    data?.flow_changed_at && range[0] && new Date(data.flow_changed_at) >= new Date(dayStart(range[0]));

  return (
    <div className="calls">
      <PageHead
        title="Звонки"
        hint="Звонки по сценарию из «Скриптов»: до какого этапа доходит разговор, где клиенты отваливаются и как звонит каждый администратор."
      />

      <div className="filters">
        <div className="seg" role="group" aria-label="Период">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className={`seg-btn ${preset === p.key ? "on" : ""}`}
              onClick={() => applyPreset(p.key)}>
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
        {data && data.sections.length > 1 && (
          <label className="filter">
            <span className="label">сценарий</span>
            <select value={data.section_id ?? ""} onChange={(e) => setSection(e.target.value)}>
              {data.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                  {s.deleted ? " (удалён)" : ""} · {s.runs}
                </option>
              ))}
            </select>
          </label>
        )}
        {me.can_view_all && (
          <label className="filter">
            <span className="label">администратор</span>
            <select value={user} onChange={(e) => setUser(e.target.value)}>
              <option value="">все</option>
              {Object.entries(knownUsers)
                .sort((a, b) => a[1].localeCompare(b[1], "ru"))
                .map(([key, name]) => (
                  <option key={key} value={key}>
                    {name || key}
                  </option>
                ))}
            </select>
          </label>
        )}
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
          {changedInPeriod && (
            <p className="calls-note muted">
              Сценарий «{activeSection?.title}» меняли {fmtWhen(data.flow_changed_at)} — звонки до и после
              правки шли по разным текстам.
            </p>
          )}

          {data.totals.runs === 0 ? (
            <Empty title={`За этот период звонков нет${userName ? ` у ${userName}` : ""}`}>
              Звонок попадает сюда, когда администратор отвечает на первом шаге сценария в «Скриптах».
            </Empty>
          ) : (
            <>
              <Totals data={data} userName={userName} />
              <Outcomes data={data} bind={bind} />
              <Funnel data={data} bind={bind} onDrops={showDrops} />
              <Ends ends={data.ends} total={data.totals.runs - data.totals.no_answer} bind={bind} onDrops={showDrops} />
              <Objections data={data} />
              {me.can_view_all && data.users.length > 0 && (
                <>
                  <Admins users={data.users} selected={user} onPick={setUser} />
                  {data.users.length > 1 && <Reach data={data} bind={bind} selected={user} />}
                </>
              )}
              <Answers funnel={data.funnel} />
            </>
          )}

          <div ref={journalRef}>
            <Journal q={{ ...q, section: data.section_id ?? "" }} dropAt={dropAt} onClearDrop={() => setDropAt(null)} />
          </div>
        </div>
      )}
      {tipNode}
    </div>
  );
}

type Bind = ReturnType<typeof useTip>["bind"];

/* --- Итоги --------------------------------------------------------------- */

function Totals({ data, userName }: { data: CallStats; userName: string }) {
  const t = data.totals;
  const connected = t.runs - t.live - t.no_answer;
  return (
    <div className="stats calls-stats">
      <Stat
        lead
        value={share(t.conversion)}
        label={`Записались${userName ? ` · ${userName}` : ""}`}
        title="Записались на пробное из всех, до кого дозвонились"
      />
      <Stat value={t.runs} label={plural(t.runs, "звонок", "звонка", "звонков")} />
      <Stat value={t.booked} label={`${plural(t.booked, "запись", "записи", "записей")} из ${connected} дозвонов`} />
      <Stat value={dur(t.avg_seconds)} label="Средняя длительность" />
      <Stat value={steps(t.avg_steps)} label="Шагов сценария в среднем" />
    </div>
  );
}

/* --- Итоги звонков: одна полоса из частей --------------------------------- */

const OUTCOME_ORDER: { key: keyof CallStats["totals"]; label: string; cls: string }[] = [
  { key: "booked", label: OUTCOME_LABELS.booked, cls: "booked" },
  { key: "callback", label: OUTCOME_LABELS.callback, cls: "callback" },
  { key: "refused", label: OUTCOME_LABELS.refused, cls: "refused" },
  { key: "no_answer", label: OUTCOME_LABELS.no_answer, cls: "no_answer" },
  { key: "no_outcome", label: "Без итога", cls: "none" },
  { key: "live", label: "Идут сейчас", cls: "live" },
];

function Outcomes({ data, bind }: { data: CallStats; bind: Bind }) {
  const t = data.totals;
  const parts = OUTCOME_ORDER.map((o) => ({ ...o, value: Number(t[o.key]) || 0 })).filter((p) => p.value);
  return (
    <Section title="Чем заканчиваются звонки" hint="«Без итога» — бросили на середине и итог не отметили">
      <div className="sheet sheet-pad">
        <div className="outcome-bar" role="img" aria-label={parts.map((p) => `${p.label}: ${p.value}`).join(", ")}>
          {parts.map((p) => (
            <span key={p.cls} tabIndex={0} className={`outcome-seg outcome-${p.cls}`}
              style={{ flexGrow: p.value }}
              {...bind(
                <>
                  <strong>{p.label}</strong>
                  <span>{p.value} {plural(p.value, "звонок", "звонка", "звонков")} · {pct(p.value, t.runs)}</span>
                </>
              )} />
          ))}
        </div>
        <ul className="outcome-legend">
          {parts.map((p) => (
            <li key={p.cls}>
              <span className={`outcome-dot outcome-${p.cls}`} aria-hidden="true" />
              <span className="outcome-name">{p.label}</span>
              <span className="num">{p.value}</span>
              <span className="muted num">{pct(p.value, t.runs)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

/* --- Воронка ------------------------------------------------------------- */

function Funnel({
  data,
  bind,
  onDrops,
}: {
  data: CallStats;
  bind: Bind;
  onDrops: (id: string, title: string) => void;
}) {
  const [open, setOpen] = useState("");
  // Доли — от дозвонившихся: «не дозвонились» в воронку не идёт.
  const total = data.totals.runs - data.totals.no_answer;
  const worst = data.funnel.reduce<CallFunnelStep | null>(
    (w, s) => (s.ended_here && (!w || s.ended_here > w.ended_here) ? s : w),
    null
  );
  if (!data.funnel.length) return null;
  return (
    <Section
      title="Воронка по этапам"
      hint={`из ${total} ${plural(total, "разговора", "разговоров", "разговоров")} — сколько дошли до этапа и сколько на нём оборвались без записи · нажмите этап — ответы клиентов`}
    >
      <div className="sheet table-wrap">
        <table className="funnel">
          <thead>
            <tr>
              <th scope="col" className="funnel-n">#</th>
              <th scope="col">Этап</th>
              <th scope="col" className="funnel-bar-col">Доля дошедших</th>
              <th scope="col" className="num-col">Дошли</th>
              <th scope="col" className="num-col">Оборвались здесь</th>
              <th scope="col" className="num-col">Время на этапе</th>
            </tr>
          </thead>
          <tbody>
            {data.funnel.map((s, i) => {
              const prev = i ? data.funnel[i - 1].reached : total;
              const isOpen = open === s.node_id;
              const isWorst = worst?.node_id === s.node_id;
              return (
                <Fragment key={s.node_id}>
                  <tr
                    className={`funnel-row${isOpen ? " open" : ""}${s.reached ? "" : " empty"}`}
                    tabIndex={0}
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? "" : s.node_id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpen(isOpen ? "" : s.node_id);
                      }
                    }}
                    {...bind(
                      <>
                        <strong>{s.title}</strong>
                        <span>Дошли: {s.reached} из {total} ({pct(s.reached, total)})</span>
                        {i > 0 && <span>От предыдущего этапа: {pct(s.reached, prev)}</span>}
                        <span>Оборвались здесь без записи: {s.ended_here}</span>
                        {s.median_seconds != null && <span>Обычно на этапе: {dur(s.median_seconds)}</span>}
                      </>
                    )}
                  >
                    <td className="funnel-n num muted">{i + 1}</td>
                    <td className="funnel-title">
                      <span className="funnel-caret" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                      {s.title}
                    </td>
                    <td className="funnel-bar-col">
                      <div className="funnel-bar-wrap">
                        <span className="funnel-track">
                          <span className="funnel-bar" style={{ width: `${total ? (s.reached / total) * 100 : 0}%` }} />
                        </span>
                        <span className="funnel-pct num">{pct(s.reached, total)}</span>
                      </div>
                    </td>
                    <td className="num-col funnel-reached" data-label="дошли">{s.reached}</td>
                    <td className={`num-col funnel-ended${isWorst ? " funnel-worst" : ""}`} data-label="оборвались">
                      {s.ended_here ? (
                        <>
                          {isWorst && <span className="funnel-worst-tag">больше всего</span>}
                          {s.ended_here}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num-col muted funnel-time" data-label="на этапе">{dur(s.median_seconds)}</td>
                  </tr>
                  {isOpen && (
                    <tr className="funnel-detail">
                      <td />
                      <td colSpan={5}>
                        <StepDetail step={s} onDrops={onDrops} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function StepDetail({ step, onDrops }: { step: CallFunnelStep; onDrops: (id: string, title: string) => void }) {
  const total = step.answers.reduce((n, a) => n + a.count, 0);
  return (
    <div className="step-detail">
      {step.answers.length ? (
        <AnswerBars answers={step.answers} total={total} />
      ) : (
        <p className="muted">Ответов клиента на этом этапе не отмечали.</p>
      )}
      {step.ended_here > 0 && (
        <button type="button" className="secondary small" onClick={() => onDrops(step.node_id, step.title)}>
          Звонки, оборвавшиеся здесь · {step.ended_here}
        </button>
      )}
    </div>
  );
}

function AnswerBars({ answers, total }: { answers: { label: string; count: number }[]; total: number }) {
  const max = Math.max(1, ...answers.map((a) => a.count));
  return (
    <ul className="answer-bars">
      {answers.map((a) => (
        <li key={a.label}>
          <span className="answer-label">{a.label}</span>
          <span className="answer-track">
            <span className="answer-bar" style={{ width: `${(a.count / max) * 100}%` }} />
          </span>
          <span className="num">{a.count}</span>
          <span className="num muted">{pct(a.count, total)}</span>
        </li>
      ))}
    </ul>
  );
}

/* --- Где обрываются ------------------------------------------------------ */

function endBreakdown(e: CallEndStat): string {
  return [
    e.refused && `отказ ${e.refused}`,
    e.callback && `перезвонить ${e.callback}`,
    e.no_outcome && `без итога ${e.no_outcome}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Ends({
  ends,
  total,
  bind,
  onDrops,
}: {
  ends: CallEndStat[];
  total: number;
  bind: Bind;
  onDrops: (id: string, title: string) => void;
}) {
  if (!ends.length) return null;
  const max = Math.max(1, ...ends.map((e) => e.count));
  const shown = ends.slice(0, 10);
  return (
    <Section title="Где обрываются звонки без записи" hint="последний блок разговора — включая возражения · нажмите, чтобы открыть звонки">
      <div className="sheet ends">
        {shown.map((e) => (
          <button key={e.node_id} type="button" className="end-row" onClick={() => onDrops(e.node_id, e.title)}
            {...bind(
              <>
                <strong>{e.title}</strong>
                <span>{e.count} {plural(e.count, "разговор", "разговора", "разговоров")} · {pct(e.count, total)} всех</span>
                <span>{endBreakdown(e)}</span>
              </>
            )}>
            <span className="end-title">
              {e.title}
              {e.group === "objection" && <span className="call-tag">Возражение</span>}
            </span>
            <span className="end-track">
              <span className="end-bar" style={{ width: `${(e.count / max) * 100}%` }} />
            </span>
            <span className="num end-count">{e.count}</span>
            <span className="end-why muted">{endBreakdown(e)}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

/* --- Возражения ---------------------------------------------------------- */

function Objections({ data }: { data: CallStats }) {
  const list = data.objections.filter((o) => o.runs);
  if (!list.length) return null;
  const total = data.totals.runs - data.totals.no_answer;
  return (
    <Section title="Возражения" hint={`записались после возражения — сравните с общей конверсией ${share(data.totals.conversion)}`}>
      <div className="sheet table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Возражение</th>
              <th scope="col" className="num-col">Звучало</th>
              <th scope="col" className="num-col">Доля разговоров</th>
              <th scope="col" className="num-col">Записались после</th>
              <th scope="col" className="num-col">Оборвались на нём</th>
            </tr>
          </thead>
          <tbody>
            {list.map((o) => {
              const after = o.runs ? o.booked / o.runs : null;
              const worse = after != null && data.totals.conversion != null && after < data.totals.conversion;
              return (
                <tr key={o.node_id}>
                  <td><strong>{o.title}</strong></td>
                  <td className="num-col">{o.runs}</td>
                  <td className="num-col muted">{pct(o.runs, total)}</td>
                  <td className={`num-col${worse ? " text-bad" : ""}`}>
                    {o.booked} · {share(after)}
                  </td>
                  <td className="num-col">{o.ended_here || <span className="muted">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* --- Администраторы ------------------------------------------------------ */

function Admins({
  users,
  selected,
  onPick,
}: {
  users: CallUserStat[];
  selected: string;
  onPick: (key: string) => void;
}) {
  return (
    <Section title="Администраторы" hint="нажмите строку — вся страница покажет звонки этого администратора">
      <div className="sheet table-wrap">
        <table className="calls-admins">
          <thead>
            <tr>
              <th scope="col">Администратор</th>
              <th scope="col" className="num-col">Звонков</th>
              <th scope="col" className="num-col">Записаны</th>
              <th scope="col" className="num-col">Конверсия</th>
              <th scope="col" className="num-col">Перезвонить</th>
              <th scope="col" className="num-col">Отказ</th>
              <th scope="col" className="num-col">Не дозвон.</th>
              <th scope="col" className="num-col">Без итога</th>
              <th scope="col" className="num-col">Длительность</th>
              <th scope="col" className="num-col">Шагов</th>
              <th scope="col">Чаще обрывается на</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.user_key} className={`row-link${selected === u.user_key ? " on" : ""}`}
                tabIndex={0}
                onClick={() => onPick(selected === u.user_key ? "" : u.user_key)}
                onKeyDown={(e) => e.key === "Enter" && onPick(selected === u.user_key ? "" : u.user_key)}>
                <td><strong>{u.name || u.user_key}</strong></td>
                <td className="num-col">{u.runs}</td>
                <td className="num-col">{u.booked}</td>
                <td className="num-col"><strong>{share(u.conversion)}</strong></td>
                <td className="num-col">{u.callback || "—"}</td>
                <td className="num-col">{u.refused || "—"}</td>
                <td className="num-col">{u.no_answer || "—"}</td>
                <td className="num-col">{u.no_outcome || "—"}</td>
                <td className="num-col">{dur(u.avg_seconds)}</td>
                <td className="num-col">{steps(u.avg_steps)}</td>
                <td>
                  {u.top_drop ? (
                    <>
                      {u.top_drop.title} <span className="muted">· {u.top_drop.count}</span>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** До каких этапов доходят администраторы: этапы — строки, администраторы —
 *  колонки, в клетке — доля его звонков, дошедших до этапа. Один цвет,
 *  насыщеннее — больше; число всегда видно текстом. */
function Reach({ data, bind, selected }: { data: CallStats; bind: Bind; selected: string }) {
  const users = data.users.slice(0, 12);
  return (
    <Section title="До каких этапов доходят администраторы" hint="доля разговоров администратора, дошедших до этапа (без «не дозвонились»)">
      <div className="sheet table-wrap">
        <table className="reach">
          <thead>
            <tr>
              <th scope="col">Этап</th>
              {users.map((u) => (
                <th key={u.user_key} scope="col" className={`reach-user${selected === u.user_key ? " on" : ""}`}>
                  {u.name || u.user_key}
                  <span className="muted num">{u.runs - u.no_answer}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.funnel.map((s) => (
              <tr key={s.node_id}>
                <th scope="row">{s.title}</th>
                {users.map((u) => {
                  const n = u.reach[s.node_id] ?? 0;
                  const base = u.runs - u.no_answer;
                  const v = base ? n / base : 0;
                  return (
                    <td key={u.user_key} className="reach-cell num" tabIndex={0}
                      style={{ "--v": v.toFixed(3) } as React.CSSProperties}
                      {...bind(
                        <>
                          <strong>{u.name}</strong>
                          <span>{s.title}: дошли {n} из {base} ({pct(n, base)})</span>
                        </>
                      )}>
                      {base ? pct(n, base) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* --- Ответы клиентов ----------------------------------------------------- */

function Answers({ funnel }: { funnel: CallFunnelStep[] }) {
  const steps = funnel.filter((s) => new Set(s.answers.map((a) => a.label)).size > 1);
  if (!steps.length) return null;
  return (
    <Section title="Что отвечают клиенты" hint="на этапах с несколькими вариантами ответа — чего хотят и что выбирают">
      <div className="answers-grid">
        {steps.map((s) => {
          const total = s.answers.reduce((n, a) => n + a.count, 0);
          return (
            <div key={s.node_id} className="sheet sheet-pad answers-card">
              <h4 className="answers-title">
                {s.title} <span className="muted num">· {total}</span>
              </h4>
              <AnswerBars answers={s.answers} total={total} />
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/* --- Журнал -------------------------------------------------------------- */

const STATUS_LABEL: Record<CallRun["status"], string> = {
  live: "Идёт сейчас",
  ended: "",
  dropped: "Брошен",
};

const JOURNAL_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "Все" },
  { key: "booked", label: OUTCOME_LABELS.booked },
  { key: "callback", label: OUTCOME_LABELS.callback },
  { key: "refused", label: OUTCOME_LABELS.refused },
  { key: "no_answer", label: OUTCOME_LABELS.no_answer },
  { key: "none", label: "Без итога" },
];

function outcomeLabel(run: CallRun): string {
  if (run.outcome) return OUTCOME_LABELS[run.outcome as Exclude<CallOutcome, "">] ?? run.outcome;
  return STATUS_LABEL[run.status] || "Без итога";
}

function Journal({
  q,
  dropAt,
  onClearDrop,
}: {
  q: CallStatsQuery;
  dropAt: { id: string; title: string } | null;
  onClearDrop: () => void;
}) {
  const [outcome, setOutcome] = useState("");
  useEffect(() => setOutcome(""), [dropAt]);
  const key = JSON.stringify({ q, outcome, node: dropAt?.id ?? "" });
  return (
    <Section title="Журнал звонков" hint="от новых к старым · нажмите звонок — весь путь по сценарию">
      <div className="journal-filters">
        <div className="seg" role="group" aria-label="Итог">
          {JOURNAL_FILTERS.map((f) => (
            <button key={f.key} type="button" className={`seg-btn ${outcome === f.key ? "on" : ""}`}
              onClick={() => setOutcome(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        {dropAt && (
          <span className="chip">
            Оборвались на «{dropAt.title}»
            <button type="button" className="chip-x" aria-label="Снять фильтр" onClick={onClearDrop}>
              ×
            </button>
          </span>
        )}
      </div>
      <JournalList key={key} q={q} outcome={outcome} node={dropAt?.id ?? ""} />
    </Section>
  );
}

function JournalList({ q, outcome, node }: { q: CallStatsQuery; outcome: string; node: string }) {
  const load = useCallback((cursor: string) => api.callRuns({ ...q, outcome, node, cursor }), [q, outcome, node]);
  const { items, loading, error, done, more, sentinel } = usePaged(load);
  const [open, setOpen] = useState("");

  if (!items.length && loading) return <Skeleton count={3} height={52} />;
  if (!items.length && error) return <Note kind="error">{error}</Note>;
  if (!items.length) return <Empty title="Звонков с такими условиями нет" />;

  return (
    <div className="sheet journal">
      {items.map((r) => {
        const isOpen = open === r.id;
        const cls = r.outcome || (r.status === "live" ? "live" : "none");
        return (
          <div key={r.id} className={`journal-item${isOpen ? " open" : ""}`}>
            <button type="button" className="journal-row" aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? "" : r.id)}>
              <span className="journal-when num">{fmtWhen(r.started_at)}</span>
              <span className="journal-who">{r.user_name}</span>
              <span className={`journal-outcome outcome-pill outcome-${cls}`}>{outcomeLabel(r)}</span>
              <span className="journal-last">
                <span className="muted">{r.outcome === "booked" ? "до" : "на"}</span> {r.last_node_title}
              </span>
              <span className="journal-meta muted num">
                {r.steps} {plural(r.steps, "шаг", "шага", "шагов")} · {dur(r.seconds)}
              </span>
            </button>
            {isOpen && (
              <ol className="journal-path">
                {r.path.map((p, i) => (
                  <li key={i} className={p.group === "objection" ? "objection" : ""}>
                    <span className="journal-step">{p.title}</span>
                    {p.answer && <span className="journal-answer">{p.answer}</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        );
      })}
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
