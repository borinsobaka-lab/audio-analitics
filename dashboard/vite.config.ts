import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** sw.js с файлами этой сборки: скрипты, стили и шрифты кириллицы и
 *  латиницы (другие начертания — греческое, вьетнамское — не нужны и
 *  догрузятся сами, если когда-нибудь понадобятся). Номер версии — отпечаток
 *  имён файлов: поменялась сборка — поменялся sw.js, браузер обновит кэш. */
function swPlugin(): Plugin {
  return {
    name: "aa-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => /\.(js|css)$/.test(f) || /roboto-(cyrillic|latin)-wght/.test(f))
        .sort()
        .map((f) => `/${f}`);
      const version = createHash("sha256").update(files.join("|")).digest("hex").slice(0, 12);
      const source = readFileSync(new URL("./sw.template.js", import.meta.url), "utf8")
        .replace("__VERSION__", version)
        .replace("__PRECACHE__", JSON.stringify(files));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

/** Соединение с API открывается заранее, пока грузится приложение: к первому
 *  запросу DNS, TCP и TLS уже готовы. Только если адрес API задан. */
function preconnectPlugin(): Plugin {
  return {
    name: "aa-preconnect",
    transformIndexHtml() {
      const api = process.env.VITE_API_URL;
      if (!api) return [];
      return [
        { tag: "link", attrs: { rel: "preconnect", href: api, crossorigin: "" }, injectTo: "head-prepend" },
        { tag: "link", attrs: { rel: "dns-prefetch", href: api }, injectTo: "head-prepend" },
      ];
    },
  };
}

export default defineConfig({
  plugins: [react(), swPlugin(), preconnectPlugin()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
  // Сборка локально — с тем же прокси: так замеряют скорость открытия.
  preview: {
    port: 4173,
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
});
