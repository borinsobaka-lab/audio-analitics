//! Audio capture (cpal) → Opus encoding → 5-minute .opus chunk files.
//!
//! Threads:
//!   * audio thread — owns the cpal stream for its whole lifetime. CoreAudio
//!     misbehaves when a stream is created on one thread and dropped on
//!     another, so the stream never leaves this thread.
//!   * encoder thread — resamples to 48 kHz mono, encodes 20 ms Opus frames
//!     and rotates chunk files.
//! The capture callback only pushes samples into a channel, so a slow disk
//! never stalls the audio device. A crash loses at most the open chunk.

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use crate::ogg_opus::OggOpusWriter;

pub const OPUS_RATE: u32 = 48_000;
pub const FRAME_SAMPLES: usize = 960; // 20 ms @ 48 kHz
pub const CHUNK_SECONDS: u64 = 300; // 5-minute chunks
const OPUS_BITRATE: i32 = 32_000;

/// Device properties discovered on the audio thread.
struct DeviceInfo {
    name: String,
    sample_rate: u32,
    channels: usize,
}

pub struct RecorderHandle {
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    pub chunk_counter: Arc<AtomicU32>,
    /// Peak input amplitude, scaled to 0..1000. Stays at 0 when the OS denies
    /// microphone access — the UI surfaces that instead of recording silence.
    pub level: Arc<AtomicU32>,
    pub device_name: String,
    audio_thread: Option<std::thread::JoinHandle<()>>,
    encoder_thread: Option<std::thread::JoinHandle<Result<()>>>,
}

impl RecorderHandle {
    pub fn pause(&self, paused: bool) {
        self.pause_flag.store(paused, Ordering::SeqCst);
    }

    pub fn is_paused(&self) -> bool {
        self.pause_flag.load(Ordering::SeqCst)
    }

    /// Current input level, 0.0..1.0.
    pub fn input_level(&self) -> f32 {
        self.level.load(Ordering::Relaxed) as f32 / 1000.0
    }

    /// Stop capture and flush the open chunk. Returns once both threads exit.
    pub fn stop(mut self) -> Result<()> {
        self.stop_flag.store(true, Ordering::SeqCst);
        // Audio thread first: dropping the stream closes the sample channel,
        // which is what tells the encoder to finish up.
        if let Some(handle) = self.audio_thread.take() {
            handle.join().map_err(|_| anyhow!("audio thread panicked"))?;
        }
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

    let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(256);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let pause_flag = Arc::new(AtomicBool::new(false));
    let chunk_counter = Arc::new(AtomicU32::new(first_chunk_idx));
    let level = Arc::new(AtomicU32::new(0));

    // The audio thread reports whether the device opened before we continue.
    let (ready_tx, ready_rx) = mpsc::channel::<Result<DeviceInfo, String>>();
    let stop_audio = stop_flag.clone();
    let pause_audio = pause_flag.clone();
    let level_audio = level.clone();

    let audio_thread = std::thread::Builder::new()
        .name("audio-capture".into())
        .spawn(move || {
            let stream = match open_stream(tx, pause_audio, level_audio, &ready_tx) {
                Some(stream) => stream,
                None => return, // error already reported through ready_tx
            };
            // Own the stream here until stop is requested, then drop it on
            // this same thread.
            while !stop_audio.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(100));
            }
            drop(stream);
        })?;

    let info = match ready_rx.recv() {
        Ok(Ok(info)) => info,
        Ok(Err(message)) => return Err(anyhow!(message)),
        Err(_) => return Err(anyhow!("Поток захвата аудио завершился неожиданно")),
    };
    log::info!(
        "input device: {}, {} Hz, {} ch",
        info.name,
        info.sample_rate,
        info.channels
    );

    let dir = chunks_dir.to_path_buf();
    let stop_enc = stop_flag.clone();
    let counter_enc = chunk_counter.clone();
    let (src_rate, src_channels) = (info.sample_rate, info.channels);
    let encoder_thread = std::thread::Builder::new()
        .name("opus-encoder".into())
        .spawn(move || encode_loop(rx, stop_enc, dir, counter_enc, src_rate, src_channels))?;

    Ok(RecorderHandle {
        stop_flag,
        pause_flag,
        chunk_counter,
        level,
        device_name: info.name,
        audio_thread: Some(audio_thread),
        encoder_thread: Some(encoder_thread),
    })
}

/// Open the default input device. Runs on the audio thread; the resulting
/// stream is `!Send` and deliberately never leaves it.
fn open_stream(
    tx: mpsc::SyncSender<Vec<f32>>,
    pause_flag: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
    ready_tx: &mpsc::Sender<Result<DeviceInfo, String>>,
) -> Option<cpal::Stream> {
    let result = (|| -> Result<(cpal::Stream, DeviceInfo)> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .context("Микрофон не найден. Подключите микрофон и проверьте разрешения.")?;
        let name = device.name().unwrap_or_else(|_| "неизвестное".into());
        let config = device
            .default_input_config()
            .context("Не удалось получить конфигурацию микрофона")?;
        let info = DeviceInfo {
            name,
            sample_rate: config.sample_rate().0,
            channels: config.channels() as usize,
        };

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
            cpal::SampleFormat::I16 => device.build_input_stream(
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
            )?,
            other => return Err(anyhow!("Неподдерживаемый формат сэмплов: {other:?}")),
        };
        stream.play()?;
        Ok((stream, info))
    })();

    match result {
        Ok((stream, info)) => {
            let _ = ready_tx.send(Ok(info));
            Some(stream)
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e.to_string()));
            None
        }
    }
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
    let mut disconnected = false;

    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
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
            Err(mpsc::RecvTimeoutError::Disconnected) => disconnected = true,
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

        // Exit only after the leftover samples above have been encoded.
        if disconnected || (stop.load(Ordering::SeqCst) && rx.try_recv().is_err()) {
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
