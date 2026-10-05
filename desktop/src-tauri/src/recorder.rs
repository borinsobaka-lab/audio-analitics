//! Audio capture (cpal) → Opus encoding → 5-minute .opus chunk files.
//!
//! Threads:
//!   * audio thread — owns the cpal stream for its whole lifetime. CoreAudio
//!     misbehaves when a stream is created on one thread and dropped on
//!     another, so the stream never leaves this thread. The same thread is a
//!     watchdog: a stream that reported an error or stopped delivering samples
//!     (the USB speaker was unplugged, Bluetooth dropped) is closed and the
//!     default input device is reopened until it works again.
//!   * encoder thread — resamples to 48 kHz mono, encodes 20 ms Opus frames
//!     and rotates chunk files. It keeps the recording on wall-clock time:
//!     a pause, a dead microphone or a crash-and-restart leave silence in the
//!     file instead of cutting time out, so «14:32 in the report» is 14:32
//!     on the studio clock and dialogs are found where they happened.
//! The capture callback only pushes samples into a channel, so a slow disk
//! never stalls the audio device. A crash loses at most the open chunk.

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use crate::ogg_opus::OggOpusWriter;

pub const OPUS_RATE: u32 = 48_000;
pub const FRAME_SAMPLES: usize = 960; // 20 ms @ 48 kHz
pub const CHUNK_SECONDS: u64 = 300; // 5-minute chunks
const OPUS_BITRATE: i32 = 32_000;

/// Микрофон молчит дольше этого — считаем поток мёртвым и переоткрываем.
/// Колбэки CoreAudio приходят каждые 10–100 мс; после отключения USB или
/// Bluetooth они просто перестают приходить, часто без единой ошибки.
const STALL_TIMEOUT: Duration = Duration::from_secs(3);
/// Пауза между попытками снова открыть микрофон.
const REOPEN_DELAY: Duration = Duration::from_secs(2);
/// Отставание записи от часов, начиная с которого дописывается тишина.
/// Порог выше задержки буферов (доли секунды) с большим запасом.
const PAD_THRESHOLD_S: f64 = 5.0;
/// Разрыв длиннее этого тишиной не заполняется: скорее всего приложение
/// подняли на следующий день, и выравнивать по часам уже нечего.
const MAX_PAD_S: f64 = 12.0 * 3600.0;

/// Device properties discovered on the audio thread.
struct DeviceInfo {
    name: String,
    sample_rate: u32,
    channels: usize,
}

/// A batch of interleaved samples from the capture callback. The format
/// travels with the data: after a reconnect the device may be a different one
/// with a different rate or channel count.
struct AudioBlock {
    rate: u32,
    channels: usize,
    samples: Vec<f32>,
}

/// Shared between the capture thread and the handle that the UI polls.
struct Shared {
    stop: AtomicBool,
    pause: AtomicBool,
    /// Peak input amplitude, scaled to 0..1000. Stays at 0 when the OS denies
    /// microphone access — the UI surfaces that instead of recording silence.
    level: AtomicU32,
    /// Is a capture stream open right now? False while reconnecting.
    connected: AtomicBool,
    /// How many times the stream had to be reopened during this session.
    reconnects: AtomicU32,
    device_name: Mutex<String>,
}

impl Shared {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            stop: AtomicBool::new(false),
            pause: AtomicBool::new(false),
            level: AtomicU32::new(0),
            connected: AtomicBool::new(false),
            reconnects: AtomicU32::new(0),
            device_name: Mutex::new(String::new()),
        })
    }
}

pub struct RecorderHandle {
    shared: Arc<Shared>,
    pub chunk_counter: Arc<AtomicU32>,
    audio_thread: Option<std::thread::JoinHandle<()>>,
    encoder_thread: Option<std::thread::JoinHandle<Result<()>>>,
}

impl RecorderHandle {
    pub fn pause(&self, paused: bool) {
        self.shared.pause.store(paused, Ordering::SeqCst);
    }

    pub fn is_paused(&self) -> bool {
        self.shared.pause.load(Ordering::SeqCst)
    }

    /// Current input level, 0.0..1.0.
    pub fn input_level(&self) -> f32 {
        self.shared.level.load(Ordering::Relaxed) as f32 / 1000.0
    }

    pub fn device_name(&self) -> String {
        self.shared.device_name.lock().unwrap().clone()
    }

    /// Открыт ли поток с микрофона прямо сейчас.
    pub fn is_connected(&self) -> bool {
        self.shared.connected.load(Ordering::SeqCst)
    }

    pub fn reconnects(&self) -> u32 {
        self.shared.reconnects.load(Ordering::SeqCst)
    }

    /// Stop capture and flush the open chunk. Returns once both threads exit.
    pub fn stop(mut self) -> Result<()> {
        self.shared.stop.store(true, Ordering::SeqCst);
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

/// Имя микрофона, который система отдаст при старте записи.
///
/// Нужно до начала смены: «наушники» вместо микрофона стойки должны быть
/// замечены ДО того, как записан рабочий день, а не после разбора пустой
/// дорожки. Устройство только опрашивается — поток не открывается.
pub fn default_input_name() -> Option<String> {
    cpal::default_host()
        .default_input_device()
        .and_then(|d| d.name().ok())
}

/// Слушать микрофон, ничего не записывая, — только чтобы был виден уровень.
///
/// Без этого «слышно ли микрофон» выяснялось только после нажатия «Начать
/// рабочий день»: сотрудник открывал приложение, начинал смену и лишь через
/// десять секунд узнавал, что звука нет. Монитор поднимается вместе с окном,
/// поэтому полоска шевелится сразу и проверить микрофон можно до записи.
///
/// Он же вызывает у macOS окно с запросом доступа к микрофону — при запуске
/// приложения, а не в момент старта смены.
pub struct MonitorHandle {
    shared: Arc<Shared>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl MonitorHandle {
    pub fn input_level(&self) -> f32 {
        self.shared.level.load(Ordering::Relaxed) as f32 / 1000.0
    }

    pub fn device_name(&self) -> String {
        self.shared.device_name.lock().unwrap().clone()
    }

    pub fn is_connected(&self) -> bool {
        self.shared.connected.load(Ordering::SeqCst)
    }
}

impl Drop for MonitorHandle {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

pub fn start_monitor() -> Result<MonitorHandle> {
    let shared = Shared::new();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<DeviceInfo, String>>();
    let shared_audio = shared.clone();

    let thread = std::thread::Builder::new()
        .name("audio-monitor".into())
        .spawn(move || capture_loop(None, shared_audio, ready_tx))?;

    match ready_rx.recv() {
        Ok(Ok(_)) => {}
        Ok(Err(message)) => return Err(anyhow!(message)),
        Err(_) => return Err(anyhow!("Поток захвата аудио завершился неожиданно")),
    }

    Ok(MonitorHandle {
        shared,
        thread: Some(thread),
    })
}

/// Start capturing into `chunks_dir`, producing seg_{idx:05}.opus files.
///
/// `first_chunk_idx` allows resuming a day after an app restart; `origin` is
/// the wall-clock moment the day was first started (see the encoder: the gap
/// since the crash is written as silence so timestamps stay on the clock).
pub fn start(
    chunks_dir: &Path,
    first_chunk_idx: u32,
    origin: SystemTime,
) -> Result<RecorderHandle> {
    std::fs::create_dir_all(chunks_dir)?;

    let (tx, rx) = mpsc::sync_channel::<AudioBlock>(256);
    let shared = Shared::new();
    let chunk_counter = Arc::new(AtomicU32::new(first_chunk_idx));

    // The audio thread reports whether the device opened before we continue.
    let (ready_tx, ready_rx) = mpsc::channel::<Result<DeviceInfo, String>>();
    let shared_audio = shared.clone();

    let audio_thread = std::thread::Builder::new()
        .name("audio-capture".into())
        .spawn(move || capture_loop(Some(tx), shared_audio, ready_tx))?;

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
    let stop_enc = shared.clone();
    let counter_enc = chunk_counter.clone();
    // Сколько времени уже лежит в готовых чанках предыдущего запуска: каждый
    // закрытый чанк — ровно CHUNK_SECONDS по часам записи.
    let already_encoded = first_chunk_idx as u64 * CHUNK_SECONDS * OPUS_RATE as u64;
    let encoder_thread = std::thread::Builder::new()
        .name("opus-encoder".into())
        .spawn(move || {
            encode_loop(rx, stop_enc, dir, counter_enc, origin, already_encoded)
        })?;

    Ok(RecorderHandle {
        shared,
        chunk_counter,
        audio_thread: Some(audio_thread),
        encoder_thread: Some(encoder_thread),
    })
}

/// Owns the capture stream for the whole session and reopens it when it dies.
///
/// The first open is reported through `ready_tx`, so the caller can show
/// «микрофон не найден» right away. Later failures are handled here: the
/// stream is dropped, the default input is reopened every couple of seconds,
/// and `Shared::connected` tells the UI what is going on in the meantime.
fn capture_loop(
    tx: Option<mpsc::SyncSender<AudioBlock>>,
    shared: Arc<Shared>,
    ready_tx: mpsc::Sender<Result<DeviceInfo, String>>,
) {
    let mut first = true;
    while !shared.stop.load(Ordering::SeqCst) {
        let failed = Arc::new(AtomicBool::new(false));
        let last_callback = Arc::new(AtomicU64::new(0));
        let opened = open_stream(tx.clone(), shared.clone(), failed.clone(), last_callback.clone());
        match opened {
            Ok((stream, info)) => {
                *shared.device_name.lock().unwrap() = info.name.clone();
                shared.connected.store(true, Ordering::SeqCst);
                if first {
                    let _ = ready_tx.send(Ok(info));
                    first = false;
                } else {
                    shared.reconnects.fetch_add(1, Ordering::SeqCst);
                    log::info!("микрофон снова открыт: {}", info.name);
                }
                let opened_at = Instant::now();
                // Own the stream here until stop is requested or it dies, then
                // drop it on this same thread.
                while !shared.stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                    if failed.load(Ordering::SeqCst) {
                        log::warn!("поток микрофона сообщил об ошибке — переоткрываем");
                        break;
                    }
                    let last_ms = last_callback.load(Ordering::Relaxed);
                    let silent_for = if last_ms == 0 {
                        opened_at.elapsed()
                    } else {
                        Duration::from_millis(now_ms().saturating_sub(last_ms))
                    };
                    if silent_for > STALL_TIMEOUT {
                        log::warn!(
                            "микрофон не отдаёт данные {} с — переоткрываем",
                            silent_for.as_secs()
                        );
                        break;
                    }
                }
                drop(stream);
                shared.connected.store(false, Ordering::SeqCst);
                shared.level.store(0, Ordering::Relaxed);
            }
            Err(e) => {
                if first {
                    let _ = ready_tx.send(Err(e.to_string()));
                    return;
                }
                log::warn!("не удалось открыть микрофон: {e}; повтор через {REOPEN_DELAY:?}");
            }
        }
        if shared.stop.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(REOPEN_DELAY);
    }
    shared.connected.store(false, Ordering::SeqCst);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Open the default input device. Runs on the audio thread; the resulting
/// stream is `!Send` and deliberately never leaves it.
fn open_stream(
    tx: Option<mpsc::SyncSender<AudioBlock>>,
    shared: Arc<Shared>,
    failed: Arc<AtomicBool>,
    last_callback: Arc<AtomicU64>,
) -> Result<(cpal::Stream, DeviceInfo)> {
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
    let (rate, channels) = (info.sample_rate, info.channels);

    let err_failed = failed.clone();
    let err_fn = move |e| {
        log::error!("audio stream error: {e}");
        err_failed.store(true, Ordering::SeqCst);
    };

    // The callback records that it is alive BEFORE looking at the pause flag:
    // a paused microphone is still a working microphone.
    let on_samples = move |floats: Vec<f32>| {
        last_callback.store(now_ms(), Ordering::Relaxed);
        if shared.pause.load(Ordering::SeqCst) {
            return;
        }
        store_level(&shared.level, floats.iter().copied());
        if let Some(tx) = &tx {
            let _ = tx.try_send(AudioBlock {
                rate,
                channels,
                samples: floats,
            });
        }
    };

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _| on_samples(data.to_vec()),
            err_fn,
            None,
        )?,
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data: &[i16], _| {
                on_samples(data.iter().map(|s| *s as f32 / 32768.0).collect())
            },
            err_fn,
            None,
        )?,
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config.into(),
            move |data: &[u16], _| {
                on_samples(
                    data.iter()
                        .map(|s| (*s as f32 - 32768.0) / 32768.0)
                        .collect(),
                )
            },
            err_fn,
            None,
        )?,
        other => return Err(anyhow!("Неподдерживаемый формат сэмплов: {other:?}")),
    };
    stream.play()?;
    Ok((stream, info))
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
    rx: mpsc::Receiver<AudioBlock>,
    shared: Arc<Shared>,
    dir: PathBuf,
    chunk_counter: Arc<AtomicU32>,
    origin: SystemTime,
    already_encoded: u64,
) -> Result<()> {
    let mut encoder = opus::Encoder::new(OPUS_RATE, opus::Channels::Mono, opus::Application::Voip)?;
    encoder.set_bitrate(opus::Bitrate::Bits(OPUS_BITRATE))?;

    let mut resampler: Option<LinearResampler> = None;
    let mut src_format: Option<(u32, usize)> = None;
    let mut pending: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 4);
    let mut packet_buf = vec![0u8; 4000];

    let mut writer: Option<OggOpusWriter> = None;
    let mut chunk_samples: u64 = 0;
    let chunk_limit = CHUNK_SECONDS * OPUS_RATE as u64;
    let mut serial: u32 = 0x5eed;
    let mut disconnected = false;
    // Всего сэмплов на шкале записи: и уже лежащих в готовых чанках, и
    // закодированных сейчас. Сравнивается с часами, чтобы дописать тишину.
    let mut encoded_total: u64 = already_encoded;
    let mut padded_total_s: f64 = 0.0;

    loop {
        // Отставание от часов проверяется ДО того, как в очередь попадёт
        // свежий блок: пропуск случился раньше него.
        let elapsed = SystemTime::now()
            .duration_since(origin)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let on_timeline = (encoded_total + pending.len() as u64) as f64 / OPUS_RATE as f64;
        let deficit = elapsed - on_timeline;
        if deficit > PAD_THRESHOLD_S && deficit < MAX_PAD_S {
            // Добиваем не до нуля, а с запасом на задержку буферов: иначе
            // следующий же блок ляжет «раньше времени».
            let pad_s = (deficit - 1.0).min(30.0);
            let pad_samples = (pad_s * OPUS_RATE as f64) as usize;
            pending.extend(std::iter::repeat(0.0f32).take(pad_samples));
            padded_total_s += pad_s;
            if padded_total_s < 40.0 || (padded_total_s as u64) % 600 == 0 {
                log::info!("дописано {pad_s:.1} с тишины (всего {padded_total_s:.0} с)");
            }
        } else {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(block) => {
                    if src_format != Some((block.rate, block.channels)) {
                        // Другое устройство после переподключения — другой
                        // ресемплер. Хвост старого не важен: там был обрыв.
                        resampler = Some(LinearResampler::new(block.rate, OPUS_RATE));
                        src_format = Some((block.rate, block.channels));
                        log::info!(
                            "формат входа: {} Hz, {} ch",
                            block.rate,
                            block.channels
                        );
                    }
                    // Downmix to mono, then resample to 48 kHz.
                    let mono: Vec<f32> = if block.channels > 1 {
                        block
                            .samples
                            .chunks(block.channels)
                            .map(|frame| frame.iter().sum::<f32>() / block.channels as f32)
                            .collect()
                    } else {
                        block.samples
                    };
                    pending.extend(resampler.as_mut().unwrap().process(&mono));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => disconnected = true,
            }
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
            encoded_total += FRAME_SAMPLES as u64;

            if chunk_samples >= chunk_limit {
                finish_chunk(&dir, &chunk_counter, writer.take().unwrap())?;
            }
        }

        // Exit only after the leftover samples above have been encoded.
        if disconnected || (shared.stop.load(Ordering::SeqCst) && rx.try_recv().is_err()) {
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
