import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api, getToken, Location, Me, onSessionExpired, setToken } from "./api";
import {
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
import LocationsPage from "./pages/LocationsPage";
import LoginPage from "./pages/LoginPage";
import MetricsPage from "./pages/MetricsPage";
import { SessionContext, StudioContext } from "./session";

const STUDIO_KEY = "aa_studio";

export default function App() {
  // null — не вошли; undefined — ещё проверяем сохранённый токен.
  const [me, setMe] = useState<Me | null | undefined>(
    getToken() ? undefined : null
  );
  const [locations, setLocations] = useState<Location[]>([]);
  // Выбранная студия переживает перезагрузку: владелец обычно смотрит одну
  // и ту же точку несколько дней подряд.
  const [locationId, setLocationId] = useState(
    () => localStorage.getItem(STUDIO_KEY) ?? ""
  );

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

  const chooseStudio = useCallback((id: string) => {
    setLocationId(id);
    if (id) localStorage.setItem(STUDIO_KEY, id);
    else localStorage.removeItem(STUDIO_KEY);
  }, []);

  // Точку могли закрыть или удалить, пока выбор лежал в localStorage:
  // иначе списки молча оказались бы пустыми.
  const known = locations.some((l) => l.id === locationId);
  const effectiveId = locationId && known ? locationId : "";
  const studio = useMemo(
    () => ({ locationId: effectiveId, setLocationId: chooseStudio, locations }),
    [effectiveId, chooseStudio, locations]
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
              </>
            )}

            <div className="sidebar-foot">
              {/* Переключатель студии стоит рядом с именем, а не на страницах:
                  выбираешь точку один раз и ходишь по разделам, не
                  переставляя фильтр заново. */}
              {locations.length > 1 && (
                <label className="studio">
                  <span className="label">Студия</span>
                  <select
                    value={effectiveId}
                    onChange={(e) => chooseStudio(e.target.value)}
                  >
                    <option value="">все студии</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                        {l.active ? "" : " · закрыта"}
                      </option>
                    ))}
                  </select>
                </label>
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
            </Routes>
          </main>
        </div>
      </StudioContext.Provider>
    </SessionContext.Provider>
  );
}
