/** «Экспорт» в настройках скриптов: все разделы, скрипты, сценарии звонков
 *  и настройки подстановки — одним JSON-файлом.
 *
 *  Нужен для переноса скриптов в админку Base40 (раздел «Скрипты LS» →
 *  «Настройки» → «Импорт»): там тот же формат разделов и скриптов, а
 *  подписи и даты последних правок переносятся как есть. Хронология,
 *  предложения и статистика в файл не попадают — у Base40 свои сотрудники.
 */
import { useState } from "react";
import { api } from "../api";

export default function ExportScripts() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    try {
      const [playbook, settings] = await Promise.all([api.playbook(), api.playbookSettings()]);
      const file = {
        format: "audio-analitics-scripts",
        version: 1,
        exported_at: new Date().toISOString(),
        sections: playbook.sections,
        settings: { studios: settings.studios, variables: settings.variables },
      };
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `scripts-${file.exported_at.slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="secondary"
      disabled={busy}
      onClick={run}
      title={error || "Скачать все скрипты и настройки одним файлом — для переноса в Base40"}
    >
      {busy ? "Готовим файл…" : error ? "Не вышло — ещё раз" : "Экспорт"}
    </button>
  );
}
