// Roboto едет внутри приложения: на ресепшене интернет может пропасть, а
// запись должна выглядеть одинаково всегда.
import "@fontsource-variable/roboto";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  listening: boolean;
  monitor_error: string;
  location_name: string;
  configured: boolean;
  just_updated: string;
  finishing: boolean;
  finish_error: string;
  mic_connected: boolean;
  reconnects: number;
  leftover_pending: number;
  leftover_days: number;
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

interface UpdateInfo {
  available: boolean;
  current: string;
  version: string;
  notes: string;
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
const warnMic = $("warn-mic");
const leftoverBox = $("leftover");
const leftoverText = $("leftover-text");
const meterTitle = $("meter-title");
const meterFill = $("meter-fill");
const warnSilence = $("warn-silence");
const updatedBox = $("updated");
const updatedVersion = $("updated-version");
const updateBox = $("update");
const updateVersion = $("update-version");
const updateNotes = $("update-notes");
const btnUpdate = $("btn-update") as HTMLButtonElement;
const btnCheckUpdate = $("btn-check-update") as HTMLButtonElement;
const updateStatus = $("update-status");
const appVersion = $("app-version");

let busy = false;
let finishing = false;
// Последнее известное состояние записи: по нему пишется второй вопрос при
// закрытии, а спрашивать сервер в этот момент поздно.
let lastStatus: Status | null = null;
// Number of consecutive polls with a completely silent input while recording.
// The OS denying microphone access looks exactly like this, so warn about it.
let silentPolls = 0;
const POLL_INTERVAL_MS = 1000;
// Раз в час: приложение открыто сутками, а обновления выходят раз в недели.
const UPDATE_CHECK_MS = 60 * 60 * 1000;
const SILENT_POLLS_BEFORE_WARNING = 10; // ~10 seconds of complete silence

function setError(message: string) {
  errorEl.textContent = message;
}

/** Полоса уровня. Видна и до начала смены: приложение слушает микрофон, ничего
 *  не записывая, поэтому «слышно или нет» проверяется до нажатия «Начать», а не
 *  через десять секунд после. Раньше это выяснялось уже на записанной смене. */
function renderMeter(status: Status) {
  // Микрофон пропал посреди записи: отдельное предупреждение, потому что
  // причина другая (кабель, питание колонки), и приложение уже само
  // пытается переподключиться.
  warnMic.classList.toggle("show", status.recording && !status.mic_connected);
  const live = status.recording || status.listening;
  if (!live) {
    // Микрофон не открылся вовсе — полосе нечего показывать, зато ровно тот
    // случай, про который написано в предупреждении.
    meter.style.display = "none";
    warnSilence.classList.add("show");
    silentPolls = 0;
    return;
  }
  meter.style.display = "block";
  meterTitle.textContent = status.recording
    ? `Уровень сигнала — ${status.device_name || "микрофон"}`
    : `Проверка микрофона — ${status.device_name || "микрофон"}`;
  // Amplitude is perceptually compressed: sqrt makes quiet speech visible.
  const width = Math.min(100, Math.sqrt(status.input_level) * 100);
  meterFill.style.width = `${width}%`;

  if (status.paused || (status.recording && !status.mic_connected)) {
    // На паузе тишина ожидаема; при отвалившемся микрофоне о ней уже сказано
    // отдельным предупреждением выше.
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
  lastStatus = status;
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
  } else if (status.finishing) {
    // Запись остановлена, но сервер ещё не подтвердил закрытие смены:
    // сегменты догружаются в фоне, «Завершить» повторяет попытку.
    statusText.textContent = "Смена остановлена, отправляем на сервер";
    statusSub.textContent =
      status.chunks_pending > 0
        ? `Осталось отправить сегментов: ${status.chunks_pending}. Не выключайте компьютер.`
        : "Все сегменты на сервере — нажмите «Завершить» ещё раз";
    statsEl.innerHTML =
      `Записано сегментов: ${status.chunks_recorded}<br>` +
      `Загружено на сервер: ${status.chunks_uploaded}`;
    if (status.finish_error && !busy) setError(status.finish_error);
  } else if (status.recording) {
    statusText.textContent = status.paused ? "ПАУЗА" : "● ИДЁТ ЗАПИСЬ";
    statusSub.textContent = `${status.date}, с ${status.started_at}`;
    statsEl.innerHTML =
      `Записано сегментов: ${status.chunks_recorded}<br>` +
      `Загружено на сервер: ${status.chunks_uploaded}` +
      (status.chunks_pending > 0 ? ` (в очереди: ${status.chunks_pending})` : "") +
      (status.reconnects > 0
        ? `<br>Микрофон переподключался: ${status.reconnects} раз`
        : "");
    if (status.upload_error) {
      setError(`Проблема загрузки (повторяем): ${status.upload_error.slice(0, 200)}`);
    }
  } else {
    statusText.textContent = "Запись не идёт";
    statusSub.textContent = "";
    statsEl.textContent = "";
  }
  if (!status.recording && confirmingFinish) resetFinishButton();
  // Прошлые смены, которые ещё не все на сервере, досылаются сами — но
  // человек должен знать, что компьютер сейчас выключать нельзя.
  if (status.leftover_days > 0) {
    leftoverText.textContent =
      ` Не отправлено сегментов: ${status.leftover_pending}` +
      ` (смен: ${status.leftover_days}). Отправляются сами, пока приложение` +
      " открыто и есть связь с сервером.";
    leftoverBox.classList.add("show");
  } else {
    leftoverBox.classList.remove("show");
  }
  const active = status.recording || status.finishing;
  // Kept visible but locked while recording, so it always shows who is on shift.
  employeeSelect.disabled = active || busy;
  employeePicker.style.opacity = active ? "0.6" : "1";
  // Точку продажи нельзя менять на ходу: смена уже открыта на другой студии.
  locationSelect.disabled = active;
  btnStart.disabled = active || busy || !status.configured;
  // Обновление перезапускает приложение: посреди смены это оборвало бы запись.
  btnUpdate.disabled = status.recording || updating;
  btnUpdate.textContent = status.recording
    ? "Обновим после завершения смены"
    : updating
      ? "Обновляем…"
      : "Обновить и перезапустить";
  // Первый запуск после обновления: напоминание проверить микрофон. Оно
  // приходит из бэкенда один раз и дальше не возвращается.
  if (status.just_updated) {
    updatedVersion.textContent = status.just_updated;
    updatedBox.style.display = "block";
  }
  btnPause.disabled = !status.recording || busy;
  btnFinish.disabled = !(status.recording || status.finishing) || busy;
  if (!confirmingFinish) {
    btnFinish.textContent = status.finishing ? RETRY_FINISH_LABEL : FINISH_LABEL;
  }
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
// После неудачного завершения запись уже остановлена: повтор ничего не
// прерывает, поэтому второго нажатия для подтверждения не требуется.
const RETRY_FINISH_LABEL = "↻ Отправить и завершить ещё раз";
let confirmingFinish = false;
let confirmTimer: number | undefined;

function resetFinishButton() {
  confirmingFinish = false;
  if (confirmTimer) clearTimeout(confirmTimer);
  confirmTimer = undefined;
  btnFinish.textContent = FINISH_LABEL;
}

btnFinish.addEventListener("click", async () => {
  const retrying = lastStatus?.finishing ?? false;
  if (!confirmingFinish && !retrying) {
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

let updating = false;

/** Проверка обновлений. Тихая при автоматическом запуске: если сервер
 *  недоступен, это не повод показывать ошибку поверх рабочего экрана —
 *  запись от этого не зависит. */
async function checkUpdate(loud: boolean) {
  if (loud) updateStatus.textContent = "Проверяем…";
  try {
    const info = await invoke<UpdateInfo>("check_update");
    appVersion.textContent = info.current;
    updateBox.style.display = info.available ? "block" : "none";
    if (info.available) {
      updateVersion.textContent = info.version;
      updateNotes.textContent = info.notes;
    }
    if (loud) {
      updateStatus.textContent = info.available
        ? `есть версия ${info.version}`
        : "установлена последняя версия";
    }
  } catch (e) {
    if (loud) updateStatus.textContent = String(e);
  }
}

btnUpdate.addEventListener("click", async () => {
  if (updating) return;
  updating = true;
  setError("");
  btnUpdate.textContent = "Обновляем…";
  btnUpdate.disabled = true;
  try {
    // Приложение перезапустится само — этот вызов обычно не возвращается.
    await invoke("install_update");
  } catch (e) {
    setError(String(e));
    updating = false;
    refresh();
  }
});

btnCheckUpdate.addEventListener("click", () => checkUpdate(true));

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

/* --- Закрытие приложения ---------------------------------------------------
 *
 * Компьютер стоит на ресепшене, за ним весь день ходят люди, и ⌘Q нажимается
 * случайно легче, чем кажется. Пока приложение закрыто, разговоры у стойки не
 * записываются, и узнают об этом вечером — по пустой смене. Поэтому вопроса
 * два, и во втором прямо написано, что именно прервётся.
 */

const quit1 = $("quit-1");
const quit2 = $("quit-2");
const quit1Text = $("quit-1-text");
const quit2Title = $("quit-2-title");
const quit2Text = $("quit-2-text");

function closeQuitDialogs() {
  quit1.style.display = "none";
  quit2.style.display = "none";
}

function askToQuit() {
  // Повторное ⌘Q не должно перескакивать сразу ко второму вопросу.
  if (quit2.style.display === "flex") return;
  const recording = lastStatus?.recording ?? false;
  const sending = (lastStatus?.finishing ?? false) || (lastStatus?.leftover_days ?? 0) > 0;
  quit1Text.textContent = recording
    ? "Сейчас идёт запись смены. Пока приложение закрыто, разговоры у стойки не записываются."
    : sending
      ? "Приложение ещё отправляет записанные сегменты на сервер. Если закрыть его сейчас, отправка остановится до следующего запуска."
      : "Пока приложение закрыто, разговоры у стойки не записываются: смену будет некому начать.";
  quit1.style.display = "flex";
  quit2.style.display = "none";
}

function askToQuitAgain() {
  const status = lastStatus;
  const recording = status?.recording ?? false;
  quit2Title.textContent = recording ? "Идёт запись смены" : "Точно закрыть?";
  if (recording) {
    const pending = status?.chunks_pending ?? 0;
    // Про недогруженные куски говорим отдельно: они уйдут на сервер, но
    // только когда смену снова начнут в этом приложении.
    const pendingNote =
      pending > 0
        ? ` Не отправлено на сервер кусков: ${pending} — они сохранены на компьютере и уйдут, когда смену начнут заново.`
        : "";
    quit2Text.innerHTML =
      "<b>Запись остановится.</b> Последние минуты разговора, которые ещё не " +
      "успели сохраниться, пропадут, и до перезапуска приложения запись не " +
      "ведётся." +
      pendingNote +
      " Правильный порядок — сначала «Завершить день и отправить», и только потом закрывать.";
  } else {
    quit2Text.innerHTML =
      "Приложение закроется полностью и само не откроется до перезагрузки " +
      "компьютера. Если просто мешает окно — сверните его, а не закрывайте.";
  }
  quit1.style.display = "none";
  quit2.style.display = "flex";
}

$("quit-1-stay").addEventListener("click", closeQuitDialogs);
$("quit-2-stay").addEventListener("click", closeQuitDialogs);
$("quit-1-next").addEventListener("click", askToQuitAgain);
$("quit-2-quit").addEventListener("click", () => {
  invoke("confirm_quit").catch((e) => {
    closeQuitDialogs();
    setError(String(e));
  });
});

// Escape закрывает вопрос, но никогда не закрывает приложение.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeQuitDialogs();
});

listen("close-requested", askToQuit);

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

  checkUpdate(false);
  setInterval(() => checkUpdate(false), UPDATE_CHECK_MS);
}

init();
