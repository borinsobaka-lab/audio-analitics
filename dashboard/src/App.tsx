import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api, getToken, Location, Me, onSessionExpired, plural, setToken } from "./api";
import {
  IconApp,
  IconDashboard,
  IconDays,
  IconMetrics,
  IconPeople,
  IconStudio,
  IconWave,
  Skeleton,
} from "./components/ui";
import DashboardPage from "./pages/DashboardPage";
import DaysPage from "./pages/DaysPage";
import DayReportPage from "./pages/DayReportPage";
import EmployeesPage from "./pages/EmployeesPage";
import AppPage from "./pages/AppPage";
import LocationsPage from "./pages/LocationsPage";
import LoginPage from "./pages/LoginPage";
import MetricsPage from "./pages/MetricsPage";
import { SessionContext, StudioContext } from "./session";

const STUDIO_KEY = "aa_studios";
/** Прежний ключ хранил одну студию строкой — переносим выбор молча. */
const LEGACY_STUDIO_KEY = "aa_studio";

function loadStudios(): string[] {
  const saved = localStorage.getItem(STUDIO_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === "string");
    } catch {
      /* испорченное значение — считаем, что выбора не было */
    }
  }
  const legacy = localStorage.getItem(LEGACY_STUDIO_KEY);
  return legacy ? [legacy] : [];
}

/** Выбор студий: галочки, а не выпадающий список.
 *
 *  Список позволял выбрать ровно одну точку, и владельцу двух студий
 *  приходилось смотреть их по очереди, складывая цифры в голове. Галочки
 *  дают все три случая одним контролом: одна студия, несколько, все сразу.
 *
 *  Раскрывается вверх — точнее, просто растёт внутри нижнего блока меню,
 *  который прижат к низу автоматическим отступом. Всплывающее меню здесь
 *  обрезалось бы прокруткой узкой полосы на телефоне.
 */
function StudioPicker({
  locations,
  selected,
  onToggle,
  onAll,
}: {
  locations: Location[];
  selected: string[];
  onToggle: (id: string) => void;
  onAll: () => void;
}) {
  const [open, setOpen] = useState(false);

  const label =
    selected.length === 0
      ? "Все студии"
      : selected.length === 1
        ? locations.find((l) => l.id === selected[0])?.name ?? "Студия"
        : `${selected.length} ${plural(selected.length, "студия", "студии", "студий")}`;

  return (
    <div className="studio">
      <span className="label">Студии</span>
      <button
        className="studio-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="studio-label">{label}</span>
        <span className="studio-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="studio-menu">
          <label className="studio-item">
            <input
              type="checkbox"
              checked={selected.length === 0}
              onChange={onAll}
            />
            Все студии
          </label>
          {locations.map((l) => (
            <label key={l.id} className="studio-item">
              <input
                type="checkbox"
                checked={selected.includes(l.id)}
                onChange={() => onToggle(l.id)}
              />
              <span className="studio-name">{l.name}</span>
              {!l.active && <span className="studio-off">закрыта</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  // null — не вошли; undefined — ещё проверяем сохранённый токен.
  const [me, setMe] = useState<Me | null | undefined>(
    getToken() ? undefined : null
  );
  const [locations, setLocations] = useState<Location[]>([]);
  // Выбор студий переживает перезагрузку: владелец обычно смотрит один и тот
  // же срез сети несколько дней подряд.
  const [locationIds, setLocationIds] = useState<string[]>(loadStudios);

  useEffect(() => {
    if (me !== undefined) return;
    api.me().then(setMe).catch(() => setMe(null));
  }, [me]);

  useEffect(() => {
    if (!me) return;
    api.listLocations().then(setLocations).catch(() => setLocations([]));
  }, [me]);

  // Сессию мог отозвать администратор — сбросом пароля или отключением.
  useEffect(() => onSessionExpired(() => setMe(null)), []);

  const remember = useCallback((ids: string[]) => {
    setLocationIds(ids);
    if (ids.length) localStorage.setItem(STUDIO_KEY, JSON.stringify(ids));
    else localStorage.removeItem(STUDIO_KEY);
    localStorage.removeItem(LEGACY_STUDIO_KEY);
  }, []);

  const toggleLocation = useCallback(
    (id: string) => {
      remember(
        locationIds.includes(id)
          ? locationIds.filter((x) => x !== id)
          : [...locationIds, id]
      );
    },
    [locationIds, remember]
  );

  const selectAll = useCallback(() => remember([]), [remember]);

  // Точку могли закрыть или удалить, пока выбор лежал в localStorage: без
  // этой чистки списки молча оказались бы пустыми.
  const effectiveIds = useMemo(
    () =>
      locations.length
        ? locationIds.filter((id) => locations.some((l) => l.id === id))
        : locationIds,
    [locationIds, locations]
  );
  const studio = useMemo(
    () => ({ locationIds: effectiveIds, toggleLocation, selectAll, locations }),
    [effectiveIds, toggleLocation, selectAll, locations]
  );

  const signOut = useCallback(() => {
    setToken(null);
    setMe(null);
  }, []);

  if (me === undefined) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <Skeleton count={1} height={120} />
        </div>
      </div>
    );
  }

  if (me === null) return <LoginPage onSignedIn={setMe} />;

  return (
    <SessionContext.Provider value={me}>
      <StudioContext.Provider value={studio}>
        <div className="layout">
          <nav className="sidebar">
            <div className="brand">
              <span className="brand-mark">
                <IconWave />
              </span>
              <span>
                <span className="brand-name">Ресепшен</span>
                <span className="brand-sub">речевая аналитика</span>
              </span>
            </div>

            <NavLink to="/" end className="nav-link">
              <IconDashboard />
              Дашборд
            </NavLink>
            <NavLink to="/days" className="nav-link">
              <IconDays />
              {me.can_view_all ? "Смены" : "Мои смены"}
            </NavLink>
            {/* Настройки системы видит только тот, кому открыты все записи:
                показывать раздел, который ответит «недостаточно прав», хуже,
                чем не показывать его вовсе. */}
            {me.can_manage && (
              <>
                <NavLink to="/metrics" className="nav-link">
                  <IconMetrics />
                  Метрики и анализ
                </NavLink>
                <NavLink to="/employees" className="nav-link">
                  <IconPeople />
                  Сотрудники
                </NavLink>
                <NavLink to="/locations" className="nav-link">
                  <IconStudio />
                  Точки продажи
                </NavLink>
                <NavLink to="/app" className="nav-link">
                  <IconApp />
                  Приложение
                </NavLink>
              </>
            )}

            <div className="sidebar-foot">
              {/* Выбор студий стоит рядом с именем, а не на страницах:
                  отмечаешь срез один раз и ходишь по разделам, не
                  переставляя фильтр заново. */}
              {locations.length > 1 && (
                <StudioPicker
                  locations={locations}
                  selected={effectiveIds}
                  onToggle={toggleLocation}
                  onAll={selectAll}
                />
              )}
              <div className="who">
                <span className="who-name">
                  {me.full_name || me.login || "Пользователь"}
                </span>
                <span className="who-role">
                  {me.is_owner
                    ? "владелец"
                    : me.can_view_all
                      ? "все смены"
                      : "только свои смены"}
                </span>
              </div>
              <button className="ghost small btn-block" onClick={signOut}>
                Выйти
              </button>
            </div>
          </nav>

          <main className="content">
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/days" element={<DaysPage />} />
              <Route path="/days/:id" element={<DayReportPage />} />
              {me.can_manage && <Route path="/metrics" element={<MetricsPage />} />}
              {me.can_manage && <Route path="/employees" element={<EmployeesPage />} />}
              {me.can_manage && <Route path="/locations" element={<LocationsPage />} />}
              {me.can_manage && <Route path="/app" element={<AppPage />} />}
            </Routes>
          </main>
        </div>
      </StudioContext.Provider>
    </SessionContext.Provider>
  );
}
