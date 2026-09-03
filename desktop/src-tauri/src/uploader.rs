//! Background upload queue: watches the chunks dir for finished .opus files,
//! uploads them with retries and exponential backoff, moves uploaded files
//! into uploaded/ (kept until the day is finished successfully).
//!
//! The same primitives serve the leftover sweeper in main.rs: a day whose
//! upload or «finish» failed (server down at closing time) is completed later
//! from the files still on disk, without anyone remembering to do it.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
pub struct ServerConfig {
    pub base_url: String,
    /// Новая схема: общий ключ приложения плюс выбранная точка продажи.
    pub app_key: String,
    pub location_id: String,
    /// Прежняя схема: свой ключ на каждое устройство.
    pub device_key: String,
}

impl ServerConfig {
    pub fn auth(
        &self,
        req: reqwest::blocking::RequestBuilder,
    ) -> reqwest::blocking::RequestBuilder {
        if !self.app_key.is_empty() && !self.location_id.is_empty() {
            req.header("X-App-Key", &self.app_key)
                .header("X-Location-Id", &self.location_id)
        } else {
            req.header("X-Device-Key", &self.device_key)
        }
    }
}

/// Сервер отказался принимать сегменты или закрывать смену, потому что она
/// уже закрыта и разобрана из админки. Файлы на диске больше никому не нужны.
#[derive(Debug)]
pub struct RecordingClosed(pub String);

impl std::fmt::Display for RecordingClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "смена уже закрыта на сервере: {}", self.0)
    }
}

impl std::error::Error for RecordingClosed {}

pub fn http_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .expect("reqwest client")
}

pub struct Uploader {
    stop_flag: Arc<AtomicBool>,
    pub uploaded_count: Arc<AtomicU32>,
    /// Сервер ответил 409: смена закрыта и разобрана без нас. Повторять
    /// загрузку бессмысленно — очередь останавливается сама.
    closed: Arc<AtomicBool>,
    pub last_error: Arc<std::sync::Mutex<String>>,
    chunks_dir: PathBuf,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Uploader {
    pub fn start(chunks_dir: PathBuf, recording_id: String, config: ServerConfig) -> Uploader {
        let watched_dir = chunks_dir.clone();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let uploaded_count = Arc::new(AtomicU32::new(0));
        let closed = Arc::new(AtomicBool::new(false));
        let last_error = Arc::new(std::sync::Mutex::new(String::new()));

        let stop = stop_flag.clone();
        let uploaded = uploaded_count.clone();
        let closed_flag = closed.clone();
        let err_slot = last_error.clone();

        let thread = std::thread::Builder::new()
            .name("uploader".into())
            .spawn(move || {
                let client = http_client();
                let mut backoff_s = 2u64;

                while !stop.load(Ordering::SeqCst) {
                    match upload_pending(&client, &watched_dir, &recording_id, &config, Some(&uploaded))
                    {
                        Ok(_) => {
                            backoff_s = 2;
                            err_slot.lock().unwrap().clear();
                            sleep_unless_stopped(&stop, Duration::from_secs(3));
                        }
                        Err(e) if e.downcast_ref::<RecordingClosed>().is_some() => {
                            *err_slot.lock().unwrap() = e.to_string();
                            closed_flag.store(true, Ordering::SeqCst);
                            log::warn!("{e}; загрузка остановлена");
                            break;
                        }
                        Err(e) => {
                            *err_slot.lock().unwrap() = e.to_string();
                            log::warn!("upload failed, retry in {backoff_s}s: {e}");
                            sleep_unless_stopped(&stop, Duration::from_secs(backoff_s));
                            backoff_s = (backoff_s * 2).min(60);
                        }
                    }
                }
            })
            .expect("uploader thread");

        Uploader {
            stop_flag,
            uploaded_count,
            closed,
            last_error,
            chunks_dir,
            thread: Some(thread),
        }
    }

    /// Wait until every finished chunk is uploaded, or `timeout` passes.
    /// The queue keeps running either way, so a failed «finish» can simply be
    /// retried later: nothing is lost, the files stay on disk.
    pub fn wait_drained(&self, timeout: Duration) -> Result<()> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if self.closed.load(Ordering::SeqCst) {
                return Err(RecordingClosed(self.last_error.lock().unwrap().clone()).into());
            }
            let remaining = count_pending(&self.chunks_dir);
            if remaining == 0 {
                return Ok(());
            }
            if std::time::Instant::now() > deadline {
                let reason = self.last_error.lock().unwrap().clone();
                let reason = if reason.is_empty() {
                    String::new()
                } else {
                    format!(" Последняя ошибка: {}.", reason.chars().take(160).collect::<String>())
                };
                anyhow::bail!(
                    "{remaining} сегментов ещё не загрузилось.{reason} Файлы сохранены на \
                     компьютере, загрузка продолжается в фоне — нажмите «Завершить» ещё раз, \
                     когда связь появится"
                );
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    }

    pub fn stop(mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Uploader {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn sleep_unless_stopped(stop: &AtomicBool, total: Duration) {
    let step = Duration::from_millis(250);
    let mut slept = Duration::ZERO;
    while slept < total && !stop.load(Ordering::SeqCst) {
        std::thread::sleep(step);
        slept += step;
    }
}

fn list_ready_chunks(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x == "opus").unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

pub fn count_pending(dir: &Path) -> u32 {
    list_ready_chunks(dir).len() as u32
}

/// Highest existing chunk index + 1 (looks in both pending and uploaded dirs).
pub fn next_chunk_idx(chunks_dir: &Path) -> u32 {
    let mut max_idx: Option<u32> = None;
    for dir in [chunks_dir.to_path_buf(), chunks_dir.join("uploaded")] {
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

/// Upload every ready chunk of `chunks_dir`; returns how many are still pending.
///
/// A 409 from the server means the recording is already closed and processed
/// (force-finished from the dashboard): it comes back as `RecordingClosed` so
/// the caller can stop retrying a file nobody will ever accept.
pub fn upload_pending(
    client: &reqwest::blocking::Client,
    chunks_dir: &Path,
    recording_id: &str,
    config: &ServerConfig,
    uploaded: Option<&AtomicU32>,
) -> Result<u32> {
    let files = list_ready_chunks(chunks_dir);
    let uploaded_dir = chunks_dir.join("uploaded");
    std::fs::create_dir_all(&uploaded_dir)?;

    for path in &files {
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        // seg_00042 → 42
        let idx: u32 = name
            .trim_start_matches("seg_")
            .parse()
            .with_context(|| format!("bad chunk name {name}"))?;

        let bytes = std::fs::read(path)?;
        let part = reqwest::blocking::multipart::Part::bytes(bytes)
            .file_name(format!("{name}.opus"))
            .mime_str("audio/ogg")?;
        let form = reqwest::blocking::multipart::Form::new().part("file", part);

        let url = format!(
            "{}/api/recordings/{}/segments/{}",
            config.base_url.trim_end_matches('/'),
            recording_id,
            idx
        );
        let resp = config.auth(client.put(&url)).multipart(form).send()?;
        let status = resp.status();
        if status == reqwest::StatusCode::CONFLICT {
            return Err(RecordingClosed(resp.text().unwrap_or_default()).into());
        }
        if !status.is_success() {
            anyhow::bail!("PUT {url} → {}: {}", status, resp.text().unwrap_or_default());
        }

        std::fs::rename(path, uploaded_dir.join(path.file_name().unwrap()))?;
        if let Some(counter) = uploaded {
            counter.fetch_add(1, Ordering::SeqCst);
        }
        log::info!("uploaded chunk {idx}");
    }
    Ok(count_pending(chunks_dir))
}

/// Tell the server the recording is complete. Idempotent on the server side;
/// a 409 means it was closed from the dashboard already (`RecordingClosed`).
pub fn finish_recording(
    client: &reqwest::blocking::Client,
    recording_id: &str,
    total_segments: u32,
    config: &ServerConfig,
) -> Result<()> {
    let url = format!(
        "{}/api/recordings/{}/finish",
        config.base_url.trim_end_matches('/'),
        recording_id
    );
    let resp = config
        .auth(client.post(&url))
        .json(&serde_json::json!({ "total_segments": total_segments }))
        .send()
        .map_err(|e| anyhow::anyhow!("Сервер недоступен: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::CONFLICT {
        return Err(RecordingClosed(resp.text().unwrap_or_default()).into());
    }
    if !status.is_success() {
        anyhow::bail!("Сервер ответил {}: {}", status, resp.text().unwrap_or_default());
    }
    Ok(())
}
