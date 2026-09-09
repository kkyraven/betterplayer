//! The engine: libmpv player, media clock, script mixer and device outputs, driven by one
//! fixed-rate tick thread. The host (napi) is a thin layer over this.

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
mod range;
mod track;
mod zones;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use bp_axes::{AxisSettings, Fallback, Frame, Mixer, ScriptTable};
use bp_devices::{
    AxisClamp, IntifaceServer, IntifaceStatus, Media, OpenShockTrigger, Output, OutputSnapshot,
    Keyframe, OutputStats, Pace, PercentilesUs, Profile, TickContext, Transport, Vibration, deadline,
    percentiles,
};
use bp_player::{Player, PlayerEvent, PlayerOptions};
use bp_script::{Axis, Container, Kind, Script, heatmap};

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
    grid50 as beat_grid50, generate as beat_generate, GenerateOptions as BeatGenerateOptions, BeatTrack,
};
pub use bp_detect::{Kind as DetectKind, MODELS, ModelSpec, Rect as DetectRect};
pub use bp_hero::{
    BUCKET_NAMES as HERO_BUCKET_NAMES, BUCKETS as HERO_BUCKETS, Direction as HeroDirection,
    Hero as RawHero, Note as HeroNote, Options as HeroOptions, Rect as HeroRect,
};
pub use bp_model::{MODELS as AI_MODELS, ModelKind, ModelSpec as AiModelSpec, TOO_SLOW_MS};
pub use detect::{DetectSnapshot, DetectStatus, Found, Verdict};
pub use generate::{GenerateProgress, GenerateStatus, Generation};
pub use hero::{ColourRule, Flourish, HeroSnapshot, MusicOptions as HeroMusicOptions, MusicRule as HeroMusicRule};
pub use zones::{Override as EffectOverride, Zone, ZoneMatch, ZoneTrigger};
use zones::ZoneState;
pub use range::{
    MODEL_TAIL_MS, RangeAnalyser, RangeOptions, RangeProgress, RangeResult, RangeStatus, Thumb,
};

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
    /// Name among several scripts for the axis, None for the plain one.
    pub variant: Option<String>,
    /// Whether this is the script playing on its axis.
    pub selected: bool,
    pub source: PathBuf,
    pub container: Container,
    pub actions: usize,
    pub duration_ms: f64,
    pub average_speed: f64,
    pub max_speed: f64,
    /// Average speed per bucket across `0..duration_ms`.
    pub heatmap: Vec<f64>,
    /// `(start_ms, end_ms)` spans of a second or more with no movement, the lead-in included.
    pub gaps: Vec<(f64, f64)>,
    pub chapters: Vec<Chapter>,
    pub bookmarks: Vec<Bookmark>,
}

#[derive(Clone, Debug)]
pub struct MediaInfo {
    pub path: PathBuf,
    pub scripts: Vec<ScriptInfo>,
}

/// One script in the loaded media's pool: its identity, the parsed actions shared with the
/// mixer and any output that hosts them, and its description measured once at load.
#[derive(Clone, Debug)]
pub struct PoolEntry {
    pub axis: Axis,
    pub variant: Option<String>,
    pub script: Arc<Script>,
    /// Measured at scan time; `selected` is filled in per selection.
    info: ScriptInfo,
}

/// A button line from a device, `ok`, `left`, `right` or `edge` on TCode boards.
#[derive(Clone, Debug)]
pub struct DeviceInput {
    pub output: u32,
    pub name: String,
}

/// Bits of `EngineState::axis_flags`.
pub const FLAG_SCRIPT: u8 = 1;
/// Derived from another axis: alpha and beta from the stroke, electrodes 1 to 4 from those.
pub const FLAG_DERIVED: u8 = 2;
/// "Find my range" is driving the axis by hand.
pub const FLAG_LIVE: u8 = 4;
/// An outside source (the live tracker, a remote client) is driving the axis.
pub const FLAG_TRACKED: u8 = 8;

/// Everything the UI polls every frame. Plain values and small arrays only: no sorting, no
/// per-axis allocation, and no lock the tick thread holds for long.
#[derive(Clone, Debug)]
pub struct EngineState {
    pub time_ms: f64,
    pub duration_ms: f64,
    pub paused: bool,
    pub rate: f64,
    pub loaded: bool,
    /// The clock is following an external VR player, not our own.
    pub following: bool,
    /// The decoded picture size, 0 by 0 until a file has loaded.
    pub video_width: u32,
    pub video_height: u32,
    /// Pipeline output per axis, 0..1, in `Axis::ALL` order.
    pub axis_values: Frame,
    /// Per axis in `Axis::ALL` order: `FLAG_SCRIPT`, `FLAG_DERIVED`, `FLAG_LIVE` and
    /// `FLAG_TRACKED`.
    pub axis_flags: [u8; Axis::COUNT],
    /// Why the last load failed, until the next load.
    pub error: Option<String>,
    /// Moves whenever `axis_flags` do, so a host can skip diffing them.
    pub flags_version: u64,
    pub outputs: Vec<OutputSnapshot>,
}

/// How the tick thread is keeping time, for diagnostics.
#[derive(Clone, Debug)]
pub struct TickStats {
    pub hz: u32,
    pub realtime: bool,
    /// How late precise ticks fired past their deadline.
    pub late: PercentilesUs,
    /// From firing to the last output written, so lock waits and device writes show.
    pub work: PercentilesUs,
}

/// Where a restim parameter axis (carrier, pulse rate, width, jitter, rise) takes its value
/// when the video has no script for it. Applies only while a restim output exists; a script
/// wins wherever it has keyframes. The value goes through the axis's own range, invert,
/// ramp and speed limit, so the range is the scope the user allows.
#[derive(Clone, Debug, PartialEq, Default)]
pub enum ParamSource {
    /// Nothing sent; restim's own setting.
    #[default]
    Restim,
    /// One value, 0..1 of the scope, sent once and held.
    Fixed(f64),
    /// A sine or random wander across the scope.
    Sweep(Provider),
    /// The sound track's loudness against its peak, from the Beat analysis; nothing is sent
    /// until the audio has been analysed.
    Audio,
    /// How much of the picture the chosen kinds cover, skewed by a bias and optionally held
    /// between scene cuts or coverage peaks; nothing is sent until a model is ready.
    Detection(DetectionSource),
}

/// The estim settings that hold across every restim output and video.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EstimOptions {
    /// Relative balance of the electrodes derived from alpha and beta, 0..1 (`bp_script::expand::contrast`).
    pub contrast: f64,
    /// Minimum of the normal volume range, 0..1, before the two-second onset fade.
    pub volume_floor: f64,
    pub volume_max: f64,
    pub volume_boost: bp_devices::ramp::VolumeBoost,
    /// Whether the carrier and pulse parameter axes go out at all: off, and neither a video's
    /// parameter scripts nor the parameter sources reach restim. Off by default.
    pub params: bool,
}

impl Default for EstimOptions {
    fn default() -> EstimOptions {
        EstimOptions {
            contrast: 0.0,
            volume_floor: bp_devices::ramp::DEFAULT_VOLUME_FLOOR,
            volume_max: 1.0,
            volume_boost: bp_devices::ramp::VolumeBoost::default(),
            params: false,
        }
    }
}

impl ParamSource {
    /// Audio and Detection change every tick; the rest are set once.
    fn is_live(&self) -> bool {
        matches!(self, ParamSource::Audio | ParamSource::Detection(_))
    }
}

/// Where an axis takes its live value from while tracking. Video is the flow, live; Beat is a
/// script generated from the audio, played on the media clock; AI Motion is the movement
/// model on the same frames as Video (and Video itself while the model is not loaded); AI
/// CH/PMV is the music model's script, with Beat's standing in until it arrives. Faptap is
/// whatever a page commands through the Intiface server, live; only the stroke can take it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackSource {
    Video,
    Beat,
    Hero,
    AiMotion,
    AiMusic,
    Faptap,
    Off,
}

impl TrackSource {
    /// Whether the source reads the flow tracker's frames, live or ahead.
    fn on_frames(self) -> bool {
        matches!(self, TrackSource::Video | TrackSource::AiMotion)
    }

    /// Whether the source plays a generated script on the media clock.
    fn generated(self) -> bool {
        matches!(
            self,
            TrackSource::Beat | TrackSource::Hero | TrackSource::AiMusic
        )
    }
}

/// One axis's row of the tracking table: its source, how much energy it moves with, the span
/// of the axis it may use, how smoothed it is and whether it runs the other way.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackAxis {
    pub source: TrackSource,
    /// Energy, 1.0 being neutral: how willing the axis is to move fast and to keep moving. It
    /// divides the smoothing and stretches the model's active hold (`DecodeConfig::energised`).
    /// Beat's Twist axis uses it to select half, normal or double tempo instead.
    /// It is not depth: the limits own depth, and until 2026-09-05 this was a multiplier about
    /// the middle that did nothing above 1.0 on any source that already filled the range.
    pub intensity: f64,
    /// Limits: the full 0..1 motion is squeezed into `min..max`.
    pub min: f64,
    pub max: f64,
    /// Time constant of the smoothing on this axis's motion component; 0 is off.
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

    /// A tracked 0..1 position flipped and squeezed into the limits, ready for the mixer.
    pub fn map(&self, v: f64) -> f64 {
        let v = if self.invert { 1.0 - v } else { v };
        self.limit(v.clamp(0.0, 1.0))
    }

    /// The row's intensity as energy, floored so a stepper at 0 cannot divide anything by it.
    pub fn energy(&self) -> f64 {
        self.intensity.max(bp_model::decoder::ENERGY_MIN)
    }

    /// A 0..1 position squeezed into the limits. `map` does this after intensity; generated
    /// scripts (Beat, Hero) get it on their actions.
    pub fn limit(&self, v: f64) -> f64 {
        self.min + v.clamp(0.0, 1.0) * (self.max - self.min)
    }
}

pub type TrackAxes = [TrackAxis; Axis::COUNT];

/// The motion component an axis follows. Fixed, so nobody routes "shear" by hand.
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

/// Stroke at full, smoothed at 100 ms; the others gentler, held to the middle half and smoothed
/// at 300 ms; twist off: a sane first run on an SR6.
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

/// The tracker's per-component smoothing, read off the axes table: the row's smoothing divided
/// by its energy, so a lively axis keeps its edges and a lazy one glides.
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

/// The rows' energy per motion component, for the model's decode.
fn energies(axes: &TrackAxes) -> [f64; Component::COUNT] {
    let mut out = [1.0; Component::COUNT];
    for axis in Axis::ALL {
        if let Some(c) = track_component(axis) {
            out[c.index()] = axes[axis.index()].energy();
        }
    }
    out
}

/// A downloaded detector model: its spec, the file and a cache directory for the compiled graph.
pub type DetectorModel = (&'static ModelSpec, PathBuf, Option<PathBuf>);

/// A downloaded AI model: its spec, the weights, the metadata beside them, and a directory the
/// engine keeps its caches under (the compiled CoreML graph, the music model's video rows).
pub type AiModel = (&'static AiModelSpec, PathBuf, PathBuf, Option<PathBuf>);

#[derive(Clone, Debug, PartialEq)]
pub enum ModelStatus {
    None,
    Loading,
    Ready,
    Error(String),
}

/// What one of the AI models is doing, for the bar and Settings.
#[derive(Clone, Debug)]
pub struct ModelSnapshot {
    pub kind: ModelKind,
    pub status: ModelStatus,
    pub id: Option<&'static str>,
    pub version: Option<String>,
    /// `coreml` or `cpu` once loaded, and why the first choice was not taken.
    pub provider: Option<&'static str>,
    pub fallback: Option<String>,
    pub warmup_ms: f64,
    /// The last window's cost.
    pub run_ms: f64,
    /// The warmup said the movement model cannot keep up live; its axes stay on the flow.
    pub too_slow: bool,
}

/// One AI model's slot: what was asked for, and the session once its thread has loaded it.
struct ModelSlot {
    status: ModelStatus,
    spec: Option<&'static AiModelSpec>,
    loaded: Option<Arc<bp_model::Loaded>>,
    cache_dir: Option<PathBuf>,
    run_ms: f64,
    /// The warmup's verdict, kept here so the tick never waits on a running window.
    too_slow: bool,
    /// Bumped per request so a stale load thread's result is dropped.
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

/// Where the tracker's region comes from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RegionSource {
    /// The detector's box, padded; the last one until a cut says otherwise; the centre when
    /// nothing has ever been found.
    Auto,
    Centre,
    Pick(Region),
}

#[derive(Clone, Copy, Debug)]
pub struct DetectOptions {
    /// How often the detector looks between cuts.
    pub interval_ms: f64,
    /// Room around the detected box, as a fraction of its size, so the flow sees the motion
    /// beside the target.
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
    /// What Auto looks for: one kind, or `None` for the rule (genitals, else a face).
    target: Option<DetectKind>,
    /// The detector's last box under Auto.
    auto: AutoRegion,
}

/// How long a target the rule follows is assumed still there after it stops being seen,
/// before a worse one (buttocks for genitals, breasts for a face) may take over.
const AUTO_HOLD_MS: f64 = 3000.0;

/// The box the detector last applied, kept across misses, with what it was and when that
/// was last seen so a worse target only takes over once the hold is up.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct AutoRegion {
    pub region: Option<Region>,
    pub target: Option<bp_detect::Target>,
    seen_ms: f64,
}

impl AutoRegion {
    /// The worst target the rule may take now: the held one within the hold, else anything.
    pub fn floor(&self, now_ms: f64) -> Option<bp_detect::Target> {
        self.target.filter(|_| now_ms - self.seen_ms < AUTO_HOLD_MS)
    }
}

/// Smallest region the detector's box grows into, as a fraction of the frame per side: a
/// tight box around a small target leaves the flow too few pixels to work with.
const MIN_AUTO_REGION: f64 = 0.3;

#[derive(Default)]
struct DetectClock {
    last_at: Option<Instant>,
    cuts_seen: u64,
}

/// What the live tracker is doing, for the tracking HUD.
#[derive(Clone, Debug)]
pub struct TrackState {
    pub active: bool,
    pub state: Phase,
    /// The region in use, `None` for the centre; whether it came from the detector.
    pub region: Option<Region>,
    pub auto: bool,
    pub detect: DetectSnapshot,
    /// The movement model, for axes on AI Motion.
    pub model: ModelSnapshot,
    /// Newest tracked stroke, 0..1.
    pub position: f64,
    /// Newest position per component, in `Component::ALL` order.
    pub motion: Motion,
    /// How far past the playhead the lookahead has tracked; `None` without one (a page, or
    /// a file that is not local).
    pub ahead_ms: Option<f64>,
    /// Frame rate measured from arrivals.
    pub fps: f64,
    pub frames: u64,
    /// Scene cuts, clamped jumps and dropped fits since the start.
    pub cuts: u64,
    pub jumps: u64,
    pub drops: u64,
}

#[derive(Default)]
struct TickSamples {
    late_us: VecDeque<u32>,
    work_us: VecDeque<u32>,
    realtime: bool,
    /// Ticks since an output last wrote a line.
    since_write: u32,
}

const SAMPLE_WINDOW: usize = 2000;
/// Half a second without a line written and the tick loop stops spinning for precision.
const RELAX_AFTER_TICKS: u32 = 50;

fn push_sample(q: &mut VecDeque<u32>, v: u32) {
    if q.len() == SAMPLE_WINDOW {
        q.pop_front();
    }
    q.push_back(v);
}

/// One tick's mixed frame and when it was mixed.
struct Mixed {
    at: Instant,
    frame: Frame,
    driven: [bool; Axis::COUNT],
}

/// The delay line between the mixer and the outputs; see `tick`. `expected_ms` and `lead`
/// are where the video clock and the lead were last tick, to spot a jump.
struct History {
    frames: VecDeque<Mixed>,
    expected_ms: f64,
    lead: f64,
}

/// A video clock jump larger than this (a seek, not jitter) breaks the delay line.
const JUMP_MS: f64 = 100.0;
/// The most an output can be told early or late, in wall ms.
const DELAY_MAX_MS: f64 = 5000.0;

/// The newest frame at least `delay` old, else the oldest kept, else nothing.
fn frame_back(history: &VecDeque<Mixed>, now: Instant, delay: Duration) -> Option<&Mixed> {
    history
        .iter()
        .rev()
        .find(|m| now.duration_since(m.at) >= delay)
        .or_else(|| history.front())
}

/// What the tick thread publishes for the UI: the pipeline output and the per-axis flags,
/// with a version that moves only when the flags do.
struct Published {
    values: Frame,
    flags: [u8; Axis::COUNT],
    version: u64,
}

struct Shared {
    clock: Mutex<Clock>,
    browser_tracking: AtomicBool,
    browser_clock: Mutex<Clock>,
    mixer: Mutex<Mixer>,
    outputs: Mutex<Vec<Output>>,
    /// Recent frames and when they were mixed, so an output can be handed one from a little
    /// while back; see `tick`.
    history: Mutex<History>,
    /// The loaded scripts, kept so an output connected mid-video can still host them.
    scripts: Mutex<Vec<(Axis, Arc<Script>)>>,
    /// Scripts the host generated for the loaded file (`generate` run through by the app),
    /// written over the file's on their axes for outputs that host the script themselves.
    /// The mixer never sees them; cleared by every load and by `unload`.
    generated: Mutex<Vec<(Axis, Arc<Script>)>>,
    /// Every script found for the loaded media, variants included.
    pool: Mutex<Vec<PoolEntry>>,
    /// A pool scanned ahead for the file expected next, so its load skips the scan.
    prepared: Mutex<Option<(String, Vec<PoolEntry>)>>,
    /// The variant chosen per axis.
    variants: Mutex<Vec<(Axis, String)>>,
    published: Mutex<Published>,
    /// The decoded picture size as mpv reports it, so nobody asks mpv on the frame loop.
    video_size: (AtomicU32, AtomicU32),
    /// Source per restim parameter axis; other axes stay `Restim`.
    param_sources: Mutex<[ParamSource; Axis::COUNT]>,
    /// Some parameter source needs a value every tick (Audio or Detection) on a restim output.
    live_params: AtomicBool,
    /// `EstimOptions::params`: the parameter axes are sent only while this is on.
    params_enabled: AtomicBool,
    /// Levels (vibration, suction, a pump) rest while playback is paused; see
    /// `TickContext::stop_on_pause`. On until the host says otherwise.
    stop_on_pause: AtomicBool,
    estim_volume: Mutex<bp_devices::ramp::VolumeSettings>,
    /// A Detection source wants frames run through the detector, tracking or not.
    detect_wanted: AtomicBool,
    /// The host hides what the detector finds (Gooner mode): every frame goes through it,
    /// tracking or not, and each run's boxes are kept for `detect_boxes`.
    boxes_wanted: AtomicBool,
    /// A held Detection source changes on scene cuts, so cuts are watched for without a tracker.
    cuts_wanted: AtomicBool,
    /// Scene cuts since the engine started, from the tracker or `cut_watch`.
    scene_cuts: AtomicU64,
    /// Cut detection on the frames that arrive while no tracker runs, with the media time of
    /// the last one so a gap re-primes it instead of reading as a cut.
    cut_watch: Mutex<Option<(CutDetector, f64)>>,
    /// The held value per parameter axis on a Detection source with a hold.
    param_hold: Mutex<[HoldState; Axis::COUNT]>,
    /// Live tracker motion the tick thread reads behind the wall clock.
    timeline: Mutex<Timeline>,
    /// The movement model's live output, the same way; NaN where an axis is released.
    model_timeline: Mutex<Timeline>,
    /// The two AI models, by `slot_index`.
    models: Mutex<[ModelSlot; 2]>,
    /// Any axis on the table is on AI Motion, so the feeds should run.
    motion_wanted: AtomicBool,
    /// The pace both AI models are conditioned on, 0..1, one per video.
    pace: Mutex<f64>,
    /// The live detector's latest run, on the wall clock, for the live model rows.
    box_run: Mutex<Option<bp_model::BoxRun>>,
    /// The player's hardware decoder, for the passes the engine starts on its own.
    hwdec: Mutex<Option<String>>,
    /// The tracker's tunables, kept for a lookahead started later.
    track_options: Mutex<TrackOptions>,
    /// Tracking ahead of playback on the loaded file, while the player's own local file is
    /// being tracked. Motion keyed by media time, read at media time minus each axis's offset.
    lookahead: Mutex<Option<Lookahead>>,
    /// What the player has loaded, for the lookahead.
    media_path: Mutex<Option<String>>,
    /// Why the last load failed (a page yt-dlp cannot read, a missing file); cleared by the next load.
    load_error: Mutex<Option<String>>,
    /// The detector model the host loaded, so a lookahead can run its own copy.
    detector_model: Mutex<Option<DetectorModel>>,
    /// Which axes follow the tracker, and how hard.
    track_axes: Mutex<TrackAxes>,
    /// The running tracker, kept here so the detector thread can hand it regions.
    track: Mutex<Option<Track>>,
    detect: Mutex<Option<Detect>>,
    detect_options: Mutex<DetectOptions>,
    detect_clock: Mutex<DetectClock>,
    region: Mutex<RegionState>,
    beat: Arc<Mutex<Beat>>,
    /// Whether `apply_selection` last put a Beat script on an axis, so a live refresh knows
    /// it can swap scripts in place instead of registering the axis first.
    beat_live_installed: AtomicBool,
    hero: Mutex<HeroState>,
    /// Zone effects: boxes read from the colour frames and the detector's last boxes.
    zones: Mutex<ZoneState>,
    /// Some zone reads the detector, so frames go through it while tracking.
    zones_detect: AtomicBool,
    /// The whole-file generation's progress and cancel flag, one run at a time.
    generate: Arc<generate::State>,
    /// The editor's draft: scripts per axis the mixer plays over the file's while the editor
    /// is open. Cleared by every load and by `unload`.
    draft: Mutex<Vec<(Axis, Arc<Script>)>>,
    /// The editor's range analysis: its progress and cancel flag, one run at a time.
    range: Arc<range::State>,
    /// The silent decode the range analysis keeps between runs.
    analyser: Mutex<Option<range::Analyser>>,
    /// The Buttplug server a page (faptap.net) drives the stroke through, while enabled.
    intiface: Mutex<Option<IntifaceServer>>,
    /// The stroke came from that server on the last tick, so its end releases the axis.
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
/// Shortest still span reported on a script; the host picks what is long enough to skip.
const GAP_MIN_MS: f64 = 1000.0;
/// Media time between frames past which the cut watch primes again instead of comparing.
const CUT_WATCH_GAP_MS: f64 = 1000.0;

impl Engine {
    pub fn new(width: u32, height: u32, opts: EngineOptions) -> Result<Engine, String> {
        let shared = Arc::new(Shared {
            clock: Mutex::new(Clock::new()),
            browser_tracking: AtomicBool::new(false),
            browser_clock: Mutex::new(Clock::new()),
            mixer: Mutex::new(Mixer::new()),
            outputs: Mutex::new(Vec::new()),
            history: Mutex::new(History { frames: VecDeque::new(), expected_ms: 0.0, lead: 0.0 }),
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
            stop_on_pause: AtomicBool::new(true),
            estim_volume: Mutex::new(bp_devices::ramp::VolumeSettings::default()),
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
            beat_live_installed: AtomicBool::new(false),
            hero: Mutex::new(HeroState::new()),
            zones: Mutex::new(ZoneState::new()),
            zones_detect: AtomicBool::new(false),
            generate: Arc::new(generate::State::new()),
            draft: Mutex::new(Vec::new()),
            range: Arc::new(range::State::new()),
            analyser: Mutex::new(None),
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

    /// Loads the video and every script found for it, on the calling thread. Axis settings
    /// are left as they are; the host applies per-video settings after this returns. Hosts
    /// with a UI thread call `player.load`, run `scan_pool` elsewhere and `loader().apply`.
    pub fn load(
        &self,
        path: &str,
        start_seconds: Option<f64>,
        variants: &[(Axis, String)],
    ) -> Result<MediaInfo, String> {
        let loader = self.loader();
        let pool = loader.pool_for(path, None, &[]);
        loader.load(path, start_seconds, pool, variants, None)
    }

    /// The video alone; `loader().apply` brings the scripts. A running lookahead moves to the
    /// new file.
    pub fn load_media(&self, path: &str, start_seconds: Option<f64>) -> Result<(), String> {
        self.loader().load_media(path, start_seconds, None)
    }

    /// Starts tracking ahead of playback on the loaded file when it is local, replacing any
    /// lookahead on another file. Nothing to track ahead on a page or a stream.
    fn start_lookahead(&self) {
        self.shared.restart_lookahead(self.player.hwdec_current());
    }

    /// The scripts for `path` without touching the player, for driving devices off an
    /// external clock. `variants` names the script to play per axis where several exist;
    /// the plain one plays otherwise.
    pub fn load_scripts(&self, path: &str, variants: &[(Axis, String)]) -> MediaInfo {
        let path = Path::new(path);
        self.loader().apply(path, scan_pool(path), variants)
    }

    /// Loading for a host with a UI thread: scan the pool on a worker (`pool_for`, or
    /// `prepare` ahead of time), then `load` on the thread that owns the engine.
    pub fn loader(&self) -> ScriptLoader {
        ScriptLoader {
            shared: self.shared.clone(),
            media: self.player.media_loader(),
        }
    }

    /// Switches the script playing on an axis to a named variant, or back to the plain one.
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

    /// Stops playback and drops the scripts; axes auto-home from wherever they are.
    pub fn unload(&self) -> Result<(), String> {
        self.player.stop()?;
        self.shared.loaded.store(false, Ordering::Relaxed);
        *self.shared.media_path.lock().unwrap() = None;
        self.shared.beat.lock().unwrap().clear();
        self.shared.beat_live_installed.store(false, Ordering::Relaxed);
        *self.shared.lookahead.lock().unwrap() = None;
        self.shared.pool.lock().unwrap().clear();
        self.shared.generated.lock().unwrap().clear();
        self.shared.draft.lock().unwrap().clear();
        // A run in progress holds the lock; it notices the path change on its next run.
        if let Ok(mut a) = self.shared.analyser.try_lock() {
            *a = None;
        }
        self.shared.set_scripts(Vec::new());
        let mut clock = self.shared.clock.lock().unwrap();
        clock.report(0.0);
        clock.duration_ms = 0.0;
        clock.snap();
        Ok(())
    }

    /// Follows a VR player's clock instead of our own: local playback pauses and mpv's
    /// events stop reaching the clock until `unfollow`. Watch `follow_state().path` and
    /// hand it to `load_scripts`; scripts already loaded keep playing until you do.
    pub fn follow(&self, kind: FollowKind, host: &str, port: Option<u16>) -> Result<(), String> {
        let mut slot = self.follow.lock().unwrap();
        if let Some(mut old) = slot.take() {
            old.stop();
        }
        self.player.pause()?;
        self.shared.following.store(true, Ordering::Relaxed);
        {
            // Hold the clock still until the player reports; it has no position yet.
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

    /// Stops following and snaps the clock back onto our own player.
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

    /// Seeks to the exact time rather than the nearest keyframe, for the editor.
    pub fn seek_exact(&self, seconds: f64) -> Result<(), String> {
        self.player.seek_exact(seconds.max(0.0))
    }

    /// Steps one frame forward or back; the player is left paused.
    pub fn frame_step(&self, forward: bool) -> Result<(), String> {
        self.player.frame_step(forward)
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

    /// Manual drive for "find my range": a raw device position until released with `None`.
    pub fn set_live(&self, axis: Axis, value: Option<f64>) {
        self.shared.mixer.lock().unwrap().set_live(axis, value);
    }

    /// Starts the live tracker. Frames go in through `track_frame`; the axes in the table
    /// follow them until `track_stop`, each read behind the wall clock by its offset. With
    /// `lookahead`, the frames are the player's own and, when the loaded file is local, a
    /// second decode tracks ahead of playback so an axis can run ahead of the picture (a
    /// negative offset) instead of behind it.
    pub fn track_start(&self, options: TrackOptions, axes: TrackAxes, lookahead: bool) {
        self.track_stop();
        self.shared.browser_tracking.store(!lookahead, Ordering::Relaxed);
        self.shared.beat_live_installed.store(false, Ordering::Relaxed);
        *self.shared.browser_clock.lock().unwrap() = Clock::new();
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
                for_frames.zone_frame(rgb, w, h, time_ms);
            },
            // The movement model on the same frames, causal, every few frames; its samples
            // are spaced back from now by the frame interval so the newest is the newest.
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
        // A region applied by the detector or picked earlier carries over to the new tracker.
        self.apply_region_source();
        self.shared.apply_selection();
        self.shared.ensure_music();
    }

    /// Keeps the player's decoder choice for the passes the engine starts on its own.
    fn note_hwdec(&self) {
        *self.shared.hwdec.lock().unwrap() =
            Some(self.player.hwdec_current()).filter(|h| !h.is_empty());
    }

    /// Loads a downloaded AI model (or unloads with `None`) on its own thread: the metadata is
    /// checked against the engine's feature layout, the graph compiled and warmed up. Watch
    /// `model_state`. Axes on the model's source use it from the next frame.
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

    /// The pace both AI models are conditioned on, 0..1: one value per video. Takes effect on
    /// the movement model's next window; the music model runs again on its cached pass.
    pub fn set_pace(&self, pace: f64) {
        *self.shared.pace.lock().unwrap() = pace.clamp(0.0, 1.0);
        self.note_hwdec();
        self.shared.ensure_music();
    }

    pub fn pace(&self) -> f64 {
        self.shared.pace()
    }

    /// Analyses a raw mono f32le sample file (`bp_beat::RATE`) for the Beat source. Axes on
    /// Beat get their scripts once it is ready; watch `beat_state`.
    pub fn beat_load(&self, path: PathBuf) {
        self.note_hwdec();
        self.shared.beat.lock().unwrap().fps = self.player.video_fps();
        let shared = self.shared.clone();
        Beat::load(&self.shared.beat, path, move || {
            shared.apply_selection();
            shared.ensure_music();
        });
    }

    /// Ends the Beat source, from a file or live audio.
    pub fn beat_clear(&self) {
        self.shared.beat_live_installed.store(false, Ordering::Relaxed);
        self.shared.beat.lock().unwrap().clear();
        self.shared.apply_selection();
    }

    pub fn beat_window_begin(&self, reset: bool) -> u32 {
        let token = {
            let mut beat = self.shared.beat.lock().unwrap();
            beat.fps = self.player.video_fps();
            beat.window_begin(reset)
        };
        if reset {
            self.shared.beat_live_installed.store(false, Ordering::Relaxed);
            self.shared.apply_selection();
        }
        token
    }

    pub fn beat_set_window(&self, track: BeatTrack, start_ms: f64, token: u32, continuous: bool) -> bool {
        if !self.shared.beat.lock().unwrap().set_window(track, start_ms, token, continuous) { return false; }
        if continuous { self.shared.refresh_beat_scripts(); } else { self.shared.apply_selection(); }
        true
    }

    pub fn beat_window_error(&self, token: u32, error: String) {
        self.shared.beat.lock().unwrap().window_error(token, error);
    }

    /// Starts the Beat source on live audio: `beat_live_push` feeds it, and `beat_clear`
    /// ends it. Beat times count from the first sample, so with browser-style tracking the
    /// `track_frame` times must count from the same instant.
    pub fn beat_live_start(&self) {
        self.shared.beat_live_installed.store(false, Ordering::Relaxed);
        self.shared.beat.lock().unwrap().live_start();
        self.shared.apply_selection();
    }

    /// Mono samples at `bp_beat::RATE` in playback order for the live Beat source. Cheap:
    /// the analysis runs on its own thread and the Beat axes' scripts follow it.
    pub fn beat_live_push(&self, samples: &[f32]) {
        let shared = self.shared.clone();
        Beat::live_push(&self.shared.beat, samples, move || shared.refresh_beat_scripts());
    }

    pub fn set_beat_options(&self, options: BeatOptions) {
        // Raw detections are analysis data; playback always needs generated strokes.
        self.shared.beat.lock().unwrap().options = BeatOptions {
            style: BeatStyle::Strokes,
            ..options
        };
        self.shared.apply_selection();
    }

    pub fn beat_state(&self) -> BeatSnapshot {
        self.shared.beat.lock().unwrap().snapshot()
    }

    /// The Hero source's zone (none turns it off) and scroll direction.
    pub fn set_hero_options(&self, zone: Option<HeroRect>, direction: HeroDirection) {
        self.shared
            .hero
            .lock()
            .unwrap()
            .set_options(zone, direction);
        self.shared.apply_selection();
    }

    /// Replace the per-video AI music overrides as a whole.
    pub fn set_hero_music(&self, options: HeroMusicOptions) {
        self.shared.hero.lock().unwrap().music = options;
    }

    /// The current playback multiplier from a colour hit or a zone, whichever started later;
    /// the host applies it without saving the temporary rate.
    pub fn effect_speed(&self) -> f64 {
        if !self.shared.timeline.lock().unwrap().active || self.shared.following.load(Ordering::Relaxed) {
            return 1.0;
        }
        let mut clock = self.shared.clock.lock().unwrap();
        if !clock.running() {
            return 1.0;
        }
        let time = clock.now();
        drop(clock);
        let music = self.shared.track_axes.lock().unwrap().iter().any(|a| a.source == TrackSource::AiMusic);
        let hit = music.then(|| self.shared.hero.lock().unwrap().music_at(time)).flatten().map(|(s, r)| (s, r.playback_speed));
        let zone = self.shared.zones.lock().unwrap().active_at(time).map(|(s, _, o)| (s, o.playback_speed));
        match (hit, zone) {
            (Some(h), Some(z)) => if z.0 >= h.0 { z.1 } else { h.1 },
            (h, z) => h.or(z).map_or(1.0, |e| e.1),
        }
    }

    /// Replaces the zone effects as a whole.
    pub fn set_zones(&self, enabled: bool, zones: Vec<Zone>) {
        let mut z = self.shared.zones.lock().unwrap();
        z.set(enabled, zones);
        self.shared.zones_detect.store(z.wants_detector(), Ordering::Relaxed);
    }

    /// Every zone's share and whether it is on, at the clock's time.
    pub fn zone_state(&self) -> Vec<ZoneMatch> {
        let time = self.shared.clock.lock().unwrap().now();
        self.shared.zones.lock().unwrap().snapshot(time)
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

    /// The axis follows the shared colour table again.
    pub fn clear_hero_axis_colours(&self, axis: Axis) {
        self.shared.hero.lock().unwrap().clear_axis_colours(axis);
        self.shared.apply_selection();
    }

    pub fn hero_state(&self) -> HeroSnapshot {
        self.shared.hero.lock().unwrap().snapshot()
    }

    /// Loads a downloaded model (or unloads with `None`). The path is the host's: the engine
    /// never downloads. `cache_dir` keeps the compiled CoreML graph between runs.
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

    /// Whether the host should keep sending frames while tracking is off: a Detection
    /// parameter source is set on a restim output, or the host hides what is detected.
    pub fn wants_frames(&self) -> bool {
        self.shared.detect_wanted.load(Ordering::Relaxed)
            || self.shared.boxes_wanted.load(Ordering::Relaxed)
    }

    /// The host hides what the detector finds: frames are wanted and every one is run, not
    /// one per `DetectOptions::interval_ms`.
    pub fn set_boxes_wanted(&self, wanted: bool) {
        self.shared.boxes_wanted.store(wanted, Ordering::Relaxed);
    }

    /// The last run's number and its boxes of the given kinds, in 0..1 of the frame. Empty
    /// (run 0) until a model is ready and has seen a frame.
    pub fn detect_boxes(&self, kinds: &[DetectKind]) -> (u64, Vec<Found>) {
        match self.shared.detect.lock().unwrap().as_ref() {
            Some(d) => {
                let s = d.snapshot();
                (s.runs, s.boxes_of(kinds))
            }
            None => (0, Vec::new()),
        }
    }

    /// Whether a held Detection source is waiting on scene cuts, so a host that sends frames
    /// now and then should send them often enough for cuts to show (about ten a second).
    pub fn wants_cuts(&self) -> bool {
        self.shared.cuts_wanted.load(Ordering::Relaxed)
    }

    /// The value a held Detection source is sending for the axis and the media time it was
    /// set, `None` while the axis is not held or nothing has arrived yet.
    pub fn param_hold(&self, axis: Axis) -> Option<(f64, f64)> {
        self.shared.param_hold.lock().unwrap()[axis.index()].held
    }

    pub fn set_detect_options(&self, options: DetectOptions) {
        *self.shared.detect_options.lock().unwrap() = options;
    }

    /// Auto (the detector), the centre, or a picked box. Applies at once to a running tracker.
    pub fn set_track_region_source(&self, source: RegionSource) {
        self.shared.region.lock().unwrap().source = source;
        self.apply_region_source();
    }

    pub fn track_region_source(&self) -> RegionSource {
        self.shared.region.lock().unwrap().source
    }

    /// What Auto looks for. A change drops the last box: it was of the old kind.
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

    /// Stops tracking and releases the axis. The samples stay readable for saving.
    pub fn track_stop(&self) {
        self.shared.browser_tracking.store(false, Ordering::Relaxed);
        {
            let mut hero = self.shared.hero.lock().unwrap();
            hero.music = HeroMusicOptions::default();
            hero.reset_hits();
        }
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
        // The file's own scripts come back on axes Beat was driving.
        self.shared.apply_selection();
    }

    /// Live change to which axes follow the tracker. An axis switched off is released on
    /// the next tick; one switched to or from Beat gets its script swapped; the tracker takes
    /// the rows' smoothing.
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

    /// Playback state of the browser video. The player's clock remains available on return.
    pub fn track_playback(&self, media_ms: f64, playing: bool, rate: f64) {
        if !self.shared.browser_tracking.load(Ordering::Relaxed) {
            return;
        }
        let mut clock = self.shared.browser_clock.lock().unwrap();
        clock.set_paused(!playing);
        clock.set_idle(!playing);
        clock.set_speed(rate);
        clock.report(media_ms);
    }

    /// One row-major frame, grayscale (`channels` 1) or packed RGB (3), with the source's
    /// media time. Frames that arrive while the tracker is busy replace the one waiting. Only
    /// RGB frames reach the detector. With tracking off, RGB frames still feed the detector
    /// while a Detection parameter source wants them.
    pub fn track_frame(&self, bytes: &[u8], channels: u32, width: u32, height: u32, time_ms: f64) {
        if self.shared.browser_tracking.load(Ordering::Relaxed) {
            self.shared.browser_clock.lock().unwrap().report(time_ms);
        }
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

    /// `None` tracks the centre 60 percent by 60 percent; a box picks it. Same as
    /// `set_track_region_source` with Centre or Pick.
    pub fn set_track_region(&self, region: Option<Region>) {
        self.set_track_region_source(match region {
            Some(r) => RegionSource::Pick(r),
            None => RegionSource::Centre,
        });
    }

    /// Smoothing is not taken from here: it is per axis, on the table. The lookahead picks
    /// the change up on its next frame.
    pub fn set_track_options(&self, options: TrackOptions) {
        let smoothing_ms = smoothing(&self.shared.track_axes.lock().unwrap());
        let options = TrackOptions {
            smoothing_ms,
            ..options
        };
        let flourishes_changed = {
            let mut current = self.shared.track_options.lock().unwrap();
            let changed = current.flourishes != options.flourishes;
            *current = options;
            changed
        };
        if let Some(t) = self.shared.track.lock().unwrap().as_ref() {
            t.tracker.lock().unwrap().set_options(options);
        }
        if flourishes_changed {
            self.shared.apply_selection();
        }
    }

    pub fn track_state(&self) -> TrackState {
        // The timeline first, then the tracker: the worker takes them in the same order.
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

    /// A run through the whole loaded file with the tracking table as it stands, for saving
    /// scripts: the flow tracker, the detector on Auto and the Hero watcher see every frame,
    /// Beat axes take the analysed audio. Call `run` on the result off the UI thread and
    /// watch `generate_progress`. Fails without a local file, with nothing on the table, or
    /// while a run is already on.
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
            !matches!(
                axes[a.index()].source,
                TrackSource::Off | TrackSource::Faptap
            ) && (!axes[a.index()].source.on_frames() || track_component(*a).is_some())
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

    /// Asks a running generation to stop; `run` returns an error shortly after.
    pub fn generate_cancel(&self) {
        self.shared.generate.cancel.store(true, Ordering::Relaxed);
    }

    /// Installs scripts generated for the loaded file: outputs that host the script (Howl,
    /// the Handy) get them over the file's scripts on those axes, so a phone playing on its
    /// own follows what the tracker would have done. The mixer, and so every other output,
    /// keeps the live path. An empty list puts the file's scripts back. Cleared by a load.
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

    /// The editor's draft for one axis: the mixer plays it in place of the file's script
    /// (`None` puts the file's back on that axis) without a resync, as a script that grows
    /// while it plays. Outputs that host the script are left alone until `push_draft_hosted`.
    pub fn set_draft(&self, axis: Axis, script: Option<Script>) {
        let script = script.map(Arc::new);
        {
            let mut d = self.shared.draft.lock().unwrap();
            d.retain(|(a, _)| *a != axis);
            if let Some(s) = &script {
                d.push((axis, s.clone()));
            }
        }
        let file = self
            .shared
            .scripts
            .lock()
            .unwrap()
            .iter()
            .find(|(a, _)| *a == axis)
            .map(|(_, s)| s.clone());
        self.shared
            .mixer
            .lock()
            .unwrap()
            .set_script_live(axis, script.or(file));
    }

    /// Drops the draft: the file's scripts play again everywhere.
    pub fn clear_draft(&self) {
        self.shared.draft.lock().unwrap().clear();
        let scripts = self.shared.scripts.lock().unwrap().clone();
        self.shared.set_scripts(scripts);
    }

    /// Hands the draft to outputs that host the script themselves (Howl, the Handy), which
    /// take a whole script: on pause rather than on every edit.
    pub fn push_draft_hosted(&self) {
        let scripts = self.shared.scripts.lock().unwrap().clone();
        let with_draft = overlay(&scripts, &self.shared.draft.lock().unwrap());
        let hosted = overlay(&with_draft, &self.shared.generated.lock().unwrap());
        let media = self.shared.hosted_media();
        for o in self.shared.outputs.lock().unwrap().iter_mut() {
            o.set_scripts(&hosted, &media);
        }
    }

    /// A range analysis for the editor over the loaded local file. Call `run` on the result
    /// off the UI thread and watch `range_progress`. Fails without a local file or while a
    /// run is on.
    pub fn range_analyser(&self) -> Result<RangeAnalyser, String> {
        let local = self
            .shared
            .media_path
            .lock()
            .unwrap()
            .as_deref()
            .is_some_and(is_local);
        if !local {
            return Err("only a local file can be analysed".into());
        }
        if self.shared.range.busy() {
            return Err("a range analysis is already on".into());
        }
        self.shared.range.cancel.store(false, Ordering::Relaxed);
        self.shared.range.progress.lock().unwrap().status = RangeStatus::Running;
        let hwdec = Some(self.player.hwdec_current()).filter(|h| !h.is_empty());
        Ok(RangeAnalyser::new(self.shared.clone(), hwdec))
    }

    pub fn range_progress(&self) -> RangeProgress {
        self.shared.range.progress.lock().unwrap().clone()
    }

    /// Asks a running range analysis to stop; `run` returns an error shortly after.
    pub fn range_cancel(&self) {
        self.shared.range.cancel.store(true, Ordering::Relaxed);
    }

    /// Drops the editor's decode; the next analysis opens it again. Nothing while a run holds it.
    pub fn range_close(&self) {
        if let Ok(mut a) = self.shared.analyser.try_lock() {
            *a = None;
        }
    }

    /// The last two seconds of tracked positions, for a trace view. Copies the samples, so
    /// ask when the view is open rather than every frame.
    pub fn track_trace(&self) -> Vec<Sample> {
        match self.shared.track.lock().unwrap().as_ref() {
            Some(t) => t.tracker.lock().unwrap().trace().to_vec(),
            None => Vec::new(),
        }
    }

    /// Every tracked sample from `since_ms` onward, keyed by the source's media time. `pos`
    /// is the stroke as the device saw it: through the L0 row's intensity and invert.
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

    /// Device button presses since the last call.
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

    /// The newest position a connected device reports for its own slider, 0..1, for the
    /// editor's recording. None while no device reports one.
    pub fn device_slider(&self) -> Option<f64> {
        self.shared
            .outputs
            .lock()
            .unwrap()
            .iter()
            .find_map(|o| o.slider())
    }

    /// Applies temporary attenuation without changing the user's output configuration.
    pub fn set_output_session_scale(&self, id: u32, scale: f64) -> bool {
        if !scale.is_finite() || !(0.0..=1.0).contains(&scale) { return false; }
        let mut outputs = self.shared.outputs.lock().unwrap();
        let Some(output) = outputs.iter_mut().find(|o| o.id == id) else { return false; };
        if matches!(output.transport, bp_devices::Transport::Howl { .. }) && scale != 0.0 && scale != 1.0 { return false; }
        output.session_scale = scale;
        true
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

    /// Shakes another axis into an output's stroke, or stops with `None`. False for an
    /// unknown output or one that takes no per-tick position.
    pub fn set_output_vibration(&self, id: u32, vibration: Option<Vibration>) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs
            .iter_mut()
            .find(|o| o.id == id)
            .is_some_and(|o| o.set_vibration(vibration))
    }

    /// When an output gets each position against the video, in ms: negative early (for a
    /// slow device), positive late. False for an unknown output or one that plays the script
    /// itself.
    pub fn set_output_delay(&self, id: u32, ms: f64) -> bool {
        if !ms.is_finite() {
            return false;
        }
        let ms = ms.clamp(-DELAY_MAX_MS, DELAY_MAX_MS);
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs
            .iter_mut()
            .find(|o| o.id == id)
            .is_some_and(|o| o.set_delay(ms))
    }

    /// Points a toy's feature at an axis, or off. False for any other output.
    pub fn set_output_feature_axis(&self, id: u32, feature: u32, axis: Option<Axis>) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs
            .iter_mut()
            .find(|o| o.id == id)
            .is_some_and(|o| o.set_feature_axis(feature, axis))
    }

    /// Gives a toy's level feature its own input window and output range, or the default
    /// with `None`. False for any other output.
    pub fn set_output_feature_level(&self, id: u32, feature: u32, level: Option<bp_devices::LevelMap>) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs
            .iter_mut()
            .find(|o| o.id == id)
            .is_some_and(|o| o.set_feature_level(feature, level))
    }

    /// Whether levels (vibration, suction, a pump) rest while playback is paused, on every
    /// output. Off, they hold their last value the way a stroker holds its position.
    pub fn set_stop_on_pause(&self, on: bool) {
        self.shared.stop_on_pause.store(on, Ordering::Relaxed);
    }

    pub fn stop_on_pause(&self) -> bool {
        self.shared.stop_on_pause.load(Ordering::Relaxed)
    }

    /// Live per-channel strength on a Coyote output, 0..200.
    pub fn set_coyote_strength(&self, id: u32, a: u8, b: u8) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs
            .iter_mut()
            .find(|o| o.id == id)
            .is_some_and(|o| o.set_strength(a, b))
    }

    /// Live trigger on an OpenShock output: the axis, the line and what fires past it.
    pub fn set_openshock_trigger(&self, id: u32, trigger: OpenShockTrigger) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs
            .iter_mut()
            .find(|o| o.id == id)
            .is_some_and(|o| o.set_openshock_trigger(trigger))
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

    /// Session volume ramp on a restim output. Turning it on starts it from the beginning.
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

    /// The wizard's test on an output that has its own (Howl's script, an OpenShock pulse).
    /// False when the output does not, or is not connected; the host sweeps the live axis for those.
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

    /// Starts the Buttplug server that stands in for Intiface Central, so a page such as
    /// faptap.net drives the stroke. Fails when the port is taken; a server already on
    /// another port is replaced.
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

    /// The server's port and clients; `None` while it is off.
    pub fn intiface_status(&self) -> Option<IntifaceStatus> {
        self.shared
            .intiface
            .lock()
            .unwrap()
            .as_ref()
            .map(IntifaceServer::status)
    }

    /// Where a restim parameter axis takes its value without a script. False for any other axis.
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

    /// Shared estim balance, volume floor and parameter settings; see `EstimOptions`.
    pub fn set_estim(&self, options: EstimOptions) {
        *self.shared.estim_volume.lock().unwrap() = bp_devices::ramp::VolumeSettings {
            min: options.volume_floor,
            max: options.volume_max,
            boost: options.volume_boost,
        }.validated();
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
        let volume = *self.shared.estim_volume.lock().unwrap();
        EstimOptions {
            contrast: self.shared.mixer.lock().unwrap().electrode_contrast(),
            volume_floor: volume.min,
            volume_max: volume.max,
            volume_boost: volume.boost,
            params: self.shared.params_enabled.load(Ordering::Relaxed),
        }
    }

    /// Everything the UI shows at 60 Hz. Cheap: no mpv calls, no sorting, and each lock is
    /// taken on its own and dropped at once.
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

    /// The decoded picture size as last reported by mpv's events, 0 by 0 when nothing is loaded.
    pub fn video_size(&self) -> (u32, u32) {
        (
            self.shared.video_size.0.load(Ordering::Relaxed),
            self.shared.video_size.1.load(Ordering::Relaxed),
        )
    }

    /// Whether anyone is looking at the frames; while not, mpv skips drawing and nothing is
    /// read back. Audio and the clock carry on.
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

    /// Counters and timings for one output, for a diagnostics view. None for an unknown id.
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

/// Loading split for a host with a UI thread. Cloneable and thread-safe: `prepare` and
/// `pool_for` scan on a worker, `load` and `apply` are quick and run on the thread that
/// owns the engine.
#[derive(Clone)]
pub struct ScriptLoader {
    shared: Arc<Shared>,
    media: bp_player::MediaLoader,
}

impl ScriptLoader {
    /// Scans the scripts beside `path` and keeps them for its load, so a session's next clip
    /// swaps in without a scan. One file at a time; a later `prepare` replaces it.
    /// `scripts_path` is a local stand-in whose siblings are scanned instead, for a stream
    /// from a library server whose scripts the host cached on disk.
    pub fn prepare(&self, path: &str, scripts_path: Option<&str>, folders: &[String]) {
        let pool = scan_pool_with_folders(Path::new(scripts_path.unwrap_or(path)), folders);
        let key = format!("{path:?}:{scripts_path:?}:{folders:?}");
        *self.shared.prepared.lock().unwrap() = Some((key, pool));
    }

    /// The pool for `path`: the prepared one when it is for this file, else a fresh scan
    /// (of `scripts_path` when given, as in `prepare`).
    pub fn pool_for(&self, path: &str, scripts_path: Option<&str>, folders: &[String]) -> Vec<PoolEntry> {
        let key = format!("{path:?}:{scripts_path:?}:{folders:?}");
        let mut prepared = self.shared.prepared.lock().unwrap();
        match prepared.take() {
            Some((p, pool)) if p == key => pool,
            other => {
                *prepared = other;
                drop(prepared);
                scan_pool_with_folders(Path::new(scripts_path.unwrap_or(path)), folders)
            }
        }
    }

    /// The file and its scripts together: the clock is held at the start position and the
    /// new scripts ramp the axes to their opening values while mpv opens the file, so no
    /// old script plays against the new position and nothing jumps when the picture starts.
    /// `remote` carries a library server stream's HTTP headers (see `MediaLoader::load`).
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

    /// The video alone. A running lookahead moves to the new file.
    pub fn load_media(
        &self,
        path: &str,
        start_seconds: Option<f64>,
        remote: Option<&str>,
    ) -> Result<(), String> {
        *self.shared.load_error.lock().unwrap() = None;
        self.media.load(path, start_seconds, remote)?;
        *self.shared.media_path.lock().unwrap() = Some(path.to_string());
        self.shared.beat.lock().unwrap().clear();
        self.shared.beat_live_installed.store(false, Ordering::Relaxed);
        if self.shared.lookahead.lock().unwrap().is_some() {
            self.shared.restart_lookahead(self.media.hwdec_current());
        }
        self.shared
            .preset_clock(start_seconds.unwrap_or(0.0) * 1000.0);
        Ok(())
    }

    /// Installs a scanned pool as the loaded scripts.
    pub fn apply(
        &self,
        path: &Path,
        pool: Vec<PoolEntry>,
        variants: &[(Axis, String)],
    ) -> MediaInfo {
        *self.shared.pool.lock().unwrap() = pool;
        *self.shared.variants.lock().unwrap() = variants.to_vec();
        self.shared.generated.lock().unwrap().clear();
        self.shared.draft.lock().unwrap().clear();
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

    /// The movement model, once loaded and quick enough to run live.
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

    /// A model finished loading (or was unloaded): the music model starts its pass, and the
    /// selection is redone so an AI CH/PMV axis plays what is there now.
    fn after_model(self: &Arc<Self>, kind: ModelKind) {
        if kind == ModelKind::Music {
            if self.music_loaded().is_none() {
                self.beat.lock().unwrap().clear_music();
            }
            self.apply_selection();
            self.ensure_music();
        }
    }

    /// Starts the music model's pass on the loaded local file when an axis is on AI CH/PMV,
    /// the model is loaded and the beats are known. A request already made is not repeated.
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

    /// Holds the clock at the position a load starts from until mpv reports the new file, so
    /// the scripts installed with it sit at their opening values through the load. The axes
    /// ramp there from wherever they are. Nothing while a VR player owns the clock.
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

    /// Starts tracking ahead of playback on the loaded file when it is local, replacing any
    /// lookahead on another file. Nothing to track ahead on a page or a stream.
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

    /// Alpha and beta are derived from the stroke, and the electrodes from those, only while
    /// a restim output exists. The derivation runs outside the mixer lock.
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

    /// The parameter sources become mixer fallbacks while a restim output exists and the
    /// parameter axes are enabled, and are cleared otherwise so the parameter axes are not
    /// sent anywhere. Audio and Detection get their value in `tick`; here they only note that
    /// the tick has work.
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

    /// Scene cuts on a frame that arrives while no tracker runs, while a held Detection
    /// source wants them. A jump in media time (a seek, a pause) primes again rather than
    /// counting the first frame after it as a cut.
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

    /// Values for the Audio and Detection sources at this tick, `None` where the source has
    /// nothing yet (audio not analysed, no model), so the axis is not sent.
    fn live_param_values(&self, media_ms: f64) -> Vec<(Axis, Option<f64>)> {
        let sources = self.param_sources.lock().unwrap().clone();
        if !sources.iter().any(ParamSource::is_live) {
            return Vec::new();
        }
        let loudness = sources
            .iter()
            .any(|s| *s == ParamSource::Audio && !self.browser_tracking.load(Ordering::Relaxed))
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
        if let PlayerEvent::VideoFps(fps) = e {
            let changed = {
                let mut beat = self.beat.lock().unwrap();
                let changed = beat.live.is_none() && beat.fps != fps;
                if changed { beat.fps = fps; }
                changed && beat.track.is_some()
            };
            if changed { self.refresh_beat_timing(); }
            return;
        }
        if let PlayerEvent::VideoSize(w, h) = e {
            self.video_size.0.store(w, Ordering::Relaxed);
            self.video_size.1.store(h, Ordering::Relaxed);
            return;
        }
        if self.following.load(Ordering::Relaxed) {
            return;
        }
        let speed_changed = matches!(e, PlayerEvent::Speed(_));
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
                self.hero.lock().unwrap().reset_hits();
                self.zones.lock().unwrap().reset();
                clock.snap();
                self.mixer.lock().unwrap().resync();
            }
            PlayerEvent::PlaybackRestart => clock.snap(),
            PlayerEvent::EndFile { error: Some(e) } => *self.load_error.lock().unwrap() = Some(e),
            PlayerEvent::EndFile { .. } | PlayerEvent::VideoSize(..) | PlayerEvent::VideoFps(_) => {}
        }
        drop(clock);
        if speed_changed { self.refresh_beat_timing(); }
    }

    /// The followed player drives the clock the same way mpv does. The scripts stay as
    /// they are on a path change: the host decides what to load for the new file.
    fn on_follow_event(&self, e: FollowEvent) {
        match e {
            FollowEvent::Time(ms) => self.clock.lock().unwrap().report(ms),
            FollowEvent::Duration(ms) => self.clock.lock().unwrap().duration_ms = ms,
            FollowEvent::Speed(s) => {
                self.clock.lock().unwrap().set_speed(s);
                self.refresh_beat_timing();
            }
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

    /// Picks one script per axis from the pool (the chosen variant, else the default),
    /// loads them, and describes the whole pool with the selection marked.
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
        let browser = self.browser_tracking.load(Ordering::Relaxed);
        let mut loaded: Vec<(Axis, Arc<Script>)> = chosen
            .iter()
            .filter(|_| !browser)
            .map(|&i| (pool[i].axis, pool[i].script.clone()))
            .collect();
        drop(pool);
        // While tracking, an axis on Beat, Hero or AI CH/PMV plays the generated script instead
        // of the file's. AI CH/PMV plays Beat's until the music model's script arrives, which
        // takes the row's intensity and invert itself rather than baking them in.
        if self.timeline.lock().unwrap().active {
            let axes = *self.track_axes.lock().unwrap();
            let flourishes = self.track_options.lock().unwrap().flourishes;
            let playback_rate = if browser { self.browser_clock.lock().unwrap().speed() } else { self.clock.lock().unwrap().speed() };
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
                    TrackSource::Beat => beat.playback_script(axis, a, flourishes, playback_rate),
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
                        .or_else(|| beat.playback_script(axis, a, flourishes, playback_rate)),
                    _ => None,
                };
                if let Some(script) = script {
                    if matches!(a.source, TrackSource::Beat | TrackSource::AiMusic) {
                        self.beat_live_installed.store(true, Ordering::Relaxed);
                    }
                    loaded.retain(|(ax, _)| *ax != axis);
                    loaded.push((axis, Arc::new(script)));
                }
            }
        }
        self.set_scripts(loaded);
        infos
    }

    /// Metadata and rate changes only rebuild the table when a Beat source uses it.
    fn refresh_beat_timing(&self) {
        let active = self.timeline.lock().unwrap().active;
        let uses_beats = self.track_axes.lock().unwrap().iter()
            .any(|a| matches!(a.source, TrackSource::Beat | TrackSource::AiMusic));
        if active && uses_beats { self.apply_selection(); }
    }

    /// A new live Beat analysis is in: the Beat axes' scripts are swapped in place, without
    /// a resync, as `hero_frame` does. Until an axis has a Beat script at all it goes through
    /// `apply_selection` so the axis is registered. Locks are taken one at a time.
    fn refresh_beat_scripts(&self) {
        if !self.timeline.lock().unwrap().active {
            return;
        }
        if !self.beat_live_installed.load(Ordering::Relaxed) {
            self.apply_selection();
            return;
        }
        let axes = *self.track_axes.lock().unwrap();
        let flourishes = self.track_options.lock().unwrap().flourishes;
        let (now, playback_rate) = {
            let clock = if self.browser_tracking.load(Ordering::Relaxed) { &self.browser_clock } else { &self.clock };
            let clock = clock.lock().unwrap();
            (clock.peek(), clock.speed())
        };
        let lead = self.outputs.lock().unwrap().iter().filter(|o| o.connected()).map(|o| -o.delay_ms).fold(0.0_f64, f64::max);
        let scripts: Vec<(Axis, Script)> = {
            let beat = self.beat.lock().unwrap();
            Axis::ALL
                .iter()
                .filter_map(|&axis| {
                    let a = axes[axis.index()];
                    if a.source != TrackSource::Beat && !(a.source == TrackSource::AiMusic && beat.music_script(axis).is_none()) {
                        return None;
                    }
                    let script = beat.playback_script(axis, a, flourishes, playback_rate)?;
                    Some((axis, script))
                })
                .collect()
        };
        let mut mixer = self.mixer.lock().unwrap();
        for (axis, script) in scripts {
            if script.actions.is_empty() {
                mixer.set_script_live(axis, Some(Arc::new(script)));
                continue;
            }
            let committed = now + lead * playback_rate - mixer.global_offset_ms - mixer.settings(axis).offset_ms;
            let script = mixer.loaded().iter().find(|(a, _)| *a == axis).map_or_else(
                || script.clone(),
                |(_, previous)| bp_beat::continue_script(previous, script.clone(), committed, bp_beat::MAX_SPEED / playback_rate.max(0.01)),
            );
            mixer.set_script_live(axis, Some(Arc::new(script)));
        }
    }

    /// One colour frame for the Hero watcher; new or moved hits regrow the Hero axes' scripts
    /// in place, without a resync.
    fn hero_frame(&self, rgb: &[u8], w: usize, h: usize, time_ms: f64) {
        let axes = *self.track_axes.lock().unwrap();
        let mut hero = self.hero.lock().unwrap();
        if !axes.iter().any(|a| a.source == TrackSource::Hero || (a.source == TrackSource::AiMusic && hero.music.enabled)) {
            return;
        }
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

    /// One colour frame for the zones: the colour zones read it, the body part zones read the
    /// detector's last run.
    fn zone_frame(&self, rgb: &[u8], w: usize, h: usize, time_ms: f64) {
        let mut zones = self.zones.lock().unwrap();
        if !zones.enabled {
            return;
        }
        if zones.wants_frames() {
            zones.push_colour(rgb, w, h, time_ms);
        }
        if zones.wants_detector() {
            let boxes = match self.detect.lock().unwrap().as_ref() {
                Some(d) => d.snapshot().boxes,
                None => Vec::new(),
            };
            zones.push_boxes(&boxes, time_ms);
        }
    }

    /// What an output that hosts scripts itself shows for the media: its name, and the `.hwl`
    /// beside a local file when one exists (Howl plays that instead of a funscript).
    fn hosted_media(&self) -> Media {
        if self.browser_tracking.load(Ordering::Relaxed) {
            return Media::default();
        }
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

    /// What an output that hosts the script gets: the loaded scripts with the generated ones
    /// over their axes.
    fn hosted_scripts(&self) -> Vec<(Axis, Arc<Script>)> {
        if self.browser_tracking.load(Ordering::Relaxed) {
            return self.scripts.lock().unwrap().clone();
        }
        overlay(
            &self.scripts.lock().unwrap(),
            &self.generated.lock().unwrap(),
        )
    }

    /// Hands the scripts to any output that hosts them itself and loads them into the mixer,
    /// with the editor's draft over them for the mixer alone. The table (alpha and beta
    /// derived from the stroke) is built before the mixer lock is taken; locks are taken one
    /// at a time and never nested.
    fn set_scripts(&self, scripts: Vec<(Axis, Arc<Script>)>) {
        let media = self.hosted_media();
        let browser = self.browser_tracking.load(Ordering::Relaxed);
        let hosted = if browser {
            scripts.clone()
        } else {
            overlay(&scripts, &self.generated.lock().unwrap())
        };
        let expand = {
            let mut outputs = self.outputs.lock().unwrap();
            for o in outputs.iter_mut() {
                o.set_scripts(&hosted, &media);
            }
            outputs.iter().any(|o| o.profile == Profile::Restim)
        };
        let for_mixer = if browser {
            scripts.clone()
        } else {
            overlay(&scripts, &self.draft.lock().unwrap())
        };
        let table = ScriptTable::build(for_mixer, expand);
        {
            let mut mixer = self.mixer.lock().unwrap();
            mixer.install(table);
            mixer.resync();
        }
        *self.scripts.lock().unwrap() = scripts;
    }

    /// Called by the track worker with every colour frame (and by `track_frame` when tracking
    /// is off but frames are wanted): the detector gets it when the region is Auto, a
    /// Detection source is set, boxes are wanted or a zone reads it, the model is ready, and
    /// either a cut just happened or the interval is up. With boxes wanted every frame goes; the thread drops
    /// what it cannot keep up with.
    fn offer_to_detector(&self, rgb: &[u8], w: usize, h: usize, cuts: u64) {
        let now = wall_ms();
        let (source, target, floor) = {
            let r = self.region.lock().unwrap();
            (r.source, r.target, r.auto.floor(now))
        };
        let boxes = self.boxes_wanted.load(Ordering::Relaxed);
        if source != RegionSource::Auto && !self.detect_wanted.load(Ordering::Relaxed) && !boxes && !self.zones_detect.load(Ordering::Relaxed) {
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

    /// The detector's verdict on a frame, applied to the live tracker's region and kept for the
    /// movement model's rows.
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

    /// One output tick. Returns how precisely the next one should be woken: precision costs
    /// a spinning core, so it is only asked for while a connected device is being written to.
    fn tick(&self, t: deadline::Tick) -> Pace {
        let (media_ms, playing, rate) = {
            let clock = if self.browser_tracking.load(Ordering::Relaxed) {
                &self.browser_clock
            } else {
                &self.clock
            };
            let mut clock = clock.lock().unwrap();
            let now = clock.now();
            (now, clock.running(), clock.speed())
        };
        // Each output has a delay against the video, in wall ms: negative for a slow device
        // that must be told early, positive for one to hold back. While playing, the mixer
        // runs ahead of the video by the earliest delay and every output is handed the frame
        // from (its delay minus the earliest) ms back, so an output at -500 gets the slam that
        // is 1 s into the video at 0.5 s and one at 0 gets it at 1 s. Paused, everything rests
        // on the frame the picture shows. Links that play the script themselves (the Handy,
        // Howl) keep the video's own time in `TickContext::media_ms`.
        let video_ms = media_ms;
        let mut delays: Vec<f64> = if playing {
            self.outputs.lock().unwrap().iter().filter(|o| o.connected()).map(|o| o.delay_ms).collect()
        } else {
            Vec::new()
        };
        delays.sort_by(f64::total_cmp);
        delays.dedup();
        let (earliest, latest) = delays.iter().fold((0.0_f64, 0.0_f64), |(lo, hi), d| (lo.min(*d), hi.max(*d)));
        let lead = -earliest;
        let media_ms = video_ms + lead * rate;
        // Each tracked axis reads the lookahead at media time minus its offset, or, where
        // nothing is tracked ahead, the live timeline that far behind the wall clock (the live
        // path cannot see ahead, so a negative offset there is 0). Stale live frames (the page
        // paused, the tab went away) release the axis so auto-home takes over.
        let tracking = self.timeline.lock().unwrap().active;
        // The stroke's row while tracking, read before the mixer is held.
        let stroke_row = tracking.then(|| self.track_axes.lock().unwrap()[Axis::L0.index()]);
        let stroke_source = stroke_row.map(|r| r.source);
        // Axes read from the live timeline this tick: the lookahead is indexed by media time
        // and mixes ahead like a script, but a live frame is only ever right for now.
        let mut from_live = [false; Axis::COUNT];
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
                // An AI Motion axis reads the model through the same lookahead-then-live path;
                // a released component (NaN) is nothing, and until the model has scored the
                // flow tracker stands in.
                if a.source == TrackSource::AiMotion && model {
                    let ahead = lookahead
                        .as_ref()
                        .and_then(|l| l.model_value_at(media_ms - offsets[i]));
                    let live = ahead.is_none();
                    if let Some(m) = ahead.or_else(|| model_tl.value_at(now, offsets[i])) {
                        from_live[i] = live;
                        return m[c.index()].is_finite().then(|| a.map(m[c.index()]));
                    }
                }
                let ahead = lookahead
                    .as_ref()
                    .and_then(|l| l.value_at(media_ms - offsets[i]));
                let live = ahead.is_none();
                let motion = ahead.or_else(|| tl.value_at(now, offsets[i]))?;
                from_live[i] = live;
                Some(a.map(motion[c.index()]))
            })
        });
        let music_axes = *self.track_axes.lock().unwrap();
        let (offsets, derived, scripted) = {
            let mixer = self.mixer.lock().unwrap();
            (std::array::from_fn::<_, { Axis::COUNT }, _>(|i| mixer.global_offset_ms + mixer.settings(Axis::ALL[i]).offset_ms),
             std::array::from_fn::<_, { Axis::COUNT }, _>(|i| mixer.is_derived(Axis::ALL[i])),
             std::array::from_fn::<_, { Axis::COUNT }, _>(|i| mixer.has_script(Axis::ALL[i])))
        };
        // Colour hits reach the AI music axes; a zone reaches every scripted axis. Where an axis
        // has both, the one that started later wins, as among hits and among zones.
        let (effects, estim_max, estim_max_relative, vibe_max) = {
            let hero = self.hero.lock().unwrap();
            let zones = self.zones.lock().unwrap();
            let live = tracking && playing;
            let music_on = live && music_axes.iter().any(|a| a.source == TrackSource::AiMusic);
            let effects = std::array::from_fn::<_, { Axis::COUNT }, _>(|i| {
                let axis = Axis::ALL[i];
                let row = music_axes[i];
                let inherited = matches!(axis, Axis::EA | Axis::EB) && derived[i];
                let stroke = inherited || axis == Axis::L0;
                let time = media_ms - offsets[i];
                let hit = if music_on && (row.source == TrackSource::AiMusic || (inherited && music_axes[Axis::L0.index()].source == TrackSource::AiMusic)) {
                    hero.music_at(time).map(|(start_ms, rule)| bp_axes::ScriptEffect {
                        start_ms, end_ms: start_ms + rule.duration_ms,
                        tempo: rule.tempo, intensity: rule.intensity,
                        stroke_speed: if stroke { rule.stroke_speed } else { None },
                        min: if inherited { 0.0 } else { row.min },
                        max: if inherited { 1.0 } else { row.max },
                    })
                } else { None };
                let zone = if live && (scripted[i] || inherited) {
                    zones.active_at(time).map(|(start_ms, end_ms, o)| {
                        // A generated script already sits within the row's limits; a file's plays 0..1.
                        let generated = !inherited && matches!(row.source, TrackSource::Beat | TrackSource::AiMusic | TrackSource::Hero);
                        bp_axes::ScriptEffect {
                            start_ms, end_ms,
                            tempo: o.tempo, intensity: o.intensity,
                            stroke_speed: if stroke { o.stroke_speed } else { None },
                            min: if generated { row.min } else { 0.0 },
                            max: if generated { row.max } else { 1.0 },
                        }
                    })
                } else { None };
                match (hit, zone) {
                    (Some(h), Some(z)) => Some(if z.start_ms >= h.start_ms { z } else { h }),
                    (h, z) => h.or(z),
                }
            });
            let hit = music_on.then(|| hero.music_at(media_ms)).flatten().map(|(s, r)| (s, r.estim_max, r.estim_max_relative, r.vibe_max));
            let zone = live.then(|| zones.active_at(media_ms)).flatten().map(|(s, _, o)| (s, o.estim_max, o.estim_max_relative, o.vibe_max));
            let winner = match (hit, zone) {
                (Some(h), Some(z)) => Some(if z.0 >= h.0 { z } else { h }),
                (h, z) => h.or(z),
            };
            (effects, winner.and_then(|w| w.1), winner.and_then(|w| w.2), winner.and_then(|w| w.3))
        };
        let live_params = if self.live_params.load(Ordering::Relaxed) {
            self.live_param_values(media_ms)
        } else {
            Vec::new()
        };
        let (frame, driven, flags, keyframes) = {
            let mut mixer = self.mixer.lock().unwrap();
            for axis in Axis::ALL {
                mixer.set_script_effect(axis, effects[axis.index()]);
            }
            mixer.set_max_override(Axis::V0, vibe_max);
            for (axis, value) in live_params {
                mixer.set_fallback(axis, value.map_or(Fallback::None, Fallback::Value));
            }
            // A page driving the stroke through the Intiface server owns the axis while the
            // table puts the stroke on Faptap or Off (nobody commanding releases it), and with
            // tracking off it takes the axis while commanding. The tracked loop leaves L0 alone
            // then: clearing and re-setting the source each tick would restart the onset ramp.
            let remote_owned =
                matches!(stroke_source, Some(TrackSource::Faptap | TrackSource::Off));
            if let Some(values) = tracked {
                for axis in Axis::ALL
                    .into_iter()
                    .filter(|a| track_component(*a).is_some() && !(remote_owned && *a == Axis::L0))
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
            if remote_owned || (stroke_source.is_none() && (remote.is_some() || was_remote)) {
                // On Faptap the row's limits and invert apply, as on every other source.
                let value = match stroke_row {
                    Some(r) if r.source == TrackSource::Faptap => remote.map(|v| r.map(v)),
                    _ => remote,
                };
                mixer.set_source(Axis::L0, value);
                from_live[Axis::L0.index()] = true;
            }
            let frame = mixer.tick(media_ms, t.dt_ms);
            let flags: [u8; Axis::COUNT] = std::array::from_fn(|i| {
                let a = Axis::ALL[i];
                (mixer.has_script(a) as u8 * FLAG_SCRIPT)
                    | (mixer.is_derived(a) as u8 * FLAG_DERIVED)
                    | (mixer.is_live(a) as u8 * FLAG_LIVE)
                    | (mixer.has_external(a) as u8 * FLAG_TRACKED)
            });
            // Alpha, beta and the electrodes the mixer expands from a live stroke have no
            // tracked component of their own; they follow the stroke's source.
            for i in (0..Axis::COUNT)
                .filter(|i| flags[*i] & FLAG_TRACKED != 0 && track_component(Axis::ALL[*i]).is_none())
            {
                from_live[i] = from_live[Axis::L0.index()];
            }
            // The stroke's next keyframe for each delay in use: an output at delay d plays
            // the script d ms behind the video (ahead for a negative delay), so it reads the
            // keyframe from there and gets the wall time left to reach it.
            let keyframes: Vec<(f64, Option<Keyframe>)> = delays
                .iter()
                .filter(|_| rate > 0.0)
                .map(|d| {
                    let at = video_ms - d * rate;
                    let k = mixer.next_keyframe(Axis::L0, at).map(|k| Keyframe {
                        at_ms: k.at,
                        pos: k.pos,
                        in_ms: ((k.at - at) / rate).max(0.0),
                    });
                    (*d, k)
                })
                .collect();
            (frame, *mixer.driven(), flags, keyframes)
        };
        // With the parameter axes off nothing drives them as far as the outputs know, so a
        // video's carrier or pulse scripts stay in the app; restim keeps its own settings.
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
        let estim_volume = estim_with_override(*self.estim_volume.lock().unwrap(), estim_max, estim_max_relative);
        let ctx = TickContext {
            manual_axes: std::array::from_fn(|i| flags[i] & (FLAG_LIVE | FLAG_TRACKED) != 0),
            media_ms: video_ms,
            stroke_next: None,
            playing,
            estim_manual: [Axis::EA, Axis::EB, Axis::EV, Axis::E1, Axis::E2, Axis::E3, Axis::E4]
                .into_iter().any(|a| flags[a.index()] & FLAG_LIVE != 0 && driven[a.index()]),
            stop_on_pause: self.stop_on_pause.load(Ordering::Relaxed),
            estim_volume,
            rate,
            interval_ms: ((t.dt_ms + 0.75).floor() as u32).clamp(1, 100),
        };
        let (connected, wrote, shown) = {
            let mut outputs = self.outputs.lock().unwrap();
            let (mut connected, mut wrote) = (false, false);
            let mut h = self.history.lock().unwrap();
            // A seek, a pause or resume, or a change of lead: the buffered frames are from
            // another timeline, so the held-back outputs start over from the current frame.
            if (video_ms - h.expected_ms).abs() > JUMP_MS || h.lead != lead {
                h.frames.clear();
            }
            h.expected_ms = video_ms + if playing { t.dt_ms * rate } else { 0.0 };
            h.lead = lead;
            h.frames.push_back(Mixed { at: t.fired, frame, driven });
            let keep = Duration::from_secs_f64((latest - earliest) / 1000.0 + 0.05);
            while h.frames.front().is_some_and(|m| t.fired.duration_since(m.at) > keep) {
                h.frames.pop_front();
            }
            let back = |delay: f64| {
                (delay > 0.0)
                    .then(|| frame_back(&h.frames, t.fired, Duration::from_secs_f64(delay / 1000.0)))
                    .flatten()
            };
            for o in outputs.iter_mut() {
                o.poll();
                connected |= o.connected();
                // An output that connected this tick has no keyframe yet and samples once.
                let stroke_next = keyframes.iter().find(|(d, _)| *d == o.delay_ms).and_then(|(_, k)| *k);
                let ctx = TickContext { stroke_next, ..ctx };
                wrote |= match back(o.delay_ms - earliest) {
                    Some(m) => {
                        // Live sources (the tracker, a page, a hand) cannot be mixed ahead,
                        // so those axes go out as they are now. A tracked axis read from the
                        // lookahead was mixed ahead like a script, so its history frame stands.
                        let (mut f, mut d) = (m.frame, m.driven);
                        for i in (0..Axis::COUNT).filter(|i| flags[*i] & FLAG_LIVE != 0 || (flags[*i] & FLAG_TRACKED != 0 && from_live[*i])) {
                            f[i] = frame[i];
                            d[i] = driven[i];
                        }
                        o.send(&f, &d, &ctx)
                    }
                    None => o.send(&frame, &driven, &ctx),
                };
            }
            // The UI shows where the video is, not where the mixer runs ahead to.
            let shown = back(lead).map_or(frame, |m| m.frame);
            (connected, wrote, shown)
        };
        {
            let mut p = self.published.lock().unwrap();
            p.values = shown;
            if p.flags != flags {
                p.flags = flags;
                p.version += 1;
            }
        }
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
        // A quiet device (paused and homed) gives up precision after half a second; its next
        // line goes out a millisecond late and the one after is precise again.
        if connected && (playing || tracked.is_some() || s.since_write < RELAX_AFTER_TICKS) {
            Pace::Precise
        } else {
            Pace::Relaxed
        }
    }
}

/// Milliseconds since the first call: the live tracker's clock for the detector hold.
fn wall_ms() -> f64 {
    static EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// The detector's verdict folded into the last box. A hit becomes the box (the detector only
/// offers what the rule allows: nothing worse than the held target until it has been missing
/// for `AUTO_HOLD_MS`), though one that barely moved is left alone so the tracker is not
/// restarted for nothing. A miss keeps the box (the target is assumed still there) unless the
/// frame followed a cut, when it means the centre.
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

/// `scripts` with `over` written over their axes; the rest stay.
fn overlay(
    scripts: &[(Axis, Arc<Script>)],
    over: &[(Axis, Arc<Script>)],
) -> Vec<(Axis, Arc<Script>)> {
    let mut out: Vec<(Axis, Arc<Script>)> = scripts
        .iter()
        .filter(|(axis, _)| !over.iter().any(|(g, _)| g == axis))
        .cloned()
        .collect();
    out.extend(over.iter().cloned());
    out
}

/// A file on disk rather than a page or a stream, so a second decode can run ahead on it.
fn is_local(path: &str) -> bool {
    !path.contains("://") || path.starts_with("file://")
}

/// A detected region no smaller than `MIN_AUTO_REGION` on each side, grown about its centre
/// and kept inside the frame.
fn grow_region(r: Region) -> Region {
    let w = r.w.max(MIN_AUTO_REGION).min(1.0);
    let h = r.h.max(MIN_AUTO_REGION).min(1.0);
    let x = (r.x + r.w / 2.0 - w / 2.0).clamp(0.0, 1.0 - w);
    let y = (r.y + r.h / 2.0 - h / 2.0).clamp(0.0, 1.0 - h);
    Region { x, y, w, h }
}

/// Whether two regions are close enough that swapping one for the other is not worth a
/// tracker restart: centres within 15 percent of the size, sizes within 25 percent.
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

/// Reads, parses and measures every script for `media`, variants included. Pure and slow
/// (tens of ms for a multi-axis set), so hosts run it off their UI thread and hand the
/// result to `ScriptLoader::apply`.
pub fn scan_pool(media: &Path) -> Vec<PoolEntry> {
    scan_pool_with_folders(media, &[])
}

/// Reads sibling scripts first, then missing axes from the supplied folders.
pub fn scan_pool_with_folders(media: &Path, folders: &[String]) -> Vec<PoolEntry> {
    bp_script::find_scripts_with_folders(media, folders)
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

/// Script metadata for a media file without touching the player, for library scans. The
/// selection is the default one, so the library shows what would play.
pub fn scan_scripts(path: &Path) -> Vec<ScriptInfo> {
    scan_scripts_with_folders(path, &[])
}

pub fn scan_scripts_with_folders(path: &Path, folders: &[String]) -> Vec<ScriptInfo> {
    let pool = scan_pool_with_folders(path, folders);
    describe(&pool, &default_selection(&pool))
}

/// Per axis, the plain script when there is one, else the first variant. The pool keeps
/// plain scripts ahead of variants, so that is the first entry per axis.
fn default_selection(pool: &[PoolEntry]) -> Vec<usize> {
    let mut out: Vec<usize> = Vec::new();
    for (i, e) in pool.iter().enumerate() {
        if !out.iter().any(|&j| pool[j].axis == e.axis) {
            out.push(i);
        }
    }
    out
}

/// Every script in the pool, marked selected when its index is in `chosen`.
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
        gaps: heatmap::stills(script, GAP_MIN_MS),
        chapters: script.chapters.clone(),
        bookmarks: script.bookmarks.clone(),
    }
}

/// Apply a temporary maximum to a copy, keeping the normal maximum as the relative base.
fn estim_with_override(mut volume: bp_devices::ramp::VolumeSettings, absolute: Option<f64>, relative: Option<f64>) -> bp_devices::ramp::VolumeSettings {
    if let Some(max) = relative.map(|factor| (volume.max * factor).clamp(0.0, 1.0)).or(absolute) {
        volume.max = max;
        volume.min = volume.min.min(max);
        volume.boost.enabled = false;
    }
    volume
}

#[cfg(test)]
mod tests {
    #[test]
    fn relative_estim_uses_normal_max_and_restores_without_compounding() {
        use bp_devices::ramp::{VolumeSettings, VolumeBoost};
        let normal = VolumeSettings { min: 0.45, max: 0.5, boost: VolumeBoost { enabled: true, ..Default::default() } };
        for _ in 0..3 {
            let active = super::estim_with_override(normal, None, Some(0.8));
            assert_eq!(active.max, 0.4);
            assert_eq!(active.min, 0.4);
            assert!(!active.boost.enabled);
        }
        assert_eq!(super::estim_with_override(normal, None, None), normal);
        assert_eq!(super::estim_with_override(normal, Some(0.7), None).max, 0.7);
        assert_eq!(super::estim_with_override(normal, None, Some(0.0)).max, 0.0);
        let higher = VolumeSettings { max: 0.8, ..normal };
        assert_eq!(super::estim_with_override(higher, None, Some(2.0)).max, 1.0);
    }

    use super::*;
    use std::fs;

    #[test]
    fn frame_back_picks_the_newest_frame_old_enough() {
        let start = Instant::now();
        let mixed = |ms: u64| Mixed { at: start + Duration::from_millis(ms), frame: [ms as f64; Axis::COUNT], driven: [false; Axis::COUNT] };
        let history: VecDeque<Mixed> = (0..=5).map(|i| mixed(i * 10)).collect();
        let now = start + Duration::from_millis(50);
        let at = |delay| frame_back(&history, now, Duration::from_millis(delay)).map(|m| m.frame[0]);
        assert_eq!(at(0), Some(50.0));
        assert_eq!(at(25), Some(20.0));
        assert_eq!(at(30), Some(20.0));
        // Asking further back than the buffer holds falls to the oldest kept.
        assert_eq!(at(500), Some(0.0));
        assert_eq!(frame_back(&VecDeque::new(), now, Duration::ZERO).map(|m| m.frame[0]), None);
    }

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
        let hosted = overlay(&file, &generated);
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
        assert_eq!(overlay(&file, &[]), file);
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
        // A miss keeps the box, and the target is assumed there until the hold is up.
        let missed = next_auto_region(held, None, false, 3500.0, 0.0);
        assert_eq!(missed, held);
        assert_eq!(missed.floor(3999.0), Some(bp_detect::Target::Genitals));
        assert_eq!(missed.floor(4000.0), None, "anything may take over now");
        // A cut drops everything: the next verdict starts from the centre.
        assert_eq!(
            next_auto_region(held, None, true, 1500.0, 0.0),
            AutoRegion::default()
        );
        // The fallback becomes the held target, and the original comes straight back over it.
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
        // Intensity no longer moves the position at all.
        let lively = TrackAxis {
            intensity: 2.0,
            ..a
        };
        assert_eq!(lively.map(0.9), a.map(0.9));
        // It halves the smoothing at 2 and doubles it at 0.5, floored so 0 is finite.
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
