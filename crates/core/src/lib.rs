mod beat;
mod clock;
mod detect;
mod follow;
mod generate;
mod hero;
mod lookahead;
mod motion;
mod params;
mod pass;
mod track;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use bp_axes::{AxisSettings, Fallback, Frame, Mixer, ScriptTable};
use bp_devices::{
    AxisClamp, IntifaceServer, IntifaceStatus, Media, Output, OutputSnapshot, OutputStats, Pace,
    PercentilesUs, Profile, TickContext, Transport, deadline, percentiles,
};
use bp_player::{Player, PlayerEvent, PlayerOptions};
use bp_script::{Axis, Container, Kind, Script, find_scripts, heatmap};

use beat::Beat;
use clock::Clock;
use detect::Detect;
use follow::{Follow, FollowEvent, FollowSink};
use hero::HeroState;
use lookahead::Lookahead;
use motion::{Cadence, MotionFeed, box_run};
use track::{Timeline, Track};

pub use beat::{BeatOptions, BeatSnapshot, BeatStatus, MusicStatus};
pub use bp_beat::{
    ENVELOPE_HOP_MS as BEAT_ENVELOPE_HOP_MS, GRID_HOP_MS as BEAT_GRID_HOP_MS,
    ONSET_HOP_MS as BEAT_ONSET_HOP_MS, Style as BeatStyle, analyse as beat_analyse,
    grid50 as beat_grid50,
};
pub use bp_detect::{Kind as DetectKind, MODELS, ModelSpec};
pub use bp_hero::{
    BUCKET_NAMES as HERO_BUCKET_NAMES, BUCKETS as HERO_BUCKETS, Direction as HeroDirection,
    Hero as RawHero, Note as HeroNote, Options as HeroOptions, Rect as HeroRect,
};
pub use bp_model::{MODELS as AI_MODELS, ModelKind, ModelSpec as AiModelSpec, TOO_SLOW_MS};
pub use detect::{DetectSnapshot, DetectStatus, Found, Verdict};
pub use generate::{GenerateProgress, GenerateStatus, Generation};
pub use hero::{ColourRule, Flourish, HeroSnapshot};

pub use bp_axes::{Provider, SmartLimit};
pub use bp_devices::{RampConfig, RampProgress};
pub use bp_player::{External, RenderSnapshot};
pub use bp_script::{Bookmark, Chapter, Interpolation};
use bp_tracking::CutDetector;
pub use bp_tracking::{
    Component, Motion, Phase, Region, Sample, TrackOptions, Tracker as RawTracker,
};
pub use follow::{FollowKind, FollowState, FollowStatus};
pub use params::{DetectionSource, Hold, HoldState};

pub struct EngineOptions {
    pub hz: u32,
    pub spin_us: u32,
    pub player: PlayerOptions,
}

impl Default for EngineOptions {
    fn default() -> EngineOptions {
        EngineOptions {
            hz: 100,
            spin_us: 500,
            player: PlayerOptions::default(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ScriptInfo {
    pub axis: Axis,

    pub variant: Option<String>,

    pub selected: bool,
    pub source: PathBuf,
    pub container: Container,
    pub actions: usize,
    pub duration_ms: f64,
    pub average_speed: f64,
    pub max_speed: f64,

    pub heatmap: Vec<f64>,
    pub chapters: Vec<Chapter>,
    pub bookmarks: Vec<Bookmark>,
}

#[derive(Clone, Debug)]
pub struct MediaInfo {
    pub path: PathBuf,
    pub scripts: Vec<ScriptInfo>,
}



#[derive(Clone, Debug)]
pub struct PoolEntry {
    pub axis: Axis,
    pub variant: Option<String>,
    pub script: Arc<Script>,

    info: ScriptInfo,
}


#[derive(Clone, Debug)]
pub struct DeviceInput {
    pub output: u32,
    pub name: String,
}


pub const FLAG_SCRIPT: u8 = 1;

pub const FLAG_DERIVED: u8 = 2;

pub const FLAG_LIVE: u8 = 4;

pub const FLAG_TRACKED: u8 = 8;



#[derive(Clone, Debug)]
pub struct EngineState {
    pub time_ms: f64,
    pub duration_ms: f64,
    pub paused: bool,
    pub rate: f64,
    pub loaded: bool,

    pub following: bool,

    pub video_width: u32,
    pub video_height: u32,

    pub axis_values: Frame,


    pub axis_flags: [u8; Axis::COUNT],

    pub error: Option<String>,

    pub flags_version: u64,
    pub outputs: Vec<OutputSnapshot>,
}


#[derive(Clone, Debug)]
pub struct TickStats {
    pub hz: u32,
    pub realtime: bool,

    pub late: PercentilesUs,

    pub work: PercentilesUs,
}





#[derive(Clone, Debug, PartialEq, Default)]
pub enum ParamSource {

    #[default]
    Restim,

    Fixed(f64),

    Sweep(Provider),


    Audio,


    Detection(DetectionSource),
}


#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EstimOptions {

    pub contrast: f64,


    pub params: bool,
}

impl Default for EstimOptions {
    fn default() -> EstimOptions {
        EstimOptions {
            contrast: 0.0,
            params: false,
        }
    }
}

impl ParamSource {

    fn is_live(&self) -> bool {
        matches!(self, ParamSource::Audio | ParamSource::Detection(_))
    }
}





#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackSource {
    Video,
    Beat,
    Hero,
    AiMotion,
    AiMusic,
    Off,
}

impl TrackSource {

    fn on_frames(self) -> bool {
        matches!(self, TrackSource::Video | TrackSource::AiMotion)
    }


    fn generated(self) -> bool {
        matches!(
            self,
            TrackSource::Beat | TrackSource::Hero | TrackSource::AiMusic
        )
    }
}



#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackAxis {
    pub source: TrackSource,




    pub intensity: f64,

    pub min: f64,
    pub max: f64,

    pub smoothing_ms: f64,
    pub invert: bool,
}

impl TrackAxis {
    pub const OFF: TrackAxis = TrackAxis {
        source: TrackSource::Off,
        intensity: 1.0,
        min: 0.0,
        max: 1.0,
        smoothing_ms: bp_tracking::SMOOTHING_MS,
        invert: false,
    };

    fn video(intensity: f64, min: f64, max: f64, smoothing_ms: f64) -> TrackAxis {
        TrackAxis {
            source: TrackSource::Video,
            intensity,
            min,
            max,
            smoothing_ms,
            invert: false,
        }
    }


    pub fn map(&self, v: f64) -> f64 {
        let v = if self.invert { 1.0 - v } else { v };
        self.limit(v.clamp(0.0, 1.0))
    }


    pub fn energy(&self) -> f64 {
        self.intensity.max(bp_model::decoder::ENERGY_MIN)
    }



    pub fn limit(&self, v: f64) -> f64 {
        self.min + v.clamp(0.0, 1.0) * (self.max - self.min)
    }
}

pub type TrackAxes = [TrackAxis; Axis::COUNT];


pub fn track_component(axis: Axis) -> Option<Component> {
    Some(match axis {
        Axis::L0 => Component::Stroke,
        Axis::L2 => Component::Sway,
        Axis::L1 => Component::Surge,
        Axis::R1 => Component::Roll,
        Axis::R2 => Component::Pitch,
        Axis::R0 => Component::Twist,
        _ => return None,
    })
}



pub fn default_track_axes() -> TrackAxes {
    let mut axes = [TrackAxis::OFF; Axis::COUNT];
    axes[Axis::L0.index()] = TrackAxis::video(1.0, 0.0, 1.0, bp_tracking::SMOOTHING_MS);
    for (axis, intensity) in [
        (Axis::L2, 0.6),
        (Axis::L1, 0.4),
        (Axis::R1, 0.6),
        (Axis::R2, 0.4),
    ] {
        axes[axis.index()] =
            TrackAxis::video(intensity, 0.25, 0.75, bp_tracking::SMOOTHING_SIDE_MS);
    }
    axes
}



fn smoothing(axes: &TrackAxes) -> [f64; Component::COUNT] {
    let mut out = [bp_tracking::SMOOTHING_MS; Component::COUNT];
    for axis in Axis::ALL {
        if let Some(c) = track_component(axis) {
            let a = axes[axis.index()];
            out[c.index()] = a.smoothing_ms.max(0.0) / a.energy();
        }
    }
    out
}


fn energies(axes: &TrackAxes) -> [f64; Component::COUNT] {
    let mut out = [1.0; Component::COUNT];
    for axis in Axis::ALL {
        if let Some(c) = track_component(axis) {
            out[c.index()] = axes[axis.index()].energy();
        }
    }
    out
}


pub type DetectorModel = (&'static ModelSpec, PathBuf, Option<PathBuf>);



pub type AiModel = (&'static AiModelSpec, PathBuf, PathBuf, Option<PathBuf>);

#[derive(Clone, Debug, PartialEq)]
pub enum ModelStatus {
    None,
    Loading,
    Ready,
    Error(String),
}


#[derive(Clone, Debug)]
pub struct ModelSnapshot {
    pub kind: ModelKind,
    pub status: ModelStatus,
    pub id: Option<&'static str>,
    pub version: Option<String>,

    pub provider: Option<&'static str>,
    pub fallback: Option<String>,
    pub warmup_ms: f64,

    pub run_ms: f64,

    pub too_slow: bool,
}


struct ModelSlot {
    status: ModelStatus,
    spec: Option<&'static AiModelSpec>,
    loaded: Option<Arc<bp_model::Loaded>>,
    cache_dir: Option<PathBuf>,
    run_ms: f64,

    too_slow: bool,

    generation: u64,
}

impl ModelSlot {
    fn empty() -> ModelSlot {
        ModelSlot {
            status: ModelStatus::None,
            spec: None,
            loaded: None,
            cache_dir: None,
            run_ms: 0.0,
            too_slow: false,
            generation: 0,
        }
    }
}

fn slot_index(kind: ModelKind) -> usize {
    match kind {
        ModelKind::Motion => 0,
        _ => 1,
    }
}


#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RegionSource {


    Auto,
    Centre,
    Pick(Region),
}

#[derive(Clone, Copy, Debug)]
pub struct DetectOptions {

    pub interval_ms: f64,


    pub padding: f64,
}

impl Default for DetectOptions {
    fn default() -> DetectOptions {
        DetectOptions {
            interval_ms: 700.0,
            padding: 0.4,
        }
    }
}

struct RegionState {
    source: RegionSource,

    target: Option<DetectKind>,

    auto: AutoRegion,
}



const AUTO_HOLD_MS: f64 = 3000.0;



#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct AutoRegion {
    pub region: Option<Region>,
    pub target: Option<bp_detect::Target>,
    seen_ms: f64,
}

impl AutoRegion {

    pub fn floor(&self, now_ms: f64) -> Option<bp_detect::Target> {
        self.target.filter(|_| now_ms - self.seen_ms < AUTO_HOLD_MS)
    }
}



const MIN_AUTO_REGION: f64 = 0.3;

#[derive(Default)]
struct DetectClock {
    last_at: Option<Instant>,
    cuts_seen: u64,
}


#[derive(Clone, Debug)]
pub struct TrackState {
    pub active: bool,
    pub state: Phase,

    pub region: Option<Region>,
    pub auto: bool,
    pub detect: DetectSnapshot,

    pub model: ModelSnapshot,

    pub position: f64,

    pub motion: Motion,


    pub ahead_ms: Option<f64>,

    pub fps: f64,
    pub frames: u64,

    pub cuts: u64,
    pub jumps: u64,
    pub drops: u64,
}

#[derive(Default)]
struct TickSamples {
    late_us: VecDeque<u32>,
    work_us: VecDeque<u32>,
    realtime: bool,

    since_write: u32,
}

const SAMPLE_WINDOW: usize = 2000;

const RELAX_AFTER_TICKS: u32 = 50;

fn push_sample(q: &mut VecDeque<u32>, v: u32) {
    if q.len() == SAMPLE_WINDOW {
        q.pop_front();
    }
    q.push_back(v);
}



struct Published {
    values: Frame,
    flags: [u8; Axis::COUNT],
    version: u64,
}

struct Shared {
    clock: Mutex<Clock>,
    mixer: Mutex<Mixer>,
    outputs: Mutex<Vec<Output>>,

    scripts: Mutex<Vec<(Axis, Arc<Script>)>>,



    generated: Mutex<Vec<(Axis, Arc<Script>)>>,

    pool: Mutex<Vec<PoolEntry>>,

    prepared: Mutex<Option<(String, Vec<PoolEntry>)>>,

    variants: Mutex<Vec<(Axis, String)>>,
    published: Mutex<Published>,

    video_size: (AtomicU32, AtomicU32),

    param_sources: Mutex<[ParamSource; Axis::COUNT]>,

    live_params: AtomicBool,

    params_enabled: AtomicBool,

    detect_wanted: AtomicBool,


    boxes_wanted: AtomicBool,

    cuts_wanted: AtomicBool,

    scene_cuts: AtomicU64,


    cut_watch: Mutex<Option<(CutDetector, f64)>>,

    param_hold: Mutex<[HoldState; Axis::COUNT]>,

    timeline: Mutex<Timeline>,

    model_timeline: Mutex<Timeline>,

    models: Mutex<[ModelSlot; 2]>,

    motion_wanted: AtomicBool,

    pace: Mutex<f64>,

    box_run: Mutex<Option<bp_model::BoxRun>>,

    hwdec: Mutex<Option<String>>,

    track_options: Mutex<TrackOptions>,


    lookahead: Mutex<Option<Lookahead>>,

    media_path: Mutex<Option<String>>,

    load_error: Mutex<Option<String>>,

    detector_model: Mutex<Option<DetectorModel>>,

    track_axes: Mutex<TrackAxes>,

    track: Mutex<Option<Track>>,
    detect: Mutex<Option<Detect>>,
    detect_options: Mutex<DetectOptions>,
    detect_clock: Mutex<DetectClock>,
    region: Mutex<RegionState>,
    beat: Arc<Mutex<Beat>>,
    hero: Mutex<HeroState>,

    generate: Arc<generate::State>,

    intiface: Mutex<Option<IntifaceServer>>,

    remote_driving: AtomicBool,
    tick: Mutex<TickSamples>,
    loaded: AtomicBool,
    following: AtomicBool,
    stop: AtomicBool,
}

pub struct Engine {
    pub player: Player,
    shared: Arc<Shared>,
    tick: Option<JoinHandle<()>>,
    follow: Mutex<Option<Follow>>,
    hz: u32,
    next_output: u32,
}

const HEATMAP_BUCKETS: usize = 240;

const CUT_WATCH_GAP_MS: f64 = 1000.0;

impl Engine {
    pub fn new(width: u32, height: u32, opts: EngineOptions) -> Result<Engine, String> {
        let shared = Arc::new(Shared {
            clock: Mutex::new(Clock::new()),
            mixer: Mutex::new(Mixer::new()),
            outputs: Mutex::new(Vec::new()),
            scripts: Mutex::new(Vec::new()),
            generated: Mutex::new(Vec::new()),
            pool: Mutex::new(Vec::new()),
            prepared: Mutex::new(None),
            variants: Mutex::new(Vec::new()),
            published: Mutex::new(Published {
                values: std::array::from_fn(|i| Axis::ALL[i].default_value()),
                flags: [0; Axis::COUNT],
                version: 0,
            }),
            video_size: (AtomicU32::new(0), AtomicU32::new(0)),
            param_sources: Mutex::new(std::array::from_fn(|_| ParamSource::Restim)),
            live_params: AtomicBool::new(false),
            params_enabled: AtomicBool::new(EstimOptions::default().params),
            detect_wanted: AtomicBool::new(false),
            boxes_wanted: AtomicBool::new(false),
            cuts_wanted: AtomicBool::new(false),
            scene_cuts: AtomicU64::new(0),
            cut_watch: Mutex::new(None),
            param_hold: Mutex::new([HoldState::default(); Axis::COUNT]),
            timeline: Mutex::new(Timeline::new()),
            model_timeline: Mutex::new(Timeline::new()),
            models: Mutex::new([ModelSlot::empty(), ModelSlot::empty()]),
            motion_wanted: AtomicBool::new(false),
            pace: Mutex::new(0.5),
            box_run: Mutex::new(None),
            hwdec: Mutex::new(None),
            track_options: Mutex::new(TrackOptions::default()),
            lookahead: Mutex::new(None),
            media_path: Mutex::new(None),
            load_error: Mutex::new(None),
            detector_model: Mutex::new(None),
            track_axes: Mutex::new(default_track_axes()),
            track: Mutex::new(None),
            detect: Mutex::new(None),
            detect_options: Mutex::new(DetectOptions::default()),
            detect_clock: Mutex::new(DetectClock::default()),
            region: Mutex::new(RegionState {
                source: RegionSource::Centre,
                target: None,
                auto: AutoRegion::default(),
            }),
            beat: Arc::new(Mutex::new(Beat::new())),
            hero: Mutex::new(HeroState::new()),
            generate: Arc::new(generate::State::new()),
            intiface: Mutex::new(None),
            remote_driving: AtomicBool::new(false),
            tick: Mutex::new(TickSamples::default()),
            loaded: AtomicBool::new(false),
            following: AtomicBool::new(false),
            stop: AtomicBool::new(false),
        });

        let sink: bp_player::EventSink = {
            let shared = shared.clone();
            Arc::new(move |e: PlayerEvent| shared.on_player_event(e))
        };
        let player = Player::new(width, height, opts.player, Some(sink))?;

        let tick = {
            let shared = shared.clone();
            let (hz, spin) = (opts.hz, opts.spin_us);
            thread::Builder::new()
                .name("bp-tick".into())
                .spawn(move || {
                    deadline::run(hz, spin, &shared.stop, |t| shared.tick(t));
                })
                .map_err(|e| e.to_string())?
        };

        Ok(Engine {
            player,
            shared,
            tick: Some(tick),
            follow: Mutex::new(None),
            hz: opts.hz,
            next_output: 1,
        })
    }




    pub fn load(
        &self,
        path: &str,
        start_seconds: Option<f64>,
        variants: &[(Axis, String)],
    ) -> Result<MediaInfo, String> {
        let loader = self.loader();
        let pool = loader.pool_for(path, None);
        loader.load(path, start_seconds, pool, variants, None)
    }



    pub fn load_media(&self, path: &str, start_seconds: Option<f64>) -> Result<(), String> {
        self.loader().load_media(path, start_seconds, None)
    }



    fn start_lookahead(&self) {
        self.shared.restart_lookahead(self.player.hwdec_current());
    }




    pub fn load_scripts(&self, path: &str, variants: &[(Axis, String)]) -> MediaInfo {
        let path = Path::new(path);
        self.loader().apply(path, scan_pool(path), variants)
    }



    pub fn loader(&self) -> ScriptLoader {
        ScriptLoader {
            shared: self.shared.clone(),
            media: self.player.media_loader(),
        }
    }


    pub fn select_variant(&self, axis: Axis, variant: Option<String>) -> Vec<ScriptInfo> {
        {
            let mut v = self.shared.variants.lock().unwrap();
            v.retain(|(a, _)| *a != axis);
            if let Some(name) = variant {
                v.push((axis, name));
            }
        }
        self.shared.apply_selection()
    }


    pub fn unload(&self) -> Result<(), String> {
        self.player.stop()?;
        self.shared.loaded.store(false, Ordering::Relaxed);
        *self.shared.media_path.lock().unwrap() = None;
        *self.shared.lookahead.lock().unwrap() = None;
        self.shared.pool.lock().unwrap().clear();
        self.shared.generated.lock().unwrap().clear();
        self.shared.set_scripts(Vec::new());
        let mut clock = self.shared.clock.lock().unwrap();
        clock.report(0.0);
        clock.duration_ms = 0.0;
        clock.snap();
        Ok(())
    }




    pub fn follow(&self, kind: FollowKind, host: &str, port: Option<u16>) -> Result<(), String> {
        let mut slot = self.follow.lock().unwrap();
        if let Some(mut old) = slot.take() {
            old.stop();
        }
        self.player.pause()?;
        self.shared.following.store(true, Ordering::Relaxed);
        {

            let mut clock = self.shared.clock.lock().unwrap();
            clock.set_paused(true);
            clock.set_idle(true);
        }
        self.shared.mixer.lock().unwrap().resync();
        let sink: FollowSink = {
            let shared = self.shared.clone();
            Arc::new(move |e: FollowEvent| shared.on_follow_event(e))
        };
        *slot = Some(Follow::start(
            kind,
            host,
            port.unwrap_or(kind.default_port()),
            sink,
        ));
        Ok(())
    }


    pub fn unfollow(&self) {
        if let Some(mut f) = self.follow.lock().unwrap().take() {
            f.stop();
        }
        if !self.shared.following.swap(false, Ordering::Relaxed) {
            return;
        }
        let (time_ms, duration_ms, paused) = (
            self.player.time_pos() * 1000.0,
            self.player.duration() * 1000.0,
            self.player.paused(),
        );
        {
            let mut clock = self.shared.clock.lock().unwrap();
            clock.report(time_ms);
            clock.duration_ms = duration_ms;
            clock.set_paused(paused);
            clock.set_idle(paused);
            clock.snap();
        }
        self.shared.mixer.lock().unwrap().resync();
    }

    pub fn follow_state(&self) -> Option<FollowState> {
        self.follow.lock().unwrap().as_ref().map(Follow::state)
    }

    pub fn play(&self) -> Result<(), String> {
        self.player.play()
    }

    pub fn pause(&self) -> Result<(), String> {
        self.player.pause()
    }

    pub fn seek(&self, seconds: f64) -> Result<(), String> {
        self.player.seek(seconds.max(0.0))
    }

    pub fn set_rate(&self, rate: f64) -> Result<(), String> {
        self.player.set_rate(rate)
    }

    pub fn global_offset_ms(&self) -> f64 {
        self.shared.mixer.lock().unwrap().global_offset_ms
    }

    pub fn set_global_offset_ms(&self, ms: f64) {
        let mut m = self.shared.mixer.lock().unwrap();
        m.global_offset_ms = ms;
        m.resync();
    }

    pub fn axis_settings(&self, axis: Axis) -> AxisSettings {
        self.shared.mixer.lock().unwrap().settings(axis).clone()
    }

    pub fn set_axis(&self, axis: Axis, settings: AxisSettings) {
        self.shared
            .mixer
            .lock()
            .unwrap()
            .set_settings(axis, settings);
    }


    pub fn set_live(&self, axis: Axis, value: Option<f64>) {
        self.shared.mixer.lock().unwrap().set_live(axis, value);
    }






    pub fn track_start(&self, options: TrackOptions, axes: TrackAxes, lookahead: bool) {
        self.track_stop();
        self.note_hwdec();
        *self.shared.track_axes.lock().unwrap() = axes;
        self.shared.update_motion_wanted(&axes);
        let options = TrackOptions {
            smoothing_ms: smoothing(&axes),
            ..options
        };
        *self.shared.track_options.lock().unwrap() = options;
        {
            let mut tl = self.shared.timeline.lock().unwrap();
            tl.clear();
            tl.active = true;
            self.shared.model_timeline.lock().unwrap().clear();
        }
        if lookahead {
            self.start_lookahead();
        }
        let shared = self.shared.clone();
        let for_frames = self.shared.clone();
        let for_model = self.shared.clone();
        let mut feed: Option<MotionFeed> = None;
        *self.shared.track.lock().unwrap() = Some(Track::start(
            options,
            move |s| {
                shared
                    .timeline
                    .lock()
                    .unwrap()
                    .push_sample(Instant::now(), s.motion);
            },
            move |rgb, w, h, time_ms, cuts| {
                for_frames.offer_to_detector(rgb, w, h, cuts);
                for_frames.hero_frame(rgb, w, h, time_ms);
            },


            move |tracker, sample, gray, w, h, time_ms| {
                let shared = &for_model;
                let Some(loaded) = shared.motion_loaded().filter(|_| shared.motion_wanted()) else {
                    feed = None;
                    return;
                };
                if feed.as_ref().is_none_or(|f| !f.same(&loaded)) {
                    feed = Some(MotionFeed::new(loaded, tracker.options(), Cadence::LIVE));
                }
                let f = feed.as_mut().unwrap();
                f.set_options(tracker.options());
                let pace = shared.pace();
                let energy = energies(&shared.track_axes.lock().unwrap());
                let detection = *shared.box_run.lock().unwrap();
                match f.push(
                    gray,
                    w,
                    h,
                    time_ms,
                    tracker,
                    sample,
                    detection.as_ref(),
                    wall_ms(),
                    pace,
                ) {
                    Ok(heads) if !heads.is_empty() => {
                        let now = Instant::now();
                        let n = heads.len();
                        let interval =
                            Duration::from_secs_f64((f.interval_ms() / 1000.0).clamp(0.001, 0.2));
                        let mut tl = shared.model_timeline.lock().unwrap();
                        for (k, h) in heads.iter().enumerate() {
                            let at = now
                                .checked_sub(interval * (n - 1 - k) as u32)
                                .unwrap_or(now);
                            let motion = f.live(h, pace, &energy);
                            tl.push_sample(at, motion);
                        }
                        drop(tl);
                        shared.note_model_run(f.run_ms);
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("bp-core: motion: {e}"),
                }
            },
        ));
        self.shared.mixer.lock().unwrap().resync();

        self.apply_region_source();
        self.shared.apply_selection();
        self.shared.ensure_music();
    }


    fn note_hwdec(&self) {
        *self.shared.hwdec.lock().unwrap() =
            Some(self.player.hwdec_current()).filter(|h| !h.is_empty());
    }




    pub fn set_model(&self, kind: ModelKind, model: Option<AiModel>) {
        if kind == ModelKind::Detector {
            return;
        }
        self.note_hwdec();
        let generation = {
            let mut slots = self.shared.models.lock().unwrap();
            let slot = &mut slots[slot_index(kind)];
            slot.generation += 1;
            slot.loaded = None;
            slot.run_ms = 0.0;
            slot.spec = model.as_ref().map(|m| m.0);
            slot.cache_dir = model.as_ref().and_then(|m| m.3.clone());
            slot.status = if model.is_some() {
                ModelStatus::Loading
            } else {
                ModelStatus::None
            };
            slot.generation
        };
        let Some((_, weights, metadata, cache_dir)) = model else {
            self.shared.after_model(kind);
            return;
        };
        let shared = self.shared.clone();
        std::thread::Builder::new()
            .name("bp-model-load".into())
            .spawn(move || {
                let coreml = cache_dir.as_ref().map(|d| d.join("coreml-cache"));
                let result = bp_model::Loaded::load(&weights, &metadata, coreml.as_deref());
                {
                    let mut slots = shared.models.lock().unwrap();
                    let slot = &mut slots[slot_index(kind)];
                    if slot.generation != generation {
                        return;
                    }
                    match result {
                        Ok(loaded) => {
                            slot.too_slow = kind == ModelKind::Motion
                                && loaded.session.lock().unwrap().too_slow();
                            slot.loaded = Some(Arc::new(loaded));
                            slot.status = ModelStatus::Ready;
                        }
                        Err(e) => slot.status = ModelStatus::Error(e),
                    }
                }
                shared.after_model(kind);
            })
            .ok();
    }

    pub fn model_state(&self, kind: ModelKind) -> ModelSnapshot {
        self.shared.model_snapshot(kind)
    }



    pub fn set_pace(&self, pace: f64) {
        *self.shared.pace.lock().unwrap() = pace.clamp(0.0, 1.0);
        self.note_hwdec();
        self.shared.ensure_music();
    }

    pub fn pace(&self) -> f64 {
        self.shared.pace()
    }



    pub fn beat_load(&self, path: PathBuf) {
        self.note_hwdec();
        let shared = self.shared.clone();
        Beat::load(&self.shared.beat, path, move || {
            shared.apply_selection();
            shared.ensure_music();
        });
    }

    pub fn beat_clear(&self) {
        self.shared.beat.lock().unwrap().clear();
        self.shared.apply_selection();
    }

    pub fn set_beat_options(&self, options: BeatOptions) {
        self.shared.beat.lock().unwrap().options = options;
        self.shared.apply_selection();
    }

    pub fn beat_state(&self) -> BeatSnapshot {
        self.shared.beat.lock().unwrap().snapshot()
    }


    pub fn set_hero_options(&self, zone: Option<HeroRect>, direction: HeroDirection) {
        self.shared
            .hero
            .lock()
            .unwrap()
            .set_options(zone, direction);
        self.shared.apply_selection();
    }



    pub fn set_hero_colour(&self, axis: Option<Axis>, bucket: usize, rule: ColourRule) {
        if bucket < HERO_BUCKETS {
            self.shared
                .hero
                .lock()
                .unwrap()
                .set_colour(axis, bucket, rule);
            self.shared.apply_selection();
        }
    }


    pub fn clear_hero_axis_colours(&self, axis: Axis) {
        self.shared.hero.lock().unwrap().clear_axis_colours(axis);
        self.shared.apply_selection();
    }

    pub fn hero_state(&self) -> HeroSnapshot {
        self.shared.hero.lock().unwrap().snapshot()
    }



    pub fn set_detector(&self, model: Option<DetectorModel>) {
        *self.shared.detector_model.lock().unwrap() = model.clone();
        let mut detect = self.shared.detect.lock().unwrap();
        if detect.is_none() {
            let shared = self.shared.clone();
            *detect = Some(Detect::start(move |v| shared.on_detected(v)));
        }
        detect.as_ref().unwrap().load(model);
        *self.shared.detect_clock.lock().unwrap() = DetectClock::default();
    }

    pub fn detect_state(&self) -> DetectSnapshot {
        match self.shared.detect.lock().unwrap().as_ref() {
            Some(d) => d.snapshot(),
            None => DetectSnapshot::empty(),
        }
    }



    pub fn wants_frames(&self) -> bool {
        self.shared.detect_wanted.load(Ordering::Relaxed) || self.shared.boxes_wanted.load(Ordering::Relaxed)
    }



    pub fn set_boxes_wanted(&self, wanted: bool) {
        self.shared.boxes_wanted.store(wanted, Ordering::Relaxed);
    }



    pub fn detect_boxes(&self, kinds: &[DetectKind]) -> (u64, Vec<Found>) {
        match self.shared.detect.lock().unwrap().as_ref() {
            Some(d) => {
                let s = d.snapshot();
                (s.runs, s.boxes_of(kinds))
            }
            None => (0, Vec::new()),
        }
    }



    pub fn wants_cuts(&self) -> bool {
        self.shared.cuts_wanted.load(Ordering::Relaxed)
    }



    pub fn param_hold(&self, axis: Axis) -> Option<(f64, f64)> {
        self.shared.param_hold.lock().unwrap()[axis.index()].held
    }

    pub fn set_detect_options(&self, options: DetectOptions) {
        *self.shared.detect_options.lock().unwrap() = options;
    }


    pub fn set_track_region_source(&self, source: RegionSource) {
        self.shared.region.lock().unwrap().source = source;
        self.apply_region_source();
    }

    pub fn track_region_source(&self) -> RegionSource {
        self.shared.region.lock().unwrap().source
    }


    pub fn set_detect_target(&self, target: Option<DetectKind>) {
        {
            let mut r = self.shared.region.lock().unwrap();
            if r.target == target {
                return;
            }
            r.target = target;
            r.auto = AutoRegion::default();
        }
        *self.shared.detect_clock.lock().unwrap() = DetectClock::default();
        self.apply_region_source();
    }

    fn apply_region_source(&self) {
        let region = {
            let r = self.shared.region.lock().unwrap();
            match r.source {
                RegionSource::Auto => r.auto.region,
                RegionSource::Centre => None,
                RegionSource::Pick(p) => Some(p),
            }
        };
        if let Some(t) = self.shared.track.lock().unwrap().as_ref() {
            t.tracker.lock().unwrap().set_region(region);
        }
    }


    pub fn track_stop(&self) {
        if let Some(t) = self
            .shared
            .track
            .lock()
            .unwrap()
            .as_mut()
            .filter(|t| t.active)
        {
            t.stop();
        }
        *self.shared.lookahead.lock().unwrap() = None;
        self.shared.model_timeline.lock().unwrap().clear();
        let mut tl = self.shared.timeline.lock().unwrap();
        if !tl.active {
            return;
        }
        tl.active = false;
        tl.clear();
        drop(tl);
        let mut mixer = self.shared.mixer.lock().unwrap();
        for axis in Axis::ALL
            .into_iter()
            .filter(|a| track_component(*a).is_some())
        {
            mixer.set_external(axis, None);
        }
        drop(mixer);

        self.shared.apply_selection();
    }




    pub fn set_track_axes(&self, axes: TrackAxes) {
        let changed = {
            let mut current = self.shared.track_axes.lock().unwrap();
            let generated = |s: TrackSource| s.generated();
            let beat_changed = Axis::ALL.iter().any(|a| {
                generated(current[a.index()].source) != generated(axes[a.index()].source)
                    || (generated(axes[a.index()].source) && current[a.index()] != axes[a.index()])
            });
            *current = axes;
            beat_changed
        };
        self.shared.update_motion_wanted(&axes);
        let options = {
            let mut o = self.shared.track_options.lock().unwrap();
            o.smoothing_ms = smoothing(&axes);
            *o
        };
        if let Some(t) = self.shared.track.lock().unwrap().as_ref() {
            t.tracker.lock().unwrap().set_options(options);
        }
        if changed {
            self.shared.apply_selection();
        }
        self.note_hwdec();
        self.shared.ensure_music();
    }

    pub fn track_axes(&self) -> TrackAxes {
        *self.shared.track_axes.lock().unwrap()
    }





    pub fn track_frame(&self, bytes: &[u8], channels: u32, width: u32, height: u32, time_ms: f64) {
        if let Some(t) = self
            .shared
            .track
            .lock()
            .unwrap()
            .as_ref()
            .filter(|t| t.active)
        {
            t.mailbox.put(
                bytes,
                channels as usize,
                width as usize,
                height as usize,
                time_ms,
            );
            return;
        }
        if channels == 3 && self.wants_frames() {
            let cuts = self.shared.detect_clock.lock().unwrap().cuts_seen;
            self.shared
                .offer_to_detector(bytes, width as usize, height as usize, cuts);
            self.shared
                .watch_cuts(bytes, width as usize, height as usize, time_ms);
        }
    }



    pub fn set_track_region(&self, region: Option<Region>) {
        self.set_track_region_source(match region {
            Some(r) => RegionSource::Pick(r),
            None => RegionSource::Centre,
        });
    }



    pub fn set_track_options(&self, options: TrackOptions) {
        let smoothing_ms = smoothing(&self.shared.track_axes.lock().unwrap());
        let options = TrackOptions {
            smoothing_ms,
            ..options
        };
        *self.shared.track_options.lock().unwrap() = options;
        if let Some(t) = self.shared.track.lock().unwrap().as_ref() {
            t.tracker.lock().unwrap().set_options(options);
        }
    }

    pub fn track_state(&self) -> TrackState {

        let (active, fps) = {
            let tl = self.shared.timeline.lock().unwrap();
            (tl.active, tl.fps())
        };
        let ahead_ms = {
            let pos = self.shared.clock.lock().unwrap().peek();
            self.shared
                .lookahead
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|l| l.ahead_of(pos))
        };
        let auto = self.shared.region.lock().unwrap().source == RegionSource::Auto;
        let detect = self.detect_state();
        let model = self.shared.model_snapshot(ModelKind::Motion);
        let track = self.shared.track.lock().unwrap();
        let Some(t) = track.as_ref() else {
            return TrackState {
                active: false,
                state: Phase::Idle,
                region: None,
                auto,
                detect,
                model,
                position: 0.5,
                motion: [0.5; Component::COUNT],
                ahead_ms,
                fps: 0.0,
                frames: 0,
                cuts: 0,
                jumps: 0,
                drops: 0,
            };
        };
        let tracker = t.tracker.lock().unwrap();
        TrackState {
            active,
            state: tracker.phase(),
            region: tracker.region(),
            auto,
            detect,
            model,
            position: tracker.position(),
            motion: tracker.motion(),
            ahead_ms,
            fps,
            frames: tracker.frames(),
            cuts: tracker.cuts(),
            jumps: tracker.jumps(),
            drops: tracker.drops(),
        }
    }






    pub fn generate(&self) -> Result<Generation, String> {
        let path = self
            .shared
            .media_path
            .lock()
            .unwrap()
            .clone()
            .filter(|p| is_local(p))
            .ok_or("only a local file can be run through")?;
        if self.shared.generate.busy() {
            return Err("a run is already on".into());
        }
        let axes = self.shared.track_axes.lock().unwrap();
        if !Axis::ALL.iter().any(|a| {
            axes[a.index()].source != TrackSource::Off
                && (!axes[a.index()].source.on_frames() || track_component(*a).is_some())
        }) {
            return Err("no axis is on the tracking table".into());
        }
        drop(axes);
        self.note_hwdec();
        let hwdec = Some(self.player.hwdec_current()).filter(|h| !h.is_empty());
        Ok(Generation::new(
            self.shared.clone(),
            self.shared.generate.clone(),
            path,
            hwdec,
        ))
    }

    pub fn generate_progress(&self) -> GenerateProgress {
        self.shared.generate.progress.lock().unwrap().clone()
    }


    pub fn generate_cancel(&self) {
        self.shared.generate.cancel.store(true, Ordering::Relaxed);
    }





    pub fn set_generated(&self, scripts: Vec<(Axis, Script)>) {
        *self.shared.generated.lock().unwrap() = scripts
            .into_iter()
            .map(|(axis, script)| (axis, Arc::new(script)))
            .collect();
        let media = self.shared.hosted_media();
        let hosted = self.shared.hosted_scripts();
        for o in self.shared.outputs.lock().unwrap().iter_mut() {
            o.set_scripts(&hosted, &media);
        }
    }



    pub fn track_trace(&self) -> Vec<Sample> {
        match self.shared.track.lock().unwrap().as_ref() {
            Some(t) => t.tracker.lock().unwrap().trace().to_vec(),
            None => Vec::new(),
        }
    }



    pub fn track_samples(&self, since_ms: f64) -> Vec<Sample> {
        let l0 = self.shared.track_axes.lock().unwrap()[Axis::L0.index()];
        match self.shared.track.lock().unwrap().as_ref() {
            Some(t) => t
                .tracker
                .lock()
                .unwrap()
                .samples_since(since_ms)
                .iter()
                .map(|s| Sample {
                    pos: l0.map(s.pos),
                    ..*s
                })
                .collect(),
            None => Vec::new(),
        }
    }

    pub fn connect(&mut self, transport: Transport, profile: Profile) -> u32 {
        let id = self.next_output;
        self.next_output += 1;
        let mut output = Output::new(id, transport, profile);
        let media = self.shared.hosted_media();
        output.set_scripts(&self.shared.hosted_scripts(), &media);
        self.shared.outputs.lock().unwrap().push(output);
        self.shared.update_expand();
        self.shared.mixer.lock().unwrap().resync();
        id
    }

    pub fn disconnect(&self, id: u32) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        let Some(i) = outputs.iter().position(|o| o.id == id) else {
            return false;
        };
        outputs.remove(i).disconnect();
        drop(outputs);
        self.shared.update_expand();
        true
    }

    pub fn set_output_profile(&self, id: u32, profile: Profile) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        let Some(o) = outputs.iter_mut().find(|o| o.id == id) else {
            return false;
        };
        o.set_profile(profile);
        drop(outputs);
        self.shared.update_expand();
        true
    }


    pub fn take_inputs(&self) -> Vec<DeviceInput> {
        let mut out = Vec::new();
        for o in self.shared.outputs.lock().unwrap().iter_mut() {
            out.extend(
                o.take_inputs()
                    .into_iter()
                    .map(|name| DeviceInput { output: o.id, name }),
            );
        }
        out
    }

    pub fn set_output_clamp(&self, id: u32, axis: Axis, clamp: AxisClamp) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        match outputs.iter_mut().find(|o| o.id == id) {
            Some(o) => {
                o.clamps[axis.index()] = clamp;
                true
            }
            None => false,
        }
    }


    pub fn set_output_feature_axis(&self, id: u32, feature: u32, axis: Option<Axis>) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs
            .iter_mut()
            .find(|o| o.id == id)
            .is_some_and(|o| o.set_feature_axis(feature, axis))
    }


    pub fn set_coyote_strength(&self, id: u32, a: u8, b: u8) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs
            .iter_mut()
            .find(|o| o.id == id)
            .is_some_and(|o| o.set_strength(a, b))
    }

    pub fn output_clamps(&self, id: u32) -> Option<[AxisClamp; Axis::COUNT]> {
        self.shared
            .outputs
            .lock()
            .unwrap()
            .iter()
            .find(|o| o.id == id)
            .map(|o| o.clamps)
    }


    pub fn set_output_ramp(&self, id: u32, config: RampConfig) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs
            .iter_mut()
            .find(|o| o.id == id)
            .map(|o| o.ramp.set_config(config))
            .is_some()
    }

    pub fn restart_output_ramp(&self, id: u32) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs
            .iter_mut()
            .find(|o| o.id == id)
            .map(|o| o.ramp.restart())
            .is_some()
    }



    pub fn test_output(&self, id: u32) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs
            .iter_mut()
            .find(|o| o.id == id)
            .is_some_and(Output::test)
    }

    pub fn output_ramp(&self, id: u32) -> Option<RampConfig> {
        self.shared
            .outputs
            .lock()
            .unwrap()
            .iter()
            .find(|o| o.id == id)
            .map(|o| o.ramp.config())
    }




    pub fn start_intiface(&self, port: u16) -> Result<(), String> {
        let mut slot = self.shared.intiface.lock().unwrap();
        if slot.as_ref().is_some_and(|s| s.port() == port) {
            return Ok(());
        }
        *slot = None;
        *slot = Some(IntifaceServer::start(port)?);
        Ok(())
    }

    pub fn stop_intiface(&self) {
        *self.shared.intiface.lock().unwrap() = None;
    }


    pub fn intiface_status(&self) -> Option<IntifaceStatus> {
        self.shared
            .intiface
            .lock()
            .unwrap()
            .as_ref()
            .map(IntifaceServer::status)
    }


    pub fn set_param_source(&self, axis: Axis, source: ParamSource) -> bool {
        if axis.kind() != Kind::EstimParam {
            return false;
        }
        self.shared.param_sources.lock().unwrap()[axis.index()] = source;
        self.shared.param_hold.lock().unwrap()[axis.index()] = HoldState::default();
        self.shared.apply_param_sources();
        true
    }

    pub fn param_source(&self, axis: Axis) -> ParamSource {
        self.shared.param_sources.lock().unwrap()[axis.index()].clone()
    }


    pub fn set_estim(&self, options: EstimOptions) {
        self.shared
            .mixer
            .lock()
            .unwrap()
            .set_electrode_contrast(options.contrast);
        self.shared
            .params_enabled
            .store(options.params, Ordering::Relaxed);
        self.shared.apply_param_sources();
    }

    pub fn estim(&self) -> EstimOptions {
        EstimOptions {
            contrast: self.shared.mixer.lock().unwrap().electrode_contrast(),
            params: self.shared.params_enabled.load(Ordering::Relaxed),
        }
    }



    pub fn state(&self) -> EngineState {
        let (time_ms, duration_ms, paused, rate) = {
            let clock = self.shared.clock.lock().unwrap();
            (
                clock.peek(),
                clock.duration_ms,
                clock.paused(),
                clock.speed(),
            )
        };
        let (axis_values, axis_flags, flags_version) = {
            let p = self.shared.published.lock().unwrap();
            (p.values, p.flags, p.version)
        };
        let outputs = self
            .shared
            .outputs
            .lock()
            .unwrap()
            .iter()
            .map(Output::snapshot)
            .collect();
        let (video_width, video_height) = self.video_size();
        EngineState {
            time_ms,
            duration_ms,
            paused,
            rate,
            loaded: self.shared.loaded.load(Ordering::Relaxed),
            following: self.shared.following.load(Ordering::Relaxed),
            video_width,
            video_height,
            axis_values,
            axis_flags,
            flags_version,
            outputs,
            error: self.shared.load_error.lock().unwrap().clone(),
        }
    }


    pub fn video_size(&self) -> (u32, u32) {
        (
            self.shared.video_size.0.load(Ordering::Relaxed),
            self.shared.video_size.1.load(Ordering::Relaxed),
        )
    }



    pub fn set_presenting(&self, on: bool) -> Result<(), String> {
        self.player.set_presenting(on)
    }

    pub fn tick_stats(&self) -> TickStats {
        let t = self.shared.tick.lock().unwrap();
        TickStats {
            hz: self.hz,
            realtime: t.realtime,
            late: percentiles(&t.late_us),
            work: percentiles(&t.work_us),
        }
    }


    pub fn output_stats(&self, id: u32) -> Option<OutputStats> {
        self.shared
            .outputs
            .lock()
            .unwrap()
            .iter()
            .find(|o| o.id == id)
            .map(Output::stats)
    }

    pub fn close(&mut self) {
        if let Some(mut f) = self.follow.lock().unwrap().take() {
            f.stop();
        }
        if let Some(mut t) = self.shared.track.lock().unwrap().take() {
            t.stop();
        }
        self.shared.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.tick.take() {
            let _ = t.join();
        }
        for o in self.shared.outputs.lock().unwrap().drain(..) {
            o.disconnect();
        }
        self.player.close();
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.close();
    }
}




#[derive(Clone)]
pub struct ScriptLoader {
    shared: Arc<Shared>,
    media: bp_player::MediaLoader,
}

impl ScriptLoader {




    pub fn prepare(&self, path: &str, scripts_path: Option<&str>) {
        let pool = scan_pool(Path::new(scripts_path.unwrap_or(path)));
        *self.shared.prepared.lock().unwrap() = Some((path.to_string(), pool));
    }



    pub fn pool_for(&self, path: &str, scripts_path: Option<&str>) -> Vec<PoolEntry> {
        let mut prepared = self.shared.prepared.lock().unwrap();
        match prepared.take() {
            Some((p, pool)) if p == path => pool,
            other => {
                *prepared = other;
                drop(prepared);
                scan_pool(Path::new(scripts_path.unwrap_or(path)))
            }
        }
    }





    pub fn load(
        &self,
        path: &str,
        start_seconds: Option<f64>,
        pool: Vec<PoolEntry>,
        variants: &[(Axis, String)],
        remote: Option<&str>,
    ) -> Result<MediaInfo, String> {
        self.load_media(path, start_seconds, remote)?;
        Ok(self.apply(Path::new(path), pool, variants))
    }


    pub fn load_media(&self, path: &str, start_seconds: Option<f64>, remote: Option<&str>) -> Result<(), String> {
        *self.shared.load_error.lock().unwrap() = None;
        self.media.load(path, start_seconds, remote)?;
        *self.shared.media_path.lock().unwrap() = Some(path.to_string());
        if self.shared.lookahead.lock().unwrap().is_some() {
            self.shared.restart_lookahead(self.media.hwdec_current());
        }
        self.shared
            .preset_clock(start_seconds.unwrap_or(0.0) * 1000.0);
        Ok(())
    }


    pub fn apply(
        &self,
        path: &Path,
        pool: Vec<PoolEntry>,
        variants: &[(Axis, String)],
    ) -> MediaInfo {
        *self.shared.pool.lock().unwrap() = pool;
        *self.shared.variants.lock().unwrap() = variants.to_vec();
        self.shared.generated.lock().unwrap().clear();
        *self.shared.param_hold.lock().unwrap() = [HoldState::default(); Axis::COUNT];
        *self.shared.cut_watch.lock().unwrap() = None;
        self.shared.loaded.store(true, Ordering::Relaxed);
        MediaInfo {
            path: path.to_path_buf(),
            scripts: self.shared.apply_selection(),
        }
    }
}

impl Shared {
    fn pace(&self) -> f64 {
        *self.pace.lock().unwrap()
    }

    fn motion_wanted(&self) -> bool {
        self.motion_wanted.load(Ordering::Relaxed)
    }

    fn update_motion_wanted(&self, axes: &TrackAxes) {
        let wanted = Axis::ALL.iter().any(|a| {
            axes[a.index()].source == TrackSource::AiMotion && track_component(*a).is_some()
        });
        self.motion_wanted.store(wanted, Ordering::Relaxed);
    }


    fn motion_loaded(&self) -> Option<Arc<bp_model::Loaded>> {
        let slots = self.models.lock().unwrap();
        let slot = &slots[slot_index(ModelKind::Motion)];
        if slot.too_slow {
            return None;
        }
        slot.loaded.clone()
    }

    fn music_loaded(&self) -> Option<(Arc<bp_model::Loaded>, Option<PathBuf>)> {
        let slots = self.models.lock().unwrap();
        let slot = &slots[slot_index(ModelKind::Music)];
        slot.loaded.clone().map(|l| (l, slot.cache_dir.clone()))
    }

    fn note_model_run(&self, run_ms: f64) {
        self.models.lock().unwrap()[slot_index(ModelKind::Motion)].run_ms = run_ms;
    }

    fn model_snapshot(&self, kind: ModelKind) -> ModelSnapshot {
        let slots = self.models.lock().unwrap();
        let slot = &slots[slot_index(kind)];
        let session = slot.loaded.as_ref().map(|l| l.session.lock().unwrap());
        ModelSnapshot {
            kind,
            status: slot.status.clone(),
            id: slot.spec.map(|s| s.id),
            version: slot.loaded.as_ref().map(|l| l.meta.version.clone()),
            provider: session.as_ref().map(|s| s.provider),
            fallback: session.as_ref().and_then(|s| s.fallback.clone()),
            warmup_ms: session.as_ref().map_or(0.0, |s| s.warmup_ms),
            run_ms: slot.run_ms,
            too_slow: slot.too_slow,
        }
    }



    fn after_model(self: &Arc<Self>, kind: ModelKind) {
        if kind == ModelKind::Music {
            if self.music_loaded().is_none() {
                self.beat.lock().unwrap().clear_music();
            }
            self.apply_selection();
            self.ensure_music();
        }
    }



    fn ensure_music(self: &Arc<Self>) {
        let axes = *self.track_axes.lock().unwrap();
        if !axes.iter().any(|a| a.source == TrackSource::AiMusic) {
            return;
        }
        let Some((loaded, cache_dir)) = self.music_loaded() else {
            return;
        };
        let Some(path) = self
            .media_path
            .lock()
            .unwrap()
            .clone()
            .filter(|p| is_local(p))
        else {
            return;
        };
        let hwdec = self.hwdec.lock().unwrap().clone();
        let shared = self.clone();
        Beat::music_start(
            &self.beat,
            self.clone(),
            path,
            hwdec,
            loaded,
            self.pace(),
            cache_dir,
            move || {
                shared.apply_selection();
            },
        );
    }




    fn preset_clock(&self, start_ms: f64) {
        if self.following.load(Ordering::Relaxed) {
            return;
        }
        {
            let mut clock = self.clock.lock().unwrap();
            clock.set_idle(true);
            clock.report(start_ms);
            clock.snap();
        }
        self.mixer.lock().unwrap().resync();
    }



    fn restart_lookahead(self: &Arc<Self>, hwdec: String) {
        let path = self
            .media_path
            .lock()
            .unwrap()
            .clone()
            .filter(|p| is_local(p));
        let mut slot = self.lookahead.lock().unwrap();
        if slot.as_ref().map(|l| l.path.as_str()) == path.as_deref() {
            return;
        }
        let hwdec = Some(hwdec).filter(|h| !h.is_empty());
        *slot = path.map(|p| Lookahead::start(self.clone(), p, hwdec));
    }



    fn update_expand(&self) {
        let any = self.has_restim();
        let loaded = {
            let mixer = self.mixer.lock().unwrap();
            (mixer.expand_stroke() != any).then(|| mixer.loaded().to_vec())
        };
        if let Some(loaded) = loaded {
            let table = ScriptTable::build(loaded, any);
            self.mixer.lock().unwrap().install(table);
        }
        self.apply_param_sources();
    }

    fn has_restim(&self) -> bool {
        self.outputs
            .lock()
            .unwrap()
            .iter()
            .any(|o| o.profile == Profile::Restim)
    }





    fn apply_param_sources(&self) {
        let restim = self.has_restim() && self.params_enabled.load(Ordering::Relaxed);
        let sources = self.param_sources.lock().unwrap();
        let live = restim && sources.iter().any(ParamSource::is_live);
        let detect = restim
            && sources
                .iter()
                .any(|s| matches!(s, ParamSource::Detection(_)));
        let cuts = restim
            && sources.iter().any(
                |s| matches!(s, ParamSource::Detection(d) if d.hold.is_some_and(|h| h.on_cut)),
            );
        let mut mixer = self.mixer.lock().unwrap();
        for axis in Axis::ALL
            .into_iter()
            .filter(|a| a.kind() == Kind::EstimParam)
        {
            let fallback = match &sources[axis.index()] {
                _ if !restim => Fallback::None,
                ParamSource::Restim | ParamSource::Audio | ParamSource::Detection(_) => {
                    Fallback::None
                }
                ParamSource::Fixed(v) => Fallback::Value(*v),
                ParamSource::Sweep(p) => Fallback::Provider(p.clone()),
            };
            mixer.set_fallback(axis, fallback);
        }
        drop(mixer);
        self.live_params.store(live, Ordering::Relaxed);
        self.detect_wanted.store(detect, Ordering::Relaxed);
        self.cuts_wanted.store(cuts, Ordering::Relaxed);
        if !cuts {
            *self.cut_watch.lock().unwrap() = None;
        }
    }




    fn watch_cuts(&self, rgb: &[u8], w: usize, h: usize, time_ms: f64) {
        if !self.cuts_wanted.load(Ordering::Relaxed) {
            return;
        }
        let mut gray = Vec::new();
        track::to_gray(rgb, w, h, &mut gray);
        let mut watch = self.cut_watch.lock().unwrap();
        let (detector, last_ms) = watch.get_or_insert_with(|| (CutDetector::new(), time_ms));
        if (time_ms - *last_ms).abs() > CUT_WATCH_GAP_MS {
            detector.reset();
        }
        *last_ms = time_ms;
        if detector.push(&gray, w, h) {
            self.scene_cuts.fetch_add(1, Ordering::Relaxed);
        }
    }



    fn live_param_values(&self, media_ms: f64) -> Vec<(Axis, Option<f64>)> {
        let sources = self.param_sources.lock().unwrap().clone();
        if !sources.iter().any(ParamSource::is_live) {
            return Vec::new();
        }
        let loudness = sources
            .iter()
            .any(|s| *s == ParamSource::Audio)
            .then(|| self.beat.lock().unwrap().loudness_at(media_ms))
            .flatten();
        let coverage = sources
            .iter()
            .any(|s| matches!(s, ParamSource::Detection(_)))
            .then(|| {
                self.detect
                    .lock()
                    .unwrap()
                    .as_ref()
                    .and_then(|d| d.coverage())
            })
            .flatten();
        let cuts = self.scene_cuts.load(Ordering::Relaxed);
        Axis::ALL
            .into_iter()
            .filter(|a| a.kind() == Kind::EstimParam)
            .filter_map(|axis| match sources[axis.index()] {
                ParamSource::Audio => Some((axis, loudness)),
                ParamSource::Detection(d) => Some((
                    axis,
                    coverage.map(|c| {
                        let raw = d.coverage(&c);
                        let shaped = d.shape(raw);
                        match d.hold {
                            Some(hold) => self.param_hold.lock().unwrap()[axis.index()]
                                .step(&hold, raw, shaped, cuts, media_ms),
                            None => shaped,
                        }
                    }),
                )),
                _ => None,
            })
            .collect()
    }

    fn on_player_event(&self, e: PlayerEvent) {
        if let PlayerEvent::VideoSize(w, h) = e {
            self.video_size.0.store(w, Ordering::Relaxed);
            self.video_size.1.store(h, Ordering::Relaxed);
            return;
        }
        if self.following.load(Ordering::Relaxed) {
            return;
        }
        let mut clock = self.clock.lock().unwrap();
        match e {
            PlayerEvent::TimePos(t) => clock.report(t * 1000.0),
            PlayerEvent::Duration(d) => clock.duration_ms = d * 1000.0,
            PlayerEvent::Pause(p) => {
                clock.set_paused(p);
                self.mixer.lock().unwrap().resync();
            }
            PlayerEvent::Idle(i) => clock.set_idle(i),
            PlayerEvent::Speed(s) => clock.set_speed(s),
            PlayerEvent::Seek | PlayerEvent::FileLoaded => {
                clock.snap();
                self.mixer.lock().unwrap().resync();
            }
            PlayerEvent::PlaybackRestart => clock.snap(),
            PlayerEvent::EndFile { error: Some(e) } => *self.load_error.lock().unwrap() = Some(e),
            PlayerEvent::EndFile { .. } | PlayerEvent::VideoSize(..) => {}
        }
    }



    fn on_follow_event(&self, e: FollowEvent) {
        match e {
            FollowEvent::Time(ms) => self.clock.lock().unwrap().report(ms),
            FollowEvent::Duration(ms) => self.clock.lock().unwrap().duration_ms = ms,
            FollowEvent::Speed(s) => self.clock.lock().unwrap().set_speed(s),
            FollowEvent::Playing(playing) => {
                let mut clock = self.clock.lock().unwrap();
                clock.set_paused(!playing);
                clock.set_idle(!playing);
                drop(clock);
                self.mixer.lock().unwrap().resync();
            }
            FollowEvent::Path(_) => {
                self.clock.lock().unwrap().snap();
                self.mixer.lock().unwrap().resync();
            }
            FollowEvent::Status(_) => {}
        }
    }



    fn apply_selection(&self) -> Vec<ScriptInfo> {
        let pool = self.pool.lock().unwrap();
        let variants = self.variants.lock().unwrap().clone();
        let default = default_selection(&pool);
        let chosen: Vec<usize> = Axis::ALL
            .iter()
            .filter_map(|&axis| {
                let wanted = variants
                    .iter()
                    .find(|(a, _)| *a == axis)
                    .map(|(_, v)| v.as_str());
                let named = wanted.and_then(|name| {
                    pool.iter()
                        .position(|e| e.axis == axis && e.variant.as_deref() == Some(name))
                });
                named.or_else(|| default.iter().copied().find(|&i| pool[i].axis == axis))
            })
            .collect();
        let infos = describe(&pool, &chosen);
        let mut loaded: Vec<(Axis, Arc<Script>)> = chosen
            .iter()
            .map(|&i| (pool[i].axis, pool[i].script.clone()))
            .collect();
        drop(pool);



        if self.timeline.lock().unwrap().active {
            let axes = *self.track_axes.lock().unwrap();
            let beat = self.beat.lock().unwrap();
            for axis in Axis::ALL {
                let a = axes[axis.index()];
                let alternate =
                    matches!(axis, Axis::R0 | Axis::R1 | Axis::R2 | Axis::L1 | Axis::L2);
                let limited = |mut script: Script| {
                    for action in &mut script.actions {
                        action.pos = a.limit(action.pos);
                    }
                    script
                };
                let script = match a.source {
                    TrackSource::Beat => beat.script(1.0, a.invert, alternate).map(limited),
                    TrackSource::Hero => Some(limited(
                        self.hero
                            .lock()
                            .unwrap()
                            .script(axis, 1.0, a.invert, alternate),
                    )),
                    TrackSource::AiMusic => beat
                        .music_script(axis)
                        .map(|mut script| {
                            for action in &mut script.actions {
                                action.pos = a.map(action.pos);
                            }
                            script
                        })
                        .or_else(|| beat.script(1.0, a.invert, alternate).map(limited)),
                    _ => None,
                };
                if let Some(script) = script {
                    loaded.retain(|(ax, _)| *ax != axis);
                    loaded.push((axis, Arc::new(script)));
                }
            }
        }
        self.set_scripts(loaded);
        infos
    }



    fn hero_frame(&self, rgb: &[u8], w: usize, h: usize, time_ms: f64) {
        let axes = *self.track_axes.lock().unwrap();
        if !axes.iter().any(|a| a.source == TrackSource::Hero) {
            return;
        }
        let mut hero = self.hero.lock().unwrap();
        if !hero.push(rgb, w, h, time_ms) {
            return;
        }
        let mut mixer = self.mixer.lock().unwrap();
        for axis in Axis::ALL {
            let a = axes[axis.index()];
            if a.source != TrackSource::Hero {
                continue;
            }
            let alternate = matches!(axis, Axis::R0 | Axis::R1 | Axis::R2 | Axis::L1 | Axis::L2);
            mixer.set_script_live(
                axis,
                Some(Arc::new(hero.script(axis, 1.0, a.invert, alternate))),
            );
        }
    }



    fn hosted_media(&self) -> Media {
        let Some(path) = self.media_path.lock().unwrap().clone() else {
            return Media::default();
        };
        if !is_local(&path) {
            return Media {
                title: path,
                hwl: None,
            };
        }
        let p = Path::new(&path);
        let title = p
            .file_stem()
            .map_or_else(|| path.clone(), |s| s.to_string_lossy().into_owned());
        let hwl = p.with_extension("hwl");
        Media {
            title,
            hwl: hwl.is_file().then_some(hwl),
        }
    }



    fn hosted_scripts(&self) -> Vec<(Axis, Arc<Script>)> {
        overlay_generated(
            &self.scripts.lock().unwrap(),
            &self.generated.lock().unwrap(),
        )
    }




    fn set_scripts(&self, scripts: Vec<(Axis, Arc<Script>)>) {
        let media = self.hosted_media();
        let hosted = overlay_generated(&scripts, &self.generated.lock().unwrap());
        let expand = {
            let mut outputs = self.outputs.lock().unwrap();
            for o in outputs.iter_mut() {
                o.set_scripts(&hosted, &media);
            }
            outputs.iter().any(|o| o.profile == Profile::Restim)
        };
        let table = ScriptTable::build(scripts.clone(), expand);
        {
            let mut mixer = self.mixer.lock().unwrap();
            mixer.install(table);
            mixer.resync();
        }
        *self.scripts.lock().unwrap() = scripts;
    }






    fn offer_to_detector(&self, rgb: &[u8], w: usize, h: usize, cuts: u64) {
        let now = wall_ms();
        let (source, target, floor) = {
            let r = self.region.lock().unwrap();
            (r.source, r.target, r.auto.floor(now))
        };
        let boxes = self.boxes_wanted.load(Ordering::Relaxed);
        if source != RegionSource::Auto && !self.detect_wanted.load(Ordering::Relaxed) && !boxes {
            return;
        }
        let detect = self.detect.lock().unwrap();
        let Some(d) = detect.as_ref().filter(|d| d.ready()) else {
            return;
        };
        let interval = self.detect_options.lock().unwrap().interval_ms;
        let mut clock = self.detect_clock.lock().unwrap();
        let after_cut = cuts != clock.cuts_seen;
        if after_cut {
            self.scene_cuts.fetch_add(1, Ordering::Relaxed);
        }
        clock.cuts_seen = cuts;
        let due = clock
            .last_at
            .is_none_or(|t| t.elapsed().as_secs_f64() * 1000.0 >= interval);
        if after_cut || due || boxes {
            clock.last_at = Some(Instant::now());
            d.put(
                rgb,
                w,
                h,
                after_cut,
                target,
                if after_cut { None } else { floor },
                now,
            );
        }
    }



    fn on_detected(&self, v: Verdict) {
        *self.box_run.lock().unwrap() = Some(box_run(&v));
        let Verdict {
            found,
            after_cut,
            time_ms,
            ..
        } = v;
        let padding = self.detect_options.lock().unwrap().padding;
        let mut region = self.region.lock().unwrap();
        let next = next_auto_region(region.auto, found, after_cut, time_ms, padding);
        let moved = next.region != region.auto.region;
        region.auto = next;
        if !moved || region.source != RegionSource::Auto {
            return;
        }
        drop(region);
        if let Some(t) = self.track.lock().unwrap().as_ref() {
            t.tracker.lock().unwrap().set_region(next.region);
        }
    }



    fn tick(&self, t: deadline::Tick) -> Pace {
        let (media_ms, playing, rate) = {
            let mut clock = self.clock.lock().unwrap();
            let now = clock.now();
            (now, clock.running(), clock.speed())
        };




        let tracking = self.timeline.lock().unwrap().active;
        let tracked: Option<[Option<f64>; Axis::COUNT]> = tracking.then(|| {
            let axes = *self.track_axes.lock().unwrap();
            let offsets: [f64; Axis::COUNT] = {
                let mixer = self.mixer.lock().unwrap();
                std::array::from_fn(|i| {
                    mixer.global_offset_ms + mixer.settings(Axis::ALL[i]).offset_ms
                })
            };
            let model = self.motion_wanted() && self.motion_loaded().is_some();
            let lookahead = self.lookahead.lock().unwrap();
            let tl = self.timeline.lock().unwrap();
            let model_tl = self.model_timeline.lock().unwrap();
            let now = Instant::now();
            std::array::from_fn(|i| {
                let a = axes[i];
                let c = track_component(Axis::ALL[i]).filter(|_| a.source.on_frames())?;



                if a.source == TrackSource::AiMotion && model {
                    let scored = lookahead
                        .as_ref()
                        .and_then(|l| l.model_value_at(media_ms - offsets[i]))
                        .or_else(|| model_tl.value_at(now, offsets[i]));
                    if let Some(m) = scored {
                        return m[c.index()].is_finite().then(|| a.map(m[c.index()]));
                    }
                }
                let motion = lookahead
                    .as_ref()
                    .and_then(|l| l.value_at(media_ms - offsets[i]))
                    .or_else(|| tl.value_at(now, offsets[i]))?;
                Some(a.map(motion[c.index()]))
            })
        });
        let live_params = if self.live_params.load(Ordering::Relaxed) {
            self.live_param_values(media_ms)
        } else {
            Vec::new()
        };
        let (frame, driven, flags) = {
            let mut mixer = self.mixer.lock().unwrap();
            for (axis, value) in live_params {
                mixer.set_fallback(axis, value.map_or(Fallback::None, Fallback::Value));
            }
            if let Some(values) = tracked {
                for axis in Axis::ALL
                    .into_iter()
                    .filter(|a| track_component(*a).is_some())
                {
                    mixer.set_source(axis, values[axis.index()]);
                }
            }


            let remote = self
                .intiface
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|s| s.stroke_at(Instant::now()));
            let was_remote = self
                .remote_driving
                .swap(remote.is_some(), Ordering::Relaxed);
            if remote.is_some() || (was_remote && tracked.is_none()) {
                mixer.set_source(Axis::L0, remote);
            }
            let frame = mixer.tick(media_ms, t.dt_ms);
            let flags: [u8; Axis::COUNT] = std::array::from_fn(|i| {
                let a = Axis::ALL[i];
                (mixer.has_script(a) as u8 * FLAG_SCRIPT)
                    | (mixer.is_derived(a) as u8 * FLAG_DERIVED)
                    | (mixer.is_live(a) as u8 * FLAG_LIVE)
                    | (mixer.has_external(a) as u8 * FLAG_TRACKED)
            });
            (frame, *mixer.driven(), flags)
        };


        let driven = if self.params_enabled.load(Ordering::Relaxed) {
            driven
        } else {
            let mut d = driven;
            for a in Axis::ALL
                .into_iter()
                .filter(|a| a.kind() == Kind::EstimParam)
            {
                d[a.index()] = false;
            }
            d
        };
        {
            let mut p = self.published.lock().unwrap();
            p.values = frame;
            if p.flags != flags {
                p.flags = flags;
                p.version += 1;
            }
        }
        let ctx = TickContext {
            media_ms,
            playing,
            rate,
            interval_ms: ((t.dt_ms + 0.75).floor() as u32).clamp(1, 100),
        };
        let (connected, wrote) = {
            let mut outputs = self.outputs.lock().unwrap();
            let (mut connected, mut wrote) = (false, false);
            for o in outputs.iter_mut() {
                o.poll();
                connected |= o.connected();
                wrote |= o.send(&frame, &driven, &ctx);
            }
            (connected, wrote)
        };
        let mut s = self.tick.lock().unwrap();
        s.realtime = t.realtime;
        if t.pace == Pace::Precise {
            push_sample(&mut s.late_us, t.late_us);
        }
        push_sample(&mut s.work_us, t.fired.elapsed().as_micros() as u32);
        s.since_write = if wrote {
            0
        } else {
            s.since_write.saturating_add(1)
        };


        if connected && (playing || tracked.is_some() || s.since_write < RELAX_AFTER_TICKS) {
            Pace::Precise
        } else {
            Pace::Relaxed
        }
    }
}


fn wall_ms() -> f64 {
    static EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}






fn next_auto_region(
    prev: AutoRegion,
    found: Option<Found>,
    after_cut: bool,
    now_ms: f64,
    padding: f64,
) -> AutoRegion {
    match found {
        Some(f) => {
            let r = f.rect.padded(padding);
            let target = bp_detect::Target::of(f.class);
            let next = Some(grow_region(Region {
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
            }));
            let region = if similar_region(prev.region, next) {
                prev.region
            } else {
                next
            };
            AutoRegion {
                region,
                target,
                seen_ms: now_ms,
            }
        }
        None if after_cut => AutoRegion::default(),
        None => prev,
    }
}



fn overlay_generated(
    scripts: &[(Axis, Arc<Script>)],
    generated: &[(Axis, Arc<Script>)],
) -> Vec<(Axis, Arc<Script>)> {
    let mut out: Vec<(Axis, Arc<Script>)> = scripts
        .iter()
        .filter(|(axis, _)| !generated.iter().any(|(g, _)| g == axis))
        .cloned()
        .collect();
    out.extend(generated.iter().cloned());
    out
}

fn is_local(path: &str) -> bool {
    !path.contains("://") || path.starts_with("file://")
}



fn grow_region(r: Region) -> Region {
    let w = r.w.max(MIN_AUTO_REGION).min(1.0);
    let h = r.h.max(MIN_AUTO_REGION).min(1.0);
    let x = (r.x + r.w / 2.0 - w / 2.0).clamp(0.0, 1.0 - w);
    let y = (r.y + r.h / 2.0 - h / 2.0).clamp(0.0, 1.0 - h);
    Region { x, y, w, h }
}



fn similar_region(a: Option<Region>, b: Option<Region>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            let size = a.w.max(a.h).max(1e-3);
            let dc = ((a.x + a.w / 2.0) - (b.x + b.w / 2.0))
                .abs()
                .max(((a.y + a.h / 2.0) - (b.y + b.h / 2.0)).abs());
            let ds = (a.w - b.w).abs().max((a.h - b.h).abs());
            dc < 0.15 * size && ds < 0.25 * size
        }
        _ => false,
    }
}




pub fn scan_pool(media: &Path) -> Vec<PoolEntry> {
    find_scripts(media)
        .into_iter()
        .map(|s| {
            let mut info = script_info(s.axis, &s.source, s.container, &s.script);
            info.variant = s.variant.clone();
            PoolEntry {
                axis: s.axis,
                variant: s.variant,
                script: Arc::new(s.script),
                info,
            }
        })
        .collect()
}



pub fn scan_scripts(path: &Path) -> Vec<ScriptInfo> {
    let pool = scan_pool(path);
    describe(&pool, &default_selection(&pool))
}



fn default_selection(pool: &[PoolEntry]) -> Vec<usize> {
    let mut out: Vec<usize> = Vec::new();
    for (i, e) in pool.iter().enumerate() {
        if !out.iter().any(|&j| pool[j].axis == e.axis) {
            out.push(i);
        }
    }
    out
}


fn describe(pool: &[PoolEntry], chosen: &[usize]) -> Vec<ScriptInfo> {
    pool.iter()
        .enumerate()
        .map(|(i, e)| ScriptInfo {
            selected: chosen.contains(&i),
            ..e.info.clone()
        })
        .collect()
}

fn script_info(axis: Axis, source: &Path, container: Container, script: &Script) -> ScriptInfo {
    let stats = heatmap::speed_stats(script);
    let duration_ms = script.duration_ms();
    ScriptInfo {
        axis,
        variant: None,
        selected: true,
        source: source.to_path_buf(),
        container,
        actions: script.actions.len(),
        duration_ms,
        average_speed: stats.average,
        max_speed: stats.max,
        heatmap: heatmap::heatmap(script, duration_ms, HEATMAP_BUCKETS).buckets,
        chapters: script.chapters.clone(),
        bookmarks: script.bookmarks.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn generated_scripts_replace_the_files_on_their_axes_only() {
        let script = |pos: f64| {
            Arc::new(Script {
                actions: vec![
                    bp_script::Action { at: 0.0, pos },
                    bp_script::Action {
                        at: 1000.0,
                        pos: 1.0 - pos,
                    },
                ],
                ..Script::default()
            })
        };
        let file = vec![(Axis::L0, script(0.0)), (Axis::R0, script(0.5))];
        let generated = vec![(Axis::L0, script(1.0)), (Axis::R1, script(0.25))];
        let hosted = overlay_generated(&file, &generated);
        let pos = |axis: Axis| {
            hosted
                .iter()
                .find(|(a, _)| *a == axis)
                .map(|(_, s)| s.actions[0].pos)
        };
        assert_eq!(pos(Axis::L0), Some(1.0));
        assert_eq!(pos(Axis::R0), Some(0.5));
        assert_eq!(pos(Axis::R1), Some(0.25));
        assert_eq!(hosted.len(), 3);
        assert_eq!(overlay_generated(&file, &[]), file);
    }

    #[test]
    fn auto_region_holds_its_target_for_three_seconds() {
        let hit = |class, x| {
            Some(Found {
                rect: bp_detect::Rect {
                    x,
                    y: 0.4,
                    w: 0.2,
                    h: 0.2,
                },
                class,
                confidence: 0.9,
            })
        };
        let held = next_auto_region(
            AutoRegion::default(),
            hit("FEMALE_GENITALIA_EXPOSED", 0.1),
            false,
            1000.0,
            0.0,
        );
        assert_eq!(held.target, Some(bp_detect::Target::Genitals));

        let missed = next_auto_region(held, None, false, 3500.0, 0.0);
        assert_eq!(missed, held);
        assert_eq!(missed.floor(3999.0), Some(bp_detect::Target::Genitals));
        assert_eq!(missed.floor(4000.0), None, "anything may take over now");

        assert_eq!(
            next_auto_region(held, None, true, 1500.0, 0.0),
            AutoRegion::default()
        );

        let fallen = next_auto_region(missed, hit("BUTTOCKS_EXPOSED", 0.6), false, 4200.0, 0.0);
        assert_eq!(fallen.target, Some(bp_detect::Target::Buttocks));
        assert_eq!(fallen.floor(4300.0), Some(bp_detect::Target::Buttocks));
        let back = next_auto_region(
            fallen,
            hit("FEMALE_GENITALIA_EXPOSED", 0.1),
            false,
            4900.0,
            0.0,
        );
        assert_eq!(back.target, Some(bp_detect::Target::Genitals));
        assert_eq!(back.region, held.region);
    }

    #[test]
    fn track_axis_map_flips_then_limits_and_intensity_is_energy_not_depth() {
        let a = TrackAxis {
            source: TrackSource::Video,
            intensity: 0.5,
            min: 0.2,
            max: 0.8,
            smoothing_ms: 100.0,
            invert: false,
        };
        assert_eq!(a.map(0.5), 0.5);
        assert!(
            (a.map(1.0) - 0.8).abs() < 1e-9,
            "full range reaches the limit"
        );
        let flipped = TrackAxis { invert: true, ..a };
        assert!((flipped.map(1.0) - 0.2).abs() < 1e-9);

        let lively = TrackAxis {
            intensity: 2.0,
            ..a
        };
        assert_eq!(lively.map(0.9), a.map(0.9));

        let mut axes = default_track_axes();
        axes[Axis::L0.index()] = lively;
        assert_eq!(smoothing(&axes)[Component::Stroke.index()], 50.0);
        axes[Axis::L0.index()] = a;
        assert_eq!(smoothing(&axes)[Component::Stroke.index()], 200.0);
        axes[Axis::L0.index()] = TrackAxis {
            intensity: 0.0,
            ..a
        };
        assert!(smoothing(&axes)[Component::Stroke.index()].is_finite());
        assert_eq!(
            energies(&axes)[Component::Stroke.index()],
            bp_model::decoder::ENERGY_MIN
        );
    }

    #[test]
    fn scan_marks_one_selected_per_axis() {
        let d = std::env::temp_dir().join(format!("bp-core-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let one = r#"{"actions":[{"at":0,"pos":0},{"at":1000,"pos":100}]}"#;
        fs::write(d.join("v.funscript"), one).unwrap();
        fs::write(d.join("v.mouth.funscript"), one).unwrap();
        let infos = scan_scripts(&d.join("v.mp4"));
        let seen: Vec<(Axis, Option<&str>, bool)> = infos
            .iter()
            .map(|i| (i.axis, i.variant.as_deref(), i.selected))
            .collect();
        assert_eq!(
            seen,
            vec![(Axis::L0, None, true), (Axis::L0, Some("mouth"), false)]
        );
        let _ = fs::remove_dir_all(&d);
    }
}
