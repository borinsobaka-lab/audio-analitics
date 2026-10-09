/** Интеграция с CRM: откуда берутся данные.
 *
 *  Конкретная CRM здесь не выбирается: любая система, сценарий в n8n/Make
 *  или скрипт выгрузки присылает сделки, сообщения и события в одном
 *  JSON-формате по ключу интеграции. Тот же формат принимает импорт файла —
 *  чтобы загрузить прошлые дни или проверить разбор до настройки
 *  интеграции. Здесь же менеджеры из CRM сопоставляются сотрудникам
 *  админки: по ним работают права «свои сделки» и статистика.
 */
import { useEffect, useRef, useState } from "react";
import { api, CrmIngestResult, CrmSettings, CrmSettingsIn, Employee, plural } from "../api";
import { ConfirmAction, Note, Section, Skeleton, TableCard } from "../components/ui";
import AmoConnect from "./AmoConnect";
import WazzupConnect from "./WazzupConnect";

const EXAMPLE = `{
  "deals": [
    {"id": "4821", "title": "Анна — пробное", "contact_name": "Анна", "contact_phone": "+995 5xx",
     "pipeline": "Продажи", "stage": "Записан на пробное", "status": "open", "source": "Instagram",
     "manager_id": "7", "manager_name": "Мария", "url": "https://crm.example/leads/4821",
     "created_at": "2026-10-04T10:00:00+04:00"}
  ],
  "messages": [
    {"id": "m-1", "deal_id": "4821", "direction": "in", "channel": "whatsapp",
     "author_name": "Анна", "text": "Здравствуйте! Сколько стоит пробное?", "at": "2026-10-04T10:02:00+04:00"},
    {"id": "m-2", "deal_id": "4821", "direction": "out", "channel": "whatsapp",
     "author_id": "7", "author_name": "Мария", "text": "Анна, добрый день! …", "at": "2026-10-04T10:09:00+04:00"}
  ],
  "events": [
    {"id": "e-1", "deal_id": "4821", "kind": "stage_change", "from": "Новая заявка", "to": "Записан на пробное",
     "author_id": "7", "author_name": "Мария", "at": "2026-10-04T10:15:00+04:00"},
    {"id": "e-2", "deal_id": "4821", "kind": "task", "text": "Напомнить за час до занятия",
     "author_id": "7", "author_name": "Мария", "at": "2026-10-04T10:16:00+04:00"}
  ]
}`;

export default function Integration() {
  const [data, setData] = useState<CrmSettings | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState("");
  const [mapDraft, setMapDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<CrmIngestResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const apply = (s: CrmSettings) => {
    setData(s);
    const draft: Record<string, string> = {};
    for (const m of s.known_managers) draft[m.key] = s.manager_map[m.key] ?? "";
    setMapDraft(draft);
  };

  useEffect(() => {
    api.crmSettings().then(apply).catch((e) => setError(String(e).replace(/^Error:\s*/, "")));
    api.listEmployees().then(setEmployees).catch(() => {});
  }, []);

  if (!data) return error ? <Note kind="error">{error}</Note> : <Skeleton count={2} height={160} />;

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setCopied("");
    }
  };

  const run = async (fn: () => Promise<CrmSettings>, message: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      apply(await fn());
      setNotice(message);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const body = (manager_map: Record<string, string | null>): Partial<CrmSettingsIn> => ({ manager_map });

  const mapDirty = data.known_managers.some((m) => (data.manager_map[m.key] ?? "") !== (mapDraft[m.key] ?? ""));

  const importFile = async (file: File) => {
    setImporting(true);
    setError("");
    setResult(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Файл не читается как JSON");
      }
      const res = await api.importCrm(parsed);
      setResult(res);
      api.crmSettings().then(apply).catch(() => {});
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const activeEmployees = employees.filter((e) => e.active);

  return (
    <div className="crm-integration">
      {error && <Note kind="error">{error}</Note>}
      {notice && <Note kind="success">{notice}</Note>}

      <AmoConnect />
      <WazzupConnect />

      <Section title="Другая CRM или свой сценарий" hint="ключ, которым CRM или сценарий n8n/Make подписывает каждый пакет данных">
        <div className="sheet sheet-pad crm-key-card">
          <div className="creds-body">
            <div className="creds-pair">
              <span className="label">Адрес</span>
              <code>{data.ingest_url}</code>
            </div>
            <button type="button" className="secondary small" onClick={() => copy("url", data.ingest_url)}>
              {copied === "url" ? "Скопировано" : "Скопировать"}
            </button>
          </div>
          <div className="creds-body">
            <div className="creds-pair">
              <span className="label">Заголовок X-Crm-Key</span>
              <code className="crm-key">{showKey ? data.integration_key : "•".repeat(24)}</code>
            </div>
            <button type="button" className="ghost small" onClick={() => setShowKey(!showKey)}>
              {showKey ? "Скрыть" : "Показать"}
            </button>
            <button type="button" className="secondary small" onClick={() => copy("key", data.integration_key)}>
              {copied === "key" ? "Скопировано" : "Скопировать"}
            </button>
            <ConfirmAction
              small
              label="Новый ключ"
              confirmLabel="Выдать новый"
              title="Прежний ключ перестанет работать сразу — его надо заменить в CRM"
              disabled={busy}
              onConfirm={() => run(() => api.rotateCrmKey(), "Ключ заменён — обновите его в CRM")}
            />
          </div>
          <p className="muted form-hint">
            Проверка связи: <code>GET {data.ingest_url}/ping</code> с тем же заголовком отвечает{" "}
            <code>{`{"ok": true}`}</code>. Данные: <code>POST {data.ingest_url}</code>, тело — JSON
            ниже. Пакет можно присылать сколько угодно раз: сделки обновляются по id, сообщения и
            события не дублируются. Время без пояса считается временем студии ({data.timezone}).
          </p>
        </div>
      </Section>

      <Section title="Формат данных" hint="один и тот же — для интеграции и для импорта файла">
        <div className="sheet sheet-pad">
          <pre className="crm-json">{EXAMPLE}</pre>
          <ul className="crm-format-notes">
            <li>
              <b>deals</b> — сделки: обязателен только <code>id</code> (как в CRM); остальные поля
              обновляют то, что прислано, и не трогают остальное. <code>status</code>:{" "}
              <code>open</code> / <code>won</code> / <code>lost</code>.
            </li>
            <li>
              <b>messages</b> — переписка: <code>direction</code> — <code>in</code> от клиента,{" "}
              <code>out</code> от администратора; <code>author_id</code> и{" "}
              <code>author_name</code> — кто из администраторов писал; <code>channel</code> —
              whatsapp, instagram, telegram, sms…
            </li>
            <li>
              <b>events</b> — движение сделки: <code>kind</code> — <code>stage_change</code>,{" "}
              <code>status_change</code>, <code>note</code>, <code>task</code>,{" "}
              <code>task_done</code>, <code>call</code>; для смены этапа — <code>from</code> и{" "}
              <code>to</code>.
            </li>
            <li>
              Сообщение по сделке, карточки которой ещё нет, не теряется: сделка заводится с этим id,
              а карточка придёт следующим пакетом.
            </li>
          </ul>
          <button type="button" className="ghost small" onClick={() => copy("example", EXAMPLE)}>
            {copied === "example" ? "Скопировано" : "Скопировать пример"}
          </button>
        </div>
      </Section>

      <Section title="Импорт файла" hint="выгрузка из CRM в том же формате — за прошлые дни или для проверки">
        <div className="sheet sheet-pad">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            disabled={importing}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importFile(file);
            }}
          />
          {importing && <p className="muted form-hint">Загружаем…</p>}
          {result && (
            <Note kind="success">
              Загружено: сделок {result.deals_created + result.deals_updated}
              {result.deals_stubbed ? ` (+${result.deals_stubbed} по одному id)` : ""}, сообщений{" "}
              {result.messages_added}, событий {result.events_added}
              {result.messages_skipped + result.events_skipped
                ? `; повторов пропущено: ${result.messages_skipped + result.events_skipped}`
                : ""}
              . Дни с новыми данными появятся в «Разборах» — там их можно разобрать.
            </Note>
          )}
        </div>
      </Section>

      <Section
        title="Менеджеры CRM и сотрудники"
        hint="по сопоставлению работают право «свои сделки» и статистика по людям"
      >
        {data.known_managers.length === 0 ? (
          <div className="sheet sheet-pad">
            <p className="muted no-margin">
              Пока данных нет — менеджеры появятся здесь после первого пакета из CRM. Совпадающие по
              имени сопоставляются сами.
            </p>
          </div>
        ) : (
          <>
            <TableCard
              columns={[
                { label: "В CRM" },
                { label: "Сделок", num: true },
                { label: "Сотрудник админки" },
              ]}
            >
              {data.known_managers.map((m) => (
                <tr key={m.key}>
                  <td>
                    <div className="person">
                      <span className="person-name">{m.name || "без имени"}</span>
                      <span className="muted mono">id {m.key}</span>
                    </div>
                  </td>
                  <td className="num-col">{m.deals}</td>
                  <td>
                    <select
                      value={mapDraft[m.key] ?? ""}
                      aria-label={`Сотрудник для ${m.name || m.key}`}
                      onChange={(e) => setMapDraft((d) => ({ ...d, [m.key]: e.target.value }))}
                    >
                      <option value="">
                        {m.employee_id && !m.mapped
                          ? `по имени: ${employees.find((e) => e.id === m.employee_id)?.full_name ?? "—"}`
                          : "— не сопоставлен"}
                      </option>
                      {activeEmployees.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.full_name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </TableCard>
            <div className="actions crm-map-actions">
              <button
                type="button"
                disabled={!mapDirty || busy}
                onClick={() =>
                  run(
                    () =>
                      api.saveCrmSettings(
                        body(Object.fromEntries(Object.entries(mapDraft).map(([k, v]) => [k, v || null])))
                      ),
                    "Сопоставление сохранено — применится к следующему разбору"
                  )
                }
              >
                {busy ? "Сохраняем…" : "Сохранить сопоставление"}
              </button>
              <span className="muted">
                {data.known_managers.length}{" "}
                {plural(data.known_managers.length, "менеджер", "менеджера", "менеджеров")} в данных CRM
              </span>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}
