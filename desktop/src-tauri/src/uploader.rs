//! Background upload queue: watches the chunks dir for finished .opus files,
//! uploads them with retries and exponential backoff, moves uploaded files
//! into uploaded/ (kept until the day is finished successfully).

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
pub struct ServerConfig {
    pub base_url: String,
    pub device_key: String,
}

pub struct Uploader {
    stop_flag: Arc<AtomicBool>,
    pub uploaded_count: Arc<AtomicU32>,
    pub pending_count: Arc<AtomicU32>,
    pub last_error: Arc<std::sync::Mutex<String>>,
    chunks_dir: PathBuf,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Uploader {
    pub fn start(chunks_dir: PathBuf, recording_id: String, config: ServerConfig) -> Uploader {
        let watched_dir = chunks_dir.clone();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let uploaded_count = Arc::new(AtomicU32::new(0));
        let pending_count = Arc::new(AtomicU32::new(0));
        let last_error = Arc::new(std::sync::Mutex::new(String::new()));

        let stop = stop_flag.clone();
        let uploaded = uploaded_count.clone();
        let pending = pending_count.clone();
        let err_slot = last_error.clone();

        let thread = std::thread::Builder::new()
            .name("uploader".into())
            .spawn(move || {
                let client = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(120))
                    .build()
                    .expect("reqwest client");
                let mut backoff_s = 2u64;

                while !stop.load(Ordering::SeqCst) {
                    match upload_pending(&client, &watched_dir, &recording_id, &config, &uploaded)
                    {
                        Ok(remaining) => {
                            pending.store(remaining, Ordering::SeqCst);
                            backoff_s = 2;
                            err_slot.lock().unwrap().clear();
                            std::thread::sleep(Duration::from_secs(3));
                        }
                        Err(e) => {
                            *err_slot.lock().unwrap() = e.to_string();
                            log::warn!("upload failed, retry in {backoff_s}s: {e}");
                            std::thread::sleep(Duration::from_secs(backoff_s));
                            backoff_s = (backoff_s * 2).min(60);
                        }
                    }
                }
            })
            .expect("uploader thread");

        Uploader {
            stop_flag,
            uploaded_count,
            pending_count,
            last_error,
            chunks_dir,
            thread: Some(thread),
        }
    }

    /// Wait until every finished chunk is uploaded (10 min cap), then stop.
    pub fn drain_and_stop(mut self) -> Result<()> {
        let deadline = std::time::Instant::now() + Duration::from_secs(600);
        loop {
            let remaining = count_pending(&self.chunks_dir);
            if remaining == 0 {
                break;
            }
            if std::time::Instant::now() > deadline {
                anyhow::bail!("{remaining} чанков не загрузилось за 10 минут — проверьте сеть");
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        Ok(())
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

fn upload_pending(
    client: &reqwest::blocking::Client,
    chunks_dir: &Path,
    recording_id: &str,
    config: &ServerConfig,
    uploaded: &AtomicU32,
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
        let resp = client
            .put(&url)
            .header("X-Device-Key", &config.device_key)
            .multipart(form)
            .send()?;
        if !resp.status().is_success() {
            anyhow::bail!("PUT {url} → {}: {}", resp.status(), resp.text().unwrap_or_default());
        }

        std::fs::rename(path, uploaded_dir.join(path.file_name().unwrap()))?;
        uploaded.fetch_add(1, Ordering::SeqCst);
        log::info!("uploaded chunk {idx}");
    }
    Ok(count_pending(chunks_dir))
}
