import { useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { getToken, setToken } from "./api";
import DaysPage from "./pages/DaysPage";
import DayReportPage from "./pages/DayReportPage";
import EmployeesPage from "./pages/EmployeesPage";
import MetricsPage from "./pages/MetricsPage";

function AccessTokenBox() {
  const [value, setValue] = useState(getToken() ?? "");
  const save = () => {
    setToken(value.trim() || null);
    window.location.reload();
  };
  return (
    <div style={{ marginTop: "auto", paddingTop: 20 }}>
      <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>
        Токен доступа
      </label>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="ADMIN_API_TOKEN"
        style={{
          width: "100%",
          padding: "7px 9px",
          borderRadius: 6,
          border: "1px solid #334155",
          background: "#1e293b",
          color: "#e2e8f0",
          fontSize: 12,
          marginBottom: 6,
        }}
      />
      <button style={{ width: "100%", padding: "7px" }} onClick={save}>
        Сохранить
      </button>
    </div>
  );
}

export default function App() {
  return (
    <div className="layout">
      <nav className="sidebar" style={{ display: "flex", flexDirection: "column" }}>
        <h1>Аналитика продаж</h1>
        <NavLink to="/" end>
          Отчёты по дням
        </NavLink>
        <NavLink to="/metrics">Метрики и анализ</NavLink>
        <NavLink to="/employees">Менеджеры</NavLink>
        <AccessTokenBox />
      </nav>
      <main className="content">
        <Routes>
          <Route path="/" element={<DaysPage />} />
          <Route path="/days/:id" element={<DayReportPage />} />
          <Route path="/metrics" element={<MetricsPage />} />
          <Route path="/employees" element={<EmployeesPage />} />
        </Routes>
      </main>
    </div>
  );
}
