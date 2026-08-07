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
  location_name: string;
  configured: boolean;
}

interface Settings {
  server_url: string;
  app_key: string;
  location_id: string;
  location_name: string;
  device_key: string;
  last_employee_id: string;
  autostart_configured: boolean;
}

interface Employee {
  id: string;
  full_name: string;
}

interface LocationPick {
  id: string;
  name: string;
  address: string;
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
const appKey = $("app-key") as HTMLInputElement;
const deviceKey = $("device-key") as HTMLInputElement;
const locationSelect = $("location") as HTMLSelectElement;
const locationHint = $("location-hint");
const autostart = $("autostart") as HTMLInputElement;
const employeeSelect = $("employee") as HTMLSelectElement;
const employeePicker = $("employee-picker");
const employeeHint = $("employee-hint");
const setupLocation = $("setup-location");
const setupMic = $("setup-mic");
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

/** Что именно сейчас пишется — студия и микрофон. Обе строки видны до начала
 *  смены: ошибку в них надо заметить сейчас, а не при разборе пустой записи. */
function renderSetup(status: Status) {
  if (status.location_name) {
    setupLocation.textContent = status.location_name;
    setupLocation.className = "val";
  } else {
    setupLocation.textContent = "не выбрана — откройте настройки";
    setupLocation.className = "val missing";
  }
  if (status.device_name) {
    setupMic.textContent = status.device_name;
    setupMic.className = "val";
  } else {
    setupMic.textContent = "система не отдаёт микрофон";
    setupMic.className = "val missing";
  }
}

function render(status: Status) {
  dot.className = "dot" + (status.recording ? (status.paused ? " paused" : " on") : "");
  renderMeter(status);
  renderSetup(status);
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
  // Точку продажи нельзя менять на ходу: смена уже открыта на другой студии.
  locationSelect.disabled = status.recording;
  btnStart.disabled = status.recording || busy || !status.configured;
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
        "Заведите сотрудников этой студии в веб-админке, в разделе «Сотрудники».";
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

let knownLocations: LocationPick[] = [];

async function loadLocations(selectedId: string) {
  try {
    knownLocations = await invoke<LocationPick[]>("list_locations");
    locationSelect.innerHTML = "";
    if (knownLocations.length === 0) {
      locationSelect.innerHTML = '<option value="">Точки не заведены</option>';
      locationHint.textContent =
        "Заведите точку продажи в веб-админке, в разделе «Точки продажи».";
      return;
    }
    locationSelect.append(new Option("— выберите точку —", ""));
    for (const location of knownLocations) {
      const label = location.address
        ? `${location.name} — ${location.address}`
        : location.name;
      locationSelect.append(new Option(label, location.id));
    }
    if (selectedId && knownLocations.some((l) => l.id === selectedId)) {
      locationSelect.value = selectedId;
    }
  } catch (e) {
    locationSelect.innerHTML = '<option value="">Список недоступен</option>';
    locationHint.textContent = String(e);
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

autostart.addEventListener("change", async () => {
  try {
    await invoke("set_autostart", { enabled: autostart.checked });
    setError("");
  } catch (e) {
    // Возвращаем галочку на место: состояние переключателя должно совпадать
    // с тем, что реально настроено в системе.
    autostart.checked = !autostart.checked;
    setError(String(e));
  }
});

$("btn-save-settings").addEventListener("click", async () => {
  try {
    const current = await invoke<Settings>("get_settings");
    const locationId = locationSelect.value;
    const chosen = knownLocations.find((l) => l.id === locationId);
    await invoke("save_settings", {
      settings: {
        server_url: serverUrl.value.trim(),
        app_key: appKey.value.trim(),
        location_id: locationId,
        location_name: chosen?.name ?? "",
        device_key: deviceKey.value.trim(),
        last_employee_id: current.last_employee_id ?? "",
        autostart_configured: current.autostart_configured,
      },
    });
    setError("");
    ($("settings-block") as HTMLDetailsElement).open = false;
    // Другая точка — другой список менеджеров.
    await loadEmployees(current.last_employee_id);
    await refresh();
  } catch (e) {
    setError(String(e));
  }
});

async function init() {
  let settings: Settings | null = null;
  try {
    settings = await invoke<Settings>("get_settings");
    serverUrl.value = settings.server_url;
    appKey.value = settings.app_key;
    deviceKey.value = settings.device_key;
  } catch (e) {
    setError(String(e));
  }

  try {
    autostart.checked = await invoke<boolean>("get_autostart");
  } catch {
    // Автозапуск может быть недоступен (например, приложение запущено из
    // сборки без установки) — переключатель просто останется выключенным.
  }

  await loadLocations(settings?.location_id ?? "");

  if (settings?.location_id || settings?.device_key) {
    await loadEmployees(settings.last_employee_id);
  } else {
    employeeSelect.innerHTML = '<option value="">Сначала выберите точку продажи</option>';
    // Настройки открыты сразу: без точки продажи начать смену нельзя.
    ($("settings-block") as HTMLDetailsElement).open = true;
  }
  refresh();
  setInterval(refresh, POLL_INTERVAL_MS);
}

init();
