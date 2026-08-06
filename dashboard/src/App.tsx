import { NavLink, Route, Routes } from "react-router-dom";
import DaysPage from "./pages/DaysPage";
import DayReportPage from "./pages/DayReportPage";
import PromptsPage from "./pages/PromptsPage";
import ScriptPage from "./pages/ScriptPage";

export default function App() {
  return (
    <div className="layout">
      <nav className="sidebar">
        <h1>Аналитика продаж</h1>
        <NavLink to="/" end>
          Отчёты по дням
        </NavLink>
        <NavLink to="/prompts">Промпты анализа</NavLink>
        <NavLink to="/script">Скрипт продаж</NavLink>
      </nav>
      <main className="content">
        <Routes>
          <Route path="/" element={<DaysPage />} />
          <Route path="/days/:id" element={<DayReportPage />} />
          <Route path="/prompts" element={<PromptsPage />} />
          <Route path="/script" element={<ScriptPage />} />
        </Routes>
      </main>
    </div>
  );
}
