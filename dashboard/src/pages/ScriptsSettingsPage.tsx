/** Настройки скриптов — вкладки: хронология правок, предложения
 *  сотрудников (со значком новых), статистика копирований, статистика
 *  звонков, подстановка и ИИ-помощник. */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHead } from "../components/ui";
import { Slider } from "../components/Slider";
import AiPromptView from "../scripts/AiPromptView";
import { IconSparkle } from "../scripts/AssistDialog";
import CopyStatsView from "../scripts/CopyStats";
import CallStatsView from "../scripts/CallStats";
import ExportScripts from "../scripts/ExportScripts";
import History from "../scripts/History";
import Substitution from "../scripts/Substitution";
import Suggestions from "../scripts/Suggestions";
import { usePlaybook } from "../scripts/store";
import { useSession } from "../session";

type Tab = "history" | "suggestions" | "stats" | "calls" | "vars" | "ai";
const TABS: Tab[] = ["history", "suggestions", "stats", "calls", "vars", "ai"];

export default function ScriptsSettingsPage() {
  const me = useSession();
  const canEdit = me.can_edit_scripts;
  const { unread } = usePlaybook();
  const [params, setParams] = useSearchParams();
  const asked = params.get("tab") as Tab | null;
  // Пришли по значку новых предложений — сразу к ним, иначе — хронология.
  const [initial] = useState<Tab>(unread > 0 ? "suggestions" : "history");
  const tab: Tab = asked && TABS.includes(asked) ? asked : initial;

  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: "history", label: "Хронология" },
    { key: "suggestions", label: "Предложения", badge: unread },
    { key: "stats", label: "Статистика" },
    { key: "calls", label: "Звонки" },
    { key: "vars", label: "Подстановка" },
    { key: "ai", label: "ИИ-помощник" },
  ];

  return (
    <div className="settings-page">
      <PageHead
        title="Настройки скриптов"
        hint={
          canEdit
            ? undefined
            : "Только просмотр: менять настройки могут те, кому выдано «Скрипты: правка»."
        }
      >
        {/* Перенос скриптов в Base40 («Скрипты LS» → «Настройки» → «Импорт»). */}
        {canEdit && <ExportScripts />}
      </PageHead>
      <Slider className="tabs" active={tab} role="tablist" aria-label="Настройки скриптов">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab${tab === t.key ? " on" : ""}`}
            onClick={() => setParams({ tab: t.key }, { replace: true })}
          >
            {t.key === "ai" && <IconSparkle size={14} />}
            {t.label}
            {t.badge ? <span className="nav-badge num">{t.badge}</span> : null}
          </button>
        ))}
      </Slider>
      {tab === "history" && <History />}
      {tab === "suggestions" && <Suggestions canEdit={canEdit} />}
      {tab === "stats" && <CopyStatsView />}
      {tab === "calls" && <CallStatsView />}
      {tab === "vars" && <Substitution canEdit={canEdit} />}
      {tab === "ai" && <AiPromptView canEdit={canEdit} />}
    </div>
  );
}
