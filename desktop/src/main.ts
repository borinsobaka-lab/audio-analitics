// Roboto едет внутри приложения: на ресепшене интернет может пропасть, а
// запись должна выглядеть одинаково всегда.
import "@fontsource-variable/roboto";
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
  input_level: number;
  device_name: string;
}

interface Settings {
  server_url: string;
  device_key: string;
  last_employee_id: string;
}

interface Employee {
  id: string;
  full_name: string;
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
const employeeSelect = $("employee") as HTMLSelectElement;
const employeePicker = $("employee-picker");
const employeeHint = $("employee-hint");
const meter = $("meter");
const meterTitle = $("meter-title");
const meterFill = $("meter-fill");
const warnSilence = $("warn-silence");

let busy = false;
let finishing = false;
// Number of consecutive polls with a completely silent input while recording.
// The OS denying microphone access looks exactly like this, so warn about it.
let silentPolls = 0;
const POLL_INTERVAL_MS = 1000;
const SILENT_POLLS_BEFORE_WARNING = 10; // ~10 seconds of complete silence

function setError(message: string) {
  errorEl.textContent = message;
}

function renderMeter(status: Status) {
  if (!status.recording) {
    meter.style.display = "none";
    warnSilence.classList.remove("show");
    silentPolls = 0;
    return;
  }
  meter.style.display = "block";
  meterTitle.textContent = `Уровень сигнала — ${status.device_name || "микрофон"}`;
  // Amplitude is perceptually compressed: sqrt makes quiet speech visible.
  const width = Math.min(100, Math.sqrt(status.input_level) * 100);
  meterFill.style.width = `${width}%`;

  if (status.paused) {
    silentPolls = 0;
  } else if (status.input_level <= 0) {
    silentPolls += 1;
  } else {
    silentPolls = 0;
  }
  warnSilence.classList.toggle("show", silentPolls >= SILENT_POLLS_BEFORE_WARNING);
}

function render(status: Status) {
  dot.className = "dot" + (status.recording ? (status.paused ? " paused" : " on") : "");
  renderMeter(status);
  if (finishing) {
    statusText.textContent = "Завершение дня…";
    statusSub.textContent = "Дозагружаем сегменты на сервер, не закрывайте окно";
    statsEl.innerHTML =
      `Записано сегментов: ${status.chunks_recorded}<br>` +
      `Загружено на сервер: ${status.chunks_uploaded}` +
      (status.chunks_pending > 0 ? ` (в очереди: ${status.chunks_pending})` : "");
  } else if (status.recording) {
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
  if (!status.recording && confirmingFinish) resetFinishButton();
  // Kept visible but locked while recording, so it always shows who is on shift.
  employeeSelect.disabled = status.recording || busy;
  employeePicker.style.opacity = status.recording ? "0.6" : "1";
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

async function loadEmployees(preselectId?: string) {
  employeeHint.textContent = "";
  try {
    const employees = await invoke<Employee[]>("list_employees");
    employeeSelect.innerHTML = "";
    if (employees.length === 0) {
      employeeSelect.innerHTML = '<option value="">Менеджеры не заведены</option>';
      employeeHint.textContent =
        "Заведите менеджеров в веб-админке, на вкладке «Менеджеры».";
      return;
    }
    employeeSelect.append(new Option("— выберите менеджера —", ""));
    for (const employee of employees) {
      employeeSelect.append(new Option(employee.full_name, employee.id));
    }
    const wanted = preselectId ?? employeeSelect.value;
    if (wanted && employees.some((e) => e.id === wanted)) {
      employeeSelect.value = wanted;
    }
  } catch (e) {
    employeeSelect.innerHTML = '<option value="">Список недоступен</option>';
    employeeHint.textContent = String(e);
  }
}

btnStart.addEventListener("click", async () => {
  const employeeId = employeeSelect.value;
  if (!employeeId) {
    setError("Выберите менеджера, который начинает рабочий день");
    employeeSelect.focus();
    return;
  }
  busy = true;
  setError("");
  btnStart.disabled = true;
  try {
    await invoke("start_day", { employeeId });
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

// Confirmation is done in-app, not with window.confirm(): the macOS WebView
// never displays native JS dialogs and silently reports "cancelled", which
// made this button look dead.
const FINISH_LABEL = "■ Завершить день и отправить";
let confirmingFinish = false;
let confirmTimer: number | undefined;

function resetFinishButton() {
  confirmingFinish = false;
  if (confirmTimer) clearTimeout(confirmTimer);
  confirmTimer = undefined;
  btnFinish.textContent = FINISH_LABEL;
}

btnFinish.addEventListener("click", async () => {
  if (!confirmingFinish) {
    confirmingFinish = true;
    btnFinish.textContent = "Нажмите ещё раз, чтобы завершить день";
    confirmTimer = window.setTimeout(resetFinishButton, 8000);
    return;
  }
  resetFinishButton();

  busy = true;
  finishing = true;
  setError("");
  render(await invoke<Status>("get_status"));
  try {
    const message = await invoke<string>("finish_day");
    finishing = false;
    setError("");
    await refresh();
    statusSub.textContent = message;
  } catch (e) {
    finishing = false;
    setError(String(e));
  } finally {
    busy = false;
    finishing = false;
    refresh();
  }
});

$("btn-save-settings").addEventListener("click", async () => {
  try {
    const current = await invoke<Settings>("get_settings");
    await invoke("save_settings", {
      settings: {
        server_url: serverUrl.value.trim(),
        device_key: deviceKey.value.trim(),
        last_employee_id: current.last_employee_id ?? "",
      },
    });
    setError("");
    ($("settings-block") as HTMLDetailsElement).open = false;
    // New server or key means a different list of managers.
    await loadEmployees(current.last_employee_id);
  } catch (e) {
    setError(String(e));
  }
});

async function init() {
  let settings: Settings | null = null;
  try {
    settings = await invoke<Settings>("get_settings");
    serverUrl.value = settings.server_url;
    deviceKey.value = settings.device_key;
    if (!settings.server_url) {
      ($("settings-block") as HTMLDetailsElement).open = true;
    }
  } catch (e) {
    setError(String(e));
  }
  if (settings?.server_url && settings?.device_key) {
    await loadEmployees(settings.last_employee_id);
  } else {
    employeeSelect.innerHTML = '<option value="">Сначала заполните настройки</option>';
  }
  refresh();
  setInterval(refresh, POLL_INTERVAL_MS);
}

init();
