/** Подключение amoCRM.
 *
 *  Два канала, и это не прихоть: сделки, этапы, задачи, заметки и SMS
 *  приходят по API раз в несколько минут, а текст сообщений из чатов
 *  («Беседы») API amoCRM не отдаёт — его присылает только вебхук в момент
 *  отправки. Поэтому здесь и токен для API, и адрес вебхука с перечнем
 *  событий, которые надо включить в amoCRM.
 *
 *  Авторизация — долгосрочный токен приватной интеграции: его выдают в
 *  настройках интеграции, без редиректов. Код авторизации OAuth — под
 *  раскрывающимся «Через код авторизации», для тех, у кого токена нет.
 */
import { useEffect, useState } from "react";
import { AmoConnectIn, AmoStatus, api, fmtWhen, plural } from "../api";
import { ConfirmAction, Note, Section, Skeleton } from "../components/ui";

const DOMAINS: AmoConnectIn["domain"][] = ["amocrm.ru", "kommo.com", "amocrm.com"];
const INTERVALS = [5, 10, 15, 30, 60];

function formOf(s: AmoStatus): AmoConnectIn {
  return {
    subdomain: s.subdomain,
    domain: (DOMAINS.includes(s.domain as AmoConnectIn["domain"]) ? s.domain : "amocrm.ru") as AmoConnectIn["domain"],
    token: "",
    client_id: "",
    client_secret: "",
    redirect_uri: "",
    code: "",
    enabled: s.enabled,
    sync_every_minutes: s.sync_every_minutes,
    lookback_days: s.lookback_days,
    tasks_enabled: s.tasks_enabled,
    tasks_min_severity: s.tasks_min_severity,
    tasks_due_hours: s.tasks_due_hours,
  };
}

const DUE_HOURS = [1, 2, 3, 4, 8, 12, 24];

export default function AmoConnect() {
  const [status, setStatus] = useState<AmoStatus | null>(null);
  const [form, setForm] = useState<AmoConnectIn | null>(null);
  const [oauth, setOauth] = useState(false);
  const [busy, setBusy] = useState<"save" | "sync" | "off" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);

  const apply = (s: AmoStatus) => {
    setStatus(s);
    setForm(formOf(s));
  };

  useEffect(() => {
    api.amoStatus().then(apply).catch((e) => setError(String(e).replace(/^Error:\s*/, "")));
  }, []);

  if (!status || !form) return error ? <Note kind="error">{error}</Note> : <Skeleton count={1} height={220} />;

  const set = (fields: Partial<AmoConnectIn>) => setForm((f) => (f ? { ...f, ...fields } : f));

  const run = async (what: "save" | "sync" | "off", fn: () => Promise<void>) => {
    setBusy(what);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", async () => {
      const res = await api.connectAmo(form);
      apply(res);
      setOauth(false);
      setNotice(
        res.connected
          ? `amoCRM подключена: аккаунт «${res.account_name || res.subdomain}», ${res.pipelines.length} ${plural(res.pipelines.length, "воронка", "воронки", "воронок")}, ${res.users} ${plural(res.users, "пользователь", "пользователя", "пользователей")}. Первая синхронизация пройдёт в течение пяти минут — или нажмите «Синхронизировать сейчас».`
          : "Настройки сохранены."
      );
    });

  const sync = () =>
    run("sync", async () => {
      const res = await api.syncAmo();
      setNotice(`Синхронизация прошла: ${res.result}.`);
      apply(await api.amoStatus());
    });

  const disconnect = () =>
    run("off", async () => {
      apply(await api.disconnectAmo());
      setNotice("amoCRM отключена — токен стёрт, данные остались.");
    });

  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(status.webhook_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const canSave =
    form.subdomain.trim().length > 0 &&
    (status.connected || form.token.trim().length > 0 || (oauth && form.code.trim().length > 0));

  return (
    <Section title="amoCRM" hint="сделки, этапы, задачи и заметки — по API; сообщения из чатов — вебхуком">
      <div className="sheet sheet-pad crm-amo">
        {status.connected ? (
          <div className="crm-amo-state">
            <span className="status done">
              <span className="dot" />
              Подключено
            </span>
            <span className="muted">
              аккаунт <b>{status.account_name || status.subdomain}</b> · {status.subdomain}.{status.domain}
              {status.token_hint && ` · токен …${status.token_hint}`}
              {status.auth === "oauth" && status.token_expires_at && ` · обновится до ${fmtWhen(status.token_expires_at)}`}
            </span>
            {!status.enabled && <span className="pill irrelevant">синхронизация выключена</span>}
          </div>
        ) : (
          <p className="muted no-margin">
            Не подключено. Нужен долгосрочный токен приватной интеграции: в amoCRM — «Настройки» →
            «Интеграции» → «Создать интеграцию» (внешняя, с правами на сделки, контакты, задачи,
            примечания и чаты) → вкладка «Ключи и доступы» → «Долгосрочный токен».
          </p>
        )}
        {status.connected && (
          <div className="crm-amo-sync">
            <span className="muted">
              Последняя синхронизация:{" "}
              {status.last_sync_at ? `${fmtWhen(status.last_sync_at)} — ${status.last_sync_result}` : "ещё не было"}.
            </span>
            <span className="muted">
              Вебхуков получено: {status.webhooks_received}
              {status.last_webhook_at && `, последний ${fmtWhen(status.last_webhook_at)}`}.
            </span>
          </div>
        )}
        {status.last_error && (
          <Note kind="error">
            amoCRM: {status.last_error}
            {status.last_error_at && <span className="muted"> · {fmtWhen(status.last_error_at)}</span>}
          </Note>
        )}
        {error && <Note kind="error">{error}</Note>}
        {notice && <Note kind="success">{notice}</Note>}

        <div className="field-row">
          <label className="field field-grow">
            <span className="label">Поддомен аккаунта</span>
            <input
              type="text"
              value={form.subdomain}
              placeholder="ladystretch — из адреса ladystretch.amocrm.ru"
              spellCheck={false}
              autoCapitalize="none"
              onChange={(e) => set({ subdomain: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="label">Домен</span>
            <select value={form.domain} onChange={(e) => set({ domain: e.target.value as AmoConnectIn["domain"] })}>
              {DOMAINS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span className="label">
            Долгосрочный токен{" "}
            {status.connected && <span className="muted">· пусто — оставить текущий</span>}
          </span>
          <input
            type="password"
            value={form.token}
            placeholder={status.connected ? "•••• оставить как есть" : "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9…"}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => set({ token: e.target.value })}
          />
        </label>

        <details className="crm-details" open={oauth} onToggle={(e) => setOauth((e.target as HTMLDetailsElement).open)}>
          <summary>Через код авторизации (OAuth) — если долгосрочного токена нет</summary>
          <p className="muted form-hint">
            Из той же вкладки «Ключи и доступы»: ID интеграции, секретный ключ и код авторизации
            (действует 20 минут). Ссылка для перенаправления — та, что указана в интеграции.
            Токены обновятся сами.
          </p>
          <div className="field-row">
            <label className="field field-grow">
              <span className="label">ID интеграции</span>
              <input type="text" value={form.client_id} spellCheck={false} onChange={(e) => set({ client_id: e.target.value })} />
            </label>
            <label className="field field-grow">
              <span className="label">Секретный ключ</span>
              <input type="password" value={form.client_secret} autoComplete="off" onChange={(e) => set({ client_secret: e.target.value })} />
            </label>
          </div>
          <div className="field-row">
            <label className="field field-grow">
              <span className="label">Ссылка для перенаправления</span>
              <input type="text" value={form.redirect_uri} spellCheck={false} placeholder="https://…" onChange={(e) => set({ redirect_uri: e.target.value })} />
            </label>
            <label className="field field-grow">
              <span className="label">Код авторизации</span>
              <input type="password" value={form.code} autoComplete="off" onChange={(e) => set({ code: e.target.value })} />
            </label>
          </div>
        </details>

        <div className="field-row crm-schedule">
          <label className="toggle">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={form.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            <span>
              <span className="toggle-title">Синхронизировать по расписанию</span>
              <span className="toggle-hint">
                {form.enabled ? "Сделки, этапы, задачи и заметки — по API; вебхук работает всегда." : "Только по кнопке; вебхук работает всегда."}
              </span>
            </span>
          </label>
          <label className="field">
            <span className="label">Каждые</span>
            <select value={form.sync_every_minutes} onChange={(e) => set({ sync_every_minutes: Number(e.target.value) })}>
              {INTERVALS.map((m) => (
                <option key={m} value={m}>
                  {m} мин
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Глубина первого запуска</span>
            <input
              type="number"
              min={1}
              max={60}
              value={form.lookback_days}
              onChange={(e) => set({ lookback_days: Number(e.target.value) || 1 })}
            />
            <span className="muted ai-model-hint">дней назад</span>
          </label>
        </div>

        {/* Задачи менеджерам — по итогам разбора по расписанию, в amoCRM на
            ту же сделку. Ставятся один раз: повторный разбор дублей не даёт. */}
        <div className="crm-amo-tasks">
          <label className="toggle">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={form.tasks_enabled}
              onChange={(e) => set({ tasks_enabled: e.target.checked })}
            />
            <span>
              <span className="toggle-title">Ставить задачи менеджерам в amoCRM</span>
              <span className="toggle-hint">
                После разбора в назначенный час — задача «Связаться» на сделке с замечаниями:
                что не так и что сделать, со ссылкой на разбор. Ответственный — тот, кто вёл сделку
                в этот день.
              </span>
            </span>
          </label>
          <div className="field-row">
            <label className="field">
              <span className="label">По каким сделкам</span>
              <select
                value={form.tasks_min_severity}
                disabled={!form.tasks_enabled}
                onChange={(e) => set({ tasks_min_severity: e.target.value as AmoConnectIn["tasks_min_severity"] })}
              >
                <option value="warning">С замечаниями и критичные</option>
                <option value="critical">Только критичные</option>
              </select>
            </label>
            <label className="field">
              <span className="label">Срок</span>
              <select
                value={form.tasks_due_hours}
                disabled={!form.tasks_enabled}
                onChange={(e) => set({ tasks_due_hours: Number(e.target.value) })}
              >
                {DUE_HOURS.map((h) => (
                  <option key={h} value={h}>
                    через {h} {plural(h, "рабочий час", "рабочих часа", "рабочих часов")}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="actions crm-amo-actions">
          <button type="button" disabled={!canSave || busy !== null} onClick={save}>
            {busy === "save" ? "Проверяем…" : status.connected ? "Сохранить" : "Подключить"}
          </button>
          {status.connected && (
            <button type="button" className="secondary" disabled={busy !== null} onClick={sync} title="Забрать из amoCRM всё новое прямо сейчас">
              {busy === "sync" ? "Синхронизируем…" : "Синхронизировать сейчас"}
            </button>
          )}
          {status.connected && (
            <ConfirmAction
              label="Отключить"
              confirmLabel="Отключить amoCRM"
              title="Токен будет стёрт; сделки и переписка, которые уже пришли, останутся"
              disabled={busy !== null}
              onConfirm={disconnect}
            />
          )}
        </div>
      </div>

      <div className="sheet sheet-pad crm-amo-webhook">
        <h4 className="crm-amo-title">Вебхук — сообщения из чатов</h4>
        <p className="muted form-hint no-margin">
          Текст сообщений WhatsApp, Instagram и Telegram API amoCRM не отдаёт: он приходит только
          вебхуком, с момента его подключения. В amoCRM: «Настройки» → «Интеграции» → «Webhooks» →
          «Добавить» → вставьте адрес и отметьте события ниже.
        </p>
        {status.webhook_url ? (
          <div className="creds-body crm-amo-url">
            <div className="creds-pair">
              <span className="label">Адрес вебхука</span>
              <code>{status.webhook_url}</code>
            </div>
            <button type="button" className="secondary small" onClick={copyWebhook}>
              {copied ? "Скопировано" : "Скопировать"}
            </button>
          </div>
        ) : (
          <p className="muted form-hint">Адрес появится после сохранения настроек CRM.</p>
        )}
        <ul className="crm-amo-events">
          {status.webhook_events.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>

      {status.pipelines.length > 0 && (
        <div className="sheet sheet-pad">
          <h4 className="crm-amo-title">Воронки и этапы из amoCRM</h4>
          <p className="muted form-hint no-margin">
            Эти названия ИИ видит в сделках — используйте их дословно в «Правилах воронки».
          </p>
          <ul className="crm-amo-pipelines">
            {status.pipelines.map((p) => (
              <li key={p.id}>
                <b>{p.name}</b>: {p.stages.join(" → ")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
