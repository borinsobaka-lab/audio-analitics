/** Сотрудники: и список для приложения на ресепшене, и пользователи админки.
 *
 *  Одна строка — один человек. Разделять «менеджера» и «пользователя» было бы
 *  честнее на бумаге и хуже в жизни: доступ «вижу только свои записи» держится
 *  ровно на том, что вошедший — тот самый менеджер, чьё имя стоит на смене.
 */
import { useEffect, useState } from "react";
import { api, Employee, EmployeeCredentials, fmtWhen } from "../api";
import { ConfirmAction, Empty, Note, PageHead, Skeleton, TableCard } from "../components/ui";
import { useSession } from "../session";

export default function EmployeesPage() {
  const me = useSession();
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<EmployeeCredentials | null>(null);

  const load = () => {
    api
      .listEmployees()
      .then(setEmployees)
      .catch((e) => {
        setEmployees([]);
        setError(String(e));
      });
  };

  useEffect(load, []);

  /** Любое изменение доступа может вернуть новый пароль — его показывают
   *  один раз, поэтому обработчик один на все действия. */
  const run = async (fn: () => Promise<EmployeeCredentials | void>) => {
    setError("");
    try {
      const result = await fn();
      if (result && result.password) setIssued(result);
      load();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const active = employees?.filter((e) => e.active) ?? [];

  return (
    <div>
      <PageHead
        title="Сотрудники"
        hint="Активные сотрудники появляются в выпадающем списке приложения — менеджер выбирает себя перед началом смены. Здесь же выдаётся доступ в админку: логин, пароль и то, чьи смены человек видит."
      />

      {error && <Note kind="error">{error}</Note>}
      {employees !== null && employees.length > 0 && active.length === 0 && (
        <Note kind="error">
          Нет ни одного активного сотрудника — приложение на ресепшене не сможет
          предложить выбор перед началом смены.
        </Note>
      )}

      {issued && <Credentials data={issued} onClose={() => setIssued(null)} />}

      <AddEmployee onSubmit={(body) => run(() => api.createEmployee(body))} />

      {employees === null && <Skeleton count={3} height={48} />}

      {employees !== null && employees.length === 0 && !error && (
        <Empty title="Сотрудники не заведены">
          Добавьте тех, кто работает у стойки — их имена появятся в приложении
          записи и будут подписывать разборы смен.
        </Empty>
      )}

      {employees !== null && employees.length > 0 && (
        <TableCard
          columns={[
            { label: "Имя", className: "col-name" },
            { label: "Доступ в админку" },
            { label: "Видит смены" },
            { label: "Статус" },
            { label: "", className: "col-row-actions" },
          ]}
        >
          {employees.map((employee) => (
            <EmployeeRow
              key={employee.id}
              employee={employee}
              isMe={employee.id === me.employee_id}
              onRun={run}
            />
          ))}
        </TableCard>
      )}
    </div>
  );
}

/** Пароль виден ровно один раз. Дальше в базе только хеш, и «посмотреть
 *  ещё раз» невозможно даже владельцу — можно лишь выдать новый. */
function Credentials({
  data,
  onClose,
}: {
  data: EmployeeCredentials;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        `Логин: ${data.login}\nПароль: ${data.password}`
      );
      setCopied(true);
    } catch {
      // Буфер обмена может быть недоступен — пароль на экране, перепишут.
      setCopied(false);
    }
  };

  return (
    <div className="sheet sheet-pad creds">
      <div className="creds-head">
        <strong>Пароль для {data.employee.full_name}</strong>
        <span className="muted">
          Показывается один раз — скопируйте и передайте сотруднику
        </span>
      </div>
      <div className="creds-body">
        <div className="creds-pair">
          <span className="label">Логин</span>
          <code>{data.login}</code>
        </div>
        <div className="creds-pair">
          <span className="label">Пароль</span>
          <code>{data.password}</code>
        </div>
        <div className="actions push">
          <button className="secondary small" onClick={copy}>
            {copied ? "Скопировано" : "Скопировать"}
          </button>
          <button className="ghost small" onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}

function AddEmployee({
  onSubmit,
}: {
  onSubmit: (body: {
    full_name: string;
    login?: string | null;
    access_scope?: "own" | "all";
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [scope, setScope] = useState<"own" | "all">("own");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (name.trim().length < 2 || busy) return;
    setBusy(true);
    await onSubmit({
      full_name: name.trim(),
      login: login.trim() || null,
      access_scope: scope,
    });
    setName("");
    setLogin("");
    setScope("own");
    setBusy(false);
  };

  return (
    <div className="sheet sheet-pad form-card">
      <span className="label form-label">Добавить сотрудника</span>
      <div className="field-row">
        <label className="field field-grow">
          <span className="label">Имя и фамилия</span>
          <input
            type="text"
            value={name}
            placeholder="Например: Анна Гелашвили"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </label>
        <label className="field">
          <span className="label">Логин — необязательно</span>
          <input
            type="text"
            value={login}
            placeholder="anna"
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(e) => setLogin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </label>
        <label className="field">
          <span className="label">Видит смены</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as "own" | "all")}
          >
            <option value="own">только свои</option>
            <option value="all">все</option>
          </select>
        </label>
        <button onClick={add} disabled={busy || name.trim().length < 2}>
          Добавить
        </button>
      </div>
      <p className="muted form-hint">
        Без логина сотрудник существует только в приложении записи. С логином
        сразу выдаётся пароль — он покажется один раз.
      </p>
    </div>
  );
}

function EmployeeRow({
  employee,
  isMe,
  onRun,
}: {
  employee: Employee;
  isMe: boolean;
  onRun: (fn: () => Promise<EmployeeCredentials | void>) => Promise<void>;
}) {
  const [editing, setEditing] = useState<"name" | "login" | null>(null);
  const [draft, setDraft] = useState("");

  const start = (what: "name" | "login") => {
    setEditing(what);
    setDraft(what === "name" ? employee.full_name : employee.login ?? "");
  };

  const commit = async () => {
    const value = draft.trim();
    if (editing === "name" && value.length >= 2) {
      await onRun(() => api.updateEmployee(employee.id, { full_name: value }));
    }
    if (editing === "login") {
      await onRun(() => api.updateEmployee(employee.id, { login: value }));
    }
    setEditing(null);
  };

  const inlineInput = (
    <input
      type="text"
      value={draft}
      autoFocus
      className="input-inline"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(null);
      }}
    />
  );

  return (
    <tr>
      <td className="col-name">
        {editing === "name" ? inlineInput : employee.full_name}
        {isMe && <span className="muted"> · это вы</span>}
      </td>

      <td className="col-access">
        {editing === "login" ? (
          inlineInput
        ) : (
          <>
            <div>
              {employee.login ? (
                <span className="mono">{employee.login}</span>
              ) : (
                <span className="muted">нет доступа</span>
              )}
              {employee.login && employee.last_login_at && (
                <span className="muted nowrap">
                  {" "}
                  · вход {fmtWhen(employee.last_login_at)}
                </span>
              )}
            </div>
            {/* Логин и пароль — про доступ, поэтому кнопки стоят в той же
                ячейке, а не в общем ряду действий: иначе строка расползается
                на пять кнопок и таблицу приходится листать вбок. */}
            <div className="actions tight">
              <button className="ghost small" onClick={() => start("login")}>
                {employee.login ? "Сменить логин" : "Выдать доступ"}
              </button>
              {employee.login && (
                <ConfirmAction
                  small
                  label="Сбросить пароль"
                  confirmLabel="Выдать новый"
                  title="Старый пароль перестанет работать, сотрудник выйдет из админки"
                  onConfirm={() => onRun(() => api.resetEmployeePassword(employee.id))}
                />
              )}
            </div>
          </>
        )}
      </td>

      <td>
        {/* Право на этот раздел выведено из области видимости, поэтому
            переключатель здесь один, а не два рассогласованных. */}
        <select
          className="select-inline"
          value={employee.access_scope}
          disabled={isMe}
          title={
            isMe
              ? "Нельзя снять доступ с самого себя"
              : "«Все» — это ещё и право заводить сотрудников и править метрики"
          }
          onChange={(e) =>
            onRun(() =>
              api.updateEmployee(employee.id, {
                access_scope: e.target.value as "own" | "all",
              })
            )
          }
        >
          <option value="own">только свои</option>
          <option value="all">все · администратор</option>
        </select>
      </td>

      <td>
        <span className={`pill ${employee.active ? "sale" : "irrelevant"}`}>
          {employee.active ? "Активен" : "Отключён"}
        </span>
      </td>

      <td className="col-row-actions">
        <div className="actions end">
          {editing ? (
            <>
              <button className="small" onClick={commit}>
                Сохранить
              </button>
              <button className="ghost small" onClick={() => setEditing(null)}>
                Отмена
              </button>
            </>
          ) : (
            <>
              <button className="ghost small" onClick={() => start("name")}>
                Переименовать
              </button>
              {!isMe && (
                <button
                  className="ghost small"
                  onClick={() =>
                    onRun(() =>
                      api.updateEmployee(employee.id, { active: !employee.active })
                    )
                  }
                >
                  {employee.active ? "Отключить" : "Включить"}
                </button>
              )}
              {/* Удаление доступно, только пока за человеком нет смен: иначе
                  сервер откажет и предложит отключение — прошлые разборы не
                  должны остаться без имени. */}
              {!isMe && (
                <ConfirmAction
                  small
                  label="Удалить"
                  confirmLabel="Удалить совсем"
                  title="Удалить сотрудника — возможно, пока за ним нет ни одной смены"
                  onConfirm={() => onRun(() => api.deleteEmployee(employee.id))}
                />
              )}
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
