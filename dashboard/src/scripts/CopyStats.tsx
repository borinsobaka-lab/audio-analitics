/** Статистика копирований: какие скрипты в ходу.
 *
 *  Каждое нажатие «Копировать» у текста скрипта — одна отметка: кто, когда,
 *  на каком языке. Здесь они складываются в рейтинг скриптов — за период, у
 *  всех или у одного администратора, на всех языках или на одном. Скрипты,
 *  которые не копируют месяцами, — кандидаты на переписывание или удаление.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, CopyStats, LangCounts, plural } from "../api";
import { DateField, Empty, Note, Skeleton } from "../components/ui";
import { Slider } from "../components/Slider";
import { LANGS, scriptPath } from "./logic";
import { usePlaybook } from "./store";

/** Дата в поле — YYYY-MM-DD по часам браузера (тбилисское время). */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
}
/** Начало дня по местному времени — в ISO для сервера. */
function dayStart(value: string, shift = 0): string {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d + shift).toISOString();
}

const PRESETS = [
  { key: "today", label: "Сегодня", from: () => daysAgo(0) },
  { key: "7", label: "7 дней", from: () => daysAgo(6) },
  { key: "30", label: "30 дней", from: () => daysAgo(29) },
  { key: "all", label: "Всё время", from: () => "" },
];

function LangCells({ row, lang }: { row: LangCounts; lang: string }) {
  return (
    <>
      {LANGS.map((l) => (
        <td key={l.key} className={`num stats-lang${lang && lang !== l.key ? " dim" : ""}`}>
          {row[l.key] || "—"}
        </td>
      ))}
    </>
  );
}

export default function CopyStatsView() {
  const navigate = useNavigate();
  const { playbook } = usePlaybook();
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(daysAgo(0));
  const [user, setUser] = useState("");
  const [lang, setLang] = useState("");
  const [data, setData] = useState<CopyStats | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // Имена выбранных раньше — чтобы выбранный не пропал из списка, если в
  // новом периоде он ничего не копировал.
  const [knownUsers, setKnownUsers] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    api
      .copyStats({
        from: from ? dayStart(from) : "",
        to: to ? dayStart(to, 1) : "",
        user,
        lang,
      })
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
  }, [from, to, user, lang]);

  const preset = PRESETS.find((p) => p.from() === from && to === daysAgo(0))?.key ?? "";
  const max = useMemo(() => Math.max(1, ...(data?.items.map((i) => i.total) ?? [1])), [data]);

  function open(itemId: string | null) {
    if (!itemId || !playbook) return;
    const sec = playbook.sections.find((s) => s.items.some((i) => i.id === itemId));
    if (sec) navigate(scriptPath(sec.id, itemId));
  }

  const userName = user ? knownUsers[user] || "сотрудник" : "";

  return (
    <div className="copy-stats">
      <div className="stats-filters">
        <Slider className="seg" active={preset} role="group" aria-label="Период">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`seg-btn${preset === p.key ? " on" : ""}`}
              onClick={() => {
                setFrom(p.from());
                setTo(daysAgo(0));
              }}
            >
              {p.label}
            </button>
          ))}
        </Slider>
        <span className="stats-range">
          <DateField value={from} max={to || undefined} onChange={setFrom} aria-label="С даты" />
          <span className="muted">—</span>
          <DateField value={to} min={from || undefined} onChange={setTo} aria-label="По дату" />
        </span>
        <select
          className="stats-user"
          value={user}
          aria-label="Сотрудник"
          onChange={(e) => setUser(e.target.value)}
        >
          <option value="">Все сотрудники</option>
          {Object.entries(knownUsers)
            .sort((a, b) => a[1].localeCompare(b[1], "ru"))
            .map(([key, name]) => (
              <option key={key} value={key}>
                {name || key}
              </option>
            ))}
        </select>
        <Slider className="seg" active={lang} role="group" aria-label="Язык">
          <button type="button" className={`seg-btn${lang === "" ? " on" : ""}`} onClick={() => setLang("")}>
            Все языки
          </button>
          {LANGS.map((l) => (
            <button
              key={l.key}
              type="button"
              className={`seg-btn${lang === l.key ? " on" : ""}`}
              title={l.name}
              onClick={() => setLang(l.key)}
            >
              {l.label}
            </button>
          ))}
        </Slider>
      </div>

      {error && <Note kind="error">{error}</Note>}
      {!data && loading && <Skeleton count={3} height={80} />}

      {data && (
        <div className={loading ? "stats-body loading" : "stats-body"}>
          <div className="stats-tiles">
            <div className="stats-tile main">
              <span className="stats-tile-label">
                Копирований{userName ? ` · ${userName}` : ""}
              </span>
              <span className="stats-tile-value num">{data.totals.total}</span>
            </div>
            {LANGS.map((l) => (
              <div key={l.key} className={`stats-tile${lang && lang !== l.key ? " dim" : ""}`}>
                <span className="stats-tile-label">{l.label} · {l.name}</span>
                <span className="stats-tile-value num">{data.totals[l.key]}</span>
              </div>
            ))}
          </div>

          {data.items.length ? (
            <div className="sheet stats-card">
              <h3 className="stats-title">
                Скрипты{userName ? ` — ${userName}` : ""}
                <span className="muted">
                  {" "}
                  · {data.items.length} {plural(data.items.length, "скрипт", "скрипта", "скриптов")}
                </span>
              </h3>
              <table className="stats-table">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Скрипт</th>
                    <th className="stats-bar-col" aria-hidden="true" />
                    <th className="num">Всего</th>
                    {LANGS.map((l) => (
                      <th key={l.key} className="num">{l.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row, i) => (
                    <tr key={row.item_id ?? i}>
                      <td className="num muted">{i + 1}</td>
                      <td className="stats-script">
                        {row.deleted ? (
                          <span className="stats-gone" title="Скрипт удалён">{row.title}</span>
                        ) : (
                          <button type="button" className="stats-link" onClick={() => open(row.item_id)}>
                            {row.title}
                          </button>
                        )}
                        {row.section && <span className="muted stats-section">{row.section}</span>}
                      </td>
                      <td className="stats-bar-col">
                        <span className="stats-bar" style={{ width: `${(row.total / max) * 100}%` }} />
                      </td>
                      <td className="num stats-total">{row.total}</td>
                      <LangCells row={row} lang={lang} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="За этот период копирований нет">
              Отметка появляется, когда сотрудник нажимает «Копировать» у текста скрипта.
            </Empty>
          )}

          {!user && data.users.length > 0 && (
            <div className="sheet stats-card">
              <h3 className="stats-title">
                Сотрудники <span className="muted">· нажмите, чтобы посмотреть его скрипты</span>
              </h3>
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>Сотрудник</th>
                    <th className="num">Всего</th>
                    {LANGS.map((l) => (
                      <th key={l.key} className="num">{l.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.user_key} className="stats-row-link" onClick={() => setUser(u.user_key)}>
                      <td>
                        <button type="button" className="stats-link">{u.name || u.user_key}</button>
                      </td>
                      <td className="num stats-total">{u.total}</td>
                      <LangCells row={u} lang={lang} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
