/** Точки продажи — студии сети.
 *
 *  Одна точка = одна студия = один ресепшен с компьютером. Раздел существует
 *  ради приложения записи: раньше сотрудник вводил там адрес сервера и ключ
 *  устройства — две строки с чужих слов, и любая опечатка выглядела как
 *  «сервер недоступен». Теперь точки заводятся здесь, а приложение показывает
 *  их списком: выбрал свою студию — и больше не возвращается к настройкам.
 */
import { useEffect, useState } from "react";
import { api, Location } from "../api";
import { ConfirmAction, Empty, Note, PageHead, Skeleton, TableCard } from "../components/ui";

export default function LocationsPage() {
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    api
      .listLocations()
      .then(setLocations)
      .catch((e) => {
        setLocations([]);
        setError(String(e));
      });
  };

  useEffect(load, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      load();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const add = async () => {
    if (name.trim().length < 2 || busy) return;
    setBusy(true);
    await run(() =>
      api.createLocation({ name: name.trim(), address: address.trim() })
    );
    setName("");
    setAddress("");
    setBusy(false);
  };

  const open = locations?.filter((l) => l.active) ?? [];

  return (
    <div>
      <PageHead
        title="Точки продажи"
        hint="Студия и её ресепшен. В приложении записи точка выбирается один раз при установке — больше никаких настроек у сотрудника нет. Сотрудники к точкам не привязаны: на любой студии в списке видны все. Закрытая точка исчезает из выбора, но её прошлые смены остаются в отчётах."
      />

      {error && <Note kind="error">{error}</Note>}
      {locations !== null && locations.length > 0 && open.length === 0 && (
        <Note kind="error">
          Все точки закрыты — приложению на ресепшене не из чего выбирать, и
          новая смена не начнётся.
        </Note>
      )}

      <div className="sheet sheet-pad form-card">
        <span className="label form-label">Добавить точку</span>
        <div className="field-row">
          <label className="field field-grow">
            <span className="label">Название студии</span>
            <input
              type="text"
              value={name}
              placeholder="Например: Ваке"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
          </label>
          <label className="field field-grow">
            <span className="label">Адрес — необязательно</span>
            <input
              type="text"
              value={address}
              placeholder="Тбилиси, ул. Чавчавадзе, 40"
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
          </label>
          <button onClick={add} disabled={busy || name.trim().length < 2}>
            Добавить
          </button>
        </div>
        <p className="muted form-hint">
          Название сотрудник увидит в приложении — пишите так, как студию
          называют между собой. Адрес помогает не перепутать две точки в одном
          районе.
        </p>
      </div>

      {locations === null && <Skeleton count={2} height={48} />}

      {locations !== null && locations.length === 0 && !error && (
        <Empty title="Точек продажи нет">
          Заведите первую студию — до этого приложение на ресепшене не сможет
          начать смену.
        </Empty>
      )}

      {locations !== null && locations.length > 0 && (
        <TableCard
          columns={[
            { label: "Студия", className: "col-name" },
            { label: "Адрес" },
            { label: "Смен", num: true },
            { label: "Статус" },
            { label: "", className: "col-row-actions" },
          ]}
        >
          {locations.map((location) => (
            <LocationRow key={location.id} location={location} onRun={run} />
          ))}
        </TableCard>
      )}
    </div>
  );
}

function LocationRow({
  location,
  onRun,
}: {
  location: Location;
  onRun: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState<"name" | "address" | null>(null);
  const [draft, setDraft] = useState("");

  const start = (what: "name" | "address") => {
    setEditing(what);
    setDraft(what === "name" ? location.name : location.address);
  };

  const commit = async () => {
    const value = draft.trim();
    if (editing === "name" && value.length < 2) return setEditing(null);
    await onRun(() =>
      api.updateLocation(
        location.id,
        editing === "name" ? { name: value } : { address: value }
      )
    );
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
        {editing === "name" ? inlineInput : <strong>{location.name}</strong>}
      </td>
      <td>
        {editing === "address" ? (
          inlineInput
        ) : location.address ? (
          location.address
        ) : (
          <span className="muted">не указан</span>
        )}
      </td>
      <td className="num-col">{location.shifts_count}</td>
      <td>
        <span className={`pill ${location.active ? "sale" : "irrelevant"}`}>
          {location.active ? "Работает" : "Закрыта"}
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
              <button className="ghost small" onClick={() => start("address")}>
                Адрес
              </button>
              <button
                className="ghost small"
                title={
                  location.active
                    ? "Убрать из выбора в приложении; смены и отчёты останутся"
                    : "Вернуть в выбор в приложении"
                }
                onClick={() =>
                  onRun(() =>
                    api.updateLocation(location.id, { active: !location.active })
                  )
                }
              >
                {location.active ? "Закрыть" : "Открыть"}
              </button>
              {/* Удаление доступно, только пока на точке нет смен — иначе
                  сервер откажет и предложит закрыть её. */}
              {location.shifts_count === 0 && (
                <ConfirmAction
                  small
                  label="Удалить"
                  confirmLabel="Удалить совсем"
                  title="Удалить точку — возможно, пока на ней нет смен"
                  onConfirm={() => onRun(() => api.deleteLocation(location.id))}
                />
              )}
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
