import { invoke } from "@tauri-apps/api/core";

interface Status {
  recording: boolean;
  paused: boolean;
  recording_id: string | null;
  date: string | null;
  started_at: string | null;
  chunks_recorded: number;
  chunks_uploaded: number;
  chunks_pending: number;
  upload_error: string;
}

interface Settings {
  server_url: string;
  device_key: string;
}

const $ = (id: string) => document.getElementById(id)!;
const dot = $("dot");
const statusText = $("status-text");
const statusSub = $("status-sub");
const errorEl = $("error");
const statsEl = $("stats");
const btnStart = $("btn-start") as HTMLButtonElement;
const btnPause = $("btn-pause") as HTMLButtonElement;
const btnFinish = $("btn-finish") as HTMLButtonElement;
const serverUrl = $("server-url") as HTMLInputElement;
const deviceKey = $("device-key") as HTMLInputElement;

let busy = false;

function setError(message: string) {
  errorEl.textContent = message;
}

function render(status: Status) {
  dot.className = "dot" + (status.recording ? (status.paused ? " paused" : " on") : "");
  if (status.recording) {
    statusText.textContent = status.paused ? "ПАУЗА" : "● ИДЁТ ЗАПИСЬ";
    statusSub.textContent = `${status.date}, с ${status.started_at}`;
    statsEl.innerHTML =
      `Записано сегментов: ${status.chunks_recorded}<br>` +
      `Загружено на сервер: ${status.chunks_uploaded}` +
      (status.chunks_pending > 0 ? ` (в очереди: ${status.chunks_pending})` : "");
    if (status.upload_error) {
      setError(`Проблема загрузки (повторяем): ${status.upload_error.slice(0, 200)}`);
    }
  } else {
    statusText.textContent = "Запись не идёт";
    statusSub.textContent = "";
    statsEl.textContent = "";
  }
  btnStart.disabled = status.recording || busy;
  btnPause.disabled = !status.recording || busy;
  btnFinish.disabled = !status.recording || busy;
  btnPause.textContent = status.paused
    ? "⏵ Продолжить запись"
    : "⏸ Пауза (личный разговор)";
}

async function refresh() {
  try {
    render(await invoke<Status>("get_status"));
  } catch (e) {
    setError(String(e));
  }
}

btnStart.addEventListener("click", async () => {
  busy = true;
  setError("");
  btnStart.disabled = true;
  try {
    await invoke("start_day");
  } catch (e) {
    setError(String(e));
  } finally {
    busy = false;
    refresh();
  }
});

btnPause.addEventListener("click", async () => {
  try {
    await invoke("toggle_pause");
  } catch (e) {
    setError(String(e));
  }
  refresh();
});

btnFinish.addEventListener("click", async () => {
  if (!confirm("Завершить рабочий день? Запись остановится и уйдёт на обработку.")) return;
  busy = true;
  setError("");
  statusText.textContent = "Завершение: дозагрузка сегментов…";
  try {
    const message = await invoke<string>("finish_day");
    setError("");
    statusSub.textContent = message;
  } catch (e) {
    setError(String(e));
  } finally {
    busy = false;
    refresh();
  }
});

$("btn-save-settings").addEventListener("click", async () => {
  try {
    await invoke("save_settings", {
      settings: { server_url: serverUrl.value.trim(), device_key: deviceKey.value.trim() },
    });
    setError("");
    ($("settings-block") as HTMLDetailsElement).open = false;
  } catch (e) {
    setError(String(e));
  }
});

async function init() {
  try {
    const settings = await invoke<Settings>("get_settings");
    serverUrl.value = settings.server_url;
    deviceKey.value = settings.device_key;
    if (!settings.server_url) {
      ($("settings-block") as HTMLDetailsElement).open = true;
    }
  } catch (e) {
    setError(String(e));
  }
  refresh();
  setInterval(refresh, 2000);
}

init();
