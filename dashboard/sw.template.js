/* Service worker админки: оболочка (HTML, скрипты, стили, шрифты) живёт на
 * устройстве, поэтому с рабочего стола и по ссылке админка открывается без
 * загрузки. Данные (API) он не трогает — их кэширует само приложение.
 *
 * Файл собирается при каждой сборке (vite.config.ts → swPlugin): в него
 * вписываются список файлов этой версии и её номер. Новая сборка — новый
 * sw.js — браузер ставит его в фоне, скачивает новую версию целиком, старую
 * удаляет. Пользователь получает её при следующем открытии.
 */
const VERSION = "__VERSION__";
const CACHE = `aa-shell-${VERSION}`;
const PRECACHE = __PRECACHE__;
// Оболочка — по адресу «/»: Cloudflare Pages отвечает на /index.html
// перенаправлением, а перенаправленный ответ нельзя отдать на переход.
const SHELL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([SHELL, ...PRECACHE]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith("aa-shell-") && k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Только своё: API, аудио и всё чужое идут в сеть как обычно.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // Переход на любую страницу админки (/, /scripts/…, ссылка на скрипт) —
  // сразу оболочка из кэша. Свежая подтягивается в фоне к следующему разу.
  if (request.mode === "navigate") {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(SHELL);
        const network = fetch(SHELL, { cache: "no-cache" })
          .then((resp) => {
            if (resp.ok && !resp.redirected) cache.put(SHELL, resp.clone());
            return resp;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Файлы сборки неизменны (в имени — хэш содержимого): из кэша, иначе из
  // сети с сохранением.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const resp = await fetch(request);
        if (resp.ok) cache.put(request, resp.clone());
        return resp;
      })
    );
  }
});
