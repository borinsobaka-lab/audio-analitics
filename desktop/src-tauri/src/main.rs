#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod keep_awake;
mod ogg_opus;
mod recorder;
mod uploader;

use anyhow::{Context, Result};
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use keep_awake::KeepAwake;
use recorder::{MonitorHandle, RecorderHandle};
use uploader::{ServerConfig, Uploader};

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
    recorder: RecorderHandle,
    uploader: Uploader,
    _keep_awake: KeepAwake,
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
    match session.as_ref() {
        Some(s) => Status {
            recording: true,
            paused: s.recorder.is_paused(),
            recording_id: Some(s.recording_id.clone()),
            date: Some(s.date.clone()),
            started_at: Some(s.started_at.clone()),
            chunks_recorded: s.recorder.chunk_counter.load(Ordering::SeqCst),
            chunks_uploaded: s.uploader.uploaded_count.load(Ordering::SeqCst),
            chunks_pending: s.uploader.pending_count.load(Ordering::SeqCst),
            upload_error: s.uploader.last_error.lock().unwrap().clone(),
            input_level: s.recorder.input_level(),
            device_name: s.recorder.device_name.clone(),
            listening: true,
            monitor_error: String::new(),
            location_name: settings.location_name.clone(),
            configured: settings.ready().is_ok(),
        },
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
                |m| m.device_name.clone(),
            ),
            listening: monitor.is_some(),
            monitor_error: state.monitor_error.lock().unwrap().clone(),
            location_name: settings.location_name.clone(),
            configured: settings.ready().is_ok(),
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
    let chunks_dir = data_dir.join("recordings").join(&day.id);
    std::fs::create_dir_all(&chunks_dir)?;

    // Resume-safe: continue numbering after any chunk already on disk.
    let next_idx = next_chunk_idx(&chunks_dir);

    // Монитор держит тот же микрофон: отпускаем, чтобы рекордер открыл его
    // без спора за устройство.
    state.stop_monitor();
    let recorder = match recorder::start(&chunks_dir, next_idx) {
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
        recorder,
        uploader,
        _keep_awake: KeepAwake::acquire(),
    });
    Ok(())
}

/// Highest existing chunk index + 1 (looks in both pending and uploaded dirs).
fn next_chunk_idx(chunks_dir: &PathBuf) -> u32 {
    let mut max_idx: Option<u32> = None;
    for dir in [chunks_dir.clone(), chunks_dir.join("uploaded")] {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(idx_str) = name
                    .strip_prefix("seg_")
                    .and_then(|s| s.strip_suffix(".opus"))
                {
                    if let Ok(idx) = idx_str.parse::<u32>() {
                        max_idx = Some(max_idx.map_or(idx, |m: u32| m.max(idx)));
                    }
                }
            }
        }
    }
    max_idx.map_or(0, |m| m + 1)
}

#[tauri::command]
fn start_day(state: tauri::State<AppState>, employee_id: String) -> Result<(), String> {
    if state.session.lock().unwrap().is_some() {
        return Err("Запись уже идёт".into());
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
    let s = session.as_ref().ok_or("Запись не идёт")?;
    let paused = !s.recorder.is_paused();
    s.recorder.pause(paused);
    Ok(paused)
}

#[tauri::command]
fn finish_day(state: tauri::State<AppState>) -> Result<String, String> {
    let session = state
        .session
        .lock()
        .unwrap()
        .take()
        .ok_or("Запись не идёт")?;

    let settings = state.settings.lock().unwrap().clone();
    let ActiveSession {
        recording_id,
        chunks_dir,
        recorder,
        uploader,
        ..
    } = session;

    // 1. Stop capture — flushes and closes the last chunk.
    recorder.stop().map_err(|e| e.to_string())?;
    let total_segments = next_chunk_idx(&chunks_dir);

    // 2. Wait for every chunk to reach the server.
    uploader.drain_and_stop().map_err(|e| e.to_string())?;

    // 3. Tell the server the day is complete → processing starts.
    let client = reqwest::blocking::Client::new();
    let resp = with_auth(
        client.post(format!(
            "{}/api/recordings/{}/finish",
            settings.base_url(),
            recording_id
        )),
        &settings,
    )
    .json(&serde_json::json!({ "total_segments": total_segments }))
    .send()
    .map_err(|e| format!("Сервер недоступен: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Сервер ответил {}: {}",
            resp.status(),
            resp.text().unwrap_or_default()
        ));
    }

    // 4. Local cleanup: uploaded copies are no longer needed.
    let _ = std::fs::remove_dir_all(chunks_dir.join("uploaded"));

    // Смена закрыта — микрофон снова слушает монитор.
    state.start_monitor();

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
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("no app data dir");
            std::fs::create_dir_all(&data_dir).ok();
            let settings = load_settings(&data_dir);
            let configured = settings.autostart_configured;
            {
                let state = app.state::<AppState>();
                *state.settings.lock().unwrap() = settings;
                *state.data_dir.lock().unwrap() = data_dir.clone();
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
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_status,
            list_locations,
            list_employees,
            input_device,
            get_autostart,
            set_autostart,
            start_day,
            toggle_pause,
            finish_day
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
