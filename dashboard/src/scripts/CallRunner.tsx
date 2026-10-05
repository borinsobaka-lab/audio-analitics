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
 *
 *  «Перезвонить» — с временем и комментарием: такой звонок попадает в
 *  список «Перезвонить» над сценарием, откуда по нему звонят снова (имя и
 *  телефон подставятся сами). Новый разговор закрывает перезвон.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  Callback,
  CallNode,
  CallOutcome,
  CallRunIn,
  OUTCOME_LABELS,
  ScriptLang,
  ScriptSection,
  fmtWhen,
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
  /** «Нет нужного ответа» на этом шаге — что сказал клиент. */
  gap?: string;
}

interface Saved {
  path: Step[];
  name: string;
  phone?: string;
  /** id звонка в аналитике: повторная отправка — обновление, не дубль. */
  runId?: string;
  /** Звонок по перезвону — id исходного звонка. */
  callbackOf?: string;
}

/** Перезвонить: когда и что важно не забыть. */
interface CallbackInfo {
  at: string | null;
  note: string;
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
  state: Saved,
  path: Step[],
  extra: {
    studio: string;
    lang: ScriptLang;
    finished: boolean;
    outcome: CallOutcome;
    callback?: CallbackInfo;
  }
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
        gap: (s.gap ?? "").slice(0, 300),
      };
    }),
    finished: extra.finished,
    outcome: extra.outcome,
    client_name: state.name.trim().slice(0, 120),
    client_phone: (state.phone ?? "").trim().slice(0, 40),
    callback_at: extra.callback?.at ?? null,
    callback_note: (extra.callback?.note ?? "").trim().slice(0, 500),
    callback_of: state.callbackOf ?? null,
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
      return { ...s, path: [...p.slice(0, -1), { id: last.id, at: last.at, gap: last.gap }] };
    });
  }, []);

  const backTo = (index: number) =>
    setState((s) => ({
      ...s,
      path: [
        ...s.path.slice(0, index),
        { id: s.path[index].id, at: s.path[index].at, gap: s.path[index].gap },
      ],
    }));

  /* --- Звонок в аналитику ------------------------------------------------ */

  const autoOutcome = pathOutcome(validPath, byId);
  // Конец сценария — звонок завершён сам; итог — от блока, если он есть.
  const atEnd = current.answers.length === 0;
  const started = validPath.length > 1;
  const [saved, setSaved] = useState("");
  const [choosing, setChoosing] = useState(false);
  // Выбрали «Перезвонить» — сначала спросить, когда.
  const [askCallback, setAskCallback] = useState(false);

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
      body: runBody(section, byId, state, validPath, {
        studio,
        lang,
        finished: atEnd,
        outcome: autoOutcome,
      }),
    };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 400);
  }, [validPath, started, state, atEnd, autoOutcome, section, byId, studio, lang, flush]);

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

  /* --- Перезвонить ------------------------------------------------------ */

  const [callbacks, setCallbacks] = useState<Callback[]>([]);
  const [showCallbacks, setShowCallbacks] = useState(false);
  const loadCallbacks = useCallback(() => {
    api.callbacks(section.id).then(setCallbacks).catch(() => {});
  }, [section.id]);
  useEffect(loadCallbacks, [loadCallbacks]);

  const restart = () => {
    flush();
    setChoosing(false);
    setAskCallback(false);
    setState(fresh(flow.start));
    // Звонок по перезвону мог закрыть перезвон — список обновится.
    if (state.callbackOf) window.setTimeout(loadCallbacks, 800);
  };

  /** Итог отмечен вручную — звонок записан, сразу готов следующий. */
  const finish = (outcome: CallOutcome, callback?: CallbackInfo) => {
    if (outcome === "callback" && !callback) {
      setAskCallback(true);
      return;
    }
    const runId = state.runId ?? newRunId();
    window.clearTimeout(timer.current);
    pending.current = null;
    api
      .saveCallRun(
        runId,
        runBody(section, byId, state, validPath, { studio, lang, finished: true, outcome, callback })
      )
      .catch(() => {})
      .finally(() => {
        if (outcome === "callback" || state.callbackOf) loadCallbacks();
      });
    setSaved(outcome ? OUTCOME_LABELS[outcome] : "без итога");
    setChoosing(false);
    setAskCallback(false);
    setState(fresh(flow.start));
  };

  /** Позвонить по перезвону: имя и телефон — из того звонка. */
  const callBack = (cb: Callback) => {
    flush();
    setShowCallbacks(false);
    setChoosing(false);
    setAskCallback(false);
    setState({ ...fresh(flow.start), name: cb.client_name, phone: cb.client_phone, callbackOf: cb.id });
  };

  const closeCallback = (cb: Callback) => {
    setCallbacks((list) => list.filter((c) => c.id !== cb.id));
    api.patchCallback(cb.id, { done: true }).catch(loadCallbacks);
  };

  /** «Нет нужного ответа» — отметка на шаге: аналитика покажет, где
   *  сценарию не хватает ответов. */
  const markGap = (text: string) =>
    setState((s) => {
      const p = s.path.filter((x) => byId.has(x.id));
      if (!p.length) return s;
      const last = p[p.length - 1];
      const gap = last.gap ? `${last.gap}; ${text}` : text;
      return { ...s, path: [...p.slice(0, -1), { ...last, gap: gap.slice(0, 300) }] };
    });

  const calledBack = state.callbackOf ? callbacks.find((c) => c.id === state.callbackOf) : undefined;

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
            maxLength={120}
            placeholder="подставится вместо {имя}"
            onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
          />
        </label>
        <label className="call-name call-phone">
          <span>Телефон</span>
          <input
            type="tel"
            value={state.phone ?? ""}
            maxLength={40}
            placeholder="для перезвона"
            onChange={(e) => setState((s) => ({ ...s, phone: e.target.value }))}
          />
        </label>
        <span className="grow" />
        {callbacks.length > 0 && (
          <button type="button" className={`call-callbacks-btn${showCallbacks ? " on" : ""}`}
            aria-expanded={showCallbacks} onClick={() => setShowCallbacks((v) => !v)}>
            Перезвонить
            <span className="call-callbacks-count num">{callbacks.length}</span>
          </button>
        )}
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

      {showCallbacks && (
        <CallbacksPanel
          list={callbacks}
          onCall={callBack}
          onDone={closeCallback}
          onClose={() => setShowCallbacks(false)}
        />
      )}

      {state.callbackOf && (
        <p className="call-recall">
          Перезвон{calledBack?.client_name ? ` · ${calledBack.client_name}` : ""}
          {calledBack?.callback_note ? ` — «${calledBack.callback_note}»` : ""}. Поговорите — и перезвон
          закроется сам; не дозвонились — останется в списке.
        </p>
      )}

      {askCallback ? (
        <CallbackForm onSave={(cb) => finish("callback", cb)} onCancel={() => setAskCallback(false)} />
      ) : (
        choosing && !atEnd && started && (
          <OutcomePicker
            title="Чем закончился звонок?"
            suggested={autoOutcome}
            onPick={finish}
            onCancel={() => setChoosing(false)}
          />
        )
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
                    {step.gap && <span className="call-path-gap">нет ответа: {step.gap}</span>}
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
                autoOutcome === "callback" ? (
                  <CallbackForm inline title="Конец сценария. Когда перезвонить?"
                    onSave={(cb) => finish("callback", cb)} />
                ) : autoOutcome ? (
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
              <NoAnswer sectionTitle={section.title} node={current} onSent={markGap} />
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

/** Время перезвона: быстрые варианты и точное время. */
function localInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function quickTimes(): { label: string; at: Date }[] {
  const now = new Date();
  const inHour = new Date(now.getTime() + 60 * 60_000);
  inHour.setMinutes(Math.ceil(inHour.getMinutes() / 15) * 15, 0, 0);
  const evening = new Date(now);
  evening.setHours(19, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(11, 0, 0, 0);
  const list = [{ label: "Через час", at: inHour }];
  if (evening.getTime() - now.getTime() > 90 * 60_000) list.push({ label: "Сегодня в 19:00", at: evening });
  list.push({ label: "Завтра в 11:00", at: tomorrow });
  return list;
}

function CallbackForm({
  title = "Когда перезвонить?",
  inline = false,
  onSave,
  onCancel,
}: {
  title?: string;
  inline?: boolean;
  onSave: (cb: CallbackInfo) => void;
  onCancel?: () => void;
}) {
  const quick = useMemo(quickTimes, []);
  const [when, setWhen] = useState(() => localInput(quick[quick.length - 1].at));
  const [note, setNote] = useState("");
  const save = () => onSave({ at: when ? new Date(when).toISOString() : null, note });
  return (
    <div className={`call-finish call-callback-form${inline ? " inline" : ""}`} role="group" aria-label={title}>
      <strong className="call-finish-title">{title}</strong>
      <div className="call-finish-btns">
        {quick.map((q) => (
          <button key={q.label} type="button"
            className={`call-outcome-btn${when === localInput(q.at) ? " suggested" : ""}`}
            onClick={() => setWhen(localInput(q.at))}>
            {q.label}
          </button>
        ))}
        <input type="datetime-local" value={when} aria-label="Дата и время перезвона"
          onChange={(e) => setWhen(e.target.value)} />
      </div>
      <input type="text" className="call-callback-note" value={note} maxLength={500}
        placeholder="Комментарий: что важно, когда удобно…"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()} />
      <div className="call-finish-btns">
        <button type="button" onClick={save}>
          {inline ? "Сохранить и новый звонок" : "Сохранить перезвон"}
        </button>
        {onCancel && (
          <button type="button" className="ghost small" onClick={onCancel}>
            Назад
          </button>
        )}
      </div>
    </div>
  );
}

/** Список «Перезвонить»: у кого время подошло — сверху и выделены. */
function CallbacksPanel({
  list,
  onCall,
  onDone,
  onClose,
}: {
  list: Callback[];
  onCall: (cb: Callback) => void;
  onDone: (cb: Callback) => void;
  onClose: () => void;
}) {
  const now = Date.now();
  return (
    <section className="call-callbacks" aria-label="Перезвонить">
      <header className="call-callbacks-head">
        <strong>Перезвонить</strong>
        <span className="muted">звонок по перезвону закроет его сам</span>
        <span className="grow" />
        <button type="button" className="ghost small" onClick={onClose}>
          Скрыть
        </button>
      </header>
      <ul>
        {list.map((cb) => {
          const due = cb.callback_at ? Date.parse(cb.callback_at) <= now : false;
          return (
            <li key={cb.id} className={due ? "due" : ""}>
              <div className="call-cb-main">
                <span className="call-cb-name">{cb.client_name || "Без имени"}</span>
                {cb.client_phone && (
                  <a className="call-cb-phone num" href={`tel:${cb.client_phone.replace(/[^+\d]/g, "")}`}>
                    {cb.client_phone}
                  </a>
                )}
                <span className={`call-cb-when${due ? " due" : ""}`}>
                  {cb.callback_at ? (due ? `пора · ${fmtWhen(cb.callback_at)}` : fmtWhen(cb.callback_at)) : "время не указано"}
                </span>
              </div>
              {cb.callback_note && <p className="call-cb-note">«{cb.callback_note}»</p>}
              <p className="call-cb-meta muted">
                {cb.user_name}, {fmtWhen(cb.started_at)} · остановились на «{cb.last_node_title}»
                {cb.attempts > 0 && ` · не дозвонились ${cb.attempts}×`}
              </p>
              <div className="call-cb-actions">
                <button type="button" className="small" onClick={() => onCall(cb)}>
                  Позвонить
                </button>
                <button type="button" className="ghost small" onClick={() => onDone(cb)}>
                  Готово
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** «Нет нужного ответа»: что сказал клиент — в «Предложения», чтобы
 *  дописать сценарий. Разговор при этом продолжается. */
function NoAnswer({
  sectionTitle,
  node,
  onSent,
}: {
  sectionTitle: string;
  node: CallNode;
  onSent: (text: string) => void;
}) {
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
    onSent(text.trim());
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
