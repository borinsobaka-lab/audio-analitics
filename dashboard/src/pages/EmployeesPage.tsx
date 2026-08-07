import { useEffect, useState } from "react";
import { api, Employee } from "../api";
import { Empty, Note, PageHead, Skeleton } from "../components/ui";

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

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

  const patch = async (id: string, body: { full_name?: string; active?: boolean }) => {
    setError("");
    try {
      await api.updateEmployee(id, body);
      setEditingId(null);
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  const active = employees?.filter((e) => e.active) ?? [];

  return (
    <div>
      <PageHead
        title="Менеджеры"
        hint="Активные менеджеры появляются в выпадающем списке приложения — менеджер выбирает себя перед началом смены. Отключённые остаются в системе: прошлые разборы остаются подписаны их именем."
      />

      {error && <Note kind="error">{error}</Note>}
      {employees !== null && employees.length > 0 && active.length === 0 && (
        <Note kind="error">
          Нет ни одного активного менеджера — приложение на ресепшене не сможет
          предложить выбор перед началом смены.
        </Note>
      )}

      <div className="sheet sheet-pad" style={{ marginBottom: 16 }}>
        <span className="label" style={{ display: "block", marginBottom: 8 }}>
          Добавить менеджера
        </span>
        <div style={{ display: "flex", gap: 10, maxWidth: 460 }}>
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

      {employees === null && <Skeleton count={3} height={48} />}

      {employees !== null && employees.length === 0 && !error && (
        <Empty title="Менеджеры не заведены">
          Добавьте тех, кто работает у стойки — их имена появятся в приложении
          записи и будут подписывать разборы смен.
        </Empty>
      )}

      {employees !== null && employees.length > 0 && (
        <div className="sheet table-wrap">
          <table>
            <thead>
              <tr>
                <th>Имя</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {employees.map((employee) => (
                <tr key={employee.id}>
                  <td style={{ width: "45%" }}>
                    {editingId === employee.id ? (
                      <input
                        type="text"
                        value={editName}
                        autoFocus
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && editName.trim().length >= 2)
                            patch(employee.id, { full_name: editName.trim() });
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        style={{ maxWidth: 300 }}
                      />
                    ) : (
                      employee.full_name
                    )}
                  </td>
                  <td>
                    <span className={`pill ${employee.active ? "sale" : "irrelevant"}`}>
                      {employee.active ? "Активен" : "Отключён"}
                    </span>
                  </td>
                  <td>
                    <div className="actions" style={{ justifyContent: "flex-end" }}>
                      {editingId === employee.id ? (
                        <>
                          <button
                            className="small"
                            disabled={editName.trim().length < 2}
                            onClick={() => patch(employee.id, { full_name: editName.trim() })}
                          >
                            Сохранить
                          </button>
                          <button className="ghost small" onClick={() => setEditingId(null)}>
                            Отмена
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="ghost small"
                            onClick={() => {
                              setEditingId(employee.id);
                              setEditName(employee.full_name);
                            }}
                          >
                            Переименовать
                          </button>
                          <button
                            className="ghost small"
                            onClick={() => patch(employee.id, { active: !employee.active })}
                          >
                            {employee.active ? "Отключить" : "Включить"}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
