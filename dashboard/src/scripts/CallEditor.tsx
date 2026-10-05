/** Редактор сценария звонка.
 *
 *  Слева — блоки: этапы разговора по порядку и возражения. Справа — выбранный
 *  блок: что говорит администратор (с форматированием и переменными),
 *  подсказка, чего ждать от клиента и кнопки ответов — каждая ведёт в блок,
 *  который выбирают из списка или создают тут же. Сохраняется весь сценарий
 *  разом, с «Что изменили?» — как у текстовых скриптов.
 */
import { useMemo, useState } from "react";
import { api, CallAnswer, CallFlow, CallNode, CallOutcomeTag, ScriptSection } from "../api";
import { Note } from "../components/ui";
import { LANGS } from "./logic";
import { FormatBar } from "./ScriptEditor";

function newId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function blankNode(group: CallNode["group"], title: string): CallNode {
  return { id: newId(), title, group, text: { ru: "", en: "", ka: "" }, hint: "", client: "", answers: [] };
}

function rows(value: string, min = 3) {
  return Math.max(min, Math.min(16, value.split("\n").length + 1));
}

export default function CallEditor({
  section,
  sections,
  variables,
  onSaved,
  onCancel,
}: {
  section: ScriptSection;
  sections: ScriptSection[];
  variables: { key: string; description: string }[];
  onSaved: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [flow, setFlow] = useState<CallFlow>(() => structuredClone(section.flow!));
  const [selected, setSelected] = useState(flow.start);
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [otherLangs, setOtherLangs] = useState(false);

  const node = flow.nodes.find((n) => n.id === selected) ?? flow.nodes[0];
  const byId = useMemo(() => new Map(flow.nodes.map((n) => [n.id, n])), [flow]);
  const dirty = JSON.stringify(flow) !== JSON.stringify(section.flow);

  // Сколько ответов ведёт в каждый блок — чтобы видеть «потерянные» блоки.
  const incoming = useMemo(() => {
    const count = new Map<string, number>();
    for (const n of flow.nodes) for (const a of n.answers) count.set(a.to, (count.get(a.to) ?? 0) + 1);
    return count;
  }, [flow]);

  function patchNode(id: string, patch: Partial<CallNode>) {
    setFlow((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  }

  function patchAnswer(index: number, patch: Partial<CallAnswer>) {
    patchNode(node.id, { answers: node.answers.map((a, i) => (i === index ? { ...a, ...patch } : a)) });
  }

  function addNode(group: CallNode["group"], linkFrom?: number) {
    const fresh = blankNode(group, group === "main" ? "Новый этап" : "Новое возражение");
    setFlow((f) => {
      const nodes = [...f.nodes];
      // Новый этап — сразу после текущего, возражение — в конец.
      const at = group === "main" ? nodes.findIndex((n) => n.id === node.id) + 1 : nodes.length;
      nodes.splice(at, 0, fresh);
      return {
        ...f,
        nodes:
          linkFrom === undefined
            ? nodes
            : nodes.map((n) =>
                n.id === node.id
                  ? { ...n, answers: n.answers.map((a, i) => (i === linkFrom ? { ...a, to: fresh.id } : a)) }
                  : n
              ),
      };
    });
    setSelected(fresh.id);
  }

  function move(delta: -1 | 1) {
    setFlow((f) => {
      const nodes = [...f.nodes];
      const i = nodes.findIndex((n) => n.id === node.id);
      // Двигаем среди блоков той же группы.
      let j = i + delta;
      while (j >= 0 && j < nodes.length && nodes[j].group !== node.group) j += delta;
      if (j < 0 || j >= nodes.length) return f;
      [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
      return { ...f, nodes };
    });
  }

  function remove() {
    setFlow((f) => ({
      ...f,
      nodes: f.nodes
        .filter((n) => n.id !== node.id)
        .map((n) => ({ ...n, answers: n.answers.filter((a) => a.to !== node.id) })),
    }));
    setSelected(flow.start === node.id ? flow.nodes[0].id : flow.start);
    setConfirmDelete(false);
  }

  const problem = useMemo(() => {
    for (const n of flow.nodes) {
      if (!n.title.trim()) return "У блока нет названия";
      if (!n.text.ru.trim() && !n.text.en.trim() && !n.text.ka.trim())
        return `В блоке «${n.title}» нет текста`;
      for (const a of n.answers) {
        if (!a.label.trim()) return `В блоке «${n.title}» есть ответ без текста кнопки`;
        if (!byId.has(a.to)) return `Ответ «${a.label}» в блоке «${n.title}» никуда не ведёт`;
      }
    }
    return "";
  }, [flow, byId]);

  async function save() {
    if (!note.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const clean: CallFlow = {
        start: flow.start,
        nodes: flow.nodes.map((n) => ({
          ...n,
          title: n.title.trim(),
          hint: n.hint.trim(),
          client: n.client.trim(),
          text: { ru: n.text.ru.trim(), en: n.text.en.trim(), ka: n.text.ka.trim() },
          answers: n.answers.map((a) => ({ label: a.label.trim(), to: a.to })),
        })),
      };
      await api.saveCallFlow(section.id, clean, note.trim());
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  function insertVariable(key: string) {
    const el = document.getElementById("call-text-ru") as HTMLTextAreaElement | null;
    const value = node.text.ru;
    const at = el ? el.selectionStart : value.length;
    const end = el ? el.selectionEnd : value.length;
    const token = `{${key}}`;
    patchNode(node.id, { text: { ...node.text, ru: value.slice(0, at) + token + value.slice(end) } });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  }

  const groups: { key: CallNode["group"]; title: string }[] = [
    { key: "main", title: "Этапы звонка" },
    { key: "objection", title: "Возражения и вопросы" },
  ];
  const vars = [{ key: "имя", description: "имя клиента — из поля на экране звонка" }, ...variables];

  return (
    <div className="call-editor">
      <aside className="ce-list">
        {groups.map((g) => (
          <div key={g.key} className="ce-group">
            <h3 className="call-side-title">{g.title}</h3>
            {flow.nodes
              .filter((n) => n.group === g.key)
              .map((n) => (
                <button key={n.id} type="button"
                  className={`ce-node${n.id === node.id ? " on" : ""}`}
                  onClick={() => {
                    setSelected(n.id);
                    setConfirmDelete(false);
                  }}>
                  {n.id === flow.start && <span className="ce-start" title="С этого блока начинается звонок">▶</span>}
                  <span className="ce-node-title">{n.title || "Без названия"}</span>
                  {n.id !== flow.start && !incoming.get(n.id) && n.group === "main" && (
                    <span className="ce-orphan" title="Ни один ответ сюда не ведёт — попасть можно только из панели этапов">
                      нет входа
                    </span>
                  )}
                  <span className="ce-count num">{n.answers.length || "конец"}</span>
                </button>
              ))}
            <button type="button" className="ghost small ce-add" onClick={() => addNode(g.key)}>
              + {g.key === "main" ? "Этап" : "Возражение"}
            </button>
          </div>
        ))}
      </aside>

      <section className="ce-form sheet sheet-pad">
        <div className="ce-row">
          <label className="field grow">
            <span className="label">Название блока</span>
            <input type="text" value={node.title} maxLength={120}
              onChange={(e) => patchNode(node.id, { title: e.target.value })} />
          </label>
          <label className="field">
            <span className="label">Где показывать</span>
            <select value={node.group}
              onChange={(e) => patchNode(node.id, { group: e.target.value as CallNode["group"] })}>
              <option value="main">Этап звонка</option>
              <option value="objection">Возражение / вопрос</option>
            </select>
          </label>
          <label className="field" title="Дошли до этого блока — звонок засчитывается с этим итогом в «Аналитике»">
            <span className="label">Итог звонка</span>
            <select value={node.outcome ?? ""}
              onChange={(e) => patchNode(node.id, { outcome: e.target.value as CallOutcomeTag })}>
              <option value="">— не ставит итог</option>
              <option value="booked">Записан</option>
              <option value="callback">Перезвонить</option>
              <option value="refused">Отказ</option>
            </select>
          </label>
        </div>
        <div className="ce-row ce-row-actions">
          {flow.start === node.id ? (
            <span className="ce-start-note">▶ С этого блока начинается звонок</span>
          ) : (
            <button type="button" className="ghost small" onClick={() => setFlow((f) => ({ ...f, start: node.id }))}>
              ▶ Начинать звонок с этого блока
            </button>
          )}
          <span className="grow" />
          <button type="button" className="ghost small" onClick={() => move(-1)} title="Выше">↑</button>
          <button type="button" className="ghost small" onClick={() => move(1)} title="Ниже">↓</button>
          {flow.nodes.length > 1 &&
            (confirmDelete ? (
              <button type="button" className="danger small" onClick={remove}>
                Удалить блок и ответы, ведущие в него
              </button>
            ) : (
              <button type="button" className="ghost small ce-delete" onClick={() => setConfirmDelete(true)}>
                Удалить блок…
              </button>
            ))}
        </div>

        <div className="field">
          <span className="label">Что говорит администратор (RU)</span>
          <FormatBar targetId="call-text-ru" value={node.text.ru} sections={sections}
            onChange={(ru) => patchNode(node.id, { text: { ...node.text, ru } })} />
          <textarea id="call-text-ru" rows={rows(node.text.ru, 5)} value={node.text.ru}
            onChange={(e) => patchNode(node.id, { text: { ...node.text, ru: e.target.value } })} />
          <div className="var-chips">
            {vars.map((v) => (
              <button key={v.key} type="button" className="var-chip" title={v.description || undefined}
                onMouseDown={(e) => e.preventDefault()} onClick={() => insertVariable(v.key)}>
                {`{${v.key}}`}
              </button>
            ))}
          </div>
          <button type="button" className="ghost small ce-langs" onClick={() => setOtherLangs((v) => !v)}>
            {otherLangs ? "Скрыть EN и GE" : "Текст на EN и GE"}
          </button>
          {otherLangs &&
            LANGS.filter((l) => l.key !== "ru").map((l) => (
              <label key={l.key} className="field">
                <span className="label">{l.label} · {l.name}</span>
                <textarea rows={rows(node.text[l.key])} value={node.text[l.key]} lang={l.key}
                  onChange={(e) => patchNode(node.id, { text: { ...node.text, [l.key]: e.target.value } })} />
              </label>
            ))}
        </div>

        <div className="ce-row">
          <label className="field grow">
            <span className="label">Подсказка администратору — клиенту не говорится</span>
            <textarea rows={rows(node.hint, 2)} value={node.hint}
              onChange={(e) => patchNode(node.id, { hint: e.target.value })} />
          </label>
          <label className="field grow">
            <span className="label">Чего ждать от клиента</span>
            <input type="text" value={node.client} maxLength={300} placeholder="Например: говорит день"
              onChange={(e) => patchNode(node.id, { client: e.target.value })} />
          </label>
        </div>

        <div className="field">
          <span className="label">Ответы клиента — кнопки перехода</span>
          {node.answers.length === 0 && (
            <p className="muted ce-empty">Ответов нет — на этом блоке звонок заканчивается.</p>
          )}
          {node.answers.map((a, i) => (
            <div key={i} className="ce-answer">
              <span className="call-answer-key num">{i + 1}</span>
              <input type="text" value={a.label} maxLength={120} placeholder="Что ответил клиент"
                onChange={(e) => patchAnswer(i, { label: e.target.value })} />
              <span className="ce-arrow" aria-hidden="true">→</span>
              <select value={a.to} onChange={(e) => {
                if (e.target.value === "__new_main") addNode("main", i);
                else if (e.target.value === "__new_obj") addNode("objection", i);
                else patchAnswer(i, { to: e.target.value });
              }}>
                {groups.map((g) => (
                  <optgroup key={g.key} label={g.title}>
                    {flow.nodes.filter((n) => n.group === g.key).map((n) => (
                      <option key={n.id} value={n.id}>{n.title || "Без названия"}</option>
                    ))}
                  </optgroup>
                ))}
                <optgroup label="Создать">
                  <option value="__new_main">+ Новый этап</option>
                  <option value="__new_obj">+ Новое возражение</option>
                </optgroup>
              </select>
              <button type="button" className="ghost small" title="Убрать ответ"
                onClick={() => patchNode(node.id, { answers: node.answers.filter((_, j) => j !== i) })}>
                ✕
              </button>
            </div>
          ))}
          {node.answers.length < 12 && (
            <button type="button" className="secondary small ce-add-answer"
              onClick={() => patchNode(node.id, {
                answers: [...node.answers, { label: "", to: flow.nodes.find((n) => n.id !== node.id)?.id ?? node.id }],
              })}>
              + Ответ
            </button>
          )}
        </div>

        {error && <Note kind="error">{error}</Note>}
        <div className="ce-foot">
          {asking ? (
            <>
              <label className="field grow change-ask">
                <span className="label">Что изменили?</span>
                <input type="text" autoFocus value={note} maxLength={500}
                  placeholder="Например: добавили возражение «Дорого»"
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && save()} />
              </label>
              <button type="button" disabled={!note.trim() || saving} onClick={save}>
                {saving ? "Сохраняем…" : "Сохранить сценарий"}
              </button>
              <button type="button" className="ghost" onClick={() => setAsking(false)}>Назад</button>
            </>
          ) : (
            <>
              <span className="muted">{problem || (dirty ? "Есть несохранённые изменения" : "Изменений нет")}</span>
              <span className="grow" />
              <button type="button" className="ghost" onClick={onCancel}>Отмена</button>
              <button type="button" disabled={!dirty || Boolean(problem)} onClick={() => setAsking(true)}>
                Сохранить
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
