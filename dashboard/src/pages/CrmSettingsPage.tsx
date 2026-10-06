/** Настройки CRM — вкладки: критерии оценки, промпт и правила воронки,
 *  интеграция (ключ, формат, импорт, сопоставление менеджеров, расписание).
 *  Доступны тем, кому открыты все сделки. */
import { useSearchParams } from "react-router-dom";
import { PageHead } from "../components/ui";
import { Slider } from "../components/Slider";
import Criteria from "../crm/Criteria";
import Integration from "../crm/Integration";
import PromptView from "../crm/PromptView";
import ScopeView from "../crm/ScopeView";

type Tab = "criteria" | "scope" | "prompt" | "integration";
const TABS: { key: Tab; label: string }[] = [
  { key: "criteria", label: "Критерии" },
  { key: "scope", label: "Что разбирать" },
  { key: "prompt", label: "Промпт и правила" },
  { key: "integration", label: "Интеграция" },
];

export default function CrmSettingsPage() {
  const [params, setParams] = useSearchParams();
  const asked = params.get("tab") as Tab | null;
  const tab: Tab = asked && TABS.some((t) => t.key === asked) ? asked : "criteria";

  return (
    <div className="settings-page">
      <PageHead
        title="Настройки CRM"
        hint="Критерии — поля, по которым ИИ оценивает каждую сделку за день, и они же — колонки статистики. «Что разбирать» — рабочее время и исключения. Промпт — что считать ошибкой. Интеграция — откуда приходят данные."
      />
      <Slider className="tabs" active={tab} role="tablist" aria-label="Настройки CRM">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab${tab === t.key ? " on" : ""}`}
            onClick={() => setParams({ tab: t.key }, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </Slider>
      {tab === "criteria" && <Criteria />}
      {tab === "scope" && <ScopeView />}
      {tab === "prompt" && <PromptView />}
      {tab === "integration" && <Integration />}
    </div>
  );
}
