#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod keep_awake;
mod ogg_opus;
mod recorder;
mod uploader;

use anyhow::{Context, Result};
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_updater::UpdaterExt;

use keep_awake::KeepAwake;
use recorder::{MonitorHandle, RecorderHandle};
use uploader::{RecordingClosed, ServerConfig, Uploader};

/// Сколько ждать дозагрузки сегментов при «Завершить день», прежде чем
/// сообщить об этом. Загрузка после этого не останавливается.
const FINISH_UPLOAD_WAIT: Duration = Duration::from_secs(180);

/// Адрес сервера и ключ приложения вшиваются в сборку:
///
///   AA_SERVER_URL=https://api.example.com AA_APP_KEY=… npm run build:mac
///
/// Смысл в том, чтобы у сотрудника на ресепшене осталась ровно одна
/// настройка — точка продажи. Адрес и ключ он всё равно набирал с чужих слов,
/// и любая опечатка выглядела как «сервер недоступен». Если сборку сделали без
/// этих переменных, поля остаются в разделе «Для настройщика».
const BUILT_IN_SERVER_URL: &str = match option_env!("AA_SERVER_URL") {
    Some(v) => v,
    None => "",
};
const BUILT_IN_APP_KEY: &str = match option_env!("AA_APP_KEY") {
    Some(v) => v,
    None => "",
};

#[derive(Clone, Serialize, Deserialize, Default)]
struct Settings {
    /// Пусто — берётся вшитый в сборку адрес.
    #[serde(default)]
    server_url: String,
    /// Пусто — берётся вшитый в сборку ключ приложения.
    #[serde(default)]
    app_key: String,
    /// Точка продажи: единственное, что выбирает сотрудник.
    #[serde(default)]
    location_id: String,
    /// Имя точки — чтобы показать выбор, не дожидаясь ответа сервера.
    #[serde(default)]
    location_name: String,
    /// Прежняя схема: свой ключ на каждое устройство. Оставлен, чтобы
    /// обновление не остановило запись там, где приложение уже настроено.
    #[serde(default)]
    device_key: String,
    /// Manager chosen last time — preselected so the daily routine is one click.
    #[serde(default)]
    last_employee_id: String,
    /// Автозапуск настраивался хотя бы раз. До этого приложение включает его
    /// само: компьютер на ресепшене перезагружают, и запись должна подняться
    /// вместе с ним, а не ждать, пока кто-то вспомнит.
    #[serde(default)]
    autostart_configured: bool,
}

impl Settings {
    fn base_url(&self) -> String {
        let url = if self.server_url.is_empty() {
            BUILT_IN_SERVER_URL
        } else {
            &self.server_url
        };
        url.trim_end_matches('/').to_string()
    }

    fn app_key(&self) -> String {
        if self.app_key.is_empty() {
            BUILT_IN_APP_KEY.to_string()
        } else {
            self.app_key.clone()
        }
    }

    /// Настроено ли приложение достаточно, чтобы обращаться к серверу.
    fn ready(&self) -> Result<(), String> {
        if self.base_url().is_empty() {
            return Err("Не задан адрес сервера — раздел «Для настройщика»".into());
        }
        let by_app = !self.app_key().is_empty() && !self.location_id.is_empty();
        if !by_app && self.device_key.is_empty() {
            return Err("Выберите точку продажи в настройках".into());
        }
        Ok(())
    }
}

/// Заголовки авторизации: новая схема (ключ приложения + точка продажи), а на
/// уже настроенных машинах — прежний ключ устройства.
fn with_auth(
    req: reqwest::blocking::RequestBuilder,
    settings: &Settings,
) -> reqwest::blocking::RequestBuilder {
    let app_key = settings.app_key();
    if !app_key.is_empty() && !settings.location_id.is_empty() {
        req.header("X-App-Key", app_key)
            .header("X-Location-Id", &settings.location_id)
    } else {
        req.header("X-Device-Key", &settings.device_key)
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Employee {
    id: String,
    full_name: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct LocationPick {
    id: String,
    name: String,
    #[serde(default)]
    address: String,
}

struct ActiveSession {
    recording_id: String,
    date: String,
    chunks_dir: PathBuf,
    started_at: String,
    /// None после «Завершить»: микрофон остановлен, но сегменты ещё
    /// догружаются или сервер не подтвердил закрытие. Смена остаётся в
    /// состоянии, чтобы «Завершить» можно было нажать ещё раз, а не начинать
    /// новую запись ради дозагрузки.
    recorder: Option<RecorderHandle>,
    uploader: Uploader,
    /// Почему последнее «Завершить» не удалось — показывается на экране.
    finish_error: String,
    _keep_awake: KeepAwake,
}

/// Что известно о смене помимо самих чанков. Лежит в meta.json рядом с ними:
/// по дате уборщик отличает вчерашнюю незакрытую смену от сегодняшней, а по
/// моменту старта запись после перезапуска остаётся на шкале часов.
#[derive(Clone, Serialize, Deserialize, Default)]
struct RecordingMeta {
    #[serde(default)]
    date: String,
    #[serde(default)]
    started_at_unix_ms: u64,
    #[serde(default)]
    location_id: String,
}

fn meta_path(chunks_dir: &Path) -> PathBuf {
    chunks_dir.join("meta.json")
}

fn read_meta(chunks_dir: &Path) -> Option<RecordingMeta> {
    std::fs::read_to_string(meta_path(chunks_dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn write_meta(chunks_dir: &Path, meta: &RecordingMeta) -> Result<()> {
    std::fs::write(meta_path(chunks_dir), serde_json::to_string_pretty(meta)?)?;
    Ok(())
}

#[derive(Default)]
struct AppState {
    session: Mutex<Option<ActiveSession>>,
    /// Прослушивание микрофона без записи — чтобы уровень был виден до начала
    /// смены. Во время записи монитор выключен: устройство занято рекордером,
    /// и уровень берётся уже у него.
    monitor: Mutex<Option<MonitorHandle>>,
    /// Почему монитор не поднялся, если не поднялся: текст показывается на
    /// главном экране вместо полоски уровня.
    monitor_error: Mutex<String>,
    settings: Mutex<Settings>,
    data_dir: Mutex<PathBuf>,
    /// Версия, на которую только что обновились. Ставится на первом запуске
    /// после обновления и живёт до перезапуска: см. `take_update_marker`.
    just_updated: Mutex<String>,
    /// Выход подтверждён обоими вопросами. Пока флаг снят, приложение не
    /// закрывается ни красным крестиком, ни ⌘Q.
    quitting: std::sync::atomic::AtomicBool,
    /// Незагруженные сегменты прошлых смен, которые уборщик ещё не отправил,
    /// и число таких смен. Показываются на экране: сотрудник должен знать,
    /// что вчерашняя запись ещё не вся на сервере.
    leftover_pending: AtomicU32,
    leftover_days: AtomicU32,
}

impl AppState {
    /// Поднять монитор, если он ещё не запущен.
    fn start_monitor(&self) {
        let mut slot = self.monitor.lock().unwrap();
        if slot.is_some() {
            return;
        }
        match recorder::start_monitor() {
            Ok(handle) => {
                *slot = Some(handle);
                self.monitor_error.lock().unwrap().clear();
            }
            Err(e) => {
                *self.monitor_error.lock().unwrap() = e.to_string();
                log::warn!("монитор микрофона не запустился: {e}");
            }
        }
    }

    /// Отпустить микрофон перед записью — и на всякий случай после неё, если
    /// монитор понадобится поднять заново.
    fn stop_monitor(&self) {
        self.monitor.lock().unwrap().take();
    }
}

#[derive(Serialize)]
struct Status {
    recording: bool,
    paused: bool,
    recording_id: Option<String>,
    date: Option<String>,
    started_at: Option<String>,
    chunks_recorded: u32,
    chunks_uploaded: u32,
    chunks_pending: u32,
    upload_error: String,
    /// 0.0..1.0 peak input level; stays at 0 if the mic is muted or blocked.
    input_level: f32,
    /// Микрофон: во время записи — тот, с которого реально идёт звук, до
    /// записи — тот, который слушает монитор.
    device_name: String,
    /// Слышно ли микрофон прямо сейчас. До начала смены это ответ монитора,
    /// во время записи — рекордера.
    listening: bool,
    monitor_error: String,
    location_name: String,
    configured: bool,
    /// Непустое ровно на том запуске, который случился сразу после
    /// обновления, — интерфейс просит проверить микрофон.
    just_updated: String,
    /// Смена остановлена, но ещё не закрыта на сервере: догружаем сегменты
    /// или ждём связи. Кнопка «Завершить» в этом состоянии повторяет попытку.
    finishing: bool,
    finish_error: String,
    /// Открыт ли поток с микрофона. Ложь во время переподключения: колонку
    /// выдернули, Bluetooth отвалился — приложение само пробует снова.
    mic_connected: bool,
    /// Сколько раз за смену микрофон пришлось переоткрывать.
    reconnects: u32,
    /// Сегменты прошлых смен, ещё не отправленные на сервер.
    leftover_pending: u32,
    leftover_days: u32,
}

fn settings_path(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("settings.json")
}

fn load_settings(data_dir: &PathBuf) -> Settings {
    std::fs::read_to_string(settings_path(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_settings(data_dir: &PathBuf, settings: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    std::fs::write(
        settings_path(data_dir),
        serde_json::to_string_pretty(settings).unwrap(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(state: tauri::State<AppState>, settings: Settings) -> Result<(), String> {
    let data_dir = state.data_dir.lock().unwrap().clone();
    // Выбор менеджера и признак настройки автозапуска приходят не из формы —
    // их нельзя терять при сохранении настроек.
    let mut merged = settings;
    {
        let current = state.settings.lock().unwrap();
        if merged.last_employee_id.is_empty() {
            merged.last_employee_id = current.last_employee_id.clone();
        }
        merged.autostart_configured = current.autostart_configured;
    }
    write_settings(&data_dir, &merged)?;
    *state.settings.lock().unwrap() = merged;
    Ok(())
}

#[tauri::command]
fn get_status(state: tauri::State<AppState>) -> Status {
    let settings = state.settings.lock().unwrap().clone();
    let monitor = state.monitor.lock().unwrap();
    let session = state.session.lock().unwrap();
    let just_updated = state.just_updated.lock().unwrap().clone();
    let leftover_pending = state.leftover_pending.load(Ordering::SeqCst);
    let leftover_days = state.leftover_days.load(Ordering::SeqCst);
    match session.as_ref() {
        Some(s) => {
            let recorder = s.recorder.as_ref();
            Status {
                recording: recorder.is_some(),
                paused: recorder.map_or(false, |r| r.is_paused()),
                recording_id: Some(s.recording_id.clone()),
                date: Some(s.date.clone()),
                started_at: Some(s.started_at.clone()),
                chunks_recorded: recorder.map_or_else(
                    || uploader::next_chunk_idx(&s.chunks_dir),
                    |r| r.chunk_counter.load(Ordering::SeqCst),
                ),
                chunks_uploaded: s.uploader.uploaded_count.load(Ordering::SeqCst),
                chunks_pending: uploader::count_pending(&s.chunks_dir),
                upload_error: s.uploader.last_error.lock().unwrap().clone(),
                // После остановки записи уровень показывает монитор.
                input_level: recorder.map_or_else(
                    || monitor.as_ref().map_or(0.0, |m| m.input_level()),
                    |r| r.input_level(),
                ),
                device_name: recorder.map_or_else(
                    || monitor.as_ref().map_or_else(String::new, |m| m.device_name()),
                    |r| r.device_name(),
                ),
                listening: recorder.map_or(monitor.is_some(), |r| r.is_connected()),
                monitor_error: String::new(),
                location_name: settings.location_name.clone(),
                configured: settings.ready().is_ok(),
                just_updated,
                finishing: recorder.is_none(),
                finish_error: s.finish_error.clone(),
                mic_connected: recorder.map_or(
                    monitor.as_ref().map_or(false, |m| m.is_connected()),
                    |r| r.is_connected(),
                ),
                reconnects: recorder.map_or(0, |r| r.reconnects()),
                leftover_pending,
                leftover_days,
            }
        }
        None => Status {
            recording: false,
            paused: false,
            recording_id: None,
            date: None,
            started_at: None,
            chunks_recorded: 0,
            chunks_uploaded: 0,
            chunks_pending: 0,
            upload_error: String::new(),
            // До начала смены уровень берётся у монитора: сотрудник видит,
            // слышно ли микрофон, ещё не нажав «Начать рабочий день».
            input_level: monitor.as_ref().map_or(0.0, |m| m.input_level()),
            device_name: monitor.as_ref().map_or_else(
                || recorder::default_input_name().unwrap_or_default(),
                |m| m.device_name(),
            ),
            listening: monitor.as_ref().map_or(false, |m| m.is_connected()),
            monitor_error: state.monitor_error.lock().unwrap().clone(),
            location_name: settings.location_name.clone(),
            configured: settings.ready().is_ok(),
            just_updated,
            finishing: false,
            finish_error: String::new(),
            mic_connected: monitor.as_ref().map_or(false, |m| m.is_connected()),
            reconnects: 0,
            leftover_pending,
            leftover_days,
        },
    }
}

#[derive(Deserialize)]
struct StartDayResponse {
    id: String,
}

#[tauri::command]
fn list_locations(state: tauri::State<AppState>) -> Result<Vec<LocationPick>, String> {
    let settings = state.settings.lock().unwrap().clone();
    let base = settings.base_url();
    if base.is_empty() {
        return Err("Не задан адрес сервера — раздел «Для настройщика»".into());
    }
    let app_key = settings.app_key();
    if app_key.is_empty() {
        return Err("Не задан ключ приложения — раздел «Для настройщика»".into());
    }
    let client = reqwest::blocking::Client::new();
    let resp = client
        .get(format!("{base}/api/recordings/locations"))
        .header("X-App-Key", app_key)
        .send()
        .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Сервер ответил {}: {}",
            resp.status(),
            resp.text().unwrap_or_default()
        ));
    }
    resp.json::<Vec<LocationPick>>()
        .map_err(|e| format!("Некорректный ответ сервера: {e}"))
}

#[tauri::command]
fn list_employees(state: tauri::State<AppState>) -> Result<Vec<Employee>, String> {
    let settings = state.settings.lock().unwrap().clone();
    settings.ready()?;
    let client = reqwest::blocking::Client::new();
    let resp = with_auth(
        client.get(format!("{}/api/recordings/employees", settings.base_url())),
        &settings,
    )
    .send()
    .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Сервер ответил {}: {}",
            resp.status(),
            resp.text().unwrap_or_default()
        ));
    }
    resp.json::<Vec<Employee>>()
        .map_err(|e| format!("Некорректный ответ сервера: {e}"))
}

/// Микрофон, с которого пойдёт запись, — до её начала.
#[tauri::command]
fn input_device() -> String {
    recorder::default_input_name().unwrap_or_default()
}

/* --- Обновление приложения ------------------------------------------------
 *
 * Приложение стоит на компьютерах в студиях, куда владелец не ходит. Раньше
 * обновление означало собрать сборку, принести флешку и обойти точки; теперь
 * оно само спрашивает сервер и ставит новую версию по нажатию кнопки.
 *
 * Адрес обновлений собирается в рантайме, а не берётся из tauri.conf.json:
 * сервер там задать нельзя — он вшивается в сборку через build.env и у разных
 * владельцев разный. А вот публичный ключ подписи живёт именно в конфиге, и
 * менять его в рантайме нельзя намеренно: он и есть то, что не даёт подсунуть
 * приложению чужой архив.
 */

#[derive(Serialize)]
struct UpdateInfo {
    available: bool,
    /// Версия, которая стоит сейчас.
    current: String,
    /// Версия на сервере, если она новее.
    version: String,
    notes: String,
}

fn update_marker_path(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("updated-to.txt")
}

/// Отметка «сейчас перезапустимся ради обновления».
///
/// Нужна из-за того, как macOS выдаёт доступ к микрофону. Разрешение выдано не
/// «приложению по имени», а конкретной подписи бандла, и у самодельной подписи
/// она меняется с каждой сборкой. После обновления система вправе счесть
/// приложение новым и спросить про микрофон заново — а если сотрудник не
/// заметит вопроса, смена запишется тишиной. Поэтому первый запуск после
/// обновления прямо просит проверить полоску уровня.
fn write_update_marker(data_dir: &PathBuf, version: &str) {
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::write(update_marker_path(data_dir), version);
}

/// Прочитать отметку и сразу стереть: напоминание показывается один раз.
fn take_update_marker(data_dir: &PathBuf) -> String {
    let path = update_marker_path(data_dir);
    let version = std::fs::read_to_string(&path).unwrap_or_default();
    if !version.is_empty() {
        let _ = std::fs::remove_file(&path);
    }
    version.trim().to_string()
}

fn updater_for(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    // Настройки читаются в отдельном блоке: держать блокировку через await
    // нельзя, а сразу после этого начинается сеть.
    let (base_url, app_key) = {
        let state = app.state::<AppState>();
        let settings = state.settings.lock().unwrap();
        (settings.base_url(), settings.app_key())
    };
    if base_url.is_empty() {
        return Err("Не задан адрес сервера".into());
    }
    let endpoint = format!(
        "{base_url}/api/app/update/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}"
    );
    app.updater_builder()
        .endpoints(vec![endpoint.parse().map_err(|e| format!("{e}"))?])
        .map_err(|e| e.to_string())?
        .header("X-App-Key", app_key)
        .map_err(|e| e.to_string())?
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let update = updater_for(&app)?
        .check()
        .await
        .map_err(|e| format!("Не удалось проверить обновления: {e}"))?;
    Ok(match update {
        Some(update) => UpdateInfo {
            available: true,
            current,
            version: update.version.clone(),
            notes: update.body.clone().unwrap_or_default(),
        },
        None => UpdateInfo {
            available: false,
            current,
            version: String::new(),
            notes: String::new(),
        },
    })
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    // Обновление перезапускает приложение: посреди смены это оборвало бы
    // запись, поэтому кнопка работает только когда запись не идёт.
    let data_dir = {
        let state = app.state::<AppState>();
        if state.session.lock().unwrap().is_some() {
            return Err("Идёт запись — обновитесь после завершения смены".into());
        }
        let dir = state.data_dir.lock().unwrap().clone();
        dir
    };
    let update = updater_for(&app)?
        .check()
        .await
        .map_err(|e| format!("Не удалось проверить обновления: {e}"))?
        .ok_or("Обновление уже не требуется")?;
    // Отметка ставится до установки: после неё приложение перезапустится и
    // сюда уже не вернётся.
    write_update_marker(&data_dir, &update.version);
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        // Обновление не встало — отметку убираем, иначе в следующий запуск
        // приложение поздравит с обновлением, которого не было.
        let _ = std::fs::remove_file(update_marker_path(&data_dir));
        return Err(format!("Не удалось установить обновление: {e}"));
    }
    app.restart();
}

/* --- Закрытие приложения ---------------------------------------------------
 *
 * Компьютер стоит на ресепшене, за ним весь день ходят люди, и ⌘Q нажимается
 * случайно легче, чем кажется. Пока приложение закрыто, разговоры у стойки не
 * записываются, и узнают об этом вечером — по пустой смене.
 *
 * Поэтому оба пути выхода (крестик и ⌘Q) перехватываются в Rust и передаются
 * окну: оно задаёт два вопроса подряд, второй — с прямым текстом о том, что
 * прервётся. Само приложение закрывается только после команды снизу.
 */

#[tauri::command]
fn confirm_quit(app: tauri::AppHandle) {
    app.state::<AppState>()
        .quitting
        .store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    enabled: bool,
) -> Result<(), String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| e.to_string())?;
    // Ручной выбор запоминается, чтобы приложение больше не включало
    // автозапуск само при следующем старте.
    let data_dir = state.data_dir.lock().unwrap().clone();
    let mut settings = state.settings.lock().unwrap();
    settings.autostart_configured = true;
    let _ = write_settings(&data_dir, &settings);
    Ok(())
}

fn start_day_inner(state: &tauri::State<AppState>, employee_id: String) -> Result<()> {
    let settings = state.settings.lock().unwrap().clone();
    if let Err(message) = settings.ready() {
        anyhow::bail!(message);
    }
    if employee_id.is_empty() {
        anyhow::bail!("Выберите менеджера, который начинает рабочий день");
    }

    let date = Local::now().format("%Y-%m-%d").to_string();

    // Register (or resume) the day on the server.
    let client = reqwest::blocking::Client::new();
    let resp = with_auth(
        client.post(format!("{}/api/recordings/start", settings.base_url())),
        &settings,
    )
    .json(&serde_json::json!({ "date": date, "employee_id": employee_id }))
    .send()
    .context("Сервер недоступен")?;
    if !resp.status().is_success() {
        anyhow::bail!("Сервер ответил {}: {}", resp.status(), resp.text().unwrap_or_default());
    }
    let day: StartDayResponse = resp.json().context("Некорректный ответ сервера")?;

    let data_dir = state.data_dir.lock().unwrap().clone();
    // Chunks live under the recording id: a second session on the same date
    // (app crashed and was restarted) gets its own directory and its own
    // segment numbering instead of colliding with the first one.
    let chunks_dir = recordings_root(&data_dir).join(&day.id);
    std::fs::create_dir_all(&chunks_dir)?;

    // Resume-safe: continue numbering after any chunk already on disk.
    let next_idx = uploader::next_chunk_idx(&chunks_dir);

    // Момент первого старта этой смены. При возобновлении после вылета
    // берётся из meta.json: пропущенное время запишется тишиной, и таймкоды
    // отчёта останутся часами на стене, а не «минутами с перезапуска».
    let meta = match read_meta(&chunks_dir) {
        Some(meta) if meta.started_at_unix_ms > 0 => meta,
        _ => {
            let meta = RecordingMeta {
                date: date.clone(),
                started_at_unix_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                location_id: settings.location_id.clone(),
            };
            write_meta(&chunks_dir, &meta)?;
            meta
        }
    };
    let origin = UNIX_EPOCH + Duration::from_millis(meta.started_at_unix_ms);

    // Монитор держит тот же микрофон: отпускаем, чтобы рекордер открыл его
    // без спора за устройство.
    state.stop_monitor();
    let recorder = match recorder::start(&chunks_dir, next_idx, origin) {
        Ok(recorder) => recorder,
        Err(e) => {
            // Запись не началась — вернуть полоску уровня на экран.
            state.start_monitor();
            return Err(e);
        }
    };
    let uploader = Uploader::start(
        chunks_dir.clone(),
        day.id.clone(),
        ServerConfig {
            base_url: settings.base_url(),
            app_key: settings.app_key(),
            location_id: settings.location_id.clone(),
            device_key: settings.device_key.clone(),
        },
    );

    *state.session.lock().unwrap() = Some(ActiveSession {
        recording_id: day.id,
        date,
        chunks_dir,
        started_at: Local::now().format("%H:%M").to_string(),
        recorder: Some(recorder),
        uploader,
        finish_error: String::new(),
        _keep_awake: KeepAwake::acquire(),
    });
    Ok(())
}

fn recordings_root(data_dir: &Path) -> PathBuf {
    data_dir.join("recordings")
}

/// Сюда переезжают папки смен, которые сервер уже закрыл и разобрал без
/// этих сегментов: слать их некуда, но и стирать чужими руками не стоит.
fn orphaned_root(data_dir: &Path) -> PathBuf {
    data_dir.join("recordings-orphaned")
}

fn server_config(settings: &Settings) -> ServerConfig {
    ServerConfig {
        base_url: settings.base_url(),
        app_key: settings.app_key(),
        location_id: settings.location_id.clone(),
        device_key: settings.device_key.clone(),
    }
}

/* --- Уборка незакрытых смен ---------------------------------------------------
 *
 * Сервер бывает недоступен ровно в тот момент, когда сотрудник нажимает
 * «Завершить день», а потом выключает компьютер и уходит. Раньше сегменты
 * оставались на диске навсегда: назавтра начиналась новая смена, а к старой
 * никто не возвращался. Теперь приложение само доделывает вчерашнее: раз в
 * минуту, пока идёт запись не идёт, оно находит папки прошлых дат, дозагружает
 * их сегменты и закрывает смену на сервере.
 *
 * Сегодняшние папки уборщик не трогает: незакрытую сегодняшнюю смену сервер
 * возобновит по «Начать», и досылать её будет обычный загрузчик.
 */

/// Сколько сегментов прошлых дней ещё лежит на диске, и в скольких сменах.
fn count_leftovers(data_dir: &Path, today: &str) -> (u32, u32) {
    let mut pending = 0;
    let mut days = 0;
    if let Ok(entries) = std::fs::read_dir(recordings_root(data_dir)) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let meta = read_meta(&dir).unwrap_or_default();
            if meta.date == today {
                continue;
            }
            days += 1;
            pending += uploader::count_pending(&dir);
        }
    }
    (pending, days)
}

/// Один проход уборки. Возвращает текст последней ошибки, если была.
fn sweep_leftovers(data_dir: &Path, settings: &Settings, today: &str) -> Option<String> {
    let entries = match std::fs::read_dir(recordings_root(data_dir)) {
        Ok(entries) => entries,
        Err(_) => return None,
    };
    if settings.ready().is_err() {
        return None;
    }
    let config = server_config(settings);
    let client = uploader::http_client();
    let mut last_error = None;

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let recording_id = entry.file_name().to_string_lossy().to_string();
        let meta = read_meta(&dir).unwrap_or_default();
        if meta.date == today {
            continue;
        }
        if uploader::next_chunk_idx(&dir) == 0 {
            // Ни одного сегмента: запись не началась. Мусор.
            let _ = std::fs::remove_dir_all(&dir);
            continue;
        }
        let outcome = uploader::upload_pending(&client, &dir, &recording_id, &config, None)
            .and_then(|remaining| {
                if remaining > 0 {
                    anyhow::bail!("{remaining} сегментов не загрузилось");
                }
                uploader::finish_recording(
                    &client,
                    &recording_id,
                    uploader::next_chunk_idx(&dir),
                    &config,
                )
            });
        match outcome {
            Ok(()) => {
                log::info!("смена {recording_id} от {} закрыта уборщиком", meta.date);
                let _ = std::fs::remove_dir_all(&dir);
            }
            Err(e) if e.downcast_ref::<RecordingClosed>().is_some() => {
                log::warn!("смена {recording_id}: {e}; сегменты убраны в архив");
                let orphaned = orphaned_root(data_dir);
                let _ = std::fs::create_dir_all(&orphaned);
                let _ = std::fs::rename(&dir, orphaned.join(&recording_id));
            }
            Err(e) => {
                log::warn!("уборка смены {recording_id}: {e}");
                last_error = Some(e.to_string());
            }
        }
    }
    last_error
}

fn spawn_sweeper(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("leftover-sweeper".into())
        .spawn(move || {
            // Первый проход через несколько секунд после запуска: окно уже
            // открыто, и счётчик на экране появляется почти сразу.
            std::thread::sleep(Duration::from_secs(5));
            loop {
                let state = app.state::<AppState>();
                let data_dir = state.data_dir.lock().unwrap().clone();
                let settings = state.settings.lock().unwrap().clone();
                let today = Local::now().format("%Y-%m-%d").to_string();
                // Во время записи сеть нужна загрузчику смены — не мешаем.
                let busy = state.session.lock().unwrap().is_some();
                if !busy {
                    sweep_leftovers(&data_dir, &settings, &today);
                }
                let (pending, days) = count_leftovers(&data_dir, &today);
                state.leftover_pending.store(pending, Ordering::SeqCst);
                state.leftover_days.store(days, Ordering::SeqCst);
                std::thread::sleep(Duration::from_secs(60));
            }
        })
        .expect("sweeper thread");
}

#[tauri::command]
fn start_day(state: tauri::State<AppState>, employee_id: String) -> Result<(), String> {
    if let Some(session) = state.session.lock().unwrap().as_ref() {
        return Err(if session.recorder.is_some() {
            "Запись уже идёт".into()
        } else {
            "Предыдущая смена ещё отправляется — дождитесь или нажмите «Завершить» ещё раз".into()
        });
    }
    start_day_inner(&state, employee_id.clone()).map_err(|e| e.to_string())?;

    // Remember the choice for tomorrow.
    let data_dir = state.data_dir.lock().unwrap().clone();
    let mut settings = state.settings.lock().unwrap();
    if settings.last_employee_id != employee_id {
        settings.last_employee_id = employee_id;
        let _ = write_settings(&data_dir, &settings);
    }
    Ok(())
}

#[tauri::command]
fn toggle_pause(state: tauri::State<AppState>) -> Result<bool, String> {
    let session = state.session.lock().unwrap();
    let recorder = session
        .as_ref()
        .and_then(|s| s.recorder.as_ref())
        .ok_or("Запись не идёт")?;
    let paused = !recorder.is_paused();
    recorder.pause(paused);
    Ok(paused)
}

#[tauri::command]
fn finish_day(state: tauri::State<AppState>) -> Result<String, String> {
    // Смена вынимается из состояния на время ожидания, чтобы не держать
    // блокировку минутами (опрос статуса встал бы вместе с ней), и кладётся
    // обратно, если закрыть день не удалось.
    let mut session = state
        .session
        .lock()
        .unwrap()
        .take()
        .ok_or("Запись не идёт")?;
    let settings = state.settings.lock().unwrap().clone();

    // 1. Stop capture — flushes and closes the last chunk. Микрофон свободен,
    //    монитор снова показывает уровень, пока идёт дозагрузка.
    if let Some(recorder) = session.recorder.take() {
        let stopped = recorder.stop();
        state.start_monitor();
        if let Err(e) = stopped {
            // Поток кодировщика упал: что успело записаться, лежит в чанках,
            // и их всё равно надо отправить.
            log::error!("остановка записи: {e}");
        }
    }
    let total_segments = uploader::next_chunk_idx(&session.chunks_dir);

    // 2. Wait for every chunk to reach the server.
    let config = server_config(&settings);
    let result = session
        .uploader
        .wait_drained(FINISH_UPLOAD_WAIT)
        .and_then(|()| {
            // 3. Tell the server the day is complete.
            uploader::finish_recording(
                &uploader::http_client(),
                &session.recording_id,
                total_segments,
                &config,
            )
        });

    match result {
        Ok(()) => {}
        Err(e) if e.downcast_ref::<RecordingClosed>().is_some() => {
            // Закрыли из админки раньше нас: считаем день завершённым, но
            // сегменты не выбрасываем — вдруг их захотят достать.
            log::warn!("{e}");
            let orphaned = orphaned_root(&state.data_dir.lock().unwrap());
            let _ = std::fs::create_dir_all(&orphaned);
            let _ = std::fs::rename(
                &session.chunks_dir,
                orphaned.join(&session.recording_id),
            );
            return Ok(
                "Смена уже была закрыта из админки. Запись остановлена.".into(),
            );
        }
        Err(e) => {
            let message = e.to_string();
            session.finish_error = message.clone();
            *state.session.lock().unwrap() = Some(session);
            return Err(message);
        }
    }

    // 4. Local cleanup: uploaded copies are no longer needed.
    session.uploader.stop();
    let _ = std::fs::remove_dir_all(&session.chunks_dir);

    Ok(format!(
        "День завершён, {total_segments} сегментов загружено. \
         Разбор запускается из админки кнопкой «Обработать»."
    ))
}

fn main() {
    env_logger::init();
    tauri::Builder::default()
        // Автозапуск при входе в систему: LaunchAgent на macOS, ключ Run на
        // Windows. Приложение стоит на ресепшене, его никто не «запускает» —
        // оно должно быть открыто с утра само.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("no app data dir");
            std::fs::create_dir_all(&data_dir).ok();
            let settings = load_settings(&data_dir);
            let configured = settings.autostart_configured;
            // Первый запуск после обновления: напомним проверить микрофон,
            // разрешение на него могло слететь вместе со сменой подписи.
            let updated_to = take_update_marker(&data_dir);
            {
                let state = app.state::<AppState>();
                *state.settings.lock().unwrap() = settings;
                *state.data_dir.lock().unwrap() = data_dir.clone();
                *state.just_updated.lock().unwrap() = updated_to;
            }
            // При первом запуске автозапуск включается сам: это то поведение,
            // которого от программы на ресепшене и ждут. Дальше решает
            // переключатель в настройках.
            if !configured {
                if let Err(e) = app.autolaunch().enable() {
                    log::warn!("не удалось включить автозапуск: {e}");
                }
                let state = app.state::<AppState>();
                let mut settings = state.settings.lock().unwrap();
                settings.autostart_configured = true;
                let _ = write_settings(&data_dir, &settings);
            }
            // Микрофон слушается сразу при открытии окна: уровень должен быть
            // виден до начала смены, а не через десять секунд после неё.
            app.state::<AppState>().start_monitor();
            // Незакрытые смены прошлых дней досылаются сами.
            spawn_sweeper(app.handle().clone());
            Ok(())
        })
        .manage(AppState::default())
        // Красный крестик: окно не закрываем, а просим окно спросить.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_status,
            list_locations,
            list_employees,
            input_device,
            check_update,
            install_update,
            confirm_quit,
            get_autostart,
            set_autostart,
            start_day,
            toggle_pause,
            finish_day
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // ⌘Q и «Завершить» из Dock приходят сюда, минуя событие окна.
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                    let _ = window.emit("close-requested", ());
                }
            }
        });
}
