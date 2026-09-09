//! The Beat source's home in the engine: a sample file decoded by the host is analysed on its
//! own thread, and the result becomes scripts for the axes whose tracking source is Beat. The
//! AI CH/PMV source builds on it: once the beats are known and the music model is loaded, a
//! video pass over the file (cached beside the model, keyed by the file and the region) and
//! the model's run give a script per axis, which those axes switch to when it arrives.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use bp_beat::{BeatTrack, GenerateOptions, RATE, Style};
use bp_model::{Loaded, Music, VideoRow, mel::log_mel};
use bp_script::{Axis, Script};

use crate::pass::Pass;
use crate::{RegionSource, Shared, TrackAxis};

#[derive(Clone, Debug, PartialEq)]
pub enum BeatStatus {
    None,
    Analysing,
    Ready,
    Error(String),
}

/// Where the music model's scripts are: nothing asked, the video pass under way, the model
/// running, done, or failed.
#[derive(Clone, Debug, PartialEq)]
pub enum MusicStatus {
    None,
    Watching { percent: f64 },
    Modelling,
    Ready,
    Error(String),
}

impl MusicStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            MusicStatus::None => "none",
            MusicStatus::Watching { .. } => "watching",
            MusicStatus::Modelling => "modelling",
            MusicStatus::Ready => "ready",
            MusicStatus::Error(_) => "error",
        }
    }
}

/// Global style and depth plus the per-video tempo factor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BeatOptions {
    pub style: Style,
    pub volume_depth: bool,
    pub bounce: bool,
    pub bounce_depth: f64,
    pub bounce_speed: f64,
    pub tempo_factor: f64,
}

impl Default for BeatOptions {
    fn default() -> BeatOptions {
        let defaults = GenerateOptions::default();
        BeatOptions {
            style: Style::Strokes,
            volume_depth: false,
            bounce: true,
            bounce_depth: defaults.bounce_depth,
            bounce_speed: defaults.bounce_speed,
            tempo_factor: 1.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BeatSnapshot {
    pub status: BeatStatus,
    pub full_status: BeatStatus,
    pub bpm: f64,
    pub beats: usize,
    pub options: BeatOptions,
    pub music: MusicStatus,
}

/// What a music run was made for, so a matching request is not run twice.
#[derive(Clone, Debug, PartialEq)]
struct MusicKey {
    media: String,
    pace: f64,
    region: String,
    model: String,
}

/// The newest `LIVE_WINDOW_MS` of audio the live source keeps for its next analysis.
const LIVE_WINDOW_MS: u64 = 24_000;
/// How much new audio arrives between analyses.
const LIVE_EVERY_MS: u64 = 100;
/// The least audio an analysis is worth running on.
const LIVE_MIN_MS: u64 = 2_000;
/// How far past the analysed audio the beats are continued, so the axes have something to
/// play until the next analysis is in.
const LIVE_AHEAD_MS: f64 = 1_500.0;

const fn live_samples(ms: u64) -> usize {
    (ms * RATE as u64 / 1000) as usize
}

/// Preserve alternating-axis direction down to quarter tempo (half-speed Twist on half tempo).
/// Only trim the old edge of a rolling window, before the playback clock.
fn align_live_beats(track: &mut BeatTrack, previous: &BeatTrack) {
    let Some(&old_first) = previous.beats.first() else { return };
    let Some((new_index, &first)) = track.beats.iter().enumerate()
        .find(|(_, at)| **at >= old_first) else { return };
    let Some((index, &matched)) = previous.beats.iter().enumerate()
        .min_by(|(_, a), (_, b)| (*a - first).abs().total_cmp(&(*b - first).abs())) else { return };
    if previous.bpm <= 0.0 || (matched - first).abs() > 30_000.0 / previous.bpm {
        return;
    }
    let skip = (new_index % 8 + 8 - index % 8) % 8;
    if track.beats.len() >= skip + 2 && track.loudness.len() >= skip {
        track.beats.drain(..skip);
        track.loudness.drain(..skip);
    }
}

/// The live source's state: samples pushed as they play, analysed in the background.
#[derive(Default)]
pub struct Live {
    pending: Vec<f32>,
    stream: Option<bp_beat::Stream>,
    /// Samples pushed since the start; beat times are measured from it.
    total: u64,
    /// `total` when the last analysis began.
    analysed_at: u64,
    analysing: bool,
}

pub struct Beat {
    pub status: BeatStatus,
    pub track: Option<BeatTrack>,
    pub options: BeatOptions,
    pub fps: f64,
    /// Bumped per load so a stale analysis thread's result is dropped.
    pub generation: u64,
    /// Set while the source runs on live audio instead of a file.
    pub live: Option<Live>,
    window: Option<PlaybackWindow>,
    window_status: BeatStatus,
    window_generation: u32,
    /// The sample file the track came from, read again for the music model's mel.
    path: Option<PathBuf>,
    pub music: MusicStatus,
    /// The music model's script per axis in `bp_model::AXES` order, once ready.
    music_scripts: Option<Vec<Script>>,
    music_key: Option<MusicKey>,
    music_generation: u64,
    /// Stops a running video pass when a newer request or a clear supersedes it.
    music_cancel: Arc<AtomicBool>,
}

struct PlaybackWindow {
    /// Beat timestamps and duration are absolute; envelope samples start at `start_ms`.
    track: BeatTrack,
    start_ms: f64,
}

/// Bumped when decoding or tracking changes the video rows, so old caches are skipped.
const CACHE_VERSION: u32 = 2;

impl Beat {
    pub fn new() -> Beat {
        Beat {
            status: BeatStatus::None,
            track: None,
            options: BeatOptions::default(),
            fps: 60.0,
            generation: 0,
            live: None,
            window: None,
            window_status: BeatStatus::None,
            window_generation: 0,
            path: None,
            music: MusicStatus::None,
            music_scripts: None,
            music_key: None,
            music_generation: 0,
            music_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn snapshot(&self) -> BeatSnapshot {
        let track = self.playback_track();
        BeatSnapshot {
            status: if self.window.is_some() { BeatStatus::Ready } else if self.window_status != BeatStatus::None { self.window_status.clone() } else { self.status.clone() },
            full_status: self.status.clone(),
            bpm: track.map_or(0.0, |t| t.bpm * self.options.tempo_factor),
            beats: track.map_or(0, |t| t.beats.len()),
            options: self.options,
            music: self.music.clone(),
        }
    }

    /// One axis at its final range, so rounding and speed checks match playback and export.
    /// Rotation axes alternate direction; the stroke can bounce on loud accents.
    pub fn script(
        &self,
        id: Axis,
        axis: TrackAxis,
        flourishes: bool,
        playback_rate: f64,
    ) -> Option<bp_script::Script> {
        let track = self.track.as_ref()?;
        Some(self.script_for(track, id, axis, flourishes, playback_rate))
    }

    fn playback_track(&self) -> Option<&BeatTrack> {
        if let Some(window) = &self.window { Some(&window.track) }
        else if self.window_status == BeatStatus::None { self.track.as_ref() }
        else { None }
    }

    pub fn playback_script(&self, id: Axis, axis: TrackAxis, flourishes: bool, playback_rate: f64) -> Option<Script> {
        if let Some(track) = self.playback_track() {
            Some(self.script_for(track, id, axis, flourishes, playback_rate))
        } else if self.window_status != BeatStatus::None {
            Some(Script::default())
        } else {
            None
        }
    }

    fn script_for(&self, track: &BeatTrack, id: Axis, axis: TrackAxis, flourishes: bool, playback_rate: f64) -> Script {
        let twist = id == Axis::R0 && axis.source == crate::TrackSource::Beat;
        let speed = if !twist { 1.0 } else if axis.intensity <= 0.75 { 0.5 } else if axis.intensity >= 1.5 { 2.0 } else { 1.0 };
        bp_beat::generate(track, GenerateOptions {
            style: self.options.style,
            volume_depth: self.options.volume_depth,
            tempo_factor: self.options.tempo_factor * speed,
            alternate: id != Axis::L0,
            flourishes: flourishes && self.options.bounce,
            bounce_depth: self.options.bounce_depth,
            bounce_speed: self.options.bounce_speed,
            fps: self.fps,
            min: axis.min,
            max: axis.max,
            invert: axis.invert,
            min_speed: bp_beat::MIN_SPEED * if twist { 1.0 } else { axis.energy() },
            playback_rate,
            ..GenerateOptions::default()
        })
    }

    /// A request token ties the asynchronous host decode to this media and seek.
    pub fn window_begin(&mut self, reset: bool) -> u32 {
        self.window_generation = self.window_generation.wrapping_add(1);
        if reset { self.window = None; }
        self.window_status = BeatStatus::Analysing;
        self.window_generation
    }

    pub fn set_window(&mut self, mut track: BeatTrack, start_ms: f64, token: u32, continuous: bool) -> bool {
        if token != self.window_generation || !start_ms.is_finite() || start_ms < 0.0 { return false; }
        for at in &mut track.beats { *at += start_ms; }
        track.duration_ms += start_ms;
        if continuous && let Some(previous) = &self.window {
            if start_ms >= previous.start_ms && start_ms < previous.track.duration_ms {
                align_live_beats(&mut track, &previous.track);
            }
        }
        self.window = Some(PlaybackWindow { track, start_ms });
        self.window_status = BeatStatus::Ready;
        true
    }

    pub fn window_error(&mut self, token: u32, error: String) {
        if token == self.window_generation { self.window_status = BeatStatus::Error(error); }
    }

    /// The music model's script for an axis, once its run is in; positions are the model's
    /// own 0..1, for the row's `map`.
    pub fn music_script(&self, axis: Axis) -> Option<Script> {
        let scripts = self.music_scripts.as_ref()?;
        let i = bp_model::AXES.iter().position(|id| *id == axis.id())?;
        scripts.get(i).filter(|s| !s.actions.is_empty()).cloned()
    }

    /// Reads a raw mono f32le file at `bp_beat::RATE` and analyses it off the caller's thread;
    /// `done` runs with the lock released once the result is in.
    pub fn load(this: &Arc<Mutex<Beat>>, path: PathBuf, done: impl FnOnce() + Send + 'static) {
        let generation = {
            let mut b = this.lock().unwrap();
            b.generation += 1;
            b.status = BeatStatus::Analysing;
            b.track = None;
            b.live = None;
            b.path = Some(path.clone());
            b.clear_music();
            b.generation
        };
        let beat = this.clone();
        let spawned = std::thread::Builder::new()
            .name("bp-beat".into())
            .spawn(move || {
                let result = read_samples(&path).map(|samples| bp_beat::analyse(&samples));
                {
                    let mut b = beat.lock().unwrap();
                    if b.generation != generation {
                        return;
                    }
                    // Silence is a valid analysis, and its envelope still serves Audio.
                    match result {
                        Ok(track) => {
                            b.status = BeatStatus::Ready;
                            b.track = Some(track);
                        }
                        Err(e) => b.status = BeatStatus::Error(e),
                    }
                }
                done();
            });
        if spawned.is_err() {
            let mut b = this.lock().unwrap();
            if b.generation == generation { b.status = BeatStatus::Error("audio analysis unavailable".into()); }
        }
    }

    /// Loudness of the sound track at `ms`, 0..1, once analysed.
    pub fn loudness_at(&self, ms: f64) -> Option<f64> {
        if let Some(window) = &self.window {
            return Some(if (window.start_ms..window.track.duration_ms).contains(&ms) {
                window.track.loudness_at(ms - window.start_ms)
            } else { 0.0 });
        }
        self.playback_track().map(|t| t.loudness_at(ms))
    }

    pub fn clear(&mut self) {
        self.generation += 1;
        self.status = BeatStatus::None;
        self.track = None;
        self.live = None;
        self.window = None;
        self.window_status = BeatStatus::None;
        self.window_generation = self.window_generation.wrapping_add(1);
        self.path = None;
        self.clear_music();
    }

    /// Starts the source on live audio: `live_push` feeds it, `clear` ends it.
    pub fn live_start(&mut self) {
        self.clear();
        self.fps = 60.0;
        self.status = BeatStatus::Analysing;
        self.live = Some(Live::default());
    }

    /// Adds samples (mono, `RATE` Hz, in order from the start) to the live window. Every
    /// `LIVE_EVERY_MS` of audio the window is analysed on its own thread, with the beats
    /// measured from the start and continued `LIVE_AHEAD_MS` past the audio; `done` runs
    /// with the lock released once a result is in. Nothing runs on the caller's thread.
    pub fn live_push(this: &Arc<Mutex<Beat>>, samples: &[f32], done: impl FnOnce() + Send + 'static) {
        let (generation, mut stream, pending) = {
            let mut b = this.lock().unwrap();
            let generation = b.generation;
            let Some(live) = b.live.as_mut() else { return };
            live.pending.extend_from_slice(samples);
            live.total += samples.len() as u64;
            if live.pending.len() > live_samples(LIVE_WINDOW_MS) {
                let excess = live.pending.len() - live_samples(LIVE_WINDOW_MS);
                live.pending.drain(..excess);
                live.stream = None;
            }
            if live.analysing
                || live.total - live.analysed_at < live_samples(LIVE_EVERY_MS) as u64
                || live.total < live_samples(LIVE_MIN_MS) as u64
            {
                return;
            }
            live.analysing = true;
            live.analysed_at = live.total;
            let stream = live.stream.take().unwrap_or_else(|| bp_beat::Stream::starting_at(live.total - live.pending.len() as u64));
            (generation, stream, std::mem::take(&mut live.pending))
        };
        let beat = this.clone();
        let spawned = std::thread::Builder::new()
            .name("bp-beat-live".into())
            .spawn(move || {
                stream.push(&pending);
                let (mut track, evidence) = stream.analyse();
                let end = track.duration_ms;
                // Predictions expire after a short dropout. Never extend old evidence forever.
                let until = evidence.map_or(0.0, |at| at + LIVE_AHEAD_MS);
                if until > end {
                    let last = track.beats.last().copied().unwrap_or(end);
                    bp_beat::extend_beats(&mut track, (until - last).max(0.0));
                }
                let keep = track.beats.partition_point(|at| *at <= until);
                track.beats.truncate(keep);
                track.loudness.truncate(keep);
                {
                    let mut b = beat.lock().unwrap();
                    if b.generation != generation { return; }
                    if let Some(live) = b.live.as_mut() {
                        live.analysing = false;
                        if stream.total_samples() + live.pending.len() as u64 == live.total {
                            live.stream = Some(stream);
                        }
                    }
                    if let Some(previous) = &b.track { align_live_beats(&mut track, previous); }
                    b.track = Some(track);
                    b.status = BeatStatus::Ready;
                }
                done();
            });
        if spawned.is_err() {
            let mut b = this.lock().unwrap();
            if b.generation == generation {
                if let Some(live) = b.live.as_mut() { live.analysing = false; }
            }
        }
    }

    /// Drops the music model's scripts and stops any pass under way.
    pub fn clear_music(&mut self) {
        self.music_generation += 1;
        self.music_cancel.store(true, Ordering::Relaxed);
        self.music_cancel = Arc::new(AtomicBool::new(false));
        self.music = MusicStatus::None;
        self.music_scripts = None;
        self.music_key = None;
    }

    /// Starts the music model on `media` unless the same request is already done or under
    /// way: the video pass (or its cached rows), then the log-mel, the grid and the model.
    /// `done` runs with the lock released once the scripts are in. Nothing without the beats.
    #[allow(clippy::too_many_arguments)]
    pub fn music_start(
        this: &Arc<Mutex<Beat>>,
        shared: Arc<Shared>,
        media: String,
        hwdec: Option<String>,
        model: Arc<Loaded>,
        pace: f64,
        cache_dir: Option<PathBuf>,
        done: impl FnOnce() + Send + 'static,
    ) {
        let region = region_key(&shared);
        let key = MusicKey {
            media: media.clone(),
            pace,
            region: region.clone(),
            model: model.meta.version.clone(),
        };
        let (generation, cancel, track, path) = {
            let mut b = this.lock().unwrap();
            if b.music_key.as_ref() == Some(&key) && !matches!(b.music, MusicStatus::Error(_)) {
                return;
            }
            let Some(track) = b.track.clone().filter(|t| t.beats.len() >= 2) else {
                return;
            };
            let Some(path) = b.path.clone() else { return };
            b.music_generation += 1;
            b.music_cancel.store(true, Ordering::Relaxed);
            b.music_cancel = Arc::new(AtomicBool::new(false));
            b.music = MusicStatus::Watching { percent: 0.0 };
            b.music_scripts = None;
            b.music_key = Some(key);
            (b.music_generation, b.music_cancel.clone(), track, path)
        };
        let beat = this.clone();
        std::thread::Builder::new()
            .name("bp-music".into())
            .spawn(move || {
                let result = music_run(
                    &shared,
                    &beat,
                    generation,
                    &cancel,
                    &media,
                    hwdec,
                    &model,
                    &track,
                    &path,
                    pace,
                    &region,
                    cache_dir.as_deref(),
                );
                let mut b = beat.lock().unwrap();
                if b.music_generation != generation {
                    return;
                }
                match result {
                    Ok(scripts) => {
                        b.music_scripts = Some(scripts);
                        b.music = MusicStatus::Ready;
                    }
                    Err(e) => b.music = MusicStatus::Error(e),
                }
                drop(b);
                done();
            })
            .ok();
    }
}

fn read_samples(path: &Path) -> Result<Vec<f32>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

/// What the rows depend on beside the file: the region source and, on Auto, the detector.
fn region_key(shared: &Shared) -> String {
    let r = shared.region.lock().unwrap();
    match r.source {
        RegionSource::Auto => format!(
            "auto-{}-{}",
            shared
                .detector_model
                .lock()
                .unwrap()
                .as_ref()
                .map_or("none", |m| m.0.id),
            r.target.map_or("rule", |t| t.id())
        ),
        RegionSource::Centre => "centre".into(),
        RegionSource::Pick(p) => format!("pick-{:.3}-{:.3}-{:.3}-{:.3}", p.x, p.y, p.w, p.h),
    }
}

/// 16 hex characters identifying a file by its size and three samples of its bytes (as
/// `ml/data/cache.py` does, with FNV in place of SHA-256), so a copy shares its cache.
fn title_id(path: &str) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    const SAMPLE: u64 = 8 * 1024 * 1024;
    let mut file = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let mut hash: u64 = 0xcbf29ce484222325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            hash ^= *b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    };
    feed(&size.to_le_bytes());
    let mut buf = vec![0u8; SAMPLE as usize];
    for offset in [
        0,
        (size / 2).saturating_sub(SAMPLE / 2),
        size.saturating_sub(SAMPLE),
    ] {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        feed(&buf[..n]);
    }
    Ok(format!("{hash:016x}"))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct CachedRows {
    version: u32,
    rows: Vec<VideoRow>,
}

/// The pass over the file, or its cached rows.
#[allow(clippy::too_many_arguments)]
fn video_rows(
    shared: &Arc<Shared>,
    beat: &Arc<Mutex<Beat>>,
    generation: u64,
    cancel: &AtomicBool,
    media: &str,
    hwdec: Option<String>,
    region: &str,
    cache_dir: Option<&Path>,
) -> Result<Vec<VideoRow>, String> {
    let cache = match (cache_dir, title_id(media)) {
        (Some(dir), Ok(id)) => Some(
            dir.join("music-cache")
                .join(format!("{id}-{region}-v{CACHE_VERSION}.json")),
        ),
        _ => None,
    };
    if let Some(file) = cache.as_ref().filter(|f| f.exists()) {
        if let Ok(text) = std::fs::read_to_string(file) {
            if let Ok(cached) = serde_json::from_str::<CachedRows>(&text) {
                if cached.version == CACHE_VERSION {
                    return Ok(cached.rows);
                }
            }
        }
    }
    let track_options = *shared.track_options.lock().unwrap();
    let cancelled = || cancel.load(Ordering::Relaxed);
    let pass = Pass {
        shared,
        path: media,
        hwdec,
        color: false,
        track_options,
        cancelled: &cancelled,
    };
    let mut rows: Vec<VideoRow> = Vec::new();
    let mut chain = [0.5; 6];
    let mut cuts_seen = 0u64;
    pass.run(
        &mut |_| {},
        &mut |p| {
            let mut b = beat.lock().unwrap();
            if b.music_generation == generation {
                b.music = MusicStatus::Watching {
                    percent: if p.duration_ms > 0.0 {
                        (p.time_ms / p.duration_ms * 100.0).clamp(0.0, 100.0)
                    } else {
                        0.0
                    },
                };
            }
        },
        &mut |f| {
            if let Some(s) = f.sample {
                chain = s.motion;
            }
            let cuts = f.tracker.cuts();
            let cut = cuts != cuts_seen;
            cuts_seen = cuts;
            rows.push(VideoRow {
                time_ms: f.time_ms,
                chain,
                signals: f.tracker.signals(),
                cut,
            });
            Ok(())
        },
    )?;
    if let Some(file) = cache {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string(&CachedRows {
            version: CACHE_VERSION,
            rows: rows.clone(),
        }) {
            let _ = std::fs::write(&file, text);
        }
    }
    Ok(rows)
}

#[allow(clippy::too_many_arguments)]
fn music_run(
    shared: &Arc<Shared>,
    beat: &Arc<Mutex<Beat>>,
    generation: u64,
    cancel: &AtomicBool,
    media: &str,
    hwdec: Option<String>,
    model: &Arc<Loaded>,
    track: &BeatTrack,
    samples: &Path,
    pace: f64,
    region: &str,
    cache_dir: Option<&Path>,
) -> Result<Vec<Script>, String> {
    let rows = video_rows(
        shared, beat, generation, cancel, media, hwdec, region, cache_dir,
    )?;
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    {
        let mut b = beat.lock().unwrap();
        if b.music_generation != generation {
            return Err("superseded".into());
        }
        b.music = MusicStatus::Modelling;
    }
    let mel = log_mel(&read_samples(samples)?);
    let grid = bp_beat::grid50(track);
    let music = Music::new(model.session.clone(), model.meta.clone());
    let result = music.run(&mel, &grid, track.bpm, Some(&rows), pace)?;
    Ok(result.scripts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playback_windows_keep_absolute_beats_and_relative_loudness_separate_from_export() {
        let mut beat = Beat::new();
        let full = BeatTrack { beats: vec![1000.0, 2000.0, 3000.0], loudness: vec![0.5; 3], duration_ms: 4000.0, ..BeatTrack::default() };
        beat.track = Some(full);
        beat.status = BeatStatus::Analysing;
        let export = beat.script(Axis::L0, TrackAxis::OFF, false, 1.0).unwrap();
        let token = beat.window_begin(true);
        assert!(beat.playback_script(Axis::L0, TrackAxis::OFF, false, 1.0).unwrap().actions.is_empty());
        let track = BeatTrack { beats: vec![500.0, 1000.0, 1500.0], loudness: vec![0.5; 3], envelope: vec![0.25; 20], duration_ms: 2000.0, ..BeatTrack::default() };
        assert!(beat.set_window(track, 1_740_000.0, token, false));
        let playing = beat.playback_script(Axis::L0, TrackAxis::OFF, false, 1.0).unwrap();
        assert!(playing.actions.iter().any(|a| a.at == 1_740_500.0 && a.pos == 0.0));
        assert_eq!(beat.loudness_at(1_740_100.0), Some(0.25));
        assert_eq!(beat.loudness_at(1_739_900.0), Some(0.0));
        assert_eq!(beat.loudness_at(1_742_100.0), Some(0.0));
        assert_eq!(beat.snapshot().status, BeatStatus::Ready);
        assert_eq!(beat.snapshot().full_status, BeatStatus::Analysing);
        assert_eq!(beat.script(Axis::L0, TrackAxis::OFF, false, 1.0).unwrap(), export);
    }

    #[test]
    fn media_and_seek_tokens_reject_stale_results_and_silent_windows_clear_motion() {
        let mut beat = Beat::new();
        let old = beat.window_begin(true);
        beat.clear();
        assert!(!beat.set_window(BeatTrack::default(), 0.0, old, false));
        let first = beat.window_begin(true);
        let next = beat.window_begin(true);
        assert!(!beat.set_window(BeatTrack::default(), 0.0, first, false));
        beat.window_error(first, "stale failure".into());
        assert_eq!(beat.snapshot().status, BeatStatus::Analysing);
        assert!(beat.set_window(BeatTrack::default(), 100_000.0, next, false));
        assert_eq!(beat.snapshot().status, BeatStatus::Ready);
        assert_eq!(beat.snapshot().full_status, BeatStatus::None);
        assert!(beat.playback_script(Axis::L0, TrackAxis::OFF, true, 1.0).unwrap().actions.is_empty());
        assert!(beat.script(Axis::L0, TrackAxis::OFF, true, 1.0).is_none());
    }

    #[test]
    fn beat_scripts_respect_flourishes_and_inversion() {
        let mut beat = Beat::new();
        let mut loudness = vec![0.5; 16];
        loudness[8] = 1.0;
        beat.track = Some(BeatTrack {
            beats: (0..16).map(|i| i as f64 * 500.0).collect(),
            loudness,
            bpm: 120.0,
            duration_ms: 8000.0,
            ..BeatTrack::default()
        });
        let plain = beat.script(Axis::L0, TrackAxis::OFF, false, 1.0).unwrap();
        let accented = beat.script(Axis::L0, TrackAxis::OFF, true, 1.0).unwrap();
        let inverted = beat.script(Axis::L0, TrackAxis { invert: true, ..TrackAxis::OFF }, true, 1.0).unwrap();
        assert_eq!(accented.actions.len(), plain.actions.len() + 3);
        assert_eq!(inverted.actions.len(), accented.actions.len());
        for (a, b) in accented.actions.iter().zip(&inverted.actions) {
            assert_eq!(a.at, b.at);
            assert!((a.pos + b.pos - 1.0).abs() < 1e-9);
        }
        beat.options.bounce = false;
        assert_eq!(beat.script(Axis::L0, TrackAxis::OFF, true, 1.0).unwrap().actions, plain.actions);
    }

    #[test]
    fn twist_intensity_changes_beat_frequency_and_keeps_the_full_range() {
        let mut beat = Beat::new();
        beat.track = Some(BeatTrack {
            beats: (0..24).map(|i| i as f64 * 1000.0).collect(),
            loudness: vec![0.5; 24],
            ..BeatTrack::default()
        });
        for tempo in [0.5, 1.0, 2.0] {
            beat.options.tempo_factor = tempo;
            for (intensity, speed) in [(0.0, 0.5), (0.5, 0.5), (0.8, 1.0), (1.0, 1.0), (1.5, 2.0), (2.0, 2.0)] {
                let axis = TrackAxis { source: crate::TrackSource::Beat, intensity, min: 0.25, max: 0.75, ..TrackAxis::OFF };
                let script = beat.script(Axis::R0, axis, true, 1.0).unwrap();
                let times: Vec<_> = script.actions.windows(2)
                    .filter(|w| w[0].pos != w[1].pos)
                    .map(|w| {
                        assert!(w[1].pos == 0.25 || w[1].pos == 0.75);
                        w[1].at
                    }).collect();
                assert_eq!(times[0], 1000.0 / (tempo * speed));
                assert!(times.windows(2).all(|w| w[1] - w[0] == times[0]));
                let fallback = beat.script(Axis::R0, TrackAxis { source: crate::TrackSource::AiMusic, ..axis }, true, 1.0).unwrap();
                let first_turn = fallback.actions.windows(2).find(|w| w[0].pos != w[1].pos).unwrap();
                assert_eq!(first_turn[1].at, 1000.0 / tempo);
            }
        }
    }

    #[test]
    fn rolling_windows_keep_alternating_strokes_in_phase() {
        let window = |start: usize| BeatTrack {
            beats: (start..start + 48).map(|i| i as f64 * 500.0).collect(),
            loudness: vec![1.0; 48],
            bpm: 120.0,
            ..BeatTrack::default()
        };
        let initial = window(0);
        let mut previous = initial.clone();
        for start in 1..12 {
            let mut next = window(start);
            align_live_beats(&mut next, &previous);
            for style in [Style::Strokes] {
                for tempo_factor in [0.25, 0.5, 1.0, 2.0, 4.0] {
                    let options = GenerateOptions { style, tempo_factor, alternate: true, ..GenerateOptions::default() };
                    let positions = |track: &BeatTrack| bp_beat::generate(track, options).actions.into_iter()
                        .filter(|a| (10_000.0..20_000.0).contains(&a.at))
                        .map(|a| (a.at, a.pos)).collect::<Vec<_>>();
                    assert_eq!(positions(&next), positions(&initial), "window {start}, {style:?}, tempo {tempo_factor}");
                }
            }
            previous = next;
        }
    }

    fn analysing(beat: &Arc<Mutex<Beat>>) -> bool {
        beat.lock().unwrap().live.as_ref().is_some_and(|l| l.analysing)
    }

    #[test]
    fn live_push_finds_the_tempo_and_runs_ahead_of_the_audio() {
        // 8 s of a decaying 80 Hz kick every 500 ms (120 BPM), pushed in 250 ms chunks.
        let rate = RATE as usize;
        let n = rate * 8;
        let mut samples = vec![0.0f32; n];
        for start in (0..n).step_by(rate / 2) {
            for k in 0..rate / 20 {
                let t = k as f64 / rate as f64;
                samples[start + k] = (0.8 * (2.0 * std::f64::consts::PI * 80.0 * t).sin() * (-t * 30.0).exp()) as f32;
            }
        }
        let beat = Arc::new(Mutex::new(Beat::new()));
        beat.lock().unwrap().live_start();
        assert_eq!(beat.lock().unwrap().status, BeatStatus::Analysing);
        for chunk in samples.chunks(rate / 4) {
            Beat::live_push(&beat, chunk, || {});
            while analysing(&beat) {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        let b = beat.lock().unwrap();
        assert_eq!(b.status, BeatStatus::Ready);
        let snap = b.snapshot();
        assert!((snap.bpm - 120.0).abs() < 6.0, "bpm {}", snap.bpm);
        let track = b.track.as_ref().unwrap();
        let last = track.beats[track.beats.len() - 1];
        assert!(last > 8000.0, "last beat {last} ms should run past the 8 s pushed");
        let analysed_ms = b.live.as_ref().unwrap().analysed_at as f64 / RATE as f64 * 1000.0;
        assert!(track.duration_ms <= analysed_ms + LIVE_AHEAD_MS);
        assert!(last >= analysed_ms + LIVE_AHEAD_MS - 2.0 * 60_000.0 / track.bpm);
        assert!(track.envelope.is_empty() && track.onset.is_empty());
    }

    #[test]
    fn a_silent_tail_expires_predictions_and_a_reset_discards_old_audio() {
        let beat = Arc::new(Mutex::new(Beat::new()));
        beat.lock().unwrap().live_start();
        let mut samples = vec![0.0; RATE as usize * 12];
        for start in (0..RATE as usize * 8).step_by(RATE as usize / 2) {
            for k in 0..RATE as usize / 20 {
                let t = k as f64 / RATE as f64;
                samples[start + k] = ((2.0 * std::f64::consts::PI * 80.0 * t).sin() * (-t * 30.0).exp()) as f32;
            }
        }
        for chunk in samples.chunks(RATE as usize / 4) {
            Beat::live_push(&beat, chunk, || {});
            while analysing(&beat) { std::thread::sleep(std::time::Duration::from_millis(2)); }
        }
        let mut b = beat.lock().unwrap();
        assert_eq!(b.status, BeatStatus::Ready);
        assert!(b.track.as_ref().unwrap().beats.last().unwrap() < &9500.0);
        b.live_start();
        assert!(b.track.is_none());
        assert_eq!(b.live.as_ref().unwrap().total, 0);
        drop(b);
        Beat::live_push(&beat, &vec![0.0; RATE as usize * 3], || {});
        while analysing(&beat) { std::thread::sleep(std::time::Duration::from_millis(2)); }
        let b = beat.lock().unwrap();
        assert_eq!(b.status, BeatStatus::Ready);
        assert!(b.track.as_ref().unwrap().beats.is_empty());
    }
}
