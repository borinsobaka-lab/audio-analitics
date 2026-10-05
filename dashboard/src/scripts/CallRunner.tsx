/** Звонок по сценарию: администратор читает с экрана и кликает, что
 *  ответил клиент, — сценарий сам ведёт к следующему блоку.
 *
 *  Задача — не зубрить ветки разговора. На экране всегда:
 *  - слева — путь: пройденные блоки и что отвечал клиент (потребность,
 *    выбранная студия), по клику можно вернуться на любой шаг;
 *  - в центре — что говорить сейчас, подсказка и кнопки ответов клиента
 *    (с клавиатуры — цифрами 1–9, назад — Backspace);
 *  - справа — возражения и этапы: перейти в любой блок в любой момент.
 *
 *  Имя клиента вписывается сверху и подставляется в {имя} по всему
 *  сценарию. «Нет нужного ответа» — записать, что сказал клиент: уйдёт в
 *  «Предложения», чтобы дописать сценарий.
 *
 *  Место в сценарии и имя живут в sessionStorage вкладки: случайный переход
 *  в другой раздел посреди звонка не сбрасывает разговор.
 *
 *  Каждый звонок пишется в аналитику по ходу разговора — после каждого
 *  клика (см. «Аналитика» → «Звонки»): путь, ответы клиента и итог. Итог
 *  ставится сам, если разговор дошёл до блока с итогом («Запись» —
 *  записан); иначе администратор отмечает его одним нажатием в конце.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  CallNode,
  CallOutcome,
  CallRunIn,
  OUTCOME_LABELS,
  ScriptLang,
  ScriptSection,
} from "../api";
import { Note } from "../components/ui";
import Formatted from "./Formatted";
import { langInfo, VarResolver } from "./logic";

interface Step {
  id: string;
  /** Что ответил клиент на этом шаге (кнопка), или «переход» из панели. */
  answer?: string;
  /** Когда открыли этот блок — для времени на этапе в аналитике. */
  at?: string;
}

interface Saved {
  path: Step[];
  name: string;
  /** id звонка в аналитике: повторная отправка — обновление, не дубль. */
  runId?: string;
}

/** Итоги, которые администратор отмечает сам, — в порядке частоты. */
const MANUAL_OUTCOMES: Exclude<CallOutcome, "">[] = ["booked", "callback", "refused", "no_answer"];
/** Приветствие могло висеть на экране до звонка долго: время на первом
 *  шаге — не больше минуты, иначе длительность звонка врёт. */
const FIRST_STEP_MAX_MS = 60_000;

function newRunId(): string {
  // randomUUID есть только на https и localhost.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function fresh(start: string): Saved {
  return { path: [{ id: start, at: new Date().toISOString() }], name: "", runId: newRunId() };
}

/** Итог, который поставил сам сценарий: последний пройденный блок с итогом. */
function pathOutcome(path: Step[], byId: Map<string, CallNode>): CallOutcome {
  for (let i = path.length - 1; i >= 0; i--) {
    const tag = byId.get(path[i].id)?.outcome;
    if (tag) return tag;
  }
  return "";
}

function runBody(
  section: ScriptSection,
  byId: Map<string, CallNode>,
  path: Step[],
  extra: { studio: string; lang: ScriptLang; finished: boolean; outcome: CallOutcome }
): CallRunIn {
  const now = new Date().toISOString();
  return {
    section_id: section.id,
    studio: extra.studio,
    lang: extra.lang,
    flow_version: section.flow_updated_at ?? null,
    path: path.map((s) => {
      const node = byId.get(s.id);
      return {
        id: s.id,
        title: (node?.title ?? s.id).slice(0, 120),
        group: node?.group ?? "main",
        answer: (s.answer ?? "").slice(0, 120),
        at: s.at ?? now,
      };
    }),
    finished: extra.finished,
    outcome: extra.outcome,
  };
}

function storageKey(sectionId: string) {
  return `aa_call:${sectionId}`;
}

function load(sectionId: string, start: string): Saved {
  try {
    const raw = sessionStorage.getItem(storageKey(sectionId));
    if (raw) {
      const saved = JSON.parse(raw) as Saved;
      if (Array.isArray(saved.path) && saved.path.length)
        return saved.runId ? saved : { ...saved, runId: newRunId() };
    }
  } catch {
    /* нет sessionStorage — начинаем сначала */
  }
  return fresh(start);
}

function nodeText(node: CallNode, lang: ScriptLang): { text: string; fallback: boolean } {
  const own = node.text[lang]?.trim();
  if (own) return { text: node.text[lang], fallback: false };
  return { text: node.text.ru || node.text.en || node.text.ka || "", fallback: lang !== "ru" };
}

export default function CallRunner({
  section,
  lang,
  studio,
  resolveVar,
  resolveRef,
  resolveId,
  canEdit,
  onEdit,
}: {
  section: ScriptSection;
  lang: ScriptLang;
  studio: string;
  resolveVar: VarResolver;
  resolveRef: (title: string) => (() => void) | null;
  resolveId: (id: string) => { open: () => void; title: string } | null;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const flow = section.flow!;
  const byId = useMemo(() => new Map(flow.nodes.map((n) => [n.id, n])), [flow]);
  const [state, setState] = useState<Saved>(() => load(section.id, flow.start));
  const { path, name } = state;

  // Сценарий могли поменять в редакторе: шаги, которых больше нет, — прочь.
  const validPath = useMemo(() => {
    const kept = path.filter((s) => byId.has(s.id));
    return kept.length ? kept : [{ id: flow.start, at: new Date().toISOString() }];
  }, [path, byId, flow.start]);
  const current = byId.get(validPath[validPath.length - 1].id)!;
  const visited = useMemo(() => new Set(validPath.map((s) => s.id)), [validPath]);

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey(section.id), JSON.stringify(state));
    } catch {
      /* не сохранится между переходами — не страшно */
    }
  }, [state, section.id]);

  const go = useCallback((to: string, answer: string) => {
    setState((s) => {
      const now = Date.now();
      let p = s.path.filter((x) => byId.has(x.id));
      if (!p.length) p = [{ id: flow.start }];
      if (p.length === 1) {
        // Первый ответ — звонок начался: приветствие на экране до звонка
        // в его длительность не идёт.
        const at = p[0].at ? Date.parse(p[0].at) : NaN;
        const first =
          Number.isFinite(at) && now - at <= FIRST_STEP_MAX_MS
            ? p[0].at
            : new Date(now - FIRST_STEP_MAX_MS / 4).toISOString();
        p = [{ ...p[0], at: first }];
      }
      const last = p[p.length - 1];
      return {
        ...s,
        path: [...p.slice(0, -1), { ...last, answer }, { id: to, at: new Date(now).toISOString() }],
      };
    });
  }, [byId, flow.start]);

  const back = useCallback(() => {
    setState((s) => {
      if (s.path.length < 2) return s;
      const p = s.path.slice(0, -1);
      const last = p[p.length - 1];
      return { ...s, path: [...p.slice(0, -1), { id: last.id, at: last.at }] };
    });
  }, []);

  const backTo = (index: number) =>
    setState((s) => ({
      ...s,
      path: [...s.path.slice(0, index), { id: s.path[index].id, at: s.path[index].at }],
    }));

  /* --- Звонок в аналитику ------------------------------------------------ */

  const autoOutcome = pathOutcome(validPath, byId);
  // Конец сценария — звонок завершён сам; итог — от блока, если он есть.
  const atEnd = current.answers.length === 0;
  const started = validPath.length > 1;
  const [saved, setSaved] = useState("");
  const [choosing, setChoosing] = useState(false);

  // Последнее состояние звонка, ещё не отправленное: шлётся с задержкой,
  // чтобы быстрые клики подряд не превращались в пачку запросов.
  const pending = useRef<{ id: string; body: CallRunIn } | null>(null);
  const timer = useRef<number>();
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (p) api.saveCallRun(p.id, p.body).catch(() => {});
  }, []);

  useEffect(() => {
    if (!started || !state.runId) return;
    pending.current = {
      id: state.runId,
      body: runBody(section, byId, validPath, {
        studio,
        lang,
        finished: atEnd,
        outcome: autoOutcome,
      }),
    };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 400);
  }, [validPath, started, state.runId, atEnd, autoOutcome, section, byId, studio, lang, flush]);

  // Ушли со страницы или закрыли вкладку — дослать последний шаг.
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(""), 4000);
    return () => window.clearTimeout(t);
  }, [saved]);

  const restart = () => {
    flush();
    setChoosing(false);
    setState(fresh(flow.start));
  };

  /** Итог отмечен вручную — звонок записан, сразу готов следующий. */
  const finish = (outcome: CallOutcome) => {
    const runId = state.runId ?? newRunId();
    window.clearTimeout(timer.current);
    pending.current = null;
    api
      .saveCallRun(
        runId,
        runBody(section, byId, validPath, { studio, lang, finished: true, outcome })
      )
      .catch(() => {});
    setSaved(outcome ? OUTCOME_LABELS[outcome] : "без итога");
    setChoosing(false);
    setState(fresh(flow.start));
  };

  // {имя} — имя клиента из поля сверху; остальные переменные — как везде.
  const callVar: VarResolver = useCallback(
    (key) => {
      if (key.toLowerCase() === "имя")
        return name.trim()
          ? { value: name.trim() }
          : { value: null, why: "Впишите имя клиента в поле над сценарием" };
      return resolveVar(key);
    },
    [name, resolveVar]
  );

  // Клавиатура: 1–9 — ответ клиента, Backspace — шаг назад. Не мешает
  // печатать в полях и не работает поверх окон.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable], dialog")) return;
      if (/^[1-9]$/.test(e.key)) {
        const a = current.answers[Number(e.key) - 1];
        if (a) {
          e.preventDefault();
          go(a.to, a.label);
        }
      } else if (e.key === "Backspace") {
        e.preventDefault();
        back();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, go, back]);

  // Новый блок — к началу карточки: длинные реплики уводят прокрутку вниз.
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [current.id]);

  const shown = nodeText(current, lang);
  const mains = flow.nodes.filter((n) => n.group === "main");
  const objections = flow.nodes.filter((n) => n.group === "objection");

  return (
    <div className="call">
      <div className="call-bar">
        <label className="call-name">
          <span>Имя клиента</span>
          <input
            type="text"
            value={name}
            placeholder="подставится вместо {имя}"
            onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
          />
        </label>
        <span className="grow" />
        <span className="call-keys muted">1–9 — ответ клиента · Backspace — назад</span>
        {saved && (
          <span className="call-saved" role="status">
            ✓ Звонок сохранён · {saved}
          </span>
        )}
        {!started ? (
          <button type="button" className="secondary" onClick={() => finish("no_answer")}
            title="Записать звонок без ответа и начать следующий">
            Не дозвонились
          </button>
        ) : atEnd ? (
          <button type="button" className="secondary" onClick={restart}>
            Новый звонок
          </button>
        ) : (
          <button type="button" className={choosing ? "" : "secondary"} aria-expanded={choosing}
            onClick={() => setChoosing((v) => !v)}>
            Завершить звонок
          </button>
        )}
        {canEdit && (
          <button type="button" className="ghost" onClick={onEdit}>
            Редактировать сценарий
          </button>
        )}
      </div>

      {choosing && !atEnd && started && (
        <OutcomePicker
          title="Чем закончился звонок?"
          suggested={autoOutcome}
          onPick={finish}
          onCancel={() => setChoosing(false)}
        />
      )}

      <div className="call-grid">
        <aside className="call-path" aria-label="Пройденный путь">
          <h3 className="call-side-title">Путь</h3>
          <ol>
            {validPath.map((step, i) => {
              const node = byId.get(step.id)!;
              const isCurrent = i === validPath.length - 1;
              return (
                <li key={i} className={isCurrent ? "on" : ""}>
                  <button type="button" disabled={isCurrent} onClick={() => backTo(i)}
                    title={isCurrent ? "Вы здесь" : "Вернуться к этому шагу"}>
                    <span className="call-path-title">{node.title}</span>
                    {step.answer && <span className="call-path-answer">{step.answer}</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        <section className="call-main" ref={cardRef}>
          <article className={`call-card${current.group === "objection" ? " objection" : ""}`}>
            <header className="call-card-head">
              <span className="call-card-step num">Шаг {validPath.length}</span>
              <h2 className="call-card-title">{current.title}</h2>
              {current.group === "objection" && <span className="call-tag">Возражение</span>}
            </header>
            <div className="call-card-body">
              {shown.fallback && (
                <p className="script-missing">
                  Текста на {langInfo(lang).inName} нет — показан русский.
                </p>
              )}
              <div className="call-say" lang={shown.fallback ? "ru" : lang}>
                <Formatted
                  text={shown.text}
                  terms={[]}
                  resolveVar={callVar}
                  resolveRef={resolveRef}
                  resolveId={resolveId}
                />
              </div>
              {current.hint && (
                <div className="call-hint">
                  <span className="call-hint-title">Подсказка</span>
                  <Formatted text={current.hint} terms={[]} resolveVar={callVar}
                    resolveRef={resolveRef} resolveId={resolveId} />
                </div>
              )}
              {current.client && (
                <p className="call-client">
                  <span>Клиент:</span> {current.client}
                </p>
              )}
            </div>

            <div className="call-answers">
              {current.answers.length ? (
                current.answers.map((a, i) => (
                  <button key={i} type="button" className="call-answer" onClick={() => go(a.to, a.label)}>
                    <span className="call-answer-key num">{i + 1}</span>
                    <span className="call-answer-label">{a.label}</span>
                    <span className="call-answer-to">{byId.get(a.to)?.title}</span>
                  </button>
                ))
              ) : (
                autoOutcome ? (
                  <div className="call-end">
                    <strong>Конец сценария</strong>
                    <span className={`call-outcome call-outcome-${autoOutcome}`}>
                      Итог: {OUTCOME_LABELS[autoOutcome]}
                    </span>
                    <button type="button" onClick={restart}>
                      Новый звонок
                    </button>
                  </div>
                ) : (
                  <OutcomePicker title="Конец сценария. Чем закончился звонок?" onPick={finish} inline />
                )
              )}
            </div>

            <footer className="call-card-foot">
              <button type="button" className="ghost small" disabled={validPath.length < 2} onClick={back}>
                ← Назад
              </button>
              <NoAnswer sectionTitle={section.title} node={current} />
            </footer>
          </article>
        </section>

        <aside className="call-jump" aria-label="Перейти к блоку">
          {objections.length > 0 && (
            <>
              <h3 className="call-side-title">Возражения</h3>
              <div className="call-jump-list">
                {objections.map((n) => (
                  <button key={n.id} type="button"
                    className={`call-jump-btn objection${n.id === current.id ? " on" : ""}`}
                    onClick={() => n.id !== current.id && go(n.id, "→ переход")}>
                    {n.title}
                  </button>
                ))}
              </div>
            </>
          )}
          <h3 className="call-side-title">Этапы звонка</h3>
          <div className="call-jump-list">
            {mains.map((n) => (
              <button key={n.id} type="button"
                className={`call-jump-btn${n.id === current.id ? " on" : ""}${visited.has(n.id) ? " visited" : ""}`}
                onClick={() => n.id !== current.id && go(n.id, "→ переход")}>
                {n.title}
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Итог звонка одним нажатием: звонок уходит в аналитику, следующий —
 *  с чистого листа. */
function OutcomePicker({
  title,
  suggested = "",
  onPick,
  onCancel,
  inline = false,
}: {
  title: string;
  suggested?: CallOutcome;
  onPick: (o: CallOutcome) => void;
  onCancel?: () => void;
  inline?: boolean;
}) {
  return (
    <div className={`call-finish${inline ? " inline" : ""}`} role="group" aria-label={title}>
      <strong className="call-finish-title">{title}</strong>
      <div className="call-finish-btns">
        {MANUAL_OUTCOMES.map((o) => (
          <button key={o} type="button"
            className={`call-outcome-btn call-outcome-${o}${suggested === o ? " suggested" : ""}`}
            onClick={() => onPick(o)}>
            {OUTCOME_LABELS[o]}
          </button>
        ))}
        <button type="button" className="ghost small" onClick={() => onPick("")}
          title="Сохранить звонок без итога">
          Без итога
        </button>
        {onCancel && (
          <button type="button" className="ghost small" onClick={onCancel}>
            Отмена
          </button>
        )}
      </div>
    </div>
  );
}

/** «Нет нужного ответа»: что сказал клиент — в «Предложения», чтобы
 *  дописать сценарий. Разговор при этом продолжается. */
function NoAnswer({ sectionTitle, node }: { sectionTitle: string; node: CallNode }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    setOpen(false);
    setText("");
    setState("idle");
  }, [node.id]);

  async function send() {
    if (text.trim().length < 3) return;
    setState("busy");
    try {
      await api.suggestScript(
        `Звонок «${sectionTitle}», блок «${node.title}» — нет нужного ответа. Клиент: ${text.trim()}`,
        null
      );
      setState("sent");
      setText("");
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  }

  if (state === "sent") return <span className="call-noanswer-sent">✓ Записано в «Предложения»</span>;
  if (!open)
    return (
      <button type="button" className="ghost small" onClick={() => setOpen(true)}>
        Нет нужного ответа
      </button>
    );
  return (
    <div className="call-noanswer">
      <input
        type="text"
        autoFocus
        value={text}
        placeholder="Что сказал клиент?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") send();
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <button type="button" className="secondary small" disabled={state === "busy" || text.trim().length < 3}
        onClick={send}>
        Записать
      </button>
      {state === "error" && <Note kind="error">{error}</Note>}
    </div>
  );
}
