/** Подключение Wazzup: тексты ответов администраторов.
 *
 *  amoCRM через API сообщает об ответе администратора в чате только время и
 *  автора — текст не отдаёт. WhatsApp студии идёт через Wazzup, а Wazzup
 *  присылает вебхуком каждое исходящее сообщение с текстом. Достаточно
 *  API-ключа: адрес для вебхуков сервер пропишет в Wazzup сам.
 *
 *  Адрес вебхуков у аккаунта Wazzup один. Если там уже стоит чужой адрес,
 *  сервер его не трогает и говорит об этом — заменить можно только явным
 *  подтверждением: другой сервис после этого перестанет получать сообщения.
 */
import { useEffect, useState } from "react";
import { api, fmtWhen, plural, WazzupStatus } from "../api";
import { ConfirmAction, Note, Section, Skeleton } from "../components/ui";

const CONFLICT = "В Wazzup уже указан адрес";

export default function WazzupConnect() {
  const [status, setStatus] = useState<WazzupStatus | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "off" | null>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    api.wazzupStatus().then(setStatus).catch((e) => setError(String(e).replace(/^Error:\s*/, "")));
  }, []);

  if (!status) return error ? <Note kind="error">{error}</Note> : <Skeleton count={1} height={160} />;

  const connect = async (force: boolean) => {
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const res = await api.connectWazzup(key.trim(), force);
      setStatus(res);
      setKey("");
      setConflict("");
      setNotice(
        "Wazzup подключён. Отправьте из amoCRM тестовое сообщение клиенту в WhatsApp — через минуту здесь вырастет счётчик ответов с текстом."
      );
    } catch (e) {
      const message = String(e).replace(/^Error:\s*/, "");
      if (message.startsWith(CONFLICT)) setConflict(message);
      else setError(message);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("off");
    setError("");
    setNotice("");
    try {
      setStatus(await api.disconnectWazzup());
      setNotice("Wazzup отключён: ключ стёрт, тексты, которые уже пришли, остались.");
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(null);
    }
  };

  const texts = status.texts_added + status.texts_merged;

  return (
    <Section title="Wazzup" hint="тексты ответов администраторов в WhatsApp">
      <div className="sheet sheet-pad crm-amo">
        {status.connected ? (
          <div className="crm-amo-state">
            <span className="status done">
              <span className="dot" />
              Подключено
            </span>
            <span className="muted">
              ключ …{status.key_hint}
              {status.connected_at && ` · с ${fmtWhen(status.connected_at)}`}
            </span>
          </div>
        ) : (
          <p className="muted no-margin">
            amoCRM сообщает об ответе администратора только время и автора — текст ответа без Wazzup
            разбор не видит и о качестве общения не судит. Нужен API-ключ из личного кабинета
            Wazzup; адрес для вебхуков сервер пропишет в Wazzup сам.
          </p>
        )}
        {status.connected && (
          <div className="crm-amo-sync">
            <span className="muted">
              Вебхуков получено: {status.webhooks_received}
              {status.last_webhook_at && `, последний ${fmtWhen(status.last_webhook_at)}`}.
            </span>
            <span className="muted">
              Ответов с текстом: {texts}
              {status.pending > 0 &&
                ` · ждут сделку в CRM: ${status.pending} ${plural(status.pending, "сообщение", "сообщения", "сообщений")}`}
              {status.unmatched > 0 && ` · без сделки: ${status.unmatched}`}.
            </span>
          </div>
        )}
        {status.last_error && <Note kind="error">Wazzup: {status.last_error}</Note>}
        {status.replaced_uri && (
          <Note kind="info">
            До подключения в Wazzup был указан адрес {status.replaced_uri}. Сервис по этому адресу больше
            не получает сообщения из Wazzup.
          </Note>
        )}
        {error && <Note kind="error">{error}</Note>}
        {notice && <Note kind="success">{notice}</Note>}
        {conflict && (
          <Note kind="error">
            {conflict}
            <div className="actions">
              <button type="button" className="danger" disabled={busy !== null} onClick={() => connect(true)}>
                Заменить адрес и подключить
              </button>
              <button type="button" className="secondary" disabled={busy !== null} onClick={() => setConflict("")}>
                Не подключать
              </button>
            </div>
          </Note>
        )}

        <label className="field">
          <span className="label">
            API-ключ Wazzup {status.connected && <span className="muted">· пусто — оставить текущий</span>}
          </span>
          <input
            type="password"
            value={key}
            placeholder={status.connected ? "•••• оставить как есть" : "ключ из личного кабинета Wazzup"}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <p className="muted form-hint no-margin">
          Берутся только исходящие сообщения: входящие с текстом уже приходят вебхуком amoCRM. Сделка
          находится по номеру клиента. Instagram, подключённый в amoCRM напрямую, а не через Wazzup,
          так не виден — по нему разбор оценивает только скорость и факт ответа.
        </p>

        <div className="actions crm-amo-actions">
          <button
            type="button"
            disabled={busy !== null || (!status.connected && !key.trim())}
            onClick={() => connect(false)}
          >
            {busy === "save" ? "Проверяем…" : status.connected ? "Переподключить" : "Подключить"}
          </button>
          {status.connected && (
            <ConfirmAction
              label="Отключить"
              confirmLabel="Отключить Wazzup"
              title="Wazzup перестанет присылать сообщения; ключ будет стёрт"
              disabled={busy !== null}
              onConfirm={disconnect}
            />
          )}
        </div>
      </div>
    </Section>
  );
}
