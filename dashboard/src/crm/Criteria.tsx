/** Критерии оценки сделки — как метрики в аналитике: название, что
 *  проверять, шкала. По каждому критерию ИИ ставит оценку каждой сделке дня
 *  (или говорит, что критерий к ней не применим), и те же критерии стоят
 *  колонками в статистике по администраторам. */
import { useEffect, useState } from "react";
import { api, CrmCriterion, plural } from "../api";
import { ConfirmAction, Empty, Note, Skeleton } from "../components/ui";

const EXAMPLES: { name: string; prompt: string; scale_max: number }[] = [
  {
    name: "Скорость ответа",
    scale_max: 5,
    prompt:
      "Как быстро администратор отвечал клиенту в этот день. 5 — каждый ответ в течение 15 минут в рабочее время; 3 — были ожидания до часа; 1 — клиент ждал больше часа или остался без ответа. Ночные сообщения (после 21:00) с ответом утром не снижают оценку.",
  },
  {
    name: "Работа по скрипту",
    scale_max: 10,
    prompt:
      "Насколько ответы администратора соответствуют скриптам студии из базы знаний: тон, структура, факты (цены, условия, акции — только из базы), отработка возражений по скрипту возражений. Не применим, если администратор за день ничего не писал.",
  },
  {
    name: "Ведение к следующему шагу",
    scale_max: 10,
    prompt:
      "Каждый ответ ведёт клиента к следующему шагу: записаться на пробное, подтвердить время, прийти, купить абонемент. 10 — разговор закончился конкретной договорённостью (день и время, напоминание, задача); 5 — ответил по делу, но без предложения и вопроса; 1 — разговор брошен. Не применим к сервисным вопросам действующих клиентов.",
  },
  {
    name: "Сделка в CRM",
    scale_max: 5,
    prompt:
      "Соответствует ли этап сделки состоянию разговора по правилам воронки и есть ли следующий шаг (задача с датой или перевод на этап). 5 — всё отмечено в тот же день; 3 — этап верный, но нет задачи; 1 — сделка не переведена или брошена.",
  },
];

export default function Criteria() {
  const [items, setItems] = useState<CrmCriterion[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState<{ name: string; prompt: string; scale_max: number } | null>(null);

  const load = () =>
    api
      .listCrmCriteria()
      .then(setItems)
      .catch((e) => {
        setItems([]);
        setError(String(e).replace(/^Error:\s*/, ""));
      });

  useEffect(() => {
    load();
  }, []);

  const activeCount = items?.filter((c) => c.active).length ?? 0;
  const taken = new Set((items ?? []).map((c) => c.name.trim().toLowerCase()));
  const remaining = EXAMPLES.filter((ex) => !taken.has(ex.name.trim().toLowerCase()));

  return (
    <div className="crm-criteria">
      <div className="crm-criteria-head">
        <p className="muted tab-hint">
          Критерий — поле: название видно в разборах и статистике, текст — что именно проверять и
          за что снижать оценку. Правки применяются к следующему разбору; прошлый день можно
          «Разобрать заново».
        </p>
        {!creating && items !== null && (
          <button type="button" onClick={() => setCreating({ name: "", prompt: "", scale_max: 10 })}>
            Добавить критерий
          </button>
        )}
      </div>

      {error && <Note kind="error">{error}</Note>}
      {items !== null && items.length > 0 && activeCount === 0 && (
        <Note kind="error">Все критерии отключены — в разборах не будет оценок. Включите хотя бы один.</Note>
      )}

      {creating && (
        <Editor
          initial={creating}
          onDone={() => {
            setCreating(null);
            load();
          }}
          onCancel={() => setCreating(null)}
        />
      )}

      {items === null && <Skeleton count={2} height={120} />}

      {items !== null && items.length === 0 && !creating && (
        <Empty title="Критериев пока нет">
          Начните с готовых — ниже четыре примера, каждый можно поправить под себя.
        </Empty>
      )}

      {items?.map((c) => (
        <Card key={c.id} criterion={c} onChanged={load} />
      ))}

      {/* Примеры остаются, пока не взяты все: после первого сохранённого
          критерия остальные нужны так же. */}
      {items !== null && remaining.length > 0 && !creating && (
        <div className="crm-examples">
          {items.length > 0 && <h4 className="crm-amo-title">Ещё готовые примеры</h4>}
          {remaining.map((ex) => (
            <div key={ex.name} className="sheet sheet-pad crm-example">
              <div className="metric-card-head">
                <strong className="metric-card-name">{ex.name}</strong>
                <span className="muted">{ex.scale_max}-балльная</span>
                <div className="actions push">
                  <button type="button" className="secondary small" onClick={() => setCreating(ex)}>
                    Взять за основу
                  </button>
                </div>
              </div>
              <p className="crm-example-text">{ex.prompt}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Editor({
  criterion,
  initial,
  onDone,
  onCancel,
}: {
  criterion?: CrmCriterion;
  initial?: { name: string; prompt: string; scale_max: number };
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(criterion?.name ?? initial?.name ?? "");
  const [prompt, setPrompt] = useState(criterion?.prompt ?? initial?.prompt ?? "");
  const [scale, setScale] = useState(criterion?.scale_max ?? initial?.scale_max ?? 10);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      if (criterion) await api.updateCrmCriterion(criterion.id, { name, prompt, scale_max: scale });
      else await api.createCrmCriterion({ name, prompt, scale_max: scale });
      onDone();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
      setSaving(false);
    }
  };

  return (
    <div className="sheet sheet-pad metric-editor">
      <h4 className="editor-title">{criterion ? "Редактирование критерия" : "Новый критерий"}</h4>
      <div className="field-row">
        <label className="field field-grow">
          <span className="label">Название — видно в разборах и статистике</span>
          <input
            type="text"
            value={name}
            placeholder="Например: Скорость ответа"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="label">Шкала оценки</span>
          <select value={scale} onChange={(e) => setScale(Number(e.target.value))}>
            <option value={5}>5-балльная</option>
            <option value={10}>10-балльная</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span className="label">Что проверять — когда критерий применим, за что снижать оценку</span>
        <textarea
          className="prompt-editor crm-criterion-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          spellCheck={false}
        />
      </label>
      {error && <Note kind="error">{error}</Note>}
      <div className="actions">
        <button type="button" onClick={save} disabled={saving || name.trim().length < 2}>
          {saving ? "Сохранение…" : "Сохранить"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  );
}

function Card({ criterion, onChanged }: { criterion: CrmCriterion; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");

  if (editing) {
    return (
      <Editor
        criterion={criterion}
        onDone={() => {
          setEditing(false);
          onChanged();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const patch = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const lines = criterion.prompt.split("\n").length;

  return (
    <div className={`sheet sheet-pad metric-card ${criterion.active ? "" : "is-off"}`}>
      <div className="metric-card-head">
        <strong className="metric-card-name">{criterion.name}</strong>
        <span className={`pill ${criterion.active ? "sale" : "irrelevant"}`}>
          {criterion.active ? "Активен" : "Отключён"}
        </span>
        <span className="muted">
          {criterion.scale_max}-балльная
          {criterion.prompt ? ` · ${lines} ${plural(lines, "строка", "строки", "строк")}` : " · без описания"}
        </span>
        <div className="actions push">
          <button type="button" className="secondary small" onClick={() => setEditing(true)}>
            Редактировать
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={() => patch(() => api.updateCrmCriterion(criterion.id, { active: !criterion.active }))}
          >
            {criterion.active ? "Отключить" : "Включить"}
          </button>
          <ConfirmAction
            small
            label="Удалить"
            confirmLabel="Удалить навсегда"
            title="Удалить критерий и все его оценки в прошлых разборах. Чтобы сохранить историю — отключите."
            onConfirm={() => patch(() => api.deleteCrmCriterion(criterion.id))}
          />
        </div>
      </div>
      {criterion.prompt && <pre className="prompt-preview open crm-criterion-preview">{criterion.prompt}</pre>}
      {error && <Note kind="error">{error}</Note>}
    </div>
  );
}
