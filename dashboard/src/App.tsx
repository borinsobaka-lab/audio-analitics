import { useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { getToken, setToken } from "./api";
import {
  IconDashboard,
  IconDays,
  IconMetrics,
  IconPeople,
  IconWave,
} from "./components/ui";
import DashboardPage from "./pages/DashboardPage";
import DaysPage from "./pages/DaysPage";
import DayReportPage from "./pages/DayReportPage";
import EmployeesPage from "./pages/EmployeesPage";
import MetricsPage from "./pages/MetricsPage";

function AccessToken() {
  const [value, setValue] = useState(getToken() ?? "");
  const [open, setOpen] = useState(!getToken());

  const save = () => {
    setToken(value.trim() || null);
    window.location.reload();
  };

  if (!open) {
    return (
      <button className="ghost small" onClick={() => setOpen(true)}>
        Токен доступа
      </button>
    );
  }
  return (
    <div>
      <span className="label" style={{ display: "block", marginBottom: 6 }}>
        Токен доступа
      </span>
      <input
        type="password"
        value={value}
        placeholder="ADMIN_API_TOKEN"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
        style={{ marginBottom: 6 }}
      />
      <button className="secondary small" style={{ width: "100%" }} onClick={save}>
        Сохранить и обновить
      </button>
    </div>
  );
}

export default function App() {
  return (
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
          Смены
        </NavLink>
        <NavLink to="/metrics" className="nav-link">
          <IconMetrics />
          Метрики и анализ
        </NavLink>
        <NavLink to="/employees" className="nav-link">
          <IconPeople />
          Менеджеры
        </NavLink>

        <div className="sidebar-foot">
          <AccessToken />
        </div>
      </nav>

      <main className="content">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/days" element={<DaysPage />} />
          <Route path="/days/:id" element={<DayReportPage />} />
          <Route path="/metrics" element={<MetricsPage />} />
          <Route path="/employees" element={<EmployeesPage />} />
        </Routes>
      </main>
    </div>
  );
}
