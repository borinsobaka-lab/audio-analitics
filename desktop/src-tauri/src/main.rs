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

use keep_awake::KeepAwake;
use recorder::RecorderHandle;
use uploader::{ServerConfig, Uploader};

#[derive(Clone, Serialize, Deserialize, Default)]
struct Settings {
    server_url: String,
    device_key: String,
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
    settings: Mutex<Settings>,
    data_dir: Mutex<PathBuf>,
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
    device_name: String,
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

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(state: tauri::State<AppState>, settings: Settings) -> Result<(), String> {
    let data_dir = state.data_dir.lock().unwrap().clone();
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    std::fs::write(
        settings_path(&data_dir),
        serde_json::to_string_pretty(&settings).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
fn get_status(state: tauri::State<AppState>) -> Status {
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
            input_level: 0.0,
            device_name: String::new(),
        },
    }
}

#[derive(Deserialize)]
struct StartDayResponse {
    id: String,
}

fn start_day_inner(state: &tauri::State<AppState>) -> Result<()> {
    let settings = state.settings.lock().unwrap().clone();
    if settings.server_url.is_empty() || settings.device_key.is_empty() {
        anyhow::bail!("Заполните адрес сервера и ключ устройства в настройках");
    }

    let date = Local::now().format("%Y-%m-%d").to_string();

    // Register (or resume) the day on the server.
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!(
            "{}/api/recordings/start",
            settings.server_url.trim_end_matches('/')
        ))
        .header("X-Device-Key", &settings.device_key)
        .json(&serde_json::json!({ "date": date }))
        .send()
        .context("Сервер недоступен")?;
    if !resp.status().is_success() {
        anyhow::bail!("Сервер ответил {}: {}", resp.status(), resp.text().unwrap_or_default());
    }
    let day: StartDayResponse = resp.json().context("Некорректный ответ сервера")?;

    let data_dir = state.data_dir.lock().unwrap().clone();
    let chunks_dir = data_dir.join("recordings").join(&date);
    std::fs::create_dir_all(&chunks_dir)?;

    // Resume-safe: continue numbering after any chunk already on disk.
    let next_idx = next_chunk_idx(&chunks_dir);

    let recorder = recorder::start(&chunks_dir, next_idx)?;
    let uploader = Uploader::start(
        chunks_dir.clone(),
        day.id.clone(),
        ServerConfig {
            base_url: settings.server_url.clone(),
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
fn start_day(state: tauri::State<AppState>) -> Result<(), String> {
    if state.session.lock().unwrap().is_some() {
        return Err("Запись уже идёт".into());
    }
    start_day_inner(&state).map_err(|e| e.to_string())
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
    let resp = client
        .post(format!(
            "{}/api/recordings/{}/finish",
            settings.server_url.trim_end_matches('/'),
            recording_id
        ))
        .header("X-Device-Key", &settings.device_key)
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

    Ok(format!("День завершён, {total_segments} сегментов отправлено на обработку"))
}

fn main() {
    env_logger::init();
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("no app data dir");
            std::fs::create_dir_all(&data_dir).ok();
            let state = app.state::<AppState>();
            *state.settings.lock().unwrap() = load_settings(&data_dir);
            *state.data_dir.lock().unwrap() = data_dir;
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_status,
            start_day,
            toggle_pause,
            finish_day
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
