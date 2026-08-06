import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
// Roboto собирается вместе с приложением, а не тянется с чужого CDN:
// админка открывается и без интернета до Google Fonts, и без скачка вёрстки
// при подмене шрифта.
import "@fontsource-variable/roboto";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
