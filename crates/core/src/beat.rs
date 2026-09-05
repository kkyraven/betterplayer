use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use bp_beat::{BeatTrack, GenerateOptions, Style};
use bp_model::{Loaded, Music, VideoRow, mel::log_mel};
use bp_script::{Axis, Script};

use crate::pass::Pass;
use crate::{RegionSource, Shared};

#[derive(Clone, Debug, PartialEq)]
pub enum BeatStatus {
    None,
    Analysing,
    Ready,
    Error(String),
}



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


#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BeatOptions {
    pub style: Style,
    pub volume_depth: bool,
    pub tempo_factor: f64,
}

impl Default for BeatOptions {
    fn default() -> BeatOptions {
        BeatOptions {
            style: Style::Full,
            volume_depth: true,
            tempo_factor: 1.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BeatSnapshot {
    pub status: BeatStatus,
    pub bpm: f64,
    pub beats: usize,
    pub options: BeatOptions,
    pub music: MusicStatus,
}


#[derive(Clone, Debug, PartialEq)]
struct MusicKey {
    media: String,
    pace: f64,
    region: String,
    model: String,
}

pub struct Beat {
    pub status: BeatStatus,
    pub track: Option<BeatTrack>,
    pub options: BeatOptions,

    pub generation: u64,

    path: Option<PathBuf>,
    pub music: MusicStatus,

    music_scripts: Option<Vec<Script>>,
    music_key: Option<MusicKey>,
    music_generation: u64,

    music_cancel: Arc<AtomicBool>,
}


const CACHE_VERSION: u32 = 2;

impl Beat {
    pub fn new() -> Beat {
        Beat {
            status: BeatStatus::None,
            track: None,
            options: BeatOptions::default(),
            generation: 0,
            path: None,
            music: MusicStatus::None,
            music_scripts: None,
            music_key: None,
            music_generation: 0,
            music_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn snapshot(&self) -> BeatSnapshot {
        BeatSnapshot {
            status: self.status.clone(),
            bpm: self
                .track
                .as_ref()
                .map_or(0.0, |t| t.bpm * self.options.tempo_factor),
            beats: self.track.as_ref().map_or(0, |t| t.beats.len()),
            options: self.options,
            music: self.music.clone(),
        }
    }



    pub fn script(
        &self,
        intensity: f64,
        invert: bool,
        alternate: bool,
    ) -> Option<bp_script::Script> {
        let track = self.track.as_ref().filter(|t| t.beats.len() >= 2)?;
        let opts = GenerateOptions {
            style: self.options.style,
            intensity,
            volume_depth: self.options.volume_depth,
            tempo_factor: self.options.tempo_factor,
            alternate,
        };
        let mut script = bp_beat::generate(track, opts);
        if invert {
            for a in &mut script.actions {
                a.pos = 1.0 - a.pos;
            }
        }
        Some(script)
    }



    pub fn music_script(&self, axis: Axis) -> Option<Script> {
        let scripts = self.music_scripts.as_ref()?;
        let i = bp_model::AXES.iter().position(|id| *id == axis.id())?;
        scripts.get(i).filter(|s| !s.actions.is_empty()).cloned()
    }



    pub fn load(this: &Arc<Mutex<Beat>>, path: PathBuf, done: impl FnOnce() + Send + 'static) {
        let generation = {
            let mut b = this.lock().unwrap();
            b.generation += 1;
            b.status = BeatStatus::Analysing;
            b.track = None;
            b.path = Some(path.clone());
            b.clear_music();
            b.generation
        };
        let beat = this.clone();
        std::thread::Builder::new()
            .name("bp-beat".into())
            .spawn(move || {
                let result = read_samples(&path).map(|samples| bp_beat::analyse(&samples));
                {
                    let mut b = beat.lock().unwrap();
                    if b.generation != generation {
                        return;
                    }


                    match result {
                        Ok(track) => {
                            b.status = if track.beats.len() >= 2 {
                                BeatStatus::Ready
                            } else {
                                BeatStatus::Error("no beats found".into())
                            };
                            b.track = Some(track);
                        }
                        Err(e) => b.status = BeatStatus::Error(e),
                    }
                }
                done();
            })
            .ok();
    }


    pub fn loudness_at(&self, ms: f64) -> Option<f64> {
        self.track.as_ref().map(|t| t.loudness_at(ms))
    }

    pub fn clear(&mut self) {
        self.generation += 1;
        self.status = BeatStatus::None;
        self.track = None;
        self.path = None;
        self.clear_music();
    }


    pub fn clear_music(&mut self) {
        self.music_generation += 1;
        self.music_cancel.store(true, Ordering::Relaxed);
        self.music_cancel = Arc::new(AtomicBool::new(false));
        self.music = MusicStatus::None;
        self.music_scripts = None;
        self.music_key = None;
    }




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
