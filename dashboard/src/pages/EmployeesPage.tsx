import { useEffect, useState } from "react";
import { api, Employee } from "../api";

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const load = () => {
    api.listEmployees().then(setEmployees).catch((e) => setError(String(e)));
  };

  useEffect(load, []);

  const add = async () => {
    const name = newName.trim();
    if (name.length < 2) return;
    setBusy(true);
    setError("");
    try {
      await api.createEmployee(name);
      setNewName("");
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (employee: Employee) => {
    setError("");
    try {
      await api.updateEmployee(employee.id, { active: !employee.active });
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  const saveName = async (employee: Employee) => {
    const name = editName.trim();
    if (name.length < 2) return;
    setError("");
    try {
      await api.updateEmployee(employee.id, { full_name: name });
      setEditingId(null);
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  const active = employees.filter((e) => e.active);

  return (
    <div>
      <h2>Менеджеры</h2>
      <p className="muted">
        Активные менеджеры появляются в выпадающем списке приложения записи —
        менеджер выбирает себя перед началом рабочего дня. Деактивированные
        сохраняются в системе: прошлые отчёты остаются подписаны их именем.
      </p>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <h4>Добавить менеджера</h4>
        <div style={{ display: "flex", gap: 12 }}>
          <input
            type="text"
            value={newName}
            placeholder="Имя и фамилия"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button onClick={add} disabled={busy || newName.trim().length < 2}>
            Добавить
          </button>
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Имя</th>
              <th>Статус</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {employees.map((employee) => (
              <tr key={employee.id}>
                <td>
                  {editingId === employee.id ? (
                    <input
                      type="text"
                      value={editName}
                      autoFocus
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && saveName(employee)}
                    />
                  ) : (
                    employee.full_name
                  )}
                </td>
                <td>
                  {employee.active ? (
                    <span className="badge sale">Активен</span>
                  ) : (
                    <span className="badge irrelevant">Отключён</span>
                  )}
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {editingId === employee.id ? (
                    <>
                      <button onClick={() => saveName(employee)} style={{ marginRight: 8 }}>
                        Сохранить
                      </button>
                      <button className="secondary" onClick={() => setEditingId(null)}>
                        Отмена
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="secondary"
                        style={{ marginRight: 8 }}
                        onClick={() => {
                          setEditingId(employee.id);
                          setEditName(employee.full_name);
                        }}
                      >
                        Переименовать
                      </button>
                      <button className="secondary" onClick={() => toggleActive(employee)}>
                        {employee.active ? "Деактивировать" : "Активировать"}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  Менеджеры пока не заведены.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {employees.length > 0 && active.length === 0 && (
        <div className="error">
          Нет ни одного активного менеджера — приложение записи не сможет
          предложить выбор.
        </div>
      )}
    </div>
  );
}
