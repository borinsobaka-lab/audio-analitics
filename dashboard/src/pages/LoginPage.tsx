/** Вход в админку.
 *
 *  Два способа, и второй не запасной, а обязательный: пока владелец не завёл
 *  ни одного логина, войти можно только мастер-ключом сервера, и он же
 *  остаётся дорогой назад, если пароль последнего администратора потерян.
 */
import { FormEvent, useEffect, useState } from "react";
import { api, Me, setToken } from "../api";
import { IconWave, Note } from "../components/ui";

export default function LoginPage({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [token, setTokenValue] = useState("");
  const [byToken, setByToken] = useState(false);
  const [hasLogins, setHasLogins] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .authState()
      .then((s) => {
        setHasLogins(s.has_logins);
        // Логинов ещё нет — форма с логином и паролем была бы тупиком.
        if (!s.has_logins) setByToken(true);
      })
      .catch(() => setHasLogins(null));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (byToken) {
        setToken(token.trim());
        onSignedIn(await api.me());
      } else {
        const session = await api.login(login.trim(), password);
        setToken(session.token);
        onSignedIn(session.user);
      }
    } catch (err) {
      setToken(null);
      setError(String(err).replace(/^Error:\s*/, ""));
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="sheet sheet-pad login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <span className="brand-mark">
            <IconWave />
          </span>
          <span>
            <span className="brand-name">Ресепшен</span>
            <span className="brand-sub">речевая аналитика</span>
          </span>
        </div>

        {byToken ? (
          <>
            <label className="field">
              <span className="label">Токен владельца</span>
              <input
                type="password"
                value={token}
                autoFocus
                placeholder="ADMIN_API_TOKEN"
                onChange={(e) => setTokenValue(e.target.value)}
              />
            </label>
            {hasLogins === false && (
              <p className="muted login-hint">
                Пользователей пока нет. Войдите мастер-ключом сервера и заведите
                сотрудников в разделе «Сотрудники» — там же выдаются логины
                и пароли.
              </p>
            )}
          </>
        ) : (
          <>
            <label className="field">
              <span className="label">Логин</span>
              <input
                type="text"
                value={login}
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                onChange={(e) => setLogin(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="label">Пароль</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <p className="muted login-hint">
              Пароль выдаёт администратор. Забыли — попросите сбросить: старый
              не восстанавливается, вместо него выдаётся новый.
            </p>
          </>
        )}

        {error && <Note kind="error">{error}</Note>}

        <button
          className="btn-block"
          type="submit"
          disabled={busy || (byToken ? !token.trim() : !login.trim() || !password)}
        >
          {busy ? "Проверяем…" : "Войти"}
        </button>

        <button
          type="button"
          className="ghost small btn-block"
          onClick={() => {
            setByToken(!byToken);
            setError("");
          }}
        >
          {byToken ? "Войти по логину и паролю" : "Войти токеном владельца"}
        </button>
      </form>
    </div>
  );
}
