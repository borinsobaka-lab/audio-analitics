/** Быстрое открытие: показать сразу то, что было в прошлый раз, и обновить
 *  в фоне.
 *
 *  Раньше открытие шло цепочкой: скачать приложение → спросить сервер «кто
 *  я» → только потом спросить скрипты. Два похода на сервер подряд, и всё
 *  это время — пустой экран. Теперь:
 *  - кто вошёл, дерево скриптов и настройки подстановки лежат в
 *    localStorage и показываются мгновенно, ещё до ответа сервера;
 *  - свежие данные запрашиваются сразу при загрузке модуля, все параллельно,
 *    до первой отрисовки, — и тихо заменяют сохранённые.
 *
 *  Кэш привязан к токену: другой вход — другой кэш, после выхода он стирается.
 *  Сессию отозвали — сервер ответит 401 на фоновую проверку, и админка
 *  сразу покажет вход, как и раньше.
 */
import { api, getToken, Me, Playbook, PlaybookSettings } from "./api";

const PREFIX = "aa_cache:";

/** Короткий отпечаток токена — чтобы кэши разных входов не смешивались,
 *  а сам токен не попадал в ключи. */
function tokenTag(token: string): string {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h << 5) + h + token.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function key(name: string): string | null {
  const token = getToken();
  return token ? `${PREFIX}${tokenTag(token)}:${name}` : null;
}

export function readCache<T>(name: string): T | null {
  const k = key(name);
  if (!k) return null;
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeCache(name: string, value: unknown): void {
  const k = key(name);
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify(value));
  } catch {
    // Переполнен localStorage — не страшно: в следующий раз просто без кэша.
  }
}

/** Выход или чужой вход — стереть все сохранённые данные. */
export function clearCache(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    /* нет доступа к localStorage — нечего и стирать */
  }
}

/* --- Запросы, начатые до первой отрисовки --------------------------------- */

type Prefetched = {
  me?: Promise<Me>;
  playbook?: Promise<Playbook>;
  settings?: Promise<PlaybookSettings>;
};

let prefetched: Prefetched = {};

/** Начать запросы сразу — параллельно, не дожидаясь «кто я». Скрипты — если
 *  открывается не «Аналитика»: там они не нужны. */
export function startPrefetch(path = window.location.pathname): void {
  if (!getToken()) return;
  const scripts = !path.startsWith("/analytics") && !path.startsWith("/days") && !path.startsWith("/calls") &&
    !path.startsWith("/metrics") && !path.startsWith("/locations") && !path.startsWith("/app");
  prefetched = {
    me: api.me(),
    playbook: scripts ? api.playbook() : undefined,
    settings: scripts ? api.playbookSettings() : undefined,
  };
  // Не дать браузеру ругаться на необработанный отказ: каждый ответ ещё
  // заберёт тот, кому он нужен, и обработает ошибку сам.
  for (const p of Object.values(prefetched)) p?.catch(() => {});
}

/** Забрать уже начатый запрос (один раз) или начать новый. */
export function take<K extends keyof Prefetched>(
  name: K,
  fresh: () => NonNullable<Prefetched[K]>
): NonNullable<Prefetched[K]> {
  const p = prefetched[name];
  prefetched[name] = undefined;
  return (p ?? fresh()) as NonNullable<Prefetched[K]>;
}
