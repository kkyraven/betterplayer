//! The engine: libmpv player, media clock, script mixer and device outputs, driven by one
//! fixed-rate tick thread. The host (napi) is a thin layer over this.

mod beat;
mod clock;
mod detect;
mod follow;
mod generate;
mod hero;
mod lookahead;
mod params;
mod track;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Instant;

use bp_axes::{AxisSettings, Fallback, Frame, Mixer, ScriptTable};
use bp_devices::{AxisClamp, IntifaceServer, IntifaceStatus, Output, OutputSnapshot, OutputStats, Pace, PercentilesUs, Profile, TickContext, Transport, deadline, percentiles};
use bp_player::{Player, PlayerEvent, PlayerOptions};
use bp_script::{Axis, Container, Kind, Script, find_scripts, heatmap};

use beat::Beat;
use clock::Clock;
use detect::Detect;
use hero::HeroState;
use lookahead::Lookahead;
use follow::{Follow, FollowEvent, FollowSink};
use track::{Timeline, Track};

pub use beat::{BeatOptions, BeatSnapshot, BeatStatus};
pub use bp_hero::{BUCKETS as HERO_BUCKETS, BUCKET_NAMES as HERO_BUCKET_NAMES, Direction as HeroDirection, Hero as RawHero, Note as HeroNote, Options as HeroOptions, Rect as HeroRect};
pub use generate::{GenerateProgress, GenerateStatus, Generation};
pub use hero::{ColourRule, Flourish, HeroSnapshot};
pub use bp_beat::{ENVELOPE_HOP_MS as BEAT_ENVELOPE_HOP_MS, ONSET_HOP_MS as BEAT_ONSET_HOP_MS, Style as BeatStyle, analyse as beat_analyse};
pub use bp_detect::{Kind as DetectKind, MODELS, ModelSpec};
pub use detect::{DetectSnapshot, DetectStatus, Found};

pub use bp_axes::{Provider, SmartLimit};
pub use bp_devices::{RampConfig, RampProgress};
pub use bp_player::{External, RenderSnapshot};
pub use bp_script::{Bookmark, Chapter, Interpolation};
pub use bp_tracking::{Component, Motion, Phase, Region, Sample, TrackOptions, Tracker as RawTracker};
pub use params::{DetectionSource, Hold, HoldState};
use bp_tracking::CutDetector;
pub use follow::{FollowKind, FollowState, FollowStatus};

pub struct EngineOptions {
    pub hz: u32,
    pub spin_us: u32,
    pub player: PlayerOptions,
}

impl Default for EngineOptions {
    fn default() -> EngineOptions {
        EngineOptions { hz: 100, spin_us: 500, player: PlayerOptions::default() }
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

impl ParamSource {
    /// Audio and Detection change every tick; the rest are set once.
    fn is_live(&self) -> bool {
        matches!(self, ParamSource::Audio | ParamSource::Detection(_))
    }
}

/// Where an axis takes its live value from while tracking. Video is the flow, live; Beat is a
/// script generated from the audio, played on the media clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackSource {
    Video,
    Beat,
    Hero,
    Off,
}

/// One axis's row of the tracking table: its source, how much of the motion it uses, the
/// span of the axis it may use, how smoothed it is and whether it runs the other way.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackAxis {
    pub source: TrackSource,
    pub intensity: f64,
    /// Limits: the full 0..1 motion is squeezed into `min..max`.
    pub min: f64,
    pub max: f64,
    /// Time constant of the smoothing on this axis's motion component; 0 is off.
    pub smoothing_ms: f64,
    pub invert: bool,
}

impl TrackAxis {
    pub const OFF: TrackAxis = TrackAxis { source: TrackSource::Off, intensity: 1.0, min: 0.0, max: 1.0, smoothing_ms: bp_tracking::SMOOTHING_MS, invert: false };

    fn video(intensity: f64, min: f64, max: f64, smoothing_ms: f64) -> TrackAxis {
        TrackAxis { source: TrackSource::Video, intensity, min, max, smoothing_ms, invert: false }
    }

    /// A tracked 0..1 position scaled about the middle, flipped and squeezed into the limits,
    /// ready for the mixer.
    pub fn map(&self, v: f64) -> f64 {
        let v = if self.invert { 1.0 - v } else { v };
        self.limit((0.5 + (v - 0.5) * self.intensity).clamp(0.0, 1.0))
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
    for (axis, intensity) in [(Axis::L2, 0.6), (Axis::L1, 0.4), (Axis::R1, 0.6), (Axis::R2, 0.4)] {
        axes[axis.index()] = TrackAxis::video(intensity, 0.25, 0.75, bp_tracking::SMOOTHING_SIDE_MS);
    }
    axes
}

/// The tracker's per-component smoothing, read off the axes table.
fn smoothing(axes: &TrackAxes) -> [f64; Component::COUNT] {
    let mut out = [bp_tracking::SMOOTHING_MS; Component::COUNT];
    for axis in Axis::ALL {
        if let Some(c) = track_component(axis) {
            out[c.index()] = axes[axis.index()].smoothing_ms.max(0.0);
        }
    }
    out
}

/// A downloaded detector model: its spec, the file and a cache directory for the compiled graph.
pub type DetectorModel = (&'static ModelSpec, PathBuf, Option<PathBuf>);

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
        DetectOptions { interval_ms: 700.0, padding: 0.4 }
    }
}

struct RegionState {
    source: RegionSource,
    /// What Auto looks for: one kind, or `None` for the rule (genitals, else a face).
    target: Option<DetectKind>,
    /// The padded box the detector last applied, kept across misses.
    auto: Option<Region>,
    /// What that box was: a face does not replace genitals until a cut says the scene changed.
    auto_target: Option<bp_detect::Target>,
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

/// What the tick thread publishes for the UI: the pipeline output and the per-axis flags,
/// with a version that moves only when the flags do.
struct Published {
    values: Frame,
    flags: [u8; Axis::COUNT],
    version: u64,
}

struct Shared {
    clock: Mutex<Clock>,
    mixer: Mutex<Mixer>,
    outputs: Mutex<Vec<Output>>,
    /// The loaded scripts, kept so an output connected mid-video can still host them.
    scripts: Mutex<Vec<(Axis, Arc<Script>)>>,
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
    /// A Detection source wants frames run through the detector, tracking or not.
    detect_wanted: AtomicBool,
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
    hero: Mutex<HeroState>,
    /// The whole-file generation's progress and cancel flag, one run at a time.
    generate: Arc<generate::State>,
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
/// Media time between frames past which the cut watch primes again instead of comparing.
const CUT_WATCH_GAP_MS: f64 = 1000.0;

impl Engine {
    pub fn new(width: u32, height: u32, opts: EngineOptions) -> Result<Engine, String> {
        let shared = Arc::new(Shared {
            clock: Mutex::new(Clock::new()),
            mixer: Mutex::new(Mixer::new()),
            outputs: Mutex::new(Vec::new()),
            scripts: Mutex::new(Vec::new()),
            pool: Mutex::new(Vec::new()),
            prepared: Mutex::new(None),
            variants: Mutex::new(Vec::new()),
            published: Mutex::new(Published { values: std::array::from_fn(|i| Axis::ALL[i].default_value()), flags: [0; Axis::COUNT], version: 0 }),
            video_size: (AtomicU32::new(0), AtomicU32::new(0)),
            param_sources: Mutex::new(std::array::from_fn(|_| ParamSource::Restim)),
            live_params: AtomicBool::new(false),
            detect_wanted: AtomicBool::new(false),
            cuts_wanted: AtomicBool::new(false),
            scene_cuts: AtomicU64::new(0),
            cut_watch: Mutex::new(None),
            param_hold: Mutex::new([HoldState::default(); Axis::COUNT]),
            timeline: Mutex::new(Timeline::new()),
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
            region: Mutex::new(RegionState { source: RegionSource::Centre, target: None, auto: None, auto_target: None }),
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

        Ok(Engine { player, shared, tick: Some(tick), follow: Mutex::new(None), hz: opts.hz, next_output: 1 })
    }

    /// Loads the video and every script found for it, on the calling thread. Axis settings
    /// are left as they are; the host applies per-video settings after this returns. Hosts
    /// with a UI thread call `player.load`, run `scan_pool` elsewhere and `loader().apply`.
    pub fn load(&self, path: &str, start_seconds: Option<f64>, variants: &[(Axis, String)]) -> Result<MediaInfo, String> {
        let loader = self.loader();
        let pool = loader.pool_for(path);
        loader.load(path, start_seconds, pool, variants)
    }

    /// The video alone; `loader().apply` brings the scripts. A running lookahead moves to the
    /// new file.
    pub fn load_media(&self, path: &str, start_seconds: Option<f64>) -> Result<(), String> {
        self.loader().load_media(path, start_seconds)
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
        ScriptLoader { shared: self.shared.clone(), media: self.player.media_loader() }
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
        *self.shared.lookahead.lock().unwrap() = None;
        self.shared.pool.lock().unwrap().clear();
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
        *slot = Some(Follow::start(kind, host, port.unwrap_or(kind.default_port()), sink));
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
        let (time_ms, duration_ms, paused) = (self.player.time_pos() * 1000.0, self.player.duration() * 1000.0, self.player.paused());
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
        self.shared.mixer.lock().unwrap().set_settings(axis, settings);
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
        *self.shared.track_axes.lock().unwrap() = axes;
        let options = TrackOptions { smoothing_ms: smoothing(&axes), ..options };
        *self.shared.track_options.lock().unwrap() = options;
        {
            let mut tl = self.shared.timeline.lock().unwrap();
            tl.clear();
            tl.active = true;
        }
        if lookahead {
            self.start_lookahead();
        }
        let shared = self.shared.clone();
        let for_frames = self.shared.clone();
        *self.shared.track.lock().unwrap() = Some(Track::start(
            options,
            move |s| {
                shared.timeline.lock().unwrap().push_sample(Instant::now(), s.motion);
            },
            move |rgb, w, h, time_ms, cuts| {
                for_frames.offer_to_detector(rgb, w, h, cuts);
                for_frames.hero_frame(rgb, w, h, time_ms);
            },
        ));
        self.shared.mixer.lock().unwrap().resync();
        // A region applied by the detector or picked earlier carries over to the new tracker.
        self.apply_region_source();
        self.shared.apply_selection();
    }

    /// Analyses a raw mono f32le sample file (`bp_beat::RATE`) for the Beat source. Axes on
    /// Beat get their scripts once it is ready; watch `beat_state`.
    pub fn beat_load(&self, path: PathBuf) {
        let shared = self.shared.clone();
        Beat::load(&self.shared.beat, path, move || {
            shared.apply_selection();
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

    /// The Hero source's zone (none turns it off) and scroll direction.
    pub fn set_hero_options(&self, zone: Option<HeroRect>, direction: HeroDirection) {
        self.shared.hero.lock().unwrap().set_options(zone, direction);
        self.shared.apply_selection();
    }

    /// What a colour bucket does, for one axis or (`None`) the shared table every axis
    /// without its own follows. Applies to the next hits and regrows the scripts.
    pub fn set_hero_colour(&self, axis: Option<Axis>, bucket: usize, rule: ColourRule) {
        if bucket < HERO_BUCKETS {
            self.shared.hero.lock().unwrap().set_colour(axis, bucket, rule);
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
            *detect = Some(Detect::start(move |found, after_cut| shared.on_detected(found, after_cut)));
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
    /// parameter source is set on a restim output.
    pub fn wants_frames(&self) -> bool {
        self.shared.detect_wanted.load(Ordering::Relaxed)
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
            r.auto = None;
            r.auto_target = None;
        }
        *self.shared.detect_clock.lock().unwrap() = DetectClock::default();
        self.apply_region_source();
    }

    fn apply_region_source(&self) {
        let region = {
            let r = self.shared.region.lock().unwrap();
            match r.source {
                RegionSource::Auto => r.auto,
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
        if let Some(t) = self.shared.track.lock().unwrap().as_mut().filter(|t| t.active) {
            t.stop();
        }
        *self.shared.lookahead.lock().unwrap() = None;
        let mut tl = self.shared.timeline.lock().unwrap();
        if !tl.active {
            return;
        }
        tl.active = false;
        tl.clear();
        drop(tl);
        let mut mixer = self.shared.mixer.lock().unwrap();
        for axis in Axis::ALL.into_iter().filter(|a| track_component(*a).is_some()) {
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
            let generated = |s: TrackSource| matches!(s, TrackSource::Beat | TrackSource::Hero);
            let beat_changed = Axis::ALL.iter().any(|a| generated(current[a.index()].source) != generated(axes[a.index()].source) || (generated(axes[a.index()].source) && current[a.index()] != axes[a.index()]));
            *current = axes;
            beat_changed
        };
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
    }

    pub fn track_axes(&self) -> TrackAxes {
        *self.shared.track_axes.lock().unwrap()
    }

    /// One row-major frame, grayscale (`channels` 1) or packed RGB (3), with the source's
    /// media time. Frames that arrive while the tracker is busy replace the one waiting. Only
    /// RGB frames reach the detector. With tracking off, RGB frames still feed the detector
    /// while a Detection parameter source wants them.
    pub fn track_frame(&self, bytes: &[u8], channels: u32, width: u32, height: u32, time_ms: f64) {
        if let Some(t) = self.shared.track.lock().unwrap().as_ref().filter(|t| t.active) {
            t.mailbox.put(bytes, channels as usize, width as usize, height as usize, time_ms);
            return;
        }
        if channels == 3 && self.shared.detect_wanted.load(Ordering::Relaxed) {
            let cuts = self.shared.detect_clock.lock().unwrap().cuts_seen;
            self.shared.offer_to_detector(bytes, width as usize, height as usize, cuts);
            self.shared.watch_cuts(bytes, width as usize, height as usize, time_ms);
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
        let options = TrackOptions { smoothing_ms, ..options };
        *self.shared.track_options.lock().unwrap() = options;
        if let Some(t) = self.shared.track.lock().unwrap().as_ref() {
            t.tracker.lock().unwrap().set_options(options);
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
            self.shared.lookahead.lock().unwrap().as_ref().and_then(|l| l.ahead_of(pos))
        };
        let auto = self.shared.region.lock().unwrap().source == RegionSource::Auto;
        let detect = self.detect_state();
        let track = self.shared.track.lock().unwrap();
        let Some(t) = track.as_ref() else {
            return TrackState { active: false, state: Phase::Idle, region: None, auto, detect, position: 0.5, motion: [0.5; Component::COUNT], ahead_ms, fps: 0.0, frames: 0, cuts: 0, jumps: 0, drops: 0 };
        };
        let tracker = t.tracker.lock().unwrap();
        TrackState {
            active,
            state: tracker.phase(),
            region: tracker.region(),
            auto,
            detect,
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
        let path = self.shared.media_path.lock().unwrap().clone().filter(|p| is_local(p)).ok_or("only a local file can be run through")?;
        if self.shared.generate.busy() {
            return Err("a run is already on".into());
        }
        let axes = self.shared.track_axes.lock().unwrap();
        if !Axis::ALL.iter().any(|a| axes[a.index()].source != TrackSource::Off && (axes[a.index()].source != TrackSource::Video || track_component(*a).is_some())) {
            return Err("no axis is on the tracking table".into());
        }
        drop(axes);
        let hwdec = Some(self.player.hwdec_current()).filter(|h| !h.is_empty());
        Ok(Generation::new(self.shared.clone(), self.shared.generate.clone(), path, hwdec))
    }

    pub fn generate_progress(&self) -> GenerateProgress {
        self.shared.generate.progress.lock().unwrap().clone()
    }

    /// Asks a running generation to stop; `run` returns an error shortly after.
    pub fn generate_cancel(&self) {
        self.shared.generate.cancel.store(true, Ordering::Relaxed);
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
            Some(t) => t.tracker.lock().unwrap().samples_since(since_ms).iter().map(|s| Sample { pos: l0.map(s.pos), ..*s }).collect(),
            None => Vec::new(),
        }
    }

    pub fn connect(&mut self, transport: Transport, profile: Profile) -> u32 {
        let id = self.next_output;
        self.next_output += 1;
        let mut output = Output::new(id, transport, profile);
        output.set_scripts(&self.shared.scripts.lock().unwrap());
        self.shared.outputs.lock().unwrap().push(output);
        self.shared.update_expand();
        self.shared.mixer.lock().unwrap().resync();
        id
    }

    pub fn disconnect(&self, id: u32) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        let Some(i) = outputs.iter().position(|o| o.id == id) else { return false };
        outputs.remove(i).disconnect();
        drop(outputs);
        self.shared.update_expand();
        true
    }

    pub fn set_output_profile(&self, id: u32, profile: Profile) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        let Some(o) = outputs.iter_mut().find(|o| o.id == id) else { return false };
        o.set_profile(profile);
        drop(outputs);
        self.shared.update_expand();
        true
    }

    /// Device button presses since the last call.
    pub fn take_inputs(&self) -> Vec<DeviceInput> {
        let mut out = Vec::new();
        for o in self.shared.outputs.lock().unwrap().iter_mut() {
            out.extend(o.take_inputs().into_iter().map(|name| DeviceInput { output: o.id, name }));
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

    /// Live per-channel strength on a Coyote output, 0..200.
    pub fn set_coyote_strength(&self, id: u32, a: u8, b: u8) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs.iter_mut().find(|o| o.id == id).is_some_and(|o| o.set_strength(a, b))
    }

    pub fn output_clamps(&self, id: u32) -> Option<[AxisClamp; Axis::COUNT]> {
        self.shared.outputs.lock().unwrap().iter().find(|o| o.id == id).map(|o| o.clamps)
    }

    /// Session volume ramp on a restim output. Turning it on starts it from the beginning.
    pub fn set_output_ramp(&self, id: u32, config: RampConfig) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs.iter_mut().find(|o| o.id == id).map(|o| o.ramp.set_config(config)).is_some()
    }

    pub fn restart_output_ramp(&self, id: u32) -> bool {
        let mut outputs = self.shared.outputs.lock().unwrap();
        outputs.iter_mut().find(|o| o.id == id).map(|o| o.ramp.restart()).is_some()
    }

    pub fn output_ramp(&self, id: u32) -> Option<RampConfig> {
        self.shared.outputs.lock().unwrap().iter().find(|o| o.id == id).map(|o| o.ramp.config())
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

    /// The server's port, clients and last error; `None` while it is off.
    pub fn intiface_status(&self) -> Option<IntifaceStatus> {
        self.shared.intiface.lock().unwrap().as_ref().map(IntifaceServer::status)
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

    /// Everything the UI shows at 60 Hz. Cheap: no mpv calls, no sorting, and each lock is
    /// taken on its own and dropped at once.
    pub fn state(&self) -> EngineState {
        let (time_ms, duration_ms, paused, rate) = {
            let clock = self.shared.clock.lock().unwrap();
            (clock.peek(), clock.duration_ms, clock.paused(), clock.speed())
        };
        let (axis_values, axis_flags, flags_version) = {
            let p = self.shared.published.lock().unwrap();
            (p.values, p.flags, p.version)
        };
        let outputs = self.shared.outputs.lock().unwrap().iter().map(Output::snapshot).collect();
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
        (self.shared.video_size.0.load(Ordering::Relaxed), self.shared.video_size.1.load(Ordering::Relaxed))
    }

    /// Whether anyone is looking at the frames; while not, mpv skips drawing and nothing is
    /// read back. Audio and the clock carry on.
    pub fn set_presenting(&self, on: bool) -> Result<(), String> {
        self.player.set_presenting(on)
    }

    pub fn tick_stats(&self) -> TickStats {
        let t = self.shared.tick.lock().unwrap();
        TickStats { hz: self.hz, realtime: t.realtime, late: percentiles(&t.late_us), work: percentiles(&t.work_us) }
    }

    /// Counters and timings for one output, for a diagnostics view. None for an unknown id.
    pub fn output_stats(&self, id: u32) -> Option<OutputStats> {
        self.shared.outputs.lock().unwrap().iter().find(|o| o.id == id).map(Output::stats)
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
    pub fn prepare(&self, path: &str) {
        let pool = scan_pool(Path::new(path));
        *self.shared.prepared.lock().unwrap() = Some((path.to_string(), pool));
    }

    /// The pool for `path`: the prepared one when it is for this file, else a fresh scan.
    pub fn pool_for(&self, path: &str) -> Vec<PoolEntry> {
        let mut prepared = self.shared.prepared.lock().unwrap();
        match prepared.take() {
            Some((p, pool)) if p == path => pool,
            other => {
                *prepared = other;
                drop(prepared);
                scan_pool(Path::new(path))
            }
        }
    }

    /// The file and its scripts together: the clock is held at the start position and the
    /// new scripts ramp the axes to their opening values while mpv opens the file, so no
    /// old script plays against the new position and nothing jumps when the picture starts.
    pub fn load(&self, path: &str, start_seconds: Option<f64>, pool: Vec<PoolEntry>, variants: &[(Axis, String)]) -> Result<MediaInfo, String> {
        self.load_media(path, start_seconds)?;
        Ok(self.apply(Path::new(path), pool, variants))
    }

    /// The video alone. A running lookahead moves to the new file.
    pub fn load_media(&self, path: &str, start_seconds: Option<f64>) -> Result<(), String> {
        *self.shared.load_error.lock().unwrap() = None;
        self.media.load(path, start_seconds)?;
        *self.shared.media_path.lock().unwrap() = Some(path.to_string());
        if self.shared.lookahead.lock().unwrap().is_some() {
            self.shared.restart_lookahead(self.media.hwdec_current());
        }
        self.shared.preset_clock(start_seconds.unwrap_or(0.0) * 1000.0);
        Ok(())
    }

    /// Installs a scanned pool as the loaded scripts.
    pub fn apply(&self, path: &Path, pool: Vec<PoolEntry>, variants: &[(Axis, String)]) -> MediaInfo {
        *self.shared.pool.lock().unwrap() = pool;
        *self.shared.variants.lock().unwrap() = variants.to_vec();
        *self.shared.param_hold.lock().unwrap() = [HoldState::default(); Axis::COUNT];
        *self.shared.cut_watch.lock().unwrap() = None;
        self.shared.loaded.store(true, Ordering::Relaxed);
        MediaInfo { path: path.to_path_buf(), scripts: self.shared.apply_selection() }
    }
}

impl Shared {
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
        let path = self.media_path.lock().unwrap().clone().filter(|p| is_local(p));
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
        self.outputs.lock().unwrap().iter().any(|o| o.profile == Profile::Restim)
    }

    /// The parameter sources become mixer fallbacks while a restim output exists, and are
    /// cleared when none does so the parameter axes are not sent anywhere. Audio and
    /// Detection get their value in `tick`; here they only note that the tick has work.
    fn apply_param_sources(&self) {
        let restim = self.has_restim();
        let sources = self.param_sources.lock().unwrap();
        let live = restim && sources.iter().any(ParamSource::is_live);
        let detect = restim && sources.iter().any(|s| matches!(s, ParamSource::Detection(_)));
        let cuts = restim && sources.iter().any(|s| matches!(s, ParamSource::Detection(d) if d.hold.is_some_and(|h| h.on_cut)));
        let mut mixer = self.mixer.lock().unwrap();
        for axis in Axis::ALL.into_iter().filter(|a| a.kind() == Kind::EstimParam) {
            let fallback = match &sources[axis.index()] {
                _ if !restim => Fallback::None,
                ParamSource::Restim | ParamSource::Audio | ParamSource::Detection(_) => Fallback::None,
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
        let loudness = sources.iter().any(|s| *s == ParamSource::Audio).then(|| self.beat.lock().unwrap().loudness_at(media_ms)).flatten();
        let coverage = sources.iter().any(|s| matches!(s, ParamSource::Detection(_))).then(|| self.detect.lock().unwrap().as_ref().and_then(|d| d.coverage())).flatten();
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
                            Some(hold) => self.param_hold.lock().unwrap()[axis.index()].step(&hold, raw, shaped, cuts, media_ms),
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

    /// The followed player drives the clock the same way mpv does. The scripts stay as
    /// they are on a path change: the host decides what to load for the new file.
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

    /// Picks one script per axis from the pool (the chosen variant, else the default),
    /// loads them, and describes the whole pool with the selection marked.
    fn apply_selection(&self) -> Vec<ScriptInfo> {
        let pool = self.pool.lock().unwrap();
        let variants = self.variants.lock().unwrap().clone();
        let default = default_selection(&pool);
        let chosen: Vec<usize> = Axis::ALL
            .iter()
            .filter_map(|&axis| {
                let wanted = variants.iter().find(|(a, _)| *a == axis).map(|(_, v)| v.as_str());
                let named = wanted.and_then(|name| pool.iter().position(|e| e.axis == axis && e.variant.as_deref() == Some(name)));
                named.or_else(|| default.iter().copied().find(|&i| pool[i].axis == axis))
            })
            .collect();
        let infos = describe(&pool, &chosen);
        let mut loaded: Vec<(Axis, Arc<Script>)> = chosen.iter().map(|&i| (pool[i].axis, pool[i].script.clone())).collect();
        drop(pool);
        // While tracking, an axis on Beat plays the generated script instead of the file's.
        if self.timeline.lock().unwrap().active {
            let axes = *self.track_axes.lock().unwrap();
            let beat = self.beat.lock().unwrap();
            for axis in Axis::ALL {
                let a = axes[axis.index()];
                let alternate = matches!(axis, Axis::R0 | Axis::R1 | Axis::R2 | Axis::L1 | Axis::L2);
                let script = match a.source {
                    TrackSource::Beat => beat.script(a.intensity, a.invert, alternate),
                    TrackSource::Hero => Some(self.hero.lock().unwrap().script(axis, a.intensity, a.invert, alternate)),
                    _ => None,
                };
                if let Some(mut script) = script {
                    for action in &mut script.actions {
                        action.pos = a.limit(action.pos);
                    }
                    loaded.retain(|(ax, _)| *ax != axis);
                    loaded.push((axis, Arc::new(script)));
                }
            }
        }
        self.set_scripts(loaded);
        infos
    }

    /// One colour frame for the Hero watcher; new or moved hits regrow the Hero axes' scripts
    /// in place, without a resync.
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
            mixer.set_script_live(axis, Some(Arc::new(hero.script(axis, a.intensity, a.invert, alternate))));
        }
    }

    /// Hands the scripts to any output that hosts them itself and loads them into the mixer.
    /// The table (alpha and beta derived from the stroke) is built before the mixer lock is
    /// taken; locks are taken one at a time and never nested.
    fn set_scripts(&self, scripts: Vec<(Axis, Arc<Script>)>) {
        let expand = {
            let mut outputs = self.outputs.lock().unwrap();
            for o in outputs.iter_mut() {
                o.set_scripts(&scripts);
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

    /// Called by the track worker with every colour frame (and by `track_frame` when tracking
    /// is off but a Detection source wants frames): the detector gets it when the region is
    /// Auto or a Detection source is set, the model is ready, and either a cut just happened
    /// or the interval is up.
    fn offer_to_detector(&self, rgb: &[u8], w: usize, h: usize, cuts: u64) {
        let (source, target) = {
            let r = self.region.lock().unwrap();
            (r.source, r.target)
        };
        if source != RegionSource::Auto && !self.detect_wanted.load(Ordering::Relaxed) {
            return;
        }
        let detect = self.detect.lock().unwrap();
        let Some(d) = detect.as_ref().filter(|d| d.ready()) else { return };
        let interval = self.detect_options.lock().unwrap().interval_ms;
        let mut clock = self.detect_clock.lock().unwrap();
        let after_cut = cuts != clock.cuts_seen;
        if after_cut {
            self.scene_cuts.fetch_add(1, Ordering::Relaxed);
        }
        clock.cuts_seen = cuts;
        let due = clock.last_at.is_none_or(|t| t.elapsed().as_secs_f64() * 1000.0 >= interval);
        if after_cut || due {
            clock.last_at = Some(Instant::now());
            d.put(rgb, w, h, after_cut, target);
        }
    }

    /// The detector's verdict on a frame, applied to the live tracker's region.
    fn on_detected(&self, found: Option<Found>, after_cut: bool) {
        let padding = self.detect_options.lock().unwrap().padding;
        let mut region = self.region.lock().unwrap();
        let (next, target) = next_auto_region(region.auto, region.auto_target, found, after_cut, padding);
        if similar_region(region.auto, next) {
            return;
        }
        region.auto = next;
        region.auto_target = target;
        if region.source != RegionSource::Auto {
            return;
        }
        drop(region);
        if let Some(t) = self.track.lock().unwrap().as_ref() {
            t.tracker.lock().unwrap().set_region(next);
        }
    }

    /// One output tick. Returns how precisely the next one should be woken: precision costs
    /// a spinning core, so it is only asked for while a connected device is being written to.
    fn tick(&self, t: deadline::Tick) -> Pace {
        let (media_ms, playing, rate) = {
            let mut clock = self.clock.lock().unwrap();
            let now = clock.now();
            (now, clock.running(), clock.speed())
        };
        // Each tracked axis reads the lookahead at media time minus its offset, or, where
        // nothing is tracked ahead, the live timeline that far behind the wall clock (the live
        // path cannot see ahead, so a negative offset there is 0). Stale live frames (the page
        // paused, the tab went away) release the axis so auto-home takes over.
        let tracking = self.timeline.lock().unwrap().active;
        let tracked: Option<[Option<f64>; Axis::COUNT]> = tracking.then(|| {
            let axes = *self.track_axes.lock().unwrap();
            let offsets: [f64; Axis::COUNT] = {
                let mixer = self.mixer.lock().unwrap();
                std::array::from_fn(|i| mixer.global_offset_ms + mixer.settings(Axis::ALL[i]).offset_ms)
            };
            let lookahead = self.lookahead.lock().unwrap();
            let tl = self.timeline.lock().unwrap();
            let now = Instant::now();
            std::array::from_fn(|i| {
                let a = axes[i];
                let c = track_component(Axis::ALL[i]).filter(|_| a.source == TrackSource::Video)?;
                let motion = lookahead.as_ref().and_then(|l| l.value_at(media_ms - offsets[i])).or_else(|| tl.value_at(now, offsets[i]))?;
                Some(a.map(motion[c.index()]))
            })
        });
        let live_params = if self.live_params.load(Ordering::Relaxed) { self.live_param_values(media_ms) } else { Vec::new() };
        let (frame, driven, flags) = {
            let mut mixer = self.mixer.lock().unwrap();
            for (axis, value) in live_params {
                mixer.set_fallback(axis, value.map_or(Fallback::None, Fallback::Value));
            }
            if let Some(values) = tracked {
                for axis in Axis::ALL.into_iter().filter(|a| track_component(*a).is_some()) {
                    mixer.set_source(axis, values[axis.index()]);
                }
            }
            // A page driving the stroke through the Intiface server wins over the tracker;
            // when it stops, the axis is released unless the tracker is still on it.
            let remote = self.intiface.lock().unwrap().as_ref().and_then(|s| s.stroke_at(Instant::now()));
            let was_remote = self.remote_driving.swap(remote.is_some(), Ordering::Relaxed);
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
        {
            let mut p = self.published.lock().unwrap();
            p.values = frame;
            if p.flags != flags {
                p.flags = flags;
                p.version += 1;
            }
        }
        let ctx = TickContext { media_ms, playing, rate, interval_ms: ((t.dt_ms + 0.75).floor() as u32).clamp(1, 100) };
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
        s.since_write = if wrote { 0 } else { s.since_write.saturating_add(1) };
        // A quiet device (paused and homed) gives up precision after half a second; its next
        // line goes out a millisecond late and the one after is precise again.
        if connected && (playing || tracked.is_some() || s.since_write < RELAX_AFTER_TICKS) { Pace::Precise } else { Pace::Relaxed }
    }
}

/// The detector's verdict folded into the last box. A miss keeps the box (the target is
/// assumed still there) unless the frame followed a cut, when it means the centre; so does a
/// face turning up where genitals were, since they are still there behind a flaky detection.
/// A box that barely moved is left alone so the tracker is not restarted for nothing.
fn next_auto_region(auto: Option<Region>, auto_target: Option<bp_detect::Target>, found: Option<Found>, after_cut: bool, padding: f64) -> (Option<Region>, Option<bp_detect::Target>) {
    let target = found.and_then(|f| bp_detect::Target::of(f.class));
    let downgrade = !after_cut && auto_target == Some(bp_detect::Target::Genitals) && target == Some(bp_detect::Target::Face);
    let next = match found {
        Some(f) if !downgrade => {
            let r = f.rect.padded(padding);
            Some(grow_region(Region { x: r.x, y: r.y, w: r.w, h: r.h }))
        }
        _ if after_cut => None,
        _ => auto,
    };
    if similar_region(auto, next) {
        return (auto, auto_target);
    }
    (next, if downgrade { auto_target } else { next.and(target) })
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
            let dc = ((a.x + a.w / 2.0) - (b.x + b.w / 2.0)).abs().max(((a.y + a.h / 2.0) - (b.y + b.h / 2.0)).abs());
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
    find_scripts(media)
        .into_iter()
        .map(|s| {
            let mut info = script_info(s.axis, &s.source, s.container, &s.script);
            info.variant = s.variant.clone();
            PoolEntry { axis: s.axis, variant: s.variant, script: Arc::new(s.script), info }
        })
        .collect()
}

/// Script metadata for a media file without touching the player, for library scans. The
/// selection is the default one, so the library shows what would play.
pub fn scan_scripts(path: &Path) -> Vec<ScriptInfo> {
    let pool = scan_pool(path);
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
    pool.iter().enumerate().map(|(i, e)| ScriptInfo { selected: chosen.contains(&i), ..e.info.clone() }).collect()
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
    fn track_axis_map_scales_flips_then_limits() {
        let a = TrackAxis { source: TrackSource::Video, intensity: 0.5, min: 0.2, max: 0.8, smoothing_ms: 0.0, invert: false };
        assert_eq!(a.map(0.5), 0.5);
        assert!((a.map(1.0) - 0.65).abs() < 1e-9, "0.75 within 0.2..0.8");
        let flipped = TrackAxis { invert: true, ..a };
        assert!((flipped.map(1.0) - 0.35).abs() < 1e-9);
        let full = TrackAxis { intensity: 2.0, ..a };
        assert!((full.map(0.0) - 0.2).abs() < 1e-9, "clamped to 0 before the limits");
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
        let seen: Vec<(Axis, Option<&str>, bool)> = infos.iter().map(|i| (i.axis, i.variant.as_deref(), i.selected)).collect();
        assert_eq!(seen, vec![(Axis::L0, None, true), (Axis::L0, Some("mouth"), false)]);
        let _ = fs::remove_dir_all(&d);
    }
}
