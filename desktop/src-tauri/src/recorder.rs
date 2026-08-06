//! Audio capture (cpal) → Opus encoding → 5-minute .opus chunk files.
//!
//! Design: the cpal callback only pushes samples into a channel; a dedicated
//! encoder thread resamples to 48 kHz mono, encodes 20 ms Opus frames and
//! rotates chunk files. A crash loses at most the currently open chunk.

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc};

use crate::ogg_opus::OggOpusWriter;

pub const OPUS_RATE: u32 = 48_000;
pub const FRAME_SAMPLES: usize = 960; // 20 ms @ 48 kHz
pub const CHUNK_SECONDS: u64 = 300; // 5-minute chunks
const OPUS_BITRATE: i32 = 32_000;

pub struct RecorderHandle {
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    pub chunk_counter: Arc<AtomicU32>,
    /// Peak input amplitude of the last callback, scaled to 0..1000.
    /// Stays at 0 when the OS denies microphone access — the UI surfaces that.
    pub level: Arc<AtomicU32>,
    pub device_name: String,
    stream: cpal::Stream,
    encoder_thread: Option<std::thread::JoinHandle<Result<()>>>,
}

// cpal::Stream is not Send on all platforms; the handle stays on the thread
// that created it (we manage it from a dedicated recording thread in state.rs).
unsafe impl Send for RecorderHandle {}

impl RecorderHandle {
    pub fn pause(&self, paused: bool) {
        self.pause_flag.store(paused, Ordering::SeqCst);
    }

    /// Current input level, 0.0..1.0.
    pub fn input_level(&self) -> f32 {
        self.level.load(Ordering::Relaxed) as f32 / 1000.0
    }

    pub fn is_paused(&self) -> bool {
        self.pause_flag.load(Ordering::SeqCst)
    }

    pub fn stop(mut self) -> Result<()> {
        self.stop_flag.store(true, Ordering::SeqCst);
        drop(self.stream); // stops the capture callback
        if let Some(handle) = self.encoder_thread.take() {
            handle
                .join()
                .map_err(|_| anyhow!("encoder thread panicked"))??;
        }
        Ok(())
    }
}

/// Start capturing into `chunks_dir`, producing seg_{idx:05}.opus files.
/// `first_chunk_idx` allows resuming a day after an app restart.
pub fn start(chunks_dir: &Path, first_chunk_idx: u32) -> Result<RecorderHandle> {
    std::fs::create_dir_all(chunks_dir)?;

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .context("Микрофон не найден. Подключите микрофон и проверьте разрешения.")?;
    let device_name = device.name().unwrap_or_else(|_| "неизвестное".into());
    let config = device
        .default_input_config()
        .context("Не удалось получить конфигурацию микрофона")?;
    log::info!("input device: {device_name}, config: {config:?}");

    let src_rate = config.sample_rate().0;
    let src_channels = config.channels() as usize;

    let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(256);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let pause_flag = Arc::new(AtomicBool::new(false));
    let chunk_counter = Arc::new(AtomicU32::new(first_chunk_idx));
    let level = Arc::new(AtomicU32::new(0));

    let pause_cb = pause_flag.clone();
    let level_cb = level.clone();
    let err_fn = |e| log::error!("audio stream error: {e}");

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                if !pause_cb.load(Ordering::SeqCst) {
                    store_level(&level_cb, data.iter().copied());
                    let _ = tx.try_send(data.to_vec());
                }
            },
            err_fn,
            None,
        )?,
        cpal::SampleFormat::I16 => {
            let tx = tx.clone();
            device.build_input_stream(
                &config.into(),
                move |data: &[i16], _| {
                    if !pause_cb.load(Ordering::SeqCst) {
                        let floats: Vec<f32> =
                            data.iter().map(|s| *s as f32 / 32768.0).collect();
                        store_level(&level_cb, floats.iter().copied());
                        let _ = tx.try_send(floats);
                    }
                },
                err_fn,
                None,
            )?
        }
        other => return Err(anyhow!("Неподдерживаемый формат сэмплов: {other:?}")),
    };
    stream.play()?;

    let dir = chunks_dir.to_path_buf();
    let stop_enc = stop_flag.clone();
    let counter_enc = chunk_counter.clone();
    let encoder_thread = std::thread::Builder::new()
        .name("opus-encoder".into())
        .spawn(move || encode_loop(rx, stop_enc, dir, counter_enc, src_rate, src_channels))?;

    Ok(RecorderHandle {
        stop_flag,
        pause_flag,
        chunk_counter,
        level,
        device_name,
        stream,
        encoder_thread: Some(encoder_thread),
    })
}

/// Peak level with slow decay, so a value polled once per second still
/// reflects the loudest sound of the last couple of seconds (VU-meter feel).
fn store_level(slot: &AtomicU32, samples: impl Iterator<Item = f32>) {
    let peak = samples.fold(0.0f32, |acc, s| acc.max(s.abs())).min(1.0);
    let previous = slot.load(Ordering::Relaxed) as f32 / 1000.0;
    let smoothed = peak.max(previous * 0.99);
    slot.store((smoothed * 1000.0) as u32, Ordering::Relaxed);
}

fn encode_loop(
    rx: mpsc::Receiver<Vec<f32>>,
    stop: Arc<AtomicBool>,
    dir: PathBuf,
    chunk_counter: Arc<AtomicU32>,
    src_rate: u32,
    src_channels: usize,
) -> Result<()> {
    let mut encoder = opus::Encoder::new(OPUS_RATE, opus::Channels::Mono, opus::Application::Voip)?;
    encoder.set_bitrate(opus::Bitrate::Bits(OPUS_BITRATE))?;

    let mut resampler = LinearResampler::new(src_rate, OPUS_RATE);
    let mut pending: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 4);
    let mut packet_buf = vec![0u8; 4000];

    let mut writer: Option<OggOpusWriter> = None;
    let mut chunk_samples: u64 = 0;
    let chunk_limit = CHUNK_SECONDS * OPUS_RATE as u64;
    let mut serial: u32 = 0x5eed;

    loop {
        match rx.recv_timeout(std::time::Duration::from_millis(200)) {
            Ok(buf) => {
                // Downmix to mono, then resample to 48 kHz.
                let mono: Vec<f32> = if src_channels > 1 {
                    buf.chunks(src_channels)
                        .map(|frame| frame.iter().sum::<f32>() / src_channels as f32)
                        .collect()
                } else {
                    buf
                };
                pending.extend(resampler.process(&mono));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        while pending.len() >= FRAME_SAMPLES {
            let frame: Vec<i16> = pending
                .drain(..FRAME_SAMPLES)
                .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
                .collect();

            if writer.is_none() {
                let idx = chunk_counter.load(Ordering::SeqCst);
                let path = dir.join(format!("seg_{idx:05}.opus.part"));
                serial = serial.wrapping_add(1);
                writer = Some(OggOpusWriter::create(&path, OPUS_RATE, serial)?);
                chunk_samples = 0;
            }

            let n = encoder.encode(&frame, &mut packet_buf)?;
            writer
                .as_mut()
                .unwrap()
                .write_packet(&packet_buf[..n], FRAME_SAMPLES as u64)?;
            chunk_samples += FRAME_SAMPLES as u64;

            if chunk_samples >= chunk_limit {
                finish_chunk(&dir, &chunk_counter, writer.take().unwrap())?;
            }
        }

        if stop.load(Ordering::SeqCst) && rx.try_recv().is_err() {
            break;
        }
    }

    if let Some(w) = writer.take() {
        finish_chunk(&dir, &chunk_counter, w)?;
    }
    Ok(())
}

/// Close the writer and atomically rename .part → .opus (upload-ready).
fn finish_chunk(dir: &Path, counter: &AtomicU32, writer: OggOpusWriter) -> Result<()> {
    let idx = counter.load(Ordering::SeqCst);
    writer.finish()?;
    let part = dir.join(format!("seg_{idx:05}.opus.part"));
    let done = dir.join(format!("seg_{idx:05}.opus"));
    std::fs::rename(&part, &done)?;
    counter.store(idx + 1, Ordering::SeqCst);
    log::info!("chunk ready: {}", done.display());
    Ok(())
}

/// Naive linear resampler — sufficient quality for speech ASR.
struct LinearResampler {
    ratio: f64,
    pos: f64,
    last: f32,
    passthrough: bool,
}

impl LinearResampler {
    fn new(from: u32, to: u32) -> Self {
        Self {
            ratio: from as f64 / to as f64,
            pos: 0.0,
            last: 0.0,
            passthrough: from == to,
        }
    }

    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if self.passthrough {
            return input.to_vec();
        }
        if input.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::with_capacity((input.len() as f64 / self.ratio) as usize + 2);
        // Virtual timeline: sample -1 is `last` from the previous call.
        while self.pos < input.len() as f64 {
            let left_idx = self.pos.floor();
            let frac = (self.pos - left_idx) as f32;
            let i = left_idx as isize;
            let left = if i < 0 { self.last } else { input[i as usize] };
            let right_idx = (i + 1).min(input.len() as isize - 1).max(0) as usize;
            let right = input[right_idx];
            out.push(left + (right - left) * frac);
            self.pos += self.ratio;
        }
        self.pos -= input.len() as f64;
        self.last = *input.last().unwrap();
        out
    }
}
