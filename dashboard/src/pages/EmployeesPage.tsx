/** Сотрудники — общие для всех продуктов админки.
 *
 *  Один человек — один вход: вошёл и видит и «Скрипты», и «Аналитику». Права
 *  у продуктов свои и настраиваются по отдельности:
 *  - Скрипты — читать и копировать или ещё и править;
 *  - Аналитика — чьи смены видно: только свои или все (и тогда человек
 *    администратор: сотрудники, метрики, точки, приложение);
 *  - CRM — разборы своих сделок или все сделки и настройка продукта.
 *
 *  Та же строка — и имя в приложении записи на ресепшене: доступ «вижу только
 *  свои смены» держится на том, что вошедший — тот самый менеджер, чьё имя
 *  стоит на смене. За студией никто не закреплён.
 *
 *  Всё про одного человека правится в одном окне: раньше доступ, логин и
 *  пароль были раскиданы кнопками по ячейкам таблицы, и строка расползалась.
 */
import { ReactNode, useEffect, useRef, useState } from "react";
import { api, CrmAccess, Employee, EmployeeCredentials, fmtWhen, ScriptsAccess } from "../api";
import { NavIcons } from "../components/navIcons";
import { ConfirmAction, Empty, Note, PageHead, Skeleton, TableCard } from "../components/ui";
import { useSession } from "../session";

type Scope = "own" | "all";

export default function EmployeesPage() {
  const me = useSession();
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [error, setError] = useState("");
  // null — окно закрыто; "new" — новый сотрудник; иначе — чей доступ правим.
  const [open, setOpen] = useState<Employee | "new" | null>(null);

  const load = () =>
    api
      .listEmployees()
      .then((list) => {
        setEmployees(list);
        return list;
      })
      .catch((e) => {
        setEmployees([]);
        setError(String(e).replace(/^Error:\s*/, ""));
        return [] as Employee[];
      });

  useEffect(() => {
    load();
  }, []);

  const active = employees?.filter((e) => e.active) ?? [];

  return (
    <div>
      <PageHead
        title="Сотрудники"
        hint="Один вход — во все продукты. Права у каждого продукта свои: в скриптах — читать или править, в аналитике — чьи смены видно, в CRM — чьи сделки. Активные сотрудники появляются в приложении записи на всех студиях."
      >
        <button type="button" onClick={() => setOpen("new")}>
          Добавить сотрудника
        </button>
      </PageHead>

      {error && <Note kind="error">{error}</Note>}
      {employees !== null && employees.length > 0 && active.length === 0 && (
        <Note kind="error">
          Нет ни одного активного сотрудника — приложение на ресепшене не сможет
          предложить выбор перед началом смены.
        </Note>
      )}

      {employees === null && <Skeleton count={3} height={56} />}

      {employees !== null && employees.length === 0 && !error && (
        <Empty title="Сотрудники не заведены">
          Добавьте тех, кто работает у стойки: их имена появятся в приложении
          записи, а с логином — и вход в админку.
        </Empty>
      )}

      {employees !== null && employees.length > 0 && (
        <TableCard
          columns={[
            { label: "Сотрудник", className: "col-name" },
            { label: "Скрипты" },
            { label: "Аналитика" },
            { label: "CRM" },
            { label: "Статус" },
            { label: "", className: "col-row-actions" },
          ]}
        >
          {employees.map((employee) => (
            <tr
              key={employee.id}
              className="row-click"
              onClick={() => setOpen(employee)}
            >
              <td className="col-name">
                <div className="person">
                  <span className="person-name">
                    {employee.full_name}
                    {employee.id === me.employee_id && (
                      <span className="muted"> · это вы</span>
                    )}
                  </span>
                  <span className="muted">
                    {employee.login ? (
                      <>
                        <span className="mono">{employee.login}</span>
                        {employee.last_login_at &&
                          ` · вход ${fmtWhen(employee.last_login_at)}`}
                      </>
                    ) : (
                      "без входа в админку — только в приложении записи"
                    )}
                  </span>
                </div>
              </td>
              <td>
                {employee.login ? (
                  <ScriptsChip value={employee.scripts_access} />
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                {employee.login ? (
                  <ScopeChip value={employee.access_scope} />
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                {employee.login ? (
                  <CrmChip value={employee.crm_access ?? "own"} />
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                <span className={`pill ${employee.active ? "sale" : "irrelevant"}`}>
                  {employee.active ? "Активен" : "Отключён"}
                </span>
              </td>
              <td className="col-row-actions">
                <button
                  type="button"
                  className="secondary small"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(employee);
                  }}
                >
                  Доступ
                </button>
              </td>
            </tr>
          ))}
        </TableCard>
      )}

      {open && (
        <AccessDialog
          key={open === "new" ? "new" : open.id}
          employee={open === "new" ? null : open}
          isMe={open !== "new" && open.id === me.employee_id}
          onChanged={load}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function ScriptsChip({ value }: { value: ScriptsAccess }) {
  return value === "edit" ? (
    <span className="access-chip on">Правка</span>
  ) : (
    <span className="access-chip">Чтение</span>
  );
}

function CrmChip({ value }: { value: CrmAccess }) {
  return value === "all" ? (
    <span className="access-chip on">Все сделки · настройки</span>
  ) : (
    <span className="access-chip">Свои сделки</span>
  );
}

function ScopeChip({ value }: { value: Scope }) {
  return value === "all" ? (
    <span className="access-chip on">Все смены · админ</span>
  ) : (
    <span className="access-chip">Свои смены</span>
  );
}

/* --- Окно доступа -------------------------------------------------------- */

interface Draft {
  full_name: string;
  active: boolean;
  hasLogin: boolean;
  login: string;
  scripts_access: ScriptsAccess;
  access_scope: Scope;
  crm_access: CrmAccess;
}

function draftOf(employee: Employee | null): Draft {
  return {
    full_name: employee?.full_name ?? "",
    active: employee?.active ?? true,
    hasLogin: employee ? Boolean(employee.login) : true,
    login: employee?.login ?? "",
    scripts_access: employee?.scripts_access ?? "read",
    access_scope: employee?.access_scope ?? "own",
    crm_access: employee?.crm_access ?? "own",
  };
}

/** Окно на нативном <dialog>: фокус внутри, Esc, подложка и порядок
 *  табуляции достаются от браузера, своя ловушка фокуса не нужна. */
function AccessDialog({
  employee,
  isMe,
  onChanged,
  onClose,
}: {
  employee: Employee | null;
  isMe: boolean;
  onChanged: () => Promise<Employee[]>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(employee));
  const [current, setCurrent] = useState<Employee | null>(employee);
  const [issued, setIssued] = useState<EmployeeCredentials | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isNew = current === null;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const set = (fields: Partial<Draft>) => setDraft((d) => ({ ...d, ...fields }));

  const name = draft.full_name.trim();
  const login = draft.login.trim();
  const invalid =
    name.length < 2
      ? "Имя — не короче двух букв"
      : draft.hasLogin && login.length < 3
        ? "Логин — не короче трёх символов"
        : "";

  async function act(fn: () => Promise<EmployeeCredentials | void>) {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      await onChanged();
      if (result) {
        setCurrent(result.employee);
        setDraft(draftOf(result.employee));
        if (result.password) {
          // Пароль виден ровно один раз — окно не закрывается, пока его не
          // скопировали и не нажали «Готово».
          setIssued(result);
          return;
        }
      }
      onClose();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (invalid || busy) return;
    if (isNew) {
      act(() =>
        api.createEmployee({
          full_name: name,
          login: draft.hasLogin ? login : null,
          access_scope: draft.access_scope,
          scripts_access: draft.scripts_access,
          crm_access: draft.crm_access,
        })
      );
      return;
    }
    const base = draftOf(current);
    const body: Parameters<typeof api.updateEmployee>[1] = {};
    if (name !== base.full_name) body.full_name = name;
    if (draft.active !== base.active) body.active = draft.active;
    if (draft.scripts_access !== base.scripts_access) body.scripts_access = draft.scripts_access;
    if (draft.access_scope !== base.access_scope) body.access_scope = draft.access_scope;
    if (draft.crm_access !== base.crm_access) body.crm_access = draft.crm_access;
    const nextLogin = draft.hasLogin ? login : "";
    if (nextLogin !== (current?.login ?? "")) body.login = nextLogin;
    if (!Object.keys(body).length) {
      onClose();
      return;
    }
    act(() => api.updateEmployee(current!.id, body));
  }

  const loginOff = !draft.hasLogin;

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="access-title"
      onClose={onClose}
      onClick={(e) => {
        // Клик по подложке — мимо окна: закрыть, как Esc.
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <div className="modal-head">
        <div>
          <h2 id="access-title">
            {isNew ? "Новый сотрудник" : current!.full_name}
            {isMe && <span className="muted modal-me"> · это вы</span>}
          </h2>
          {!isNew && (
            <p className="muted">
              {current!.login
                ? `Вход: ${current!.login}${
                    current!.last_login_at ? ` · последний ${fmtWhen(current!.last_login_at)}` : ""
                  }`
                : "Без входа в админку"}
            </p>
          )}
        </div>
        <button
          type="button"
          className="ghost small icon-btn"
          aria-label="Закрыть"
          onClick={() => ref.current?.close()}
        >
          ✕
        </button>
      </div>

      {issued ? (
        <div className="modal-body">
          <Issued data={issued} />
          <div className="modal-foot">
            <button type="button" onClick={() => ref.current?.close()}>
              Готово
            </button>
          </div>
        </div>
      ) : (
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <section className="modal-section">
            <label className="field">
              <span className="label">Имя и фамилия</span>
              <input
                type="text"
                value={draft.full_name}
                autoFocus={isNew}
                placeholder="Например: Анна Гелашвили"
                onChange={(e) => set({ full_name: e.target.value })}
              />
            </label>

            <Toggle
              checked={draft.hasLogin}
              onChange={(v) => set({ hasLogin: v })}
              title="Вход в админку"
              hint={
                draft.hasLogin
                  ? isNew || !current?.login
                    ? "После сохранения покажем пароль — один раз, его нужно передать сотруднику."
                    : "Логин и пароль на все продукты сразу."
                  : current?.login
                    ? "Вход пропадёт после сохранения, открытые сессии закончатся. Имя останется в приложении записи."
                    : "Сотрудник есть только в приложении записи на ресепшене."
              }
              disabled={isMe}
            />
            {draft.hasLogin && (
              <div className="login-row">
                <label className="field grow">
                  <span className="label">Логин</span>
                  <input
                    type="text"
                    value={draft.login}
                    placeholder="anna"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ login: e.target.value })}
                  />
                </label>
                {current?.login && (
                  <div className="login-reset">
                    <ConfirmAction
                      small
                      label="Сбросить пароль"
                      confirmLabel="Выдать новый"
                      title="Старый пароль перестанет работать, сотрудник выйдет из админки"
                      onConfirm={() => act(() => api.resetEmployeePassword(current.id))}
                    />
                  </div>
                )}
              </div>
            )}
          </section>

          <section className={`modal-section${loginOff ? " dimmed" : ""}`}>
            <h3 className="modal-section-title">Права в продуктах</h3>
            {loginOff && (
              <p className="muted modal-hint">
                Права начнут действовать, когда у сотрудника появится вход.
              </p>
            )}

            <ProductAccess
              icon={<NavIcons.allScripts size={22} />}
              title="Скрипты"
              name="scripts_access"
              value={draft.scripts_access}
              onChange={(v) => set({ scripts_access: v as ScriptsAccess })}
              options={[
                {
                  value: "read",
                  title: "Чтение",
                  text: "Ищет, читает и копирует скрипты в чат.",
                },
                {
                  value: "edit",
                  title: "Чтение и правка",
                  text: "Ещё добавляет, меняет и удаляет скрипты и разделы.",
                },
              ]}
            />

            <ProductAccess
              icon={<NavIcons.metrics size={22} />}
              title="Аналитика"
              name="access_scope"
              value={draft.access_scope}
              onChange={(v) => set({ access_scope: v as Scope })}
              disabled={isMe}
              disabledHint="Доступ ко всем сменам с самого себя снять нельзя — иначе вернуть его сможет только владелец."
              options={[
                {
                  value: "own",
                  title: "Только свои смены",
                  text: "Видит разборы смен, где стоит его имя. Ничего не настраивает.",
                },
                {
                  value: "all",
                  title: "Все смены · администратор",
                  text: "Видит все смены и настраивает систему: сотрудники, метрики, точки, приложение.",
                },
              ]}
            />

            <ProductAccess
              icon={<NavIcons.crm size={22} />}
              title="CRM"
              name="crm_access"
              value={draft.crm_access}
              onChange={(v) => set({ crm_access: v as CrmAccess })}
              options={[
                {
                  value: "own",
                  title: "Только свои сделки",
                  text: "Видит разборы сделок, которые вёл сам, и свою статистику.",
                },
                {
                  value: "all",
                  title: "Все сделки · настройки",
                  text: "Видит все разборы и итоги дня, настраивает критерии, промпт и интеграцию.",
                },
              ]}
            />
          </section>

          {!isNew && !isMe && (
            <section className="modal-section">
              <Toggle
                checked={draft.active}
                onChange={(v) => set({ active: v })}
                title="Работает в студии"
                hint={
                  draft.active
                    ? "Есть в приложении записи на всех студиях."
                    : "Пропадёт из приложения записи и потеряет вход. Прошлые разборы останутся с его именем."
                }
              />
              <div className="modal-danger">
                <ConfirmAction
                  small
                  label="Удалить сотрудника"
                  confirmLabel="Удалить совсем"
                  title="Удалить можно, пока за сотрудником нет ни одной смены"
                  onConfirm={() =>
                    act(async () => {
                      await api.deleteEmployee(current!.id);
                    })
                  }
                />
                <span className="muted">
                  Только пока за ним нет смен — иначе отключите.
                </span>
              </div>
            </section>
          )}

          {error && <Note kind="error">{error}</Note>}

          <div className="modal-foot">
            {invalid && draft.full_name && <span className="muted">{invalid}</span>}
            <button type="button" className="ghost" onClick={() => ref.current?.close()}>
              Отмена
            </button>
            <button type="submit" disabled={Boolean(invalid) || busy}>
              {busy ? "Сохраняем…" : isNew ? "Добавить" : "Сохранить"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/** Право в одном продукте: два варианта плитками, а не выпадающий список —
 *  оба видны сразу, вместе с тем, что каждый из них разрешает. */
function ProductAccess({
  icon,
  title,
  name,
  value,
  onChange,
  options,
  disabled = false,
  disabledHint,
}: {
  icon: ReactNode;
  title: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; title: string; text: string }[];
  disabled?: boolean;
  disabledHint?: string;
}) {
  return (
    <fieldset className="product-access" disabled={disabled}>
      <legend className="product-access-head">
        <span className="product-access-icon" aria-hidden="true">
          {icon}
        </span>
        {title}
      </legend>
      <div className="choices">
        {options.map((o) => (
          <label key={o.value} className={`choice${value === o.value ? " on" : ""}`}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span className="choice-title">{o.title}</span>
            <span className="choice-text">{o.text}</span>
          </label>
        ))}
      </div>
      {disabled && disabledHint && <p className="muted modal-hint">{disabledHint}</p>}
    </fieldset>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle${disabled ? " disabled" : ""}`}>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="toggle-title">{title}</span>
        <span className="toggle-hint">{hint}</span>
      </span>
    </label>
  );
}

/** Пароль виден ровно один раз. Дальше в базе только хеш, и «посмотреть
 *  ещё раз» невозможно даже владельцу — можно лишь выдать новый. */
function Issued({ data }: { data: EmployeeCredentials }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`Логин: ${data.login}\nПароль: ${data.password}`);
      setCopied(true);
    } catch {
      // Буфер обмена может быть недоступен — пароль на экране, перепишут.
      setCopied(false);
    }
  };

  return (
    <div className="issued">
      <h3 className="modal-section-title">Пароль для {data.employee.full_name}</h3>
      <p className="muted">
        Показывается один раз — скопируйте и передайте сотруднику. Вход
        работает во всех продуктах.
      </p>
      <div className="creds-body">
        <div className="creds-pair">
          <span className="label">Логин</span>
          <code>{data.login}</code>
        </div>
        <div className="creds-pair">
          <span className="label">Пароль</span>
          <code>{data.password}</code>
        </div>
        <button type="button" className="secondary small" onClick={copy}>
          {copied ? "Скопировано" : "Скопировать"}
        </button>
      </div>
    </div>
  );
}
