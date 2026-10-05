import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { startPrefetch } from "./boot";
// Roboto собирается вместе с приложением, а не тянется с чужого CDN:
// админка открывается и без интернета до Google Fonts, и без скачка вёрстки
// при подмене шрифта.
import "@fontsource-variable/roboto";
import "./styles.css";

// Запросы к серверу — сразу, параллельно и до первой отрисовки: пока React
// собирает страницу, ответы уже в пути.
startPrefetch();

// Service worker держит оболочку админки (HTML, скрипты, стили, шрифты) на
// устройстве: с рабочего стола и по ссылке она открывается без загрузки.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
