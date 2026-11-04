use std::collections::{BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bp_detect::{Detector, Kind, ModelSpec, Rect, Skin, Variant};
use bp_player::{Matte, MatteSource, Player, PlayerEvent, PlayerOptions};
use serde::{Deserialize, Serialize};

use crate::Shared;
use crate::censor::{self, Held};

const MASK_FPS: u32 = 30;
const CENSOR_FPS: u32 = 15;
const MAKE_CELLS: usize = 384;
const CENSOR_CELLS: usize = 192;
const ALPHA_SIZE: u32 = 768;
const BOX_PADDING: f64 = 0.15;
const MASK_VERSION: u32 = 2;
const CENSOR_VERSION: u32 = 1;
const LEAD_PAUSE_S: u32 = 60;
const LEAD_RESUME_S: u32 = 30;
const KEPT_BEHIND: u32 = 1;
const KEPT_AHEAD: u32 = 4;
const HOLDOFF: Duration = Duration::from_secs(5);
const SEEK_S: u32 = 10;
const SEEK_SLACK_S: f64 = 5.0;
const FRAME_WAIT: Duration = Duration::from_millis(100);
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
const PACE: f64 = 1.5;
const PACE_GAP_S: f64 = 0.5;
const SKIP_FROM_FRAMES: f64 = 4.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EyeLayout {
    Mono,
    Sbs,
    Ou,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MatteSetup {
    pub path: String,
    pub dir: PathBuf,
    pub maker: Maker,
    pub cache_dir: Option<PathBuf>,
    pub layout: EyeLayout,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Maker {
    Alpha { alpha: String },
    Passthrough { skin: Vec<Variant> },
    Censor { detector: Arc<ModelSpec>, skin: Option<Vec<Variant>>, kinds: Vec<Kind>, key: String },
}

impl Maker {
    fn fps(&self, video_fps: f64) -> u32 {
        match self {
            Maker::Censor { .. } => CENSOR_FPS,
            _ => mask_fps(video_fps),
        }
    }

    fn version(&self) -> u32 {
        match self {
            Maker::Censor { .. } => CENSOR_VERSION,
            _ => MASK_VERSION,
        }
    }

    fn variants(&self) -> impl Iterator<Item = &Variant> {
        let (first, second) = match self {
            Maker::Alpha { .. } => (&[][..], None),
            Maker::Passthrough { skin } => (skin.as_slice(), None),
            Maker::Censor { detector, skin, .. } => (detector.variants.as_slice(), skin.as_deref()),
        };
        first.iter().chain(second.into_iter().flatten())
    }

    fn input(&self) -> (u32, u32) {
        self.variants().fold((0, 0), |(w, h), v| (w.max(v.width), h.max(v.height)))
    }

    fn names(&self) -> String {
        match self {
            Maker::Alpha { .. } => "xalpha".into(),
            Maker::Passthrough { skin } => skin.iter().filter_map(|v| Some(v.path.file_name()?.to_string_lossy().into_owned())).collect::<Vec<_>>().join(","),
            Maker::Censor { key, .. } => key.clone(),
        }
    }

    fn decoded<'a>(&'a self, path: &'a str) -> &'a str {
        match self {
            Maker::Alpha { alpha } => alpha,
            _ => path,
        }
    }
}

fn mask_fps(video_fps: f64) -> u32 {
    let f = video_fps.round();
    if f >= 1.0 { (f as u32).min(MASK_FPS) } else { MASK_FPS }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum MatteState {
    #[default]
    Loading,
    Running,
    Done,
    Error(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct MatteStatus {
    pub state: MatteState,
    pub ahead_s: f64,
    pub seconds: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MatteMakeStatus {
    pub state: MatteState,
    pub seconds: usize,
    pub total: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Meta {
    version: u32,
    w: u32,
    h: u32,
    fps: u32,
    layout: EyeLayout,
    eye: u8,
    model: String,
    #[serde(default)]
    source: String,
}

impl Meta {
    fn same_track(&self, other: &Meta) -> bool {
        (self.version, self.fps, self.layout, self.eye, &self.model, &self.source) == (other.version, other.fps, other.layout, other.eye, &other.model, &other.source)
    }
}

fn source_of(path: &str) -> String {
    let stamp = std::fs::metadata(path).ok().map(|m| (m.len(), m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())));
    match stamp {
        Some((len, secs)) => format!("{path}|{len}|{secs}"),
        None => path.to_string(),
    }
}

fn wanted_meta(setup: &MatteSetup, fps: u32) -> Meta {
    let source = source_of(setup.maker.decoded(&setup.path));
    Meta { version: setup.maker.version(), w: 0, h: 0, fps, layout: setup.layout, eye: 2, model: setup.maker.names(), source }
}

#[derive(Default)]
struct Track {
    state: MatteState,
    fps: u32,
    total: u32,
    done: BTreeSet<u32>,
    near: HashMap<u32, Arc<[Arc<Matte>]>>,
}

struct Inner {
    track: Mutex<Track>,
    stop: AtomicBool,
}

impl Inner {
    fn new() -> Arc<Inner> {
        Arc::new(Inner { track: Mutex::new(Track::default()), stop: AtomicBool::new(false) })
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }
}

fn spawn(inner: &Arc<Inner>, work: impl FnOnce(&Inner) -> Result<(), String> + Send + 'static) {
    let i = inner.clone();
    let spawned = std::thread::Builder::new().name("bp-matte".into()).spawn(move || {
        if let Err(e) = work(&i) {
            eprintln!("bp-core: mask track: {e}");
            i.track.lock().unwrap().state = MatteState::Error(e);
        }
    });
    if let Err(e) = spawned {
        inner.track.lock().unwrap().state = MatteState::Error(format!("thread: {e}"));
    }
}

static TRACKS: AtomicU64 = AtomicU64::new(0);

pub struct MatteTrack {
    pub setup: MatteSetup,
    reader: Arc<Source>,
    generation: u64,
}

impl MatteTrack {
    pub(crate) fn start(shared: Arc<Shared>, setup: MatteSetup, hwdec: Option<String>) -> MatteTrack {
        let inner = Inner::new();
        let (s, run_setup) = (shared.clone(), setup.clone());
        spawn(&inner, move |inner| run(inner, &s, &run_setup, hwdec));
        let generation = TRACKS.fetch_add(1, Ordering::Relaxed) + 1;
        let reader = Arc::new(Source { inner, shared, path: setup.path.clone() });
        MatteTrack { setup, reader, generation }
    }

    pub(crate) fn source(&self) -> Arc<dyn MatteSource> {
        self.reader.clone()
    }

    pub fn grid(&self) -> Option<(u64, Arc<Matte>)> {
        let pos = self.reader.shared.clock.lock().unwrap().peek() / 1000.0;
        let (slot, grid) = self.reader.matte_at(pos)?;
        Some(((self.generation << 32) + slot.min(u32::MAX as u64), grid))
    }

    pub fn status(&self) -> MatteStatus {
        let pos = (self.reader.shared.clock.lock().unwrap().peek() / 1000.0).max(0.0);
        let t = self.reader.inner.track.lock().unwrap();
        let mut s = pos.floor() as u32;
        while t.done.contains(&s) {
            s += 1;
        }
        MatteStatus { state: t.state.clone(), ahead_s: (s as f64 - pos).max(0.0), seconds: t.done.len() }
    }
}

impl Drop for MatteTrack {
    fn drop(&mut self) {
        self.reader.inner.stop.store(true, Ordering::Relaxed);
    }
}

pub struct MatteMake {
    pub setup: MatteSetup,
    inner: Arc<Inner>,
}

impl MatteMake {
    pub(crate) fn start(setup: MatteSetup, hwdec: Option<String>) -> MatteMake {
        let inner = Inner::new();
        let run_setup = setup.clone();
        spawn(&inner, move |inner| run_make(inner, &run_setup, hwdec));
        MatteMake { setup, inner }
    }

    pub fn going(&self) -> bool {
        matches!(self.inner.track.lock().unwrap().state, MatteState::Loading | MatteState::Running)
    }

    pub fn status(&self) -> MatteMakeStatus {
        let t = self.inner.track.lock().unwrap();
        MatteMakeStatus { state: t.state.clone(), seconds: t.done.len(), total: t.total }
    }
}

impl Drop for MatteMake {
    fn drop(&mut self) {
        self.inner.stop.store(true, Ordering::Relaxed);
    }
}

struct Source {
    inner: Arc<Inner>,
    shared: Arc<Shared>,
    path: String,
}

impl MatteSource for Source {
    fn matte_at(&self, pts: f64) -> Option<(u64, Arc<Matte>)> {
        if self.shared.media_path.lock().unwrap().as_deref().is_some_and(|p| p != self.path) {
            return None;
        }
        let t = self.inner.track.lock().unwrap();
        let fps = t.fps as u64;
        let i = slot_of(pts, t.fps).filter(|_| fps > 0)?;
        let grid = t.near.get(&((i / fps) as u32))?.get((i % fps) as usize)?.clone();
        Some((i, grid))
    }
}

fn slot_of(pts: f64, fps: u32) -> Option<u64> {
    (pts.is_finite() && pts >= 0.0).then(|| (pts * fps as f64 + 1e-3).floor() as u64)
}

fn made_slot(pts: f64, fps: u32, video_fps: f64) -> Option<u64> {
    let half = if video_fps > 0.0 { 0.5 / video_fps } else { 0.0 };
    let s = (pts + half) * fps as f64 - 0.5 + 1e-3;
    (pts.is_finite() && s >= 0.0).then(|| s.floor() as u64)
}

fn skips(video_fps: f64, fps: u32) -> bool {
    (video_fps / fps as f64).round() >= SKIP_FROM_FRAMES
}

#[derive(Default)]
struct Pace {
    last: Option<(f64, Instant)>,
}

impl Pace {
    fn wait(&mut self, pts: f64, now: Instant) -> Duration {
        let wait = match self.last {
            Some((p, _)) if pts <= p => return Duration::ZERO,
            Some((p, t)) if pts - p < PACE_GAP_S => (t + Duration::from_secs_f64((pts - p) / PACE)).saturating_duration_since(now),
            _ => Duration::ZERO,
        };
        self.last = Some((pts, now + wait));
        wait
    }
}

struct Chunker {
    second: u32,
    fps: u64,
    slots: Vec<Option<Arc<Matte>>>,
    last: Option<Arc<Matte>>,
}

impl Chunker {
    fn new(second: u32, fps: u32) -> Chunker {
        Chunker { second, fps: fps as u64, slots: vec![None; fps as usize], last: None }
    }

    fn wants(&self, slot: u64) -> bool {
        let s = slot / self.fps;
        s > self.second as u64 || (s == self.second as u64 && self.slots[(slot % self.fps) as usize].is_none())
    }

    fn push(&mut self, slot: u64, grid: Arc<Matte>) -> Vec<(u32, Vec<Arc<Matte>>)> {
        let mut out = Vec::new();
        if !self.wants(slot) {
            return out;
        }
        let s = (slot / self.fps) as u32;
        while self.second < s {
            out.push((self.second, self.fill(&grid)));
            self.second += 1;
        }
        self.slots[(slot % self.fps) as usize] = Some(grid);
        out
    }

    fn finish(&mut self) -> Option<(u32, Vec<Arc<Matte>>)> {
        let any = self.slots.iter().flatten().next()?.clone();
        let done = (self.second, self.fill(&any));
        self.second += 1;
        Some(done)
    }

    fn fill(&mut self, next: &Arc<Matte>) -> Vec<Arc<Matte>> {
        let first = self.slots.iter().flatten().next().cloned();
        let mut prev = self.last.take().or(first).unwrap_or_else(|| next.clone());
        let grids: Vec<Arc<Matte>> = self
            .slots
            .iter_mut()
            .map(|s| {
                if let Some(g) = s.take() {
                    prev = g;
                }
                prev.clone()
            })
            .collect();
        self.last = Some(prev);
        grids
    }
}

fn decode_size((w, h): (u32, u32), layout: EyeLayout, (mw, mh): (u32, u32)) -> (u32, u32) {
    let (ex, ey) = match layout {
        EyeLayout::Mono => (1.0, 1.0),
        EyeLayout::Sbs => (2.0, 1.0),
        EyeLayout::Ou => (1.0, 2.0),
    };
    let (ew, eh) = (w.max(1) as f64 / ex, h.max(1) as f64 / ey);
    let scale = (mw.max(1) as f64 / ew).min(mh.max(1) as f64 / eh).min(1.0);
    let even = |v: f64| ((v / 2.0).round() as u32 * 2).max(2);
    (even(ew * scale * ex), even(eh * scale * ey))
}

fn decode_for(setup: &MatteSetup, (w, h): (u32, u32)) -> (u32, u32) {
    match setup.maker {
        Maker::Alpha { .. } => decode_size((w, h), EyeLayout::Mono, (ALPHA_SIZE, ALPHA_SIZE)),
        _ => decode_size((w, h), setup.layout, setup.maker.input()),
    }
}

fn eye_rgb(bytes: &[u8], (w, h): (usize, usize), bgra: bool, layout: EyeLayout, second: bool, out: &mut Vec<u8>) -> (usize, usize) {
    let (ew, eh, x0, y0) = match layout {
        EyeLayout::Mono => (w, h, 0, 0),
        EyeLayout::Sbs => (w / 2, h, if second { w / 2 } else { 0 }, 0),
        EyeLayout::Ou => (w, h / 2, 0, if second { h / 2 } else { 0 }),
    };
    let (r, b) = if bgra { (2, 0) } else { (0, 2) };
    out.clear();
    out.reserve(ew * eh * 3);
    for y in y0..y0 + eh {
        let row = (y * w + x0) * 4;
        for p in bytes[row..row + ew * 4].chunks_exact(4) {
            out.extend_from_slice(&[p[r], p[1], p[b]]);
        }
    }
    (ew, eh)
}

fn linear_table() -> Box<[f32; 256]> {
    let mut t = Box::new([0.0; 256]);
    for (i, v) in t.iter_mut().enumerate() {
        let c = i as f32 / 255.0;
        *v = if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) };
    }
    t
}

fn alpha_of(lin: &[f32; 256], [r, g, b]: [u8; 3]) -> u8 {
    ((lin[r as usize] + lin[g as usize] + lin[b as usize]).min(1.0) * 255.0).round() as u8
}

fn alpha_grid(bytes: &[u8], (w, h): (usize, usize), lin: &[f32; 256]) -> Matte {
    let cover = bytes[..w * h * 4].chunks_exact(4).map(|p| alpha_of(lin, [p[0], p[1], p[2]])).collect();
    Matte { w: w as u32, h: h as u32, cover }
}

fn second_file(dir: &Path, second: u32) -> PathBuf {
    dir.join(format!("{second}.z"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

fn encode(grids: &[Arc<Matte>]) -> std::io::Result<Vec<u8>> {
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    for g in grids {
        z.write_all(&g.cover)?;
    }
    z.finish()
}

fn decode(bytes: &[u8], w: u32, h: u32, fps: u32) -> Option<Vec<Arc<Matte>>> {
    let n = w as usize * h as usize;
    let mut raw = Vec::with_capacity(n * fps as usize);
    flate2::read::ZlibDecoder::new(bytes).read_to_end(&mut raw).ok()?;
    if n == 0 || raw.len() != n * fps as usize {
        return None;
    }
    Some(raw.chunks_exact(n).map(|c| Arc::new(Matte { w, h, cover: c.to_vec() })).collect())
}

fn read_meta(dir: &Path) -> Option<Meta> {
    serde_json::from_slice(&std::fs::read(dir.join("meta.json")).ok()?).ok()
}

fn meta_for<'a>(meta: &'a mut Option<Meta>, wanted: &Meta, grid: &Matte, dir: &Path) -> &'a Meta {
    meta.get_or_insert_with(|| {
        let m = Meta { w: grid.w, h: grid.h, ..wanted.clone() };
        if let Err(e) = serde_json::to_vec(&m).map_err(std::io::Error::other).and_then(|b| write_atomic(&dir.join("meta.json"), &b)) {
            eprintln!("bp-core: mask track: meta.json: {e}");
        }
        m
    })
}

fn seconds_on_disk(dir: &Path) -> BTreeSet<u32> {
    let Ok(entries) = std::fs::read_dir(dir) else { return BTreeSet::new() };
    entries.flatten().filter_map(|e| e.file_name().to_str()?.strip_suffix(".z")?.parse().ok()).collect()
}

fn clear(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if name == "meta.json" || name.ends_with(".z") || name.ends_with(".tmp") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn resume(inner: &Inner, dir: &Path, wanted: &Meta) -> Result<Option<Meta>, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let meta = read_meta(dir).filter(|m| m.same_track(wanted));
    let mut t = inner.track.lock().unwrap();
    t.fps = wanted.fps;
    match meta {
        Some(_) => t.done = seconds_on_disk(dir),
        None => clear(dir),
    }
    Ok(meta)
}

fn next_missing(done: &BTreeSet<u32>, from: u32, end: Option<u32>) -> Option<u32> {
    let mut s = from;
    while done.contains(&s) {
        s += 1;
    }
    end.is_none_or(|e| s < e).then_some(s)
}

fn file_end(duration: f64, end_seen: Option<u32>) -> Option<u32> {
    [(duration > 0.0).then(|| duration.ceil() as u32), end_seen].into_iter().flatten().min()
}

#[derive(Default)]
struct Events {
    loaded: AtomicBool,
    ended: AtomicBool,
    restarted: AtomicBool,
    eof: AtomicBool,
    duration: Mutex<f64>,
}

fn open(inner: &Inner, path: &str, (w, h): (u32, u32), options: PlayerOptions) -> Result<Option<(Player, Arc<Events>)>, String> {
    let events = Arc::new(Events::default());
    let sink: bp_player::EventSink = {
        let events = events.clone();
        Arc::new(move |e| match e {
            PlayerEvent::FileLoaded => events.loaded.store(true, Ordering::Relaxed),
            PlayerEvent::EndFile { .. } => events.ended.store(true, Ordering::Relaxed),
            PlayerEvent::PlaybackRestart => events.restarted.store(true, Ordering::Relaxed),
            PlayerEvent::PlaybackEnded(on) => events.eof.store(on, Ordering::Relaxed),
            PlayerEvent::Duration(d) => *events.duration.lock().unwrap() = d,
            _ => {}
        })
    };
    let player = Player::new(w, h, options, Some(sink))?;
    player.load(path, None)?;
    let began = Instant::now();
    while !events.loaded.load(Ordering::Relaxed) {
        if inner.stopped() {
            return Ok(None);
        }
        if events.ended.load(Ordering::Relaxed) || began.elapsed() > LOAD_TIMEOUT {
            return Err("the file did not open".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    inner.track.lock().unwrap().state = MatteState::Running;
    Ok(Some((player, events)))
}

fn seek_to(player: &Player, events: &Events, second: u32) -> Result<(), String> {
    events.restarted.store(false, Ordering::Relaxed);
    events.eof.store(false, Ordering::Relaxed);
    player.seek(second as f64)?;
    player.play()
}

fn past_seek(seeking: &mut Option<u32>, pts: f64, restarted: bool) -> bool {
    if let Some(s) = *seeking {
        let slack = if restarted { SEEK_SLACK_S } else { 1.0 };
        if pts < s as f64 - 0.05 || pts > s as f64 + slack {
            return false;
        }
        *seeking = None;
    }
    true
}

fn run(inner: &Inner, shared: &Shared, setup: &MatteSetup, hwdec: Option<String>) -> Result<(), String> {
    let dir = setup.dir.as_path();
    let decoded = setup.maker.decoded(&setup.path);
    let info = bp_player::probe_video(decoded)?;
    let fps = setup.maker.fps(info.fps);
    let wanted = wanted_meta(setup, fps);
    let mut meta = resume(inner, dir, &wanted)?;
    let mut analyser = Analyser::load(&setup.maker, setup.cache_dir.as_deref())?;
    let Some((player, events)) = open(inner, decoded, decode_for(setup, (info.width, info.height)), options(hwdec, skips(info.fps, fps)))? else {
        return Ok(());
    };

    let mut chunker: Option<Chunker> = None;
    let mut seeking: Option<u32> = None;
    let mut restarted: Option<Instant> = None;
    let mut stride: u32 = 1;
    let mut due: u64 = 0;
    let mut lead: u32 = 0;
    let mut started: Option<u32> = None;
    let mut skip: Option<(u32, u32)> = None;
    let mut paused = true;
    let mut end_seen: Option<u32> = None;
    let mut pace = Pace::default();
    let mut rgb = Vec::new();

    while !inner.stopped() {
        let pos = (shared.clock.lock().unwrap().peek() / 1000.0).max(0.0);
        let here = pos.floor() as u32;
        let end = file_end(*events.duration.lock().unwrap(), end_seen);
        keep_near(inner, dir, meta.as_ref(), here);

        let from = match skip {
            Some((p, s)) if (p..s).contains(&here) => s,
            _ => {
                skip = None;
                here
            }
        };
        let want = next_missing(&inner.track.lock().unwrap().done, from, end);
        match (want, chunker.as_ref()) {
            (None, _) => {
                if !paused {
                    player.pause()?;
                    paused = true;
                }
            }
            (Some(want), c) => {
                let at = c.map(|c| c.second);
                let held = restarted.is_some_and(|t| t.elapsed() < HOLDOFF) && at.is_some_and(|a| a.abs_diff(here) < SEEK_S && !inner.track.lock().unwrap().done.contains(&a));
                if at != Some(want) && !held {
                    let mut want = want;
                    if restarted.is_some() && at.is_some_and(|a| a < here && here - a < SEEK_S) {
                        if stride < fps {
                            stride = (stride * 2).min(fps);
                            eprintln!("bp-core: mask track: slower than playback, now {:.1} grids a second", fps as f32 / stride as f32);
                        }
                        if let Some(ahead) = next_missing(&inner.track.lock().unwrap().done, here + lead, end) {
                            skip = Some((here, ahead));
                            want = ahead;
                        }
                    }
                    started = Some(here);
                    seek_to(&player, &events, want)?;
                    paused = false;
                    chunker = Some(Chunker::new(want, fps));
                    due = 0;
                    analyser.restart();
                    pace = Pace::default();
                    seeking = Some(want);
                    restarted = Some(Instant::now());
                } else if let Some(a) = at {
                    let ahead = a.saturating_sub(here);
                    if !paused && ahead >= LEAD_PAUSE_S {
                        player.pause()?;
                        paused = true;
                    } else if paused && ahead < LEAD_RESUME_S {
                        player.play()?;
                        paused = false;
                    }
                }
            }
        }

        let Some(frame) = player.acquire_wait(FRAME_WAIT) else {
            if events.eof.load(Ordering::Relaxed)
                && seeking.is_none()
                && let Some(c) = chunker.as_mut()
            {
                match c.finish() {
                    Some((s, grids)) => {
                        end_seen = Some(s + 1);
                        save(inner, dir, meta.as_ref(), here, s, grids);
                    }
                    None => end_seen = Some(c.second),
                }
            }
            continue;
        };
        let Some(pts) = frame.pts else { continue };
        if !past_seek(&mut seeking, pts, events.restarted.load(Ordering::Relaxed)) {
            continue;
        }
        let wait = pace.wait(pts, Instant::now());
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
        let (Some(c), Some(slot)) = (chunker.as_mut(), made_slot(pts, fps, info.fps)) else { continue };
        if !c.wants(slot) || slot < due {
            continue;
        }
        due = slot + stride as u64;
        let Some(grid) = frame_grid(&player, frame.index, &mut analyser, setup, pts, &mut rgb)? else { continue };
        if inner.stopped() {
            break;
        }
        let m = meta_for(&mut meta, &wanted, &grid, dir);
        if (grid.w, grid.h) != (m.w, m.h) {
            continue;
        }
        for (s, grids) in c.push(slot, grid) {
            save(inner, dir, meta.as_ref(), here, s, grids);
            if let Some(p) = started.take() {
                lead = (here.saturating_sub(p) + 1).min(SEEK_S - 1);
            }
        }
    }
    Ok(())
}

fn run_make(inner: &Inner, setup: &MatteSetup, hwdec: Option<String>) -> Result<(), String> {
    let dir = setup.dir.as_path();
    let info = bp_player::probe_video(&setup.path)?;
    let fps = setup.maker.fps(info.fps);
    let wanted = wanted_meta(setup, fps);
    let mut meta = resume(inner, dir, &wanted)?;
    let mut analyser = Analyser::load(&setup.maker, setup.cache_dir.as_deref())?;
    let Some((player, events)) = open(inner, &setup.path, decode_for(setup, (info.width, info.height)), options(hwdec, skips(info.fps, fps)))? else {
        return Ok(());
    };

    let mut chunker: Option<Chunker> = None;
    let mut seeking: Option<u32> = None;
    let mut end_seen: Option<u32> = None;
    let mut rgb = Vec::new();
    while !inner.stopped() {
        let end = file_end(*events.duration.lock().unwrap(), end_seen);
        let at = chunker.as_ref().map(|c| c.second);
        let want = {
            let mut t = inner.track.lock().unwrap();
            t.total = end.unwrap_or(0);
            next_missing(&t.done, at.unwrap_or(0), end)
        };
        let Some(want) = want else {
            inner.track.lock().unwrap().state = MatteState::Done;
            return Ok(());
        };
        if at != Some(want) {
            seek_to(&player, &events, want)?;
            chunker = Some(Chunker::new(want, fps));
            analyser.restart();
            seeking = Some(want);
        }

        let Some(frame) = player.acquire_wait(FRAME_WAIT) else {
            if events.eof.load(Ordering::Relaxed)
                && (seeking.is_none() || events.restarted.load(Ordering::Relaxed))
                && let Some(c) = chunker.as_mut()
            {
                match c.finish() {
                    Some((s, grids)) => {
                        end_seen = Some(s + 1);
                        if meta.is_some() {
                            write_second(dir, s, &grids)?;
                            inner.track.lock().unwrap().done.insert(s);
                        }
                    }
                    None => end_seen = Some(c.second),
                }
            }
            continue;
        };
        let Some(pts) = frame.pts else { continue };
        if !past_seek(&mut seeking, pts, events.restarted.load(Ordering::Relaxed)) {
            continue;
        }
        let (Some(c), Some(slot)) = (chunker.as_mut(), made_slot(pts, fps, info.fps)) else { continue };
        if !c.wants(slot) {
            continue;
        }
        let Some(grid) = frame_grid(&player, frame.index, &mut analyser, setup, pts, &mut rgb)? else { continue };
        if inner.stopped() {
            break;
        }
        let m = meta_for(&mut meta, &wanted, &grid, dir);
        if (grid.w, grid.h) != (m.w, m.h) {
            continue;
        }
        for (s, grids) in c.push(slot, grid) {
            write_second(dir, s, &grids)?;
            inner.track.lock().unwrap().done.insert(s);
        }
    }
    Ok(())
}

fn frame_grid(player: &Player, index: usize, analyser: &mut Analyser, setup: &MatteSetup, pts: f64, rgb: &mut Vec<u8>) -> Result<Option<Arc<Matte>>, String> {
    let slot = player.slot(index);
    let bytes = unsafe { slot.as_slice() };
    let (w, h) = player.size();
    let (w, h) = (w as usize, h as usize);
    if bytes.len() < w * h * 4 {
        return Ok(None);
    }
    Ok(Some(Arc::new(analyser.grid(bytes, (w, h), player.bgra(), setup, pts, rgb)?)))
}

fn write_second(dir: &Path, second: u32, grids: &[Arc<Matte>]) -> Result<(), String> {
    encode(grids).and_then(|z| write_atomic(&second_file(dir, second), &z)).map_err(|e| format!("second {second}: {e}"))
}

fn save(inner: &Inner, dir: &Path, meta: Option<&Meta>, here: u32, second: u32, grids: Vec<Arc<Matte>>) {
    if meta.is_none() {
        return;
    }
    if let Err(e) = write_second(dir, second, &grids) {
        eprintln!("bp-core: mask track: {e}");
        return;
    }
    let mut t = inner.track.lock().unwrap();
    t.done.insert(second);
    if near(here, second) {
        t.near.insert(second, grids.into());
    }
}

fn near(here: u32, second: u32) -> bool {
    second + KEPT_BEHIND >= here && second <= here + KEPT_AHEAD
}

fn keep_near(inner: &Inner, dir: &Path, meta: Option<&Meta>, here: u32) {
    let missing: Vec<u32> = {
        let mut t = inner.track.lock().unwrap();
        t.near.retain(|s, _| near(here, *s));
        (here.saturating_sub(KEPT_BEHIND)..=here + KEPT_AHEAD).filter(|s| t.done.contains(s) && !t.near.contains_key(s)).collect()
    };
    let Some(m) = meta else { return };
    for s in missing {
        let grids = std::fs::read(second_file(dir, s)).ok().and_then(|z| decode(&z, m.w, m.h, m.fps));
        let mut t = inner.track.lock().unwrap();
        match grids {
            Some(g) => {
                t.near.insert(s, g.into());
            }
            None => {
                t.done.remove(&s);
                let _ = std::fs::remove_file(second_file(dir, s));
            }
        }
    }
}

enum Analyser {
    Alpha(Box<[f32; 256]>),
    Passthrough(Box<(Skin, [Vec<f32>; 2])>),
    Censor(Box<CensorPass>),
}

struct CensorPass {
    detector: Detector,
    skin: Option<Skin>,
    box_kinds: Vec<Kind>,
    held: [Vec<Held>; 2],
    prev: [Vec<f32>; 2],
    epoch: Instant,
}

impl Analyser {
    fn load(maker: &Maker, cache_dir: Option<&Path>) -> Result<Analyser, String> {
        Ok(match maker {
            Maker::Alpha { .. } => Analyser::Alpha(linear_table()),
            Maker::Passthrough { skin } => Analyser::Passthrough(Box::new((Skin::load(skin.clone(), cache_dir, MAKE_CELLS)?, Default::default()))),
            Maker::Censor { detector, skin, kinds, .. } => {
                let mut d = Detector::load(detector.clone(), cache_dir)?;
                d.set_threshold(censor::KEEP);
                let skin = skin
                    .clone()
                    .filter(|_| kinds.contains(&Kind::Skin))
                    .and_then(|v| Skin::load(v, cache_dir, CENSOR_CELLS).map_err(|e| eprintln!("bp-core: censor track: skin: {e}")).ok());
                let box_kinds = kinds.iter().copied().filter(|k| !(skin.is_some() && *k == Kind::Skin)).collect();
                Analyser::Censor(Box::new(CensorPass { detector: d, skin, box_kinds, held: Default::default(), prev: Default::default(), epoch: Instant::now() }))
            }
        })
    }

    fn restart(&mut self) {
        match self {
            Analyser::Alpha(_) => {}
            Analyser::Passthrough(p) => p.1 = Default::default(),
            Analyser::Censor(c) => {
                c.held = Default::default();
                c.prev = Default::default();
            }
        }
    }

    fn grid(&mut self, bytes: &[u8], (w, h): (usize, usize), bgra: bool, setup: &MatteSetup, pts: f64, rgb: &mut Vec<u8>) -> Result<Matte, String> {
        let eyes = if setup.layout == EyeLayout::Mono { 1 } else { 2 };
        match self {
            Analyser::Alpha(lin) => Ok(alpha_grid(bytes, (w, h), lin)),
            Analyser::Passthrough(p) => {
                let (skin, prev) = &mut **p;
                let mut masks = Vec::with_capacity(eyes);
                for (eye, prev) in prev.iter_mut().enumerate().take(eyes) {
                    let (ew, eh) = eye_rgb(bytes, (w, h), bgra, setup.layout, eye == 1, rgb);
                    let mask = skin.segment_soft_with(rgb, ew, eh, prev)?;
                    masks.push(Matte { w: mask.width as u32, h: mask.height as u32, cover: mask.data });
                }
                Ok(whole_frame(setup.layout, masks))
            }
            Analyser::Censor(c) => {
                let now = c.epoch + Duration::from_secs_f64(pts.max(0.0));
                let mut covers = Vec::with_capacity(eyes);
                for eye in 0..eyes {
                    let (ew, eh) = eye_rgb(bytes, (w, h), bgra, setup.layout, eye == 1, rgb);
                    let CensorPass { detector, skin, box_kinds, held, prev, .. } = &mut **c;
                    let rgb = &*rgb;
                    let (dets, mask) = std::thread::scope(|scope| {
                        let mask = skin.as_mut().map(|s| {
                            let prev = &mut prev[eye];
                            scope.spawn(move || s.segment_with(rgb, ew, eh, prev))
                        });
                        let dets = detector.detect(rgb, ew, eh);
                        (dets, mask.map(|m| m.join().unwrap_or_else(|_| Err("skin pass panicked".into()))))
                    });
                    let boxes = censor::follow(&dets?, box_kinds, &mut held[eye], now);
                    let mask = mask.and_then(|m| m.map_err(|e| eprintln!("bp-core: censor track: skin: {e}")).ok());
                    covers.push(cover_eye(ew, eh, &boxes, mask.as_ref()));
                }
                Ok(whole_frame(setup.layout, covers))
            }
        }
    }
}

fn cover_eye(ew: usize, eh: usize, boxes: &[Rect], skin: Option<&bp_detect::SkinMask>) -> Matte {
    let k = ew.div_ceil(CENSOR_CELLS).max(1);
    let (cw, ch) = (ew.div_ceil(k).max(1), eh.div_ceil(k).max(1));
    let mut cover = vec![0u8; cw * ch];
    for b in boxes {
        let (dx, dy) = ((b.w * BOX_PADDING).max(0.01), (b.h * BOX_PADDING).max(0.01));
        let span = |from: f64, to: f64, n: usize| ((from * n as f64).floor().clamp(0.0, n as f64) as usize, (to * n as f64).ceil().clamp(0.0, n as f64) as usize);
        let (x0, x1) = span(b.x - dx, b.x + b.w + dx, cw);
        let (y0, y1) = span(b.y - dy, b.y + b.h + dy, ch);
        for y in y0..y1 {
            cover[y * cw + x0..y * cw + x1].fill(255);
        }
    }
    if let Some(m) = skin.filter(|m| m.width > 0 && m.height > 0) {
        for y in 0..ch {
            let row = (y * m.height / ch) * m.width;
            for x in 0..cw {
                let c = &mut cover[y * cw + x];
                *c = (*c).max(m.data[row + x * m.width / cw]);
            }
        }
    }
    Matte { w: cw as u32, h: ch as u32, cover }
}

fn whole_frame(layout: EyeLayout, mut eyes: Vec<Matte>) -> Matte {
    if eyes.len() < 2 {
        return eyes.pop().unwrap_or(Matte { w: 0, h: 0, cover: Vec::new() });
    }
    let (a, b) = (&eyes[0], &eyes[1]);
    match layout {
        EyeLayout::Sbs => {
            let w = a.w as usize;
            let cover = a.cover.chunks_exact(w).zip(b.cover.chunks_exact(w)).flat_map(|(l, r)| l.iter().chain(r).copied()).collect();
            Matte { w: a.w * 2, h: a.h, cover }
        }
        _ => Matte { w: a.w, h: a.h * 2, cover: [a.cover.as_slice(), b.cover.as_slice()].concat() },
    }
}

fn options(hwdec: Option<String>, skip: bool) -> PlayerOptions {
    let skip = skip.then_some("vd-lavc-skipframe=nonref");
    let mpv_options = ["aid=no", "sid=no", "untimed=yes", "framedrop=no", "hr-seek=yes", "osd-level=0", "audio-display=no"]
        .into_iter()
        .chain(skip)
        .map(|kv| {
            let (k, v) = kv.split_once('=').unwrap();
            (k.to_string(), v.to_string())
        })
        .collect();
    PlayerOptions { hwdec, stamp_frames: true, hold_frames: true, mpv_options, ..PlayerOptions::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(v: u8) -> Arc<Matte> {
        Arc::new(Matte { w: 2, h: 1, cover: vec![v, v] })
    }

    fn values(grids: &[Arc<Matte>]) -> Vec<u8> {
        grids.iter().map(|g| g.cover[0]).collect()
    }

    #[test]
    fn a_frames_time_picks_its_grid() {
        assert_eq!(slot_of(0.0, 10), Some(0));
        assert_eq!(slot_of(0.098, 10), Some(0));
        assert_eq!(slot_of(0.29999999, 10), Some(3));
        assert_eq!(slot_of(12.34, 10), Some(123));
        assert_eq!(slot_of(-0.1, 10), None);
        assert_eq!(slot_of(f64::NAN, 10), None);
    }

    #[test]
    fn a_grid_is_made_from_the_frame_showing_at_its_slots_middle() {
        assert_eq!(made_slot(0.0, 10, 0.0), None, "before the first slot's middle");
        assert_eq!(made_slot(0.049, 10, 0.0), None);
        assert_eq!(made_slot(0.05, 10, 0.0), Some(0));
        assert_eq!(made_slot(0.149, 10, 0.0), Some(0));
        assert_eq!(made_slot(0.15, 10, 0.0), Some(1));
        assert_eq!(made_slot(12.34, 10, 0.0), Some(122));
        assert_eq!(made_slot(1.0 / 60.0, 15, 60.0), None);
        assert_eq!(made_slot(2.0 / 60.0 - 1e-9, 15, 60.0), Some(0));
        for f in [0, 1, 29, 30, 1799] {
            assert_eq!(made_slot(f as f64 / 30.0, 30, 30.0), Some(f), "frame {f}");
            assert_eq!(made_slot(f as f64 / 24.0, 24, 24.0), Some(f));
        }
        assert_eq!(made_slot(0.0, 30, 60.0), None);
        assert_eq!(made_slot(1.0 / 60.0, 30, 60.0), Some(0));
        assert_eq!(made_slot(2.0 / 60.0, 30, 60.0), Some(0));
        assert_eq!(made_slot(3.0 / 60.0, 30, 60.0), Some(1));
    }

    #[test]
    fn mask_tracks_follow_the_video_up_to_30_grids_a_second() {
        assert_eq!(mask_fps(24.0), 24);
        assert_eq!(mask_fps(30000.0 / 1001.0), 30);
        assert_eq!(mask_fps(25.0), 25);
        assert_eq!(mask_fps(60.0), 30);
        assert_eq!(mask_fps(0.0), 30, "unknown");
        let alpha = Maker::Alpha { alpha: "a_XALPHA.mp4".into() };
        assert_eq!(alpha.fps(24.0), 24);
        let censor = Maker::Censor { detector: Arc::new(ModelSpec::new("d", &[], Vec::new())), skin: None, kinds: Vec::new(), key: "k".into() };
        assert_eq!(censor.fps(60.0), CENSOR_FPS);
        assert_eq!((alpha.version(), Maker::Passthrough { skin: Vec::new() }.version(), censor.version()), (2, 2, 1));
        let setup = MatteSetup { path: "v.mp4".into(), dir: PathBuf::new(), maker: alpha, cache_dir: None, layout: EyeLayout::Sbs };
        let m = wanted_meta(&setup, 30);
        assert_eq!((m.version, m.eye, m.model.as_str(), m.source.as_str()), (2, 2, "xalpha", "a_XALPHA.mp4"), "the alpha file's stamp");
        assert!(!Meta { version: 1, eye: 0, ..m.clone() }.same_track(&m));
    }

    #[test]
    fn an_alpha_pixels_opacity_is_its_channels_summed_in_linear_light() {
        let lin = linear_table();
        assert_eq!(alpha_of(&lin, [0, 0, 0]), 0, "black is transparent");
        assert_eq!(alpha_of(&lin, [255, 255, 255]), 255);
        assert_eq!(alpha_of(&lin, [128, 128, 128]), 165);
        assert_eq!(alpha_of(&lin, [128, 0, 0]), 55);
        assert_eq!(alpha_of(&lin, [128, 128, 0]), 110, "colours sum");
        assert_eq!(alpha_of(&lin, [255, 0, 0]), 255);
        assert_eq!(alpha_of(&lin, [200, 200, 0]), 255, "at most opaque");
        let frame = [0, 0, 0, 255, 255, 255, 255, 0, 128, 128, 128, 7, 0, 0, 255, 255];
        assert_eq!(alpha_grid(&frame, (2, 2), &lin), Matte { w: 2, h: 2, cover: vec![0, 255, 165, 255] });
    }

    #[test]
    fn the_decode_is_held_to_its_pace() {
        let t0 = Instant::now();
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        let step = 1000.0 / 60.0 / PACE;
        let mut p = Pace::default();
        assert_eq!(p.wait(10.0, t0), Duration::ZERO, "the first frame");
        assert!((ms(p.wait(10.0 + 1.0 / 60.0, t0)) - step).abs() < 0.01);
        assert!((ms(p.wait(10.0 + 2.0 / 60.0, t0)) - 2.0 * step).abs() < 0.01, "from when the last was let go");
        let later = t0 + Duration::from_secs(1);
        assert_eq!(p.wait(10.0 + 3.0 / 60.0, later), Duration::ZERO);
        assert!((ms(p.wait(10.0 + 4.0 / 60.0, later)) - step).abs() < 0.01);
        assert_eq!(p.wait(20.0, later), Duration::ZERO);
        assert_eq!(p.wait(19.0, later), Duration::ZERO);
    }

    #[test]
    fn frames_nothing_refers_to_are_skipped_only_with_plenty_a_slot() {
        assert!(skips(60.0, 10));
        assert!(skips(60000.0 / 1001.0, 15), "59.94 fps for a censor track");
        assert!(skips(120.0, 15));
        assert!(!skips(30.0, 10), "a frame each 100 ms could leave a slot without one");
        assert!(!skips(50.0, 15));
        assert!(!skips(60.0, 30));
        assert!(!skips(0.0, 10), "unknown");
        let has = |skip| options(None, skip).mpv_options.iter().any(|(k, v)| k == "vd-lavc-skipframe" && v == "nonref");
        assert!(has(true) && !has(false));
    }

    #[test]
    fn seconds_are_handed_back_whole_with_gaps_filled() {
        let mut c = Chunker::new(3, 10);
        assert!(c.push(29, grid(1)).is_empty(), "before the second asked for");
        for (slot, v) in [(30, 10), (32, 12), (35, 15), (37, 17)] {
            assert!(c.wants(slot));
            assert!(c.push(slot, grid(v)).is_empty());
        }
        assert!(!c.wants(30), "a grid there already");
        let out = c.push(40, grid(20));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, 3);
        assert_eq!(values(&out[0].1), [10, 10, 12, 12, 12, 15, 15, 17, 17, 17]);
        let out = c.push(60, grid(40));
        assert_eq!(out.iter().map(|o| o.0).collect::<Vec<_>>(), [4, 5]);
        assert_eq!(values(&out[0].1), [20; 10]);
        assert_eq!(values(&out[1].1), [20; 10]);
        let (s, grids) = c.finish().unwrap();
        assert_eq!((s, values(&grids)), (6, vec![40; 10]));
        assert!(c.finish().is_none(), "nothing more");
    }

    #[test]
    fn a_second_round_trips_through_its_file() {
        let grids: Vec<Arc<Matte>> = (0..10u8).map(|i| Arc::new(Matte { w: 3, h: 2, cover: vec![i, 255, 0, i, 128, 7] })).collect();
        let z = encode(&grids).unwrap();
        assert_eq!(z[0], 0x78);
        assert_eq!(decode(&z, 3, 2, 10).unwrap(), grids);
        assert!(decode(&z, 2, 2, 10).is_none(), "another size");

        let dir = std::env::temp_dir().join(format!("bp-matte-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_atomic(&second_file(&dir, 41), &z).unwrap();
        std::fs::write(dir.join("notes.txt"), b"kept").unwrap();
        assert_eq!(seconds_on_disk(&dir), BTreeSet::from([41]));
        assert_eq!(decode(&std::fs::read(second_file(&dir, 41)).unwrap(), 3, 2, 10).unwrap(), grids);
        clear(&dir);
        assert!(seconds_on_disk(&dir).is_empty());
        assert!(dir.join("notes.txt").exists(), "only the track's own files go");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_first_second_missing_from_the_playhead_is_next() {
        let done = BTreeSet::from([4, 5, 6, 9]);
        assert_eq!(next_missing(&done, 4, None), Some(7));
        assert_eq!(next_missing(&done, 8, Some(20)), Some(8));
        assert_eq!(next_missing(&done, 4, Some(7)), None, "made to the end");
    }

    #[test]
    fn a_make_runs_to_the_files_end() {
        assert_eq!(file_end(9.5, None), Some(10));
        assert_eq!(file_end(0.0, None), None, "unknown until the duration comes");
        assert_eq!(file_end(10.02, Some(10)), Some(10));
        let done = BTreeSet::from([0, 1, 2, 5]);
        assert_eq!(next_missing(&done, 0, file_end(9.5, None)), Some(3));
        assert_eq!(next_missing(&done, 4, file_end(9.5, None)), Some(4));
        let all: BTreeSet<u32> = (0..10).collect();
        assert_eq!(next_missing(&all, 0, file_end(9.5, None)), None, "done");
        assert_eq!(next_missing(&all, 0, None), Some(10), "not done before the end is known");
    }

    #[test]
    fn the_decode_fits_one_eye_to_the_model() {
        assert_eq!(decode_size((3840, 1920), EyeLayout::Sbs, (768, 768)), (1536, 768));
        assert_eq!(decode_size((1920, 1080), EyeLayout::Mono, (768, 768)), (768, 432));
        assert_eq!(decode_size((1920, 2160), EyeLayout::Ou, (768, 768)), (768, 864));
        assert_eq!(decode_size((640, 360), EyeLayout::Mono, (1024, 1024)), (640, 360), "never larger");
        let alpha = |w, h| decode_for(&MatteSetup { path: String::new(), dir: PathBuf::new(), maker: Maker::Alpha { alpha: String::new() }, cache_dir: None, layout: EyeLayout::Sbs }, (w, h));
        assert_eq!(alpha(1920, 960), (768, 384));
        assert_eq!(alpha(960, 1920), (384, 768));
        assert_eq!(alpha(640, 320), (640, 320), "never larger");
    }

    #[test]
    fn a_censor_cover_fills_padded_boxes_and_skin_over_the_whole_frame() {
        let b = Rect { x: 0.5, y: 0.5, w: 0.25, h: 0.25 };
        let skin = bp_detect::SkinMask { width: 2, height: 1, data: vec![200, 0] };
        let m = cover_eye(384, 192, &[b], Some(&skin));
        assert_eq!((m.w, m.h), (192, 96));
        let at = |x: usize, y: usize| m.cover[y * 192 + x];
        assert_eq!((at(87, 60), at(88, 60), at(151, 60), at(152, 60)), (200, 255, 255, 0));
        assert_eq!(at(10, 10), 200, "skin on the left half");
        assert_eq!(at(180, 10), 0);

        let eye = |v: u8| Matte { w: 2, h: 1, cover: vec![v, v] };
        assert_eq!(whole_frame(EyeLayout::Sbs, vec![eye(1), eye(2)]), Matte { w: 4, h: 1, cover: vec![1, 1, 2, 2] });
        assert_eq!(whole_frame(EyeLayout::Ou, vec![eye(1), eye(2)]), Matte { w: 2, h: 2, cover: vec![1, 1, 2, 2] });
        assert_eq!(whole_frame(EyeLayout::Mono, vec![eye(3)]), eye(3));
    }

    #[test]
    fn an_eye_is_cut_out_as_rgb() {
        let px = |left: bool| if left { [0u8, 0, 255, 255] } else { [255, 0, 0, 255] };
        let frame: Vec<u8> = (0..8).flat_map(|i| px(i % 4 < 2)).collect();
        let mut rgb = Vec::new();
        assert_eq!(eye_rgb(&frame, (4, 2), true, EyeLayout::Sbs, true, &mut rgb), (2, 2));
        assert_eq!(rgb, [0, 0, 255].repeat(4));
        assert_eq!(eye_rgb(&frame, (4, 2), true, EyeLayout::Sbs, false, &mut rgb), (2, 2));
        assert_eq!(rgb, [255, 0, 0].repeat(4));
        assert_eq!(eye_rgb(&frame, (4, 2), false, EyeLayout::Ou, true, &mut rgb), (4, 1));
        assert_eq!(&rgb[..3], &[0, 0, 255], "RGBA kept in order");
    }
}
