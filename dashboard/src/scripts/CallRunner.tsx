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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, CallNode, ScriptLang, ScriptSection } from "../api";
import { Note } from "../components/ui";
import Formatted from "./Formatted";
import { langInfo, VarResolver } from "./logic";

interface Step {
  id: string;
  /** Что ответил клиент на этом шаге (кнопка), или «переход» из панели. */
  answer?: string;
}

interface Saved {
  path: Step[];
  name: string;
}

function storageKey(sectionId: string) {
  return `aa_call:${sectionId}`;
}

function load(sectionId: string, start: string): Saved {
  try {
    const raw = sessionStorage.getItem(storageKey(sectionId));
    if (raw) {
      const saved = JSON.parse(raw) as Saved;
      if (Array.isArray(saved.path) && saved.path.length) return saved;
    }
  } catch {
    /* нет sessionStorage — начинаем сначала */
  }
  return { path: [{ id: start }], name: "" };
}

function nodeText(node: CallNode, lang: ScriptLang): { text: string; fallback: boolean } {
  const own = node.text[lang]?.trim();
  if (own) return { text: node.text[lang], fallback: false };
  return { text: node.text.ru || node.text.en || node.text.ka || "", fallback: lang !== "ru" };
}

export default function CallRunner({
  section,
  lang,
  resolveVar,
  resolveRef,
  resolveId,
  canEdit,
  onEdit,
}: {
  section: ScriptSection;
  lang: ScriptLang;
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
    return kept.length ? kept : [{ id: flow.start }];
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
      const p = s.path.filter((x) => byId.has(x.id));
      const last = p[p.length - 1];
      return { ...s, path: [...p.slice(0, -1), { ...last, answer }, { id: to }] };
    });
  }, [byId]);

  const back = useCallback(() => {
    setState((s) => {
      if (s.path.length < 2) return s;
      const p = s.path.slice(0, -1);
      const last = p[p.length - 1];
      return { ...s, path: [...p.slice(0, -1), { id: last.id }] };
    });
  }, []);

  const backTo = (index: number) =>
    setState((s) => ({ ...s, path: [...s.path.slice(0, index), { id: s.path[index].id }] }));

  const restart = () => setState({ name: "", path: [{ id: flow.start }] });

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
        <button type="button" className="secondary" onClick={restart}>
          Новый звонок
        </button>
        {canEdit && (
          <button type="button" className="ghost" onClick={onEdit}>
            Редактировать сценарий
          </button>
        )}
      </div>

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
                <div className="call-end">
                  <strong>Конец сценария</strong>
                  <button type="button" onClick={restart}>
                    Новый звонок
                  </button>
                </div>
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
