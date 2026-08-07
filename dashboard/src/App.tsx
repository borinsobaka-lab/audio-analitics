import { useCallback, useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api, getToken, Me, onSessionExpired, setToken } from "./api";
import {
  IconDashboard,
  IconDays,
  IconMetrics,
  IconPeople,
  IconWave,
  Skeleton,
} from "./components/ui";
import DashboardPage from "./pages/DashboardPage";
import DaysPage from "./pages/DaysPage";
import DayReportPage from "./pages/DayReportPage";
import EmployeesPage from "./pages/EmployeesPage";
import LoginPage from "./pages/LoginPage";
import MetricsPage from "./pages/MetricsPage";
import { SessionContext } from "./session";

export default function App() {
  // null — не вошли; undefined — ещё проверяем сохранённый токен.
  const [me, setMe] = useState<Me | null | undefined>(
    getToken() ? undefined : null
  );

  useEffect(() => {
    if (me !== undefined) return;
    api.me().then(setMe).catch(() => setMe(null));
  }, [me]);

  // Сессию мог отозвать администратор — сбросом пароля или отключением.
  useEffect(() => onSessionExpired(() => setMe(null)), []);

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
            </>
          )}

          <div className="sidebar-foot">
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
          </Routes>
        </main>
      </div>
    </SessionContext.Provider>
  );
}
