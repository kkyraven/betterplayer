//! Node bindings for the engine. Class names and shapes here are the contract the app sees.

use std::collections::HashMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use napi::bindgen_prelude::*;
use napi_derive::napi;

fn err(e: String) -> Error {
    Error::from_reason(e)
}

#[napi(object)]
pub struct Percentiles {
    pub mean: f64,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
}

impl From<bp_player::Percentiles> for Percentiles {
    fn from(p: bp_player::Percentiles) -> Percentiles {
        Percentiles {
            mean: p.mean as f64,
            p50: p.p50 as f64,
            p95: p.p95 as f64,
            max: p.max as f64,
        }
    }
}

#[napi(object)]
pub struct RenderStats {
    pub frames: f64,
    pub dropped: f64,
    /// Frame updates that went undrawn while the picture was gone.
    pub skipped: f64,
    pub render_errors: f64,
    pub gl_errors: f64,
    pub last_gl_error: u32,
    pub render_ms: Percentiles,
    /// Copy queued to frame published.
    pub readback_ms: Percentiles,
    pub interval_ms: Percentiles,
    /// Frame published to `acquire` taking it.
    pub present_ms: Percentiles,
}

#[napi(object)]
pub struct EngineOptions {
    /// Output tick rate, default 100.
    pub hz: Option<u32>,
    pub spin_us: Option<u32>,
    pub hwdec: Option<String>,
    pub verbose: Option<bool>,
    /// Frame bytes are BGRA; sample `.bgra` in the shader. Default true except on Windows, where
    /// ANGLE swizzles BGRA reads on the CPU and RGBA is several times faster; read `bgra()`.
    pub bgra: Option<bool>,
    /// Default true. Fenced readback, published as soon as the GPU has copied the frame.
    pub async_readback: Option<bool>,
    /// Extra mpv options applied before init.
    pub mpv_options: Option<HashMap<String, String>>,
}

/// Upscaling, frame generation and DLSS 5 this machine offers; each reason says what is missing.
#[napi(object)]
pub struct EnhanceCapabilities {
    pub vsr: bool,
    pub apple_vsr: bool,
    pub frame_gen: bool,
    pub dlss: bool,
    pub vsr_reason: Option<String>,
    pub apple_vsr_reason: Option<String>,
    pub frame_gen_reason: Option<String>,
    pub dlss_reason: Option<String>,
    pub gpu: Option<String>,
}

/// The DLSS 5 controls, named as the settings name them; the engine validates the ranges.
#[napi(object)]
pub struct DlssOptions {
    /// `default`, `1`, `2` or `3`.
    pub nr_preset: String,
    /// `default`, `natural` or `cinematic`.
    pub nr_style: String,
    /// 0 to 2.
    pub intensity: f64,
    /// 0 to 2.
    pub local_tone: f64,
    /// 0 to 2.
    pub local_structure: f64,
    /// -1 (the native default) to 2.
    pub skin_structure: f64,
    pub auto_mask: bool,
    /// `default`, `j`, `k`, `l` or `m`.
    pub model_preset: String,
    /// One of NVIDIA's modes: 1, 1.5, 1.724, 2 or 3.
    pub factor: f64,
    /// 480, 720, 1080, 1440 or 2160.
    pub input_height: u32,
    /// `auto`, `source` or a frame rate.
    pub rate: String,
    /// `fast` or `quality`.
    pub guide: String,
    /// 2 to 30.
    pub buffer_seconds: f64,
}

#[napi(object)]
pub struct EnhanceOptions {
    /// `off`, `sharp` (mpv's ewa_lanczossharp, any GPU), `fsr` (AMD FidelityFX Super Resolution
    /// 1.0, any GPU), `rtx` (RTX Video Super Resolution, Windows), `apple` (macOS VideoToolbox)
    /// or `dlss` (DLSS 5 Neural Rendering, Windows).
    pub upscaler: String,
    /// Frame generation target in frames per second; absent or 0 is off.
    pub target_fps: Option<f64>,
    /// The DLSS 5 controls; absent keeps the engine's defaults.
    pub dlss: Option<DlssOptions>,
}

/// What is in effect right now, which differs from the options where the machine cannot do them.
#[napi(object)]
pub struct EnhanceState {
    pub upscaler: String,
    /// The picture leaves larger than it was decoded.
    pub upscaling: bool,
    /// Output rows over source rows while upscaling, else 0.
    pub factor: f64,
    pub source_width: u32,
    pub source_height: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub frame_gen: bool,
    pub target_fps: f64,
    /// Why what was asked for is not in effect.
    pub reason: Option<String>,
}

/// The settings' names into the engine's values, each checked; the error names the field.
fn parse_dlss(d: DlssOptions) -> std::result::Result<bp_player::DlssOptions, String> {
    let options = bp_player::DlssOptions {
        nr_preset: bp_player::NrPreset::parse(&d.nr_preset)
            .ok_or_else(|| format!("unknown NR preset {}", d.nr_preset))?,
        nr_style: bp_player::NrStyle::parse(&d.nr_style)
            .ok_or_else(|| format!("unknown NR style {}", d.nr_style))?,
        intensity: d.intensity as f32,
        local_tone: d.local_tone as f32,
        local_structure: d.local_structure as f32,
        skin_structure: d.skin_structure as f32,
        auto_mask: d.auto_mask,
        model_preset: bp_player::ModelPreset::parse(&d.model_preset)
            .ok_or_else(|| format!("unknown model preset {}", d.model_preset))?,
        factor: d.factor,
        input_height: d.input_height,
        rate: bp_player::DlssRate::parse(&d.rate)
            .ok_or_else(|| format!("unknown rate {}", d.rate))?,
        guide: bp_player::GuideQuality::parse(&d.guide)
            .ok_or_else(|| format!("unknown guide quality {}", d.guide))?,
        buffer_seconds: d.buffer_seconds,
    };
    options.validate()?;
    Ok(options)
}

#[napi(object)]
pub struct Chapter {
    pub name: String,
    pub start_ms: f64,
    pub end_ms: f64,
}

#[napi(object)]
pub struct Bookmark {
    pub name: String,
    pub at_ms: f64,
}

/// A stretch of a script with no movement.
#[napi(object)]
pub struct Span {
    pub start_ms: f64,
    pub end_ms: f64,
}

#[napi(object)]
pub struct ScriptInfo {
    pub axis: String,
    /// Name among several scripts for the axis; absent for the plain one.
    pub variant: Option<String>,
    /// Whether this is the script playing on its axis.
    pub selected: bool,
    pub source: String,
    pub container: String,
    pub actions: u32,
    pub duration_ms: f64,
    /// Position units (0..100) per second.
    pub average_speed: f64,
    pub max_speed: f64,
    /// Average speed per bucket across `0..durationMs`.
    pub heatmap: Vec<f64>,
    /// Spans of a second or more with no movement, the lead-in before the first action included.
    pub gaps: Vec<Span>,
    pub chapters: Vec<Chapter>,
    pub bookmarks: Vec<Bookmark>,
}

#[napi(object)]
pub struct MediaInfo {
    pub path: String,
    pub scripts: Vec<ScriptInfo>,
}

#[napi(object)]
pub struct AxisSettings {
    pub enabled: bool,
    pub offset_ms: f64,
    /// Output range, 0..1.
    pub min: f64,
    pub max: f64,
    /// Scale of the scripted motion around the rest value; 1 plays the script as written.
    pub amplitude: f64,
    pub invert: bool,
    /// `step`, `linear` or `pchip`.
    pub interpolation: String,
    /// Play another axis's script on this one.
    pub link: Option<String>,
    /// `none`, `random` or `sine`.
    pub provider: String,
    /// Random: targets per second.
    pub provider_speed: f64,
    /// Sine: period in ms.
    pub provider_period_ms: f64,
    pub provider_blend: f64,
    pub fill_gaps_over_ms: f64,
    /// 0 disables auto-home.
    pub auto_home_delay_ms: f64,
    pub auto_home_duration_ms: f64,
    /// Full-range units per second, 0 disables.
    pub speed_limit: f64,
    /// Axis whose depth reduces this one, with the default curve.
    pub smart_limit_input: Option<String>,
    /// Stretch the script so its own lowest and highest positions play as 0 and 1.
    pub extend_range: Option<bool>,
}

fn axis(id: &str) -> Result<bp_script::Axis> {
    bp_script::Axis::from_id(id).ok_or_else(|| err(format!("unknown axis {id}")))
}

impl AxisSettings {
    fn to_core(&self) -> Result<bp_axes::AxisSettings> {
        Ok(bp_axes::AxisSettings {
            enabled: self.enabled,
            offset_ms: self.offset_ms,
            min: self.min.clamp(0.0, 1.0),
            max: self.max.clamp(0.0, 1.0),
            amplitude: self.amplitude.max(0.0),
            invert: self.invert,
            interpolation: bp_axes::interpolation_from(&self.interpolation),
            link: self.link.as_deref().map(axis).transpose()?,
            provider: match self.provider.as_str() {
                "random" => bp_core::Provider::Random {
                    speed: self.provider_speed,
                },
                "sine" => bp_core::Provider::Sine {
                    period_ms: self.provider_period_ms,
                },
                _ => bp_core::Provider::None,
            },
            provider_blend: self.provider_blend.clamp(0.0, 1.0),
            fill_gaps_over_ms: self.fill_gaps_over_ms,
            auto_home_delay_ms: self.auto_home_delay_ms,
            auto_home_duration_ms: self.auto_home_duration_ms,
            speed_limit: self.speed_limit.max(0.0),
            smart_limit: self
                .smart_limit_input
                .as_deref()
                .map(axis)
                .transpose()?
                .map(bp_core::SmartLimit::default_for),
            extend_range: self.extend_range.unwrap_or(false),
        })
    }

    fn from_core(s: &bp_axes::AxisSettings) -> AxisSettings {
        let (provider, provider_speed, provider_period_ms) = match s.provider {
            bp_core::Provider::None => ("none", 1.0, 2000.0),
            bp_core::Provider::Random { speed } => ("random", speed, 2000.0),
            bp_core::Provider::Sine { period_ms } => ("sine", 1.0, period_ms),
        };
        AxisSettings {
            enabled: s.enabled,
            offset_ms: s.offset_ms,
            min: s.min,
            max: s.max,
            amplitude: s.amplitude,
            invert: s.invert,
            interpolation: s.interpolation.as_str().to_string(),
            link: s.link.map(|a| a.id().to_string()),
            provider: provider.to_string(),
            provider_speed,
            provider_period_ms,
            provider_blend: s.provider_blend,
            fill_gaps_over_ms: s.fill_gaps_over_ms,
            auto_home_delay_ms: s.auto_home_delay_ms,
            auto_home_duration_ms: s.auto_home_duration_ms,
            speed_limit: s.speed_limit,
            smart_limit_input: s.smart_limit.as_ref().map(|l| l.input.id().to_string()),
            extend_range: Some(s.extend_range),
        }
    }
}

/// A button press reported by a device (`ok`, `left`, `right`, `edge` on TCode boards).
#[napi(object)]
pub struct DeviceInput {
    pub output: u32,
    pub name: String,
}

#[napi(object)]
pub struct OutputState {
    /// Final Restim values sent this connection, keyed by internal axis id, in 0..1.
    pub sent_values: HashMap<String, f64>,
    pub id: u32,
    pub kind: String,
    pub address: String,
    /// `stroker` or `restim`: which axis family the output speaks.
    pub profile: String,
    /// `connecting`, `connected` or `error`.
    pub status: String,
    pub error: Option<String>,
    pub device: Option<String>,
    pub tcode: Option<String>,
    /// The session volume ramp's progress, while it is on and the profile is restim.
    pub ramp: Option<RampProgress>,
    /// What a connected Howl phone last reported.
    pub howl: Option<HowlStatus>,
    /// What a connected OSSM last reported.
    pub ossm: Option<OssmStatus>,
    /// A connected toy's features and the axis each follows; empty for every other output.
    pub features: Vec<OutputFeature>,
    /// Battery level of a toy that reports one, 0 to 100.
    pub battery: Option<u8>,
}

/// Howl's player and main controls, from its last reply. `position` is in seconds, the powers
/// are 0..200.
#[napi(object)]
pub struct HowlStatus {
    pub playing: bool,
    pub position: f64,
    pub title: String,
    pub power_a: u8,
    pub power_b: u8,
    pub mute: bool,
}

/// An OSSM's firmware state (`streaming.idle` while it takes positions, `streaming.preflight`
/// until its speed knob is at zero, `homing.forward` and `homing.backward`, `menu.idle`), its
/// effective speed 0..100 (the knob) and the carriage position in mm.
#[napi(object)]
pub struct OssmStatus {
    pub state: String,
    pub speed: u8,
    pub position_mm: f64,
}

/// A second axis shaken into an output's stroke: a sine at `hz` whose swing is `depth` in
/// full-range units, scaled by the source axis's value.
#[napi(object)]
pub struct VibrationConfig {
    pub source: String,
    pub depth: f64,
    pub hz: f64,
}

/// One feature of a toy (embedded Buttplug): `kind` is `vibrate`, `rotate`, `oscillate`,
/// `constrict`, `position`, `spray`, `temperature` or `led`. `axis` is the axis id it follows,
/// unset when off; `speed` says it takes that axis's speed rather than its value. `level` says
/// it is a level with its own `FeatureLevel` map rather than a place within the axis's range,
/// and `input` is that level's input right now (0 to 1, before the map) while its axis drives it.
#[napi(object)]
pub struct OutputFeature {
    pub index: u32,
    pub kind: String,
    pub description: String,
    pub axis: Option<String>,
    pub speed: bool,
    pub level: bool,
    pub input: Option<f64>,
}

/// How a toy's level feature maps its input to the toy: off up to `from`, `floor` just past
/// it, a straight line to `cap` at `to`, `cap` beyond. All 0 to 1; zero in is always zero out.
#[napi(object)]
pub struct FeatureLevel {
    pub from: f64,
    pub to: f64,
    pub floor: f64,
    pub cap: f64,
}

/// A device the embedded Buttplug server has connected, from `toyDevices`. `bound` means an
/// output already drives it.
#[napi(object)]
pub struct ToyDevice {
    pub index: u32,
    pub name: String,
    pub address: String,
    pub features: Vec<ToyFeature>,
    pub battery: Option<u8>,
    pub bound: bool,
}

/// One feature of a device from `toyDevices`; `kind` as in `OutputFeature`.
#[napi(object)]
pub struct ToyFeature {
    pub index: u32,
    pub kind: String,
    pub description: String,
}

/// The embedded Buttplug server's devices, and why it is not running when it is not.
#[napi(object)]
pub struct ToyScanState {
    pub devices: Vec<ToyDevice>,
    pub error: Option<String>,
}

/// The Buttplug server standing in for Intiface Central, from `intifaceState`.
#[napi(object)]
pub struct IntifaceState {
    pub port: u16,
    /// Connected clients.
    pub clients: u32,
    /// What the newest client called itself.
    pub client: Option<String>,
}

/// Counters and timings for one output, from `outputStats`. Ask while a diagnostics view
/// is open, not every frame: the write samples are sorted on each call.
#[napi(object)]
pub struct OutputStats {
    pub lines_sent: f64,
    pub write_us: PercentilesUs,
    /// Newest first.
    pub received: Vec<String>,
}

/// How the tick thread is keeping time, from `tickStats`.
#[napi(object)]
pub struct EngineTickStats {
    pub hz: u32,
    pub realtime: bool,
    /// How late precise ticks fired past their deadline.
    pub late_us: PercentilesUs,
    /// From firing to the last output written, so lock waits and device writes show.
    pub work_us: PercentilesUs,
}

/// Session volume ramp on a restim output: `V0` rises from `start` to `max` (0..1) over
/// `durationMs` of playing time, restarting on every connect.
#[napi(object)]
pub struct RampConfig {
    pub enabled: bool,
    pub start: f64,
    pub max: f64,
    pub duration_ms: f64,
}

/// Optional volume added past the normal limits as a motion axis rises.
#[napi(object)]
pub struct EstimVolumeBoost {
    pub enabled: bool,
    pub axis: String,
    /// Added volume at the source axis's maximum, 0..1.
    pub amount: f64,
}

/// Estim settings shared by every restim output: electrode balance, volume limits and
/// boost. With `params` off, carrier and pulse scripts and parameter sources stay in the app.
#[napi(object)]
pub struct EstimOptions {
    pub contrast: f64,
    /// Minimum of the normal volume range, 0..1; defaults to 0.75. Zero volume stays silent.
    pub volume_floor: Option<f64>,
    pub volume_max: Option<f64>,
    pub volume_boost: Option<EstimVolumeBoost>,
    pub params: bool,
}

#[napi(object)]
pub struct RampProgress {
    /// The multiplier in force, 0..1.
    pub value: f64,
    pub elapsed_ms: f64,
    pub duration_ms: f64,
    pub start: f64,
    pub max: f64,
}

/// Where a restim parameter axis (`C0`, `P0`..`P3`) takes its value without a script:
/// `restim` (nothing sent), `fixed` with `value` 0..1 of the axis range, `sweep` with
/// `provider` `sine` (`providerPeriodMs`) or `random` (`providerSpeed`), `audio` (the sound
/// track's loudness, once `beatLoad` has run) or `detection` with `kinds` from
/// `detectionKinds()` (how much of the picture they cover, once a model is loaded and frames
/// arrive; see `wantsFrames`). Detection also takes `bias` (−1..1, skews the value down or
/// up), and holds the value between triggers when `holdOnCut` or `holdCoverageOver` (0..1 of
/// the coverage) is set, moving by at most `jump` (0..1 of the range) per trigger.
#[napi(object)]
pub struct ParamSource {
    pub source: String,
    pub value: Option<f64>,
    pub provider: Option<String>,
    pub provider_speed: Option<f64>,
    pub provider_period_ms: Option<f64>,
    pub kinds: Option<Vec<String>>,
    pub bias: Option<f64>,
    pub hold_on_cut: Option<bool>,
    pub hold_coverage_over: Option<f64>,
    pub jump: Option<f64>,
}

/// What a held Detection source is sending for an axis and the media time it was set.
#[napi(object)]
pub struct ParamHold {
    pub value: f64,
    pub since_ms: f64,
}

/// The kinds a Detection parameter source can watch, in the order `trackState().detector.coverage` uses.
#[napi]
pub fn detection_kinds() -> Vec<String> {
    bp_core::DetectKind::ALL
        .iter()
        .map(|k| k.id().to_string())
        .collect()
}

impl ParamSource {
    fn to_core(&self) -> Result<bp_core::ParamSource> {
        Ok(match self.source.as_str() {
            "restim" => bp_core::ParamSource::Restim,
            "fixed" => bp_core::ParamSource::Fixed(self.value.unwrap_or(0.5).clamp(0.0, 1.0)),
            "sweep" => bp_core::ParamSource::Sweep(match self.provider.as_deref() {
                Some("random") => bp_core::Provider::Random {
                    speed: self.provider_speed.unwrap_or(1.0).max(0.01),
                },
                None | Some("sine") => bp_core::Provider::Sine {
                    period_ms: self.provider_period_ms.unwrap_or(2000.0).max(1.0),
                },
                Some(p) => return Err(err(format!("unknown provider {p}"))),
            }),
            "audio" => bp_core::ParamSource::Audio,
            "detection" => {
                let mut mask = 0u16;
                for id in self.kinds.iter().flatten() {
                    let kind = bp_core::DetectKind::from_id(id)
                        .ok_or_else(|| err(format!("unknown detection kind {id}")))?;
                    mask |= 1 << kind.index();
                }
                let on_cut = self.hold_on_cut.unwrap_or(false);
                let coverage_over = self.hold_coverage_over.map(|v| v.clamp(0.0, 1.0));
                let hold = (on_cut || coverage_over.is_some()).then(|| bp_core::Hold {
                    on_cut,
                    coverage_over,
                    jump: self.jump.unwrap_or(1.0).clamp(0.0, 1.0),
                });
                bp_core::ParamSource::Detection(bp_core::DetectionSource {
                    kinds: mask,
                    bias: self.bias.unwrap_or(0.0).clamp(-1.0, 1.0),
                    hold,
                })
            }
            s => return Err(err(format!("unknown parameter source {s}"))),
        })
    }

    fn from_core(s: bp_core::ParamSource) -> ParamSource {
        let none = ParamSource {
            source: "restim".into(),
            value: None,
            provider: None,
            provider_speed: None,
            provider_period_ms: None,
            kinds: None,
            bias: None,
            hold_on_cut: None,
            hold_coverage_over: None,
            jump: None,
        };
        match s {
            bp_core::ParamSource::Restim => none,
            bp_core::ParamSource::Audio => ParamSource {
                source: "audio".into(),
                ..none
            },
            bp_core::ParamSource::Detection(d) => ParamSource {
                source: "detection".into(),
                kinds: Some(
                    bp_core::DetectKind::ALL
                        .iter()
                        .filter(|k| d.kinds & (1 << k.index()) != 0)
                        .map(|k| k.id().to_string())
                        .collect(),
                ),
                bias: Some(d.bias),
                hold_on_cut: d.hold.map(|h| h.on_cut),
                hold_coverage_over: d.hold.and_then(|h| h.coverage_over),
                jump: d.hold.map(|h| h.jump),
                ..none
            },
            bp_core::ParamSource::Fixed(v) => ParamSource {
                source: "fixed".into(),
                value: Some(v),
                ..none
            },
            bp_core::ParamSource::Sweep(bp_core::Provider::Random { speed }) => ParamSource {
                source: "sweep".into(),
                provider: Some("random".into()),
                provider_speed: Some(speed),
                ..none
            },
            bp_core::ParamSource::Sweep(bp_core::Provider::Sine { period_ms }) => ParamSource {
                source: "sweep".into(),
                provider: Some("sine".into()),
                provider_period_ms: Some(period_ms),
                ..none
            },
            bp_core::ParamSource::Sweep(bp_core::Provider::None) => none,
        }
    }
}

/// Bits of `EngineState.axisFlags`: the axis has a script, is derived from another axis
/// (alpha and beta from the stroke, electrodes 1 to 4 from those), is driven by hand, or an
/// outside source (the live tracker, a remote client) is driving it.
pub const AXIS_FLAG_SCRIPT: u8 = bp_core::FLAG_SCRIPT;
pub const AXIS_FLAG_DERIVED: u8 = bp_core::FLAG_DERIVED;
pub const AXIS_FLAG_LIVE: u8 = bp_core::FLAG_LIVE;
pub const AXIS_FLAG_TRACKED: u8 = bp_core::FLAG_TRACKED;

/// Everything the UI polls every frame: plain values and two small typed arrays.
#[napi(object)]
pub struct EngineState {
    pub time_ms: f64,
    pub duration_ms: f64,
    pub paused: bool,
    pub rate: f64,
    pub loaded: bool,
    /// The clock is following a VR player, not our own.
    pub following: bool,
    /// The decoded picture size, 0 by 0 until a file has loaded.
    pub video_width: u32,
    pub video_height: u32,
    /// Pipeline output per axis, 0..1, in `axes()` order.
    pub axis_values: Float64Array,
    /// Per axis in `axes()` order: bit 0 has a script, bit 1 derived, bit 2 live, bit 3 tracked.
    pub axis_flags: Uint8Array,
    /// Moves whenever `axisFlags` do, so the host can skip diffing them.
    pub flags_version: f64,
    pub outputs: Vec<OutputState>,
    /// Why the last load failed (mpv's message), until the next load.
    pub error: Option<String>,
}

/// What the VR player we are following reports.
#[napi(object)]
pub struct FollowState {
    /// `deovr`, `heresphere` or `whirligig`.
    pub kind: String,
    pub address: String,
    /// `connecting`, `connected` or `error`.
    pub status: String,
    pub error: Option<String>,
    /// The file the player has open; pass it to `loadScripts`.
    pub path: Option<String>,
    pub playing: bool,
    pub time_ms: f64,
    pub duration_ms: f64,
    pub rate: f64,
}

/// Live tracker tunables. `sensitivity` scales the per-frame pixel motion. Timing is not
/// here: each axis's offset says how far behind (or, with a lookahead, ahead of) the picture
/// it runs. `pace` (0..1, default 0.5) is what the two AI sources are conditioned on, one
/// value per video.
#[napi(object)]
pub struct TrackOptions {
    pub sensitivity: Option<f64>,
    pub pace: Option<f64>,
    /// Mean absolute frame difference (0..255) that counts as a scene cut; default 18.
    pub cut_threshold: Option<f64>,
    /// How long the output eases into the new signal after a cut; default 250.
    pub ease_ms: Option<f64>,
    /// Bounce at the bottom of a stroke deeper than usual; default true.
    pub flourishes: Option<bool>,
    /// Clamp per-frame signals far past the recent motion; default true.
    pub clamp_jumps: Option<bool>,
}

impl TrackOptions {
    fn to_core(&self) -> bp_core::TrackOptions {
        let d = bp_core::TrackOptions::default();
        bp_core::TrackOptions {
            sensitivity: self.sensitivity.unwrap_or(d.sensitivity),
            cut_threshold: self
                .cut_threshold
                .unwrap_or(d.cut_threshold)
                .clamp(1.0, 255.0),
            ease_ms: self.ease_ms.unwrap_or(d.ease_ms).max(0.0),
            smoothing_ms: d.smoothing_ms,
            flourishes: self.flourishes.unwrap_or(d.flourishes),
            clamp_jumps: self.clamp_jumps.unwrap_or(d.clamp_jumps),
        }
    }
}

impl Default for TrackOptions {
    fn default() -> TrackOptions {
        TrackOptions {
            sensitivity: None,
            pace: None,
            cut_threshold: None,
            ease_ms: None,
            flourishes: None,
            clamp_jumps: None,
        }
    }
}

/// One row of the tracking table. `source` is `video`, `beat`, `hero`, `ai-motion`, `ai-music`,
/// `faptap` or `off`; `intensity` scales the
/// motion about the middle (1 is as tracked, 0 holds still, 2 doubles it); `min`..`max` in 0..1
/// is the span of the axis the motion is squeezed into; `smoothingMs` is the time constant of
/// the smoothing on the axis's motion component, 0 for none. Axes without a motion component
/// (vibrate, estim) are ignored. The component per axis is fixed: L0 stroke, L2 sway, L1 surge,
/// R1 roll, R2 pitch, R0 twist.
#[napi(object)]
pub struct TrackAxis {
    pub axis: String,
    pub source: String,
    pub intensity: f64,
    pub min: f64,
    pub max: f64,
    pub smoothing_ms: f64,
    pub invert: bool,
}

/// The engine's table with `rows` written over it; rows for unknown axes are an error.
fn track_axes(rows: Vec<TrackAxis>, mut table: bp_core::TrackAxes) -> Result<bp_core::TrackAxes> {
    for r in rows {
        let source = match r.source.as_str() {
            "video" => bp_core::TrackSource::Video,
            "beat" => bp_core::TrackSource::Beat,
            "hero" => bp_core::TrackSource::Hero,
            "ai-motion" => bp_core::TrackSource::AiMotion,
            "ai-music" => bp_core::TrackSource::AiMusic,
            "faptap" => bp_core::TrackSource::Faptap,
            _ => bp_core::TrackSource::Off,
        };
        let min = r.min.clamp(0.0, 1.0);
        let max = r.max.clamp(min, 1.0);
        table[axis(&r.axis)?.index()] = bp_core::TrackAxis {
            source,
            intensity: r.intensity.clamp(0.0, 2.0),
            min,
            max,
            smoothing_ms: r.smoothing_ms.max(0.0),
            invert: r.invert,
        };
    }
    Ok(table)
}

/// The part of the frame to track, in 0..1 with a top-left origin.
#[napi(object)]
pub struct TrackRegion {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// One tracked frame keyed by the page's media time: the stroke, and every component
/// (stroke, sway, surge, roll, pitch, twist).
#[napi(object)]
pub struct TrackSample {
    pub time_ms: f64,
    pub pos: f64,
    pub motion: Vec<f64>,
}

/// A whole-file generation's progress.
#[napi(object)]
pub struct GenerateState {
    /// `idle`, `loading` (the file, and a detector on Auto), `running`, `music` (waiting on
    /// the music model's own pass), `done`, `cancelled` or `error`.
    pub status: String,
    pub error: Option<String>,
    /// Media time reached and the file's length.
    pub time_ms: f64,
    pub duration_ms: f64,
    /// Frames got through per wall second, once running.
    pub fps: f64,
    pub frames: f64,
    /// Hero hits seen so far.
    pub hits: f64,
    /// The movement model's provider and the time its windows have taken, when it ran.
    pub provider: Option<String>,
    pub model_ms: f64,
}

/// One script from a generation, as file contents.
#[napi(object)]
pub struct GeneratedScript {
    pub axis: String,
    /// The sibling file's suffix (`sway` for `name.sway.funscript`), empty for the stroke.
    pub suffix: String,
    pub actions: f64,
    pub duration_ms: f64,
    pub json: String,
}

/// One script to install with `setGenerated`: an axis id and funscript JSON.
#[napi(object)]
pub struct GeneratedInput {
    pub axis: String,
    pub json: String,
}

/// A box the detector chose, in 0..1 of the frame.
#[napi(object)]
pub struct FoundBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub class: String,
    pub confidence: f64,
}

/// One detector run's boxes of the kinds asked for, from `detectBoxes`.
#[napi(object)]
pub struct DetectBoxes {
    pub runs: f64,
    pub boxes: Vec<FoundBox>,
}

#[napi(object)]
pub struct DetectorState {
    /// `none`, `loading`, `ready` or `error`.
    pub status: String,
    pub error: Option<String>,
    pub model: Option<String>,
    /// `coreml` or `cpu` once loaded.
    pub provider: Option<String>,
    /// The last run's choice; null when it found nothing worth following.
    pub found: Option<FoundBox>,
    pub run_ms: f64,
    pub runs: f64,
    /// Share of the frame each kind covers, in `detectionKinds()` order, smoothed across runs.
    pub coverage: Vec<f64>,
}

/// One file of a model in the host's model folder. `url` and `sha256` say where a download
/// comes from and what it must hash to; both are empty for a bundled model.
#[napi(object)]
pub struct ModelFile {
    pub file: String,
    pub url: String,
    pub sha256: String,
}

/// A model the app uses: `kind` is `detector`, `motion` or `music`; `files` is the weights then
/// the metadata. Ours ship inside the app (`bundled`). The detectors are AGPL-3.0 downloads:
/// verify every `sha256`, never bundle, and show the licence for agreement first (`consent`).
#[napi(object)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub version: String,
    pub files: Vec<ModelFile>,
    pub bundled: bool,
    pub size_mb: u32,
    pub licence: String,
    pub licence_url: String,
    pub source_url: String,
    pub consent: bool,
}

/// What one of the AI models is doing, from `modelState`.
#[napi(object)]
pub struct ModelState {
    /// `none`, `loading`, `ready` or `error`.
    pub status: String,
    pub error: Option<String>,
    pub model: Option<String>,
    pub version: Option<String>,
    /// `coreml` or `cpu` once loaded, and why the first choice was not taken.
    pub provider: Option<String>,
    pub fallback: Option<String>,
    /// The warmup's median window, and the last window's cost, in ms.
    pub warmup_ms: f64,
    pub run_ms: f64,
    /// The movement model cannot keep up live; its axes stay on the flow tracker.
    pub too_slow: bool,
}

/// A model the app may offer to download. Every one is treated as AGPL-3.0: show the licence
/// and ask before fetching, verify `sha256`, never bundle.
#[napi(object)]
pub struct DetectorModel {
    pub id: String,
    pub label: String,
    pub file: String,
    pub input: u32,
    pub url: String,
    pub sha256: String,
    pub size_mb: u32,
    pub licence: String,
    pub licence_url: String,
    pub source_url: String,
}

#[napi(object)]
pub struct TrackState {
    pub active: bool,
    /// `idle`, `locating` or `tracking`.
    pub state: String,
    /// The region in use, null for the centre, and whether the detector chose it.
    pub region: Option<TrackRegion>,
    pub auto: bool,
    pub detector: DetectorState,
    /// The movement model, for axes on AI Motion.
    pub model: ModelState,
    /// Newest tracked stroke, 0..1.
    pub position: f64,
    /// Newest position per component: stroke, sway, surge, roll, pitch, twist.
    pub motion: Vec<f64>,
    /// How far past the playhead the lookahead has tracked, null without one (a page, or a
    /// file that is not local).
    pub ahead_ms: Option<f64>,
    /// Frame rate measured from arrivals.
    pub fps: f64,
    pub frames: f64,
    /// Scene cuts, clamped jumps and dropped fits since the start.
    pub cuts: f64,
    pub jumps: f64,
    pub drops: f64,
}

/// One of: `{kind:'serial', path, baud}`, `{kind:'udp'|'tcp', host, port}`,
/// `{kind:'websocket'|'buttplug', url}`, `{kind:'ble', name}` for a TCode board over BLE,
/// `{kind:'ossm', name}` for an OSSM over its firmware's BLE streaming service, or
/// `{kind:'coyote', name, strengthA, strengthB}` for a DG-Lab Coyote v3. BLE `name` matches
/// the start of an advertised name or address from `bleScan`; an empty Coyote or OSSM name
/// takes the first one that answers. Coyote strengths are the per-channel cap, 0..200, and default to
/// 0: nothing comes out until the user raises them. `{kind:'handy', key, appKey?, hosting?}` takes a
/// connection key, an optional app key (which picks API v3) and where the script is hosted,
/// `cloud` or `lan`. `{kind:'howl', host, key}` is the Howl app on a phone at `host`, with the
/// key its settings show. `{kind:'toy', name, address}` is a Bluetooth toy through the embedded
/// Buttplug server, matched by the `address` `toyDevices` reported, or a unique `name` if no address is supplied.
/// `{kind:'openshock', url?, token, shocker, trigger?}` is one OpenShock shocker (by its id) over
/// the API at `url` (the public service without one), fired by `trigger`. `profile` is
/// `stroker` (default) or `restim`.
#[napi(object)]
pub struct Transport {
    pub kind: String,
    pub path: Option<String>,
    pub baud: Option<u32>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub profile: Option<String>,
    pub name: Option<String>,
    pub strength_a: Option<u8>,
    pub strength_b: Option<u8>,
    pub key: Option<String>,
    pub app_key: Option<String>,
    pub hosting: Option<String>,
    pub address: Option<String>,
    pub token: Option<String>,
    pub shocker: Option<String>,
    pub username: Option<String>,
    pub user_id: Option<u32>,
    pub client_id: Option<u32>,
    pub trigger: Option<OpenShockTrigger>,
}

/// When an OpenShock shocker fires: while `axis` is past `line` (0..1), above it or below.
/// `control` is `shock`, `vibrate` or `sound`; `intensity` 0..100, zero fires nothing.
#[napi(object)]
pub struct OpenShockTrigger {
    pub axis: String,
    pub line: f64,
    pub above: bool,
    pub control: String,
    pub intensity: u8,
}

impl OpenShockTrigger {
    fn to_core(&self) -> Result<bp_devices::OpenShockTrigger> {
        Ok(bp_devices::OpenShockTrigger {
            axis: axis(&self.axis)?,
            line: self.line.clamp(0.0, 1.0),
            above: self.above,
            control: bp_devices::OpenShockControl::from_str(&self.control)
                .ok_or_else(|| err(format!("unknown openshock control {}", self.control)))?,
            intensity: self.intensity.min(100),
        })
    }
}

fn profile(s: &str) -> Result<bp_devices::Profile> {
    bp_devices::Profile::from_str(s).ok_or_else(|| err(format!("unknown profile {s}")))
}

impl Transport {
    fn to_core(&self) -> Result<bp_devices::Transport> {
        let need = |v: &Option<String>, what: &str| {
            v.clone()
                .ok_or_else(|| err(format!("{} transport needs {what}", self.kind)))
        };
        Ok(match self.kind.as_str() {
            "serial" => bp_devices::Transport::Serial {
                path: need(&self.path, "path")?,
                baud: self.baud.unwrap_or(115_200),
            },
            "udp" => bp_devices::Transport::Udp {
                host: need(&self.host, "host")?,
                port: self.port.unwrap_or(8000),
            },
            "tcp" => bp_devices::Transport::Tcp {
                host: need(&self.host, "host")?,
                port: self.port.unwrap_or(8080),
            },
            "websocket" => bp_devices::Transport::WebSocket {
                url: need(&self.url, "url")?,
            },
            "buttplug" => bp_devices::Transport::Buttplug {
                url: self
                    .url
                    .clone()
                    .unwrap_or_else(|| "ws://127.0.0.1:12345".into()),
            },
            "ble" => bp_devices::Transport::Ble {
                name: need(&self.name, "name")?,
            },
            "ossm" => bp_devices::Transport::Ossm {
                name: self.name.clone().unwrap_or_default(),
            },
            "coyote" => bp_devices::Transport::Coyote {
                name: self.name.clone().unwrap_or_default(),
                strength_a: self.strength_a.unwrap_or(0),
                strength_b: self.strength_b.unwrap_or(0),
            },
            "handy" => bp_devices::Transport::Handy {
                key: need(&self.key, "key")?,
                app_key: self.app_key.clone().filter(|k| !k.is_empty()),
                hosting: match self.hosting.as_deref() {
                    Some("lan") => bp_devices::HandyHosting::Lan,
                    None | Some("cloud") => bp_devices::HandyHosting::Cloud,
                    Some(h) => return Err(err(format!("unknown handy hosting {h}"))),
                },
            },
            "howl" => bp_devices::Transport::Howl {
                host: need(&self.host, "host")?,
                key: need(&self.key, "key")?,
            },
            "toy" => bp_devices::Transport::Toy {
                name: self.name.clone().unwrap_or_default(),
                address: self.address.clone().unwrap_or_default(),
            },
            "pishock" => bp_devices::Transport::PiShock {
                username: need(&self.username, "username")?,
                key: need(&self.token, "token")?,
                user: self.user_id.filter(|v| *v > 0).ok_or_else(|| err("PiShock needs userId".into()))?,
                client: self.client_id.filter(|v| *v > 0).ok_or_else(|| err("PiShock needs clientId".into()))?,
                shocker: need(&self.shocker, "shocker")?.parse::<u32>().ok().filter(|v| *v > 0).ok_or_else(|| err("PiShock needs shocker".into()))?,
                trigger: self.trigger.as_ref().map(OpenShockTrigger::to_core).transpose()?.unwrap_or_default(),
            },
            "openshock" => bp_devices::Transport::OpenShock {
                url: self
                    .url
                    .clone()
                    .filter(|u| !u.trim().is_empty())
                    .unwrap_or_else(|| bp_devices::OPENSHOCK_API.into()),
                token: need(&self.token, "token")?,
                shocker: need(&self.shocker, "shocker")?,
                trigger: self
                    .trigger
                    .as_ref()
                    .map(OpenShockTrigger::to_core)
                    .transpose()?
                    .unwrap_or_default(),
            },
            k => return Err(err(format!("unknown transport {k}"))),
        })
    }
}

#[napi(object)]
pub struct AxisClamp {
    pub enabled: bool,
    pub min: f64,
    pub max: f64,
}

/// Player, clock, script mixer and device outputs in one object. Frames are written into
/// host memory exactly as in Phase 0.
#[napi]
pub struct Engine {
    inner: bp_core::Engine,
    pishock_enabled: bool,
    pishock_outputs: Vec<u32>,
    /// Host frame memory. Held so the typed arrays stay alive while the engine writes to them.
    buffers: Vec<Uint8Array>,
}

/// Checks three host buffers of exactly width * height * 4 bytes and takes their addresses.
fn external(width: u32, height: u32, buffers: &[Uint8Array]) -> Result<bp_core::External> {
    let len = width as usize * height as usize * 4;
    if buffers.len() != 3 {
        return Err(err(format!(
            "expected 3 frame buffers, got {}",
            buffers.len()
        )));
    }
    let mut out = [(0usize, 0usize); 3];
    for (i, b) in buffers.iter().enumerate() {
        if b.len() != len {
            return Err(err(format!(
                "frame buffer {i} is {} bytes, expected {len}",
                b.len()
            )));
        }
        out[i] = (b.as_ptr() as usize, len);
    }
    Ok(out)
}

#[napi]
impl Engine {
    /// `buffers` are three `Uint8Array(width * height * 4)` the engine writes frames into.
    #[napi(constructor)]
    pub fn new(
        width: u32,
        height: u32,
        buffers: Vec<Uint8Array>,
        options: Option<EngineOptions>,
    ) -> Result<Engine> {
        let ext = external(width, height, &buffers)?;
        let o = options.unwrap_or(EngineOptions {
            hz: None,
            spin_us: None,
            hwdec: None,
            verbose: None,
            bgra: None,
            async_readback: None,
            mpv_options: None,
        });
        let d = bp_core::EngineOptions::default();
        let dp = bp_player::PlayerOptions::default();
        let inner = bp_core::Engine::new(
            width,
            height,
            bp_core::EngineOptions {
                hz: o.hz.unwrap_or(d.hz),
                spin_us: o.spin_us.unwrap_or(d.spin_us),
                player: bp_player::PlayerOptions {
                    hwdec: o.hwdec,
                    verbose: o.verbose.unwrap_or(dp.verbose),
                    bgra: o.bgra.unwrap_or(dp.bgra),
                    async_readback: o.async_readback.unwrap_or(dp.async_readback),
                    stamp_frames: dp.stamp_frames,
                    hold_frames: dp.hold_frames,
                    mpv_options: o
                        .mpv_options
                        .map(|m| m.into_iter().collect())
                        .unwrap_or_default(),
                },
            },
        )
        .map_err(err)?;
        inner.player.resize(width, height, Some(ext)).map_err(err)?;
        Ok(Engine { inner, buffers, pishock_enabled: false, pishock_outputs: Vec::new() })
    }

    /// Loads the video and every script beside it, starting at `startSeconds` when given.
    /// The scripts are read and measured off the JS thread (or taken from `prepare`), then
    /// the file and the scripts swap in together; the promise resolves with the scripts.
    /// `state().loaded` is set at once, the duration and picture follow when mpv has opened
    /// the file. For a library server's stream, `scriptsPath` is the local stand-in whose
    /// siblings hold the cached scripts, and `headers` the HTTP headers the stream needs
    /// (`Field: value`, comma separated; pass an empty string for none), which also keeps
    /// yt-dlp away from the URL.
    /// Aborting `signal` prevents a pending script scan from installing the media.
    #[napi(ts_return_type = "Promise<MediaInfo>")]
    pub fn load(
        &self,
        path: String,
        start_seconds: Option<f64>,
        variants: Option<HashMap<String, String>>,
        scripts_path: Option<String>,
        headers: Option<String>,
        signal: Option<AbortSignal>,
        script_folders: Option<Vec<String>>,
    ) -> Result<AsyncTask<LoadScripts>> {
        let variants = variant_pairs(variants)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(signal) = &signal {
            let cancelled = Arc::clone(&cancelled);
            signal.on_abort(move || cancelled.store(true, Ordering::Relaxed));
        }
        Ok(AsyncTask::with_optional_signal(
            LoadScripts {
                loader: self.inner.loader(),
                path,
                start_seconds: Some(start_seconds),
                variants,
                scripts_path,
                script_folders: script_folders.unwrap_or_default(),
                headers,
                cancelled,
            },
            signal,
        ))
    }

    /// Scans the scripts beside `path` (or beside `scriptsPath`, as in `load`) ahead of its
    /// `load`, off the JS thread, so a session's next clip swaps in without waiting for the
    /// scan. One file is kept; a later call replaces it.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn prepare(&self, path: String, scripts_path: Option<String>, script_folders: Option<Vec<String>>) -> AsyncTask<Prepare> {
        AsyncTask::new(Prepare {
            loader: self.inner.loader(),
            path,
            scripts_path,
            script_folders: script_folders.unwrap_or_default(),
        })
    }

    /// Plays a named variant on an axis (null for the plain script). Returns every script
    /// for the media with the selection marked.
    #[napi]
    pub fn select_variant(
        &self,
        axis_id: String,
        variant: Option<String>,
    ) -> Result<Vec<ScriptInfo>> {
        Ok(self
            .inner
            .select_variant(axis(&axis_id)?, variant)
            .into_iter()
            .map(script_info_js)
            .collect())
    }

    /// Stops playback and drops the scripts.
    #[napi]
    pub fn unload(&self) -> Result<()> {
        self.inner.unload().map_err(err)
    }

    /// The scripts beside `path` without touching the player, for driving devices off a
    /// VR player's clock. Same threading as `load`.
    #[napi(ts_return_type = "Promise<MediaInfo>")]
    pub fn load_scripts(
        &self,
        path: String,
        variants: Option<HashMap<String, String>>,
        script_folders: Option<Vec<String>>,
    ) -> Result<AsyncTask<LoadScripts>> {
        Ok(AsyncTask::new(LoadScripts {
            loader: self.inner.loader(),
            path,
            start_seconds: None,
            variants: variant_pairs(variants)?,
            scripts_path: None,
            script_folders: script_folders.unwrap_or_default(),
            headers: None,
            cancelled: Arc::new(AtomicBool::new(false)),
        }))
    }

    /// Follows a VR player's clock: `deovr` or `heresphere` (port 23554) or `whirligig`
    /// (port 2000). Local playback pauses. Watch `followState().path` and hand it to
    /// `loadScripts` when it changes.
    #[napi]
    pub fn follow(&self, kind: String, host: String, port: Option<u16>) -> Result<()> {
        let kind = bp_core::FollowKind::from_str(&kind)
            .ok_or_else(|| err(format!("unknown follow kind {kind}")))?;
        self.inner.follow(kind, &host, port).map_err(err)
    }

    /// Stops following and puts the clock back on our own player.
    #[napi]
    pub fn unfollow(&self) {
        self.inner.unfollow()
    }

    /// Whether frames should keep coming through `trackFrame` while tracking is off: a
    /// Detection parameter source is set on a restim output, or `setDetectBoxes` is on.
    #[napi]
    pub fn wants_frames(&self) -> bool {
        self.inner.wants_frames()
    }

    /// The host hides what the detector finds (Gooner mode): frames are wanted (see
    /// `wantsFrames`) and every one is run, not one per `setDetectOptions` interval. Read the
    /// boxes with `detectBoxes`.
    #[napi]
    pub fn set_detect_boxes(&self, wanted: bool) {
        self.inner.set_boxes_wanted(wanted)
    }

    /// Every box of the detector's last run whose class is one of `kinds` (`detectionKinds()`
    /// ids), in 0..1 of the frame, with the run's number so a host can tell a fresh run from
    /// the last one. Run 0 and no boxes until a model is ready and has seen a frame.
    #[napi]
    pub fn detect_boxes(&self, kinds: Vec<String>) -> DetectBoxes {
        let kinds: Vec<bp_core::DetectKind> = kinds
            .iter()
            .filter_map(|k| bp_core::DetectKind::from_id(k))
            .collect();
        let (runs, boxes) = self.inner.detect_boxes(&kinds);
        DetectBoxes {
            runs: runs as f64,
            boxes: boxes.into_iter().map(found_js).collect(),
        }
    }

    /// Null when not following.
    #[napi]
    pub fn follow_state(&self) -> Option<FollowState> {
        self.inner.follow_state().map(|s| {
            let (status, error) = match s.status {
                bp_core::FollowStatus::Connecting => ("connecting", None),
                bp_core::FollowStatus::Connected => ("connected", None),
                bp_core::FollowStatus::Error(e) => ("error", Some(e)),
            };
            FollowState {
                kind: s.kind.as_str().to_string(),
                address: s.address,
                status: status.to_string(),
                error,
                path: s.path,
                playing: s.playing,
                time_ms: s.time_ms,
                duration_ms: s.duration_ms,
                rate: s.rate,
            }
        })
    }

    #[napi]
    pub fn play(&self) -> Result<()> {
        self.inner.play().map_err(err)
    }

    #[napi]
    pub fn pause(&self) -> Result<()> {
        self.inner.pause().map_err(err)
    }

    #[napi]
    pub fn seek(&self, seconds: f64) -> Result<()> {
        self.inner.seek(seconds).map_err(err)
    }

    #[napi]
    pub fn set_rate(&self, rate: f64) -> Result<()> {
        self.inner.set_rate(rate).map_err(err)
    }

    /// 0..1.
    #[napi]
    pub fn set_volume(&self, volume: f64) -> Result<()> {
        self.inner.player.set_volume(volume).map_err(err)
    }

    #[napi]
    pub fn volume(&self) -> f64 {
        self.inner.player.volume()
    }

    #[napi]
    pub fn set_muted(&self, muted: bool) -> Result<()> {
        self.inner.player.set_muted(muted).map_err(err)
    }

    #[napi]
    pub fn muted(&self) -> bool {
        self.inner.player.muted()
    }

    /// Seeks to the exact time rather than the nearest keyframe, for the editor.
    #[napi]
    pub fn seek_exact(&self, seconds: f64) -> Result<()> {
        self.inner.seek_exact(seconds).map_err(err)
    }

    /// Steps one frame forward (or back with `false`); the player is left paused.
    #[napi]
    pub fn frame_step(&self, forward: bool) -> Result<()> {
        self.inner.frame_step(forward).map_err(err)
    }

    /// The editor's draft for one axis: keyframe times in ms and positions 0..1, played by
    /// the mixer in place of the file's script until `clearDraft`. Without arrays the axis
    /// goes back to the file's script. Outputs that host the script are left alone until
    /// `pushDraftHosted`.
    #[napi]
    pub fn set_draft(
        &self,
        axis_id: String,
        at: Option<Float64Array>,
        pos: Option<Float64Array>,
    ) -> Result<()> {
        let script = match (at, pos) {
            (Some(at), Some(pos)) => Some(script_from_arrays(&at, &pos)?),
            _ => None,
        };
        self.inner.set_draft(axis(&axis_id)?, script);
        Ok(())
    }

    /// Drops the draft: the file's scripts play again everywhere.
    #[napi]
    pub fn clear_draft(&self) {
        self.inner.clear_draft()
    }

    /// Hands the draft to outputs that host the script (Howl, the Handy), which take a whole
    /// script: call it on pause rather than on every edit.
    #[napi]
    pub fn push_draft_hosted(&self) {
        self.inner.push_draft_hosted()
    }

    /// Analyses one stretch of the loaded local file for the editor: a silent decode with
    /// the 3 s warm-up, through the flow tracker, the detector on Auto and, when asked, the
    /// movement model (which decodes 0.7 s past the range for its future frames). One run at
    /// a time; watch `analyseState`. Local files only.
    #[napi(ts_return_type = "Promise<RangeAnalysis>")]
    pub fn analyse_range(&self, options: AnalyseOptions) -> Result<AsyncTask<AnalyseRange>> {
        let analyser = self.inner.range_analyser().map_err(err)?;
        Ok(AsyncTask::new(AnalyseRange {
            analyser: Some(analyser),
            options: bp_core::RangeOptions {
                start_ms: options.start_ms,
                end_ms: options.end_ms,
                region: options.region.map(region_core),
                model: options.model.unwrap_or(false),
                hero: options.hero.unwrap_or(false),
                thumbs_every_ms: options.thumbs_every_ms,
                thumb_width: options.thumb_width.unwrap_or(96),
            },
        }))
    }

    #[napi]
    pub fn analyse_state(&self) -> RangeState {
        let p = self.inner.range_progress();
        let error = match &p.status {
            bp_core::RangeStatus::Error(e) => Some(e.clone()),
            _ => None,
        };
        RangeState {
            status: p.status.as_str().to_string(),
            error,
            start_ms: p.start_ms,
            end_ms: p.end_ms,
            time_ms: p.time_ms,
        }
    }

    /// The newest position a connected device reports for its own slider, 0..1 (a `#pos`,
    /// `#slider` or echoed `L0` line); null while none does. For recording in the editor.
    #[napi]
    pub fn device_slider(&self) -> Option<f64> {
        self.inner.device_slider()
    }

    /// Stops a running analysis; its promise rejects.
    #[napi]
    pub fn analyse_cancel(&self) {
        self.inner.range_cancel()
    }

    /// Drops the editor's decode (about one extra mpv); the next analysis opens it again.
    #[napi]
    pub fn analyse_close(&self) {
        self.inner.range_close()
    }

    #[napi]
    pub fn global_offset_ms(&self) -> f64 {
        self.inner.global_offset_ms()
    }

    #[napi]
    pub fn set_global_offset_ms(&self, ms: f64) {
        self.inner.set_global_offset_ms(ms)
    }

    #[napi]
    pub fn axis_settings(&self, axis_id: String) -> Result<AxisSettings> {
        Ok(AxisSettings::from_core(
            &self.inner.axis_settings(axis(&axis_id)?),
        ))
    }

    #[napi]
    pub fn set_axis(&self, axis_id: String, settings: AxisSettings) -> Result<()> {
        self.inner.set_axis(axis(&axis_id)?, settings.to_core()?);
        Ok(())
    }

    /// Manual drive for "find my range": a raw device position, or null to release.
    #[napi]
    pub fn set_live(&self, axis_id: String, value: Option<f64>) -> Result<()> {
        self.inner.set_live(axis(&axis_id)?, value);
        Ok(())
    }

    /// Starts the live tracker: hand it frames with `trackFrame` and the axes in the table
    /// follow them through the normal per-axis pipeline, each behind the picture by its
    /// offset. With `lookahead` the frames are the player's own: when the loaded file is
    /// local a second decode tracks ahead of playback, so a negative offset runs the axis
    /// ahead of the picture. Without `axes` the engine's default table applies.
    #[napi]
    pub fn track_start(
        &self,
        options: Option<TrackOptions>,
        axes: Option<Vec<TrackAxis>>,
        lookahead: Option<bool>,
    ) -> Result<()> {
        let o = options.unwrap_or_default();
        let table = track_axes(axes.unwrap_or_default(), bp_core::default_track_axes())?;
        if let Some(pace) = o.pace {
            self.inner.set_pace(pace);
        }
        self.inner
            .track_start(o.to_core(), table, lookahead.unwrap_or(false));
        Ok(())
    }

    /// Live change to the tracking table; rows not given keep their current values.
    #[napi]
    pub fn set_track_axes(&self, axes: Vec<TrackAxis>) -> Result<()> {
        let table = track_axes(axes, self.inner.track_axes())?;
        self.inner.set_track_axes(table);
        Ok(())
    }

    /// Stops tracking and releases the axis. `trackSamples` still works afterwards.
    #[napi]
    pub fn track_stop(&self) {
        self.inner.track_stop()
    }

    /// Browser playback state while tracking browser frames.
    #[napi]
    pub fn track_playback(&self, media_ms: f64, playing: bool, rate: f64) {
        self.inner.track_playback(media_ms, playing, rate);
    }

    /// One row-major frame with the page's media time: grayscale (`channels` 1, the default)
    /// or packed RGB (3). Only RGB frames reach the region detector. The bytes are copied, so
    /// the caller can reuse the buffer. Frames that arrive while the tracker is busy replace
    /// the one waiting.
    #[napi]
    pub fn track_frame(
        &self,
        bytes: Uint8Array,
        width: u32,
        height: u32,
        time_ms: f64,
        channels: Option<u32>,
    ) -> Result<()> {
        let channels = channels.unwrap_or(1);
        if channels != 1 && channels != 3 {
            return Err(err(format!("channels must be 1 or 3, not {channels}")));
        }
        let need = width as usize * height as usize * channels as usize;
        if bytes.len() < need {
            return Err(err(format!(
                "frame is {} bytes, expected {need}",
                bytes.len()
            )));
        }
        self.inner
            .track_frame(&bytes, channels, width, height, time_ms);
        Ok(())
    }

    /// Null tracks the centre 60 percent by 60 percent; a box picks it.
    #[napi]
    pub fn set_track_region(&self, region: Option<TrackRegion>) {
        self.inner.set_track_region(region.map(region_core))
    }

    /// `auto` (the detector's box), `centre`, or `pick` with a region. `target` is the kind
    /// Auto looks for (a `detectionKinds()` id), or null for genitals, else a face.
    #[napi]
    pub fn set_track_region_source(
        &self,
        source: String,
        region: Option<TrackRegion>,
        target: Option<String>,
    ) -> Result<()> {
        let target = match target {
            Some(id) => Some(
                bp_core::DetectKind::from_id(&id)
                    .ok_or_else(|| err(format!("unknown detection kind {id}")))?,
            ),
            None => None,
        };
        self.inner.set_detect_target(target);
        let source = match (source.as_str(), region) {
            ("auto", _) => bp_core::RegionSource::Auto,
            ("centre", _) => bp_core::RegionSource::Centre,
            ("pick", Some(r)) => bp_core::RegionSource::Pick(region_core(r)),
            ("pick", None) => return Err(err("pick needs a region".into())),
            (other, _) => return Err(err(format!("unknown region source {other}"))),
        };
        self.inner.set_track_region_source(source);
        Ok(())
    }

    /// Loads a downloaded model by id from `path` (or unloads with null). `cacheDir` keeps the
    /// compiled CoreML graph between runs. Loading runs on its own thread; watch
    /// `trackState().detector`.
    #[napi]
    pub fn set_detector(
        &self,
        model: Option<String>,
        path: Option<String>,
        cache_dir: Option<String>,
    ) -> Result<()> {
        let load = match (model, path) {
            (Some(id), Some(path)) => {
                let spec = bp_core::MODELS
                    .iter()
                    .find(|m| m.id == id)
                    .ok_or_else(|| err(format!("unknown model {id}")))?;
                Some((
                    spec,
                    std::path::PathBuf::from(path),
                    cache_dir.map(std::path::PathBuf::from),
                ))
            }
            _ => None,
        };
        self.inner.set_detector(load);
        Ok(())
    }

    /// Analyses a raw mono f32le sample file at 22050 Hz (from `audio:decode`) for the Beat
    /// source. Axes on Beat get their scripts once it is ready; watch `beatState`.
    #[napi]
    pub fn beat_load(&self, path: String) {
        self.inner.beat_load(std::path::PathBuf::from(path))
    }

    #[napi]
    pub fn beat_clear(&self) {
        self.inner.beat_clear()
    }

    #[napi]
    pub fn beat_window_begin(&self, reset: bool) -> u32 {
        self.inner.beat_window_begin(reset)
    }

    #[napi]
    pub fn beat_set_window(&self, track: BeatTrackInfo, start_ms: f64, token: u32, continuous: bool) -> bool {
        self.inner.beat_set_window(bp_core::BeatTrack {
            bpm: track.bpm,
            beats: track.beats,
            loudness: track.loudness,
            onset: track.onset.into_iter().map(|v| v as f32).collect(),
            envelope: track.envelope.into_iter().map(|v| v as f32).collect(),
            duration_ms: track.duration_ms,
        }, start_ms, token, continuous)
    }

    #[napi]
    pub fn beat_window_error(&self, token: u32, error: String) {
        self.inner.beat_window_error(token, error)
    }

    /// Starts the Beat source on live audio: feed it `beatLivePush`, and `beatClear` ends it.
    #[napi]
    pub fn beat_live_start(&self) {
        self.inner.beat_live_start()
    }

    /// Mono f32 samples at 22050 Hz in playback order, from the same instant `trackFrame`
    /// times count from.
    #[napi]
    pub fn beat_live_push(&self, samples: Float32Array) {
        self.inner.beat_live_push(&samples)
    }

    #[napi]
    pub fn set_beat_options(&self, options: BeatOptions) -> Result<()> {
        let defaults = bp_core::BeatOptions::default();
        let style = bp_core::BeatStyle::from_str(&options.style).unwrap_or(bp_core::BeatStyle::Strokes);
        self.inner.set_beat_options(bp_core::BeatOptions {
            style,
            volume_depth: options.volume_depth,
            bounce: options.bounce.unwrap_or(true),
            bounce_depth: options.bounce_depth.unwrap_or(defaults.bounce_depth),
            bounce_speed: options.bounce_speed.unwrap_or(defaults.bounce_speed),
            tempo_factor: if options.tempo_factor.is_finite() { options.tempo_factor.clamp(0.25, 4.0) } else { 1.0 },
        });
        Ok(())
    }

    #[napi]
    pub fn beat_state(&self) -> BeatState {
        let b = self.inner.beat_state();
        let (status, error) = match b.status {
            bp_core::BeatStatus::None => ("none", None),
            bp_core::BeatStatus::Analysing => ("analysing", None),
            bp_core::BeatStatus::Ready => ("ready", None),
            bp_core::BeatStatus::Error(e) => ("error", Some(e)),
        };
        let (music_error, percent) = match &b.music {
            bp_core::MusicStatus::Error(e) => (Some(e.clone()), 0.0),
            bp_core::MusicStatus::Watching { percent } => (None, *percent),
            bp_core::MusicStatus::Ready => (None, 100.0),
            _ => (None, 0.0),
        };
        let (full_status, full_error) = match b.full_status {
            bp_core::BeatStatus::None => ("none", None),
            bp_core::BeatStatus::Analysing => ("analysing", None),
            bp_core::BeatStatus::Ready => ("ready", None),
            bp_core::BeatStatus::Error(e) => ("error", Some(e)),
        };
        BeatState {
            status: status.to_string(),
            error,
            full_status: full_status.to_string(),
            full_error,
            bpm: b.bpm,
            beats: b.beats as f64,
            style: b.options.style.as_str().to_string(),
            volume_depth: b.options.volume_depth,
            tempo_factor: b.options.tempo_factor,
            model: MusicState {
                status: b.music.as_str().to_string(),
                percent,
                error: music_error,
            },
        }
    }

    /// The Hero source's target zone (null turns it off) and scroll direction (`auto`,
    /// `right-to-left`, `left-to-right`, `top-down`, `bottom-up`).
    #[napi]
    pub fn set_hero_options(&self, zone: Option<TrackRegion>, direction: String) -> Result<()> {
        let direction = bp_core::HeroDirection::from_str(&direction)
            .ok_or_else(|| err(format!("unknown direction {direction}")))?;
        self.inner.set_hero_options(
            zone.map(|z| bp_core::HeroRect {
                x: z.x,
                y: z.y,
                w: z.w,
                h: z.h,
            }),
            direction,
        );
        Ok(())
    }

    /// What one colour bucket does on `axis`, or on every axis without its own table when
    /// `axis` is null.
    #[napi]
    pub fn set_hero_colour(
        &self,
        axis: Option<String>,
        bucket: u32,
        rule: HeroColourRule,
    ) -> Result<()> {
        let axis = axis.as_deref().map(self::axis).transpose()?;
        let flourish = bp_core::Flourish::from_str(&rule.flourish)
            .ok_or_else(|| err(format!("unknown flourish {}", rule.flourish)))?;
        self.inner.set_hero_colour(
            axis,
            bucket as usize,
            bp_core::ColourRule {
                intensity: rule.intensity.clamp(0.0, 2.0),
                flourish,
                smooth: rule.smooth.clamp(0.0, 1.0),
                ignore: rule.ignore,
            },
        );
        Ok(())
    }

    #[napi]
    pub fn set_hero_music(&self, enabled: bool, rules: Vec<HeroMusicRule>) -> Result<()> {
        let mut options = bp_core::HeroMusicOptions { enabled, ..Default::default() };
        for r in rules {
            let valid = |v: f64, lo: f64, hi: f64| v.is_finite() && v >= lo && v <= hi;
            if r.bucket as usize >= bp_core::HERO_BUCKETS
                || !valid(r.duration_ms, 100.0, 30000.0) || !valid(r.tempo, 0.25, 4.0)
                || !valid(r.intensity, 0.0, 2.0) || !valid(r.playback_speed, 0.25, 2.0)
                || r.estim_max.is_some_and(|v| !valid(v, 0.0, 1.0))
                || r.estim_max_relative.is_some_and(|v| !valid(v, 0.0, 2.0) || r.estim_max.is_some())
                || r.colour.is_some_and(|v| v > 0xffffff)
                || r.tolerance.is_some_and(|v| !valid(v, 0.0, 1.0))
                || r.vibe_max.is_some_and(|v| !valid(v, 0.0, 1.0))
                || r.stroke_speed.is_some_and(|v| !valid(v, 0.1, 20.0)) {
                return Err(err("invalid Hero music rule".to_string()));
            }
            options.rules[r.bucket as usize] = Some(bp_core::HeroMusicRule {
                duration_ms: r.duration_ms, tempo: r.tempo, intensity: r.intensity,
                playback_speed: r.playback_speed, estim_max: r.estim_max, stroke_speed: r.stroke_speed,
                vibe_max: r.vibe_max,
                estim_max_relative: r.estim_max_relative,
                colour: r.colour, tolerance: r.tolerance.unwrap_or(0.15),
            });
        }
        self.inner.set_hero_music(options);
        Ok(())
    }

    /// The playback multiplier a colour hit or a zone asks for right now, 1 for none.
    #[napi]
    pub fn effect_speed(&self) -> f64 {
        self.inner.effect_speed()
    }

    /// Replaces the zone effects as a whole; a rule out of range refuses the lot.
    #[napi]
    pub fn set_zones(&self, enabled: bool, zones: Vec<ZoneRule>) -> Result<()> {
        let valid = |v: f64, lo: f64, hi: f64| v.is_finite() && v >= lo && v <= hi;
        let mut out = Vec::with_capacity(zones.len());
        for z in zones {
            let trigger = match z.trigger.as_str() {
                "colour" => {
                    let mut buckets = [false; bp_core::HERO_BUCKETS];
                    for b in &z.buckets {
                        let b = *b as usize;
                        if b >= bp_core::HERO_BUCKETS {
                            return Err(err("invalid zone colour".to_string()));
                        }
                        buckets[b] = true;
                    }
                    let mut matches = Vec::new();
                    for m in z.colour_matches.as_deref().unwrap_or_default() {
                        let b = m.bucket as usize;
                        if b >= bp_core::HERO_BUCKETS || !z.buckets.contains(&m.bucket) || m.colour > 0xffffff || !valid(m.tolerance, 0.0, 1.0) {
                            return Err(err("invalid zone colour match".to_string()));
                        }
                        buckets[b] = false;
                        matches.push((m.colour, m.tolerance));
                    }
                    if matches.is_empty() { bp_core::ZoneTrigger::Colour(buckets) }
                    else { bp_core::ZoneTrigger::CustomColour { buckets, matches } }
                }
                "part" => bp_core::ZoneTrigger::Part(
                    z.part.as_deref().and_then(bp_core::DetectKind::from_id).ok_or_else(|| err("invalid zone part".to_string()))?,
                ),
                other => return Err(err(format!("unknown zone trigger {other}"))),
            };
            let r = z.region;
            if !valid(r.x, 0.0, 1.0) || !valid(r.y, 0.0, 1.0) || !valid(r.w, 0.0, 1.0) || !valid(r.h, 0.0, 1.0) || r.w <= 0.0 || r.h <= 0.0
                || !valid(z.cover, 0.0, 1.0) || !valid(z.hold_ms, 0.0, 60000.0)
                || !valid(z.tempo, 0.25, 4.0) || !valid(z.intensity, 0.0, 2.0) || !valid(z.playback_speed, 0.25, 2.0)
                || z.stroke_speed.is_some_and(|v| !valid(v, 0.1, 20.0))
                || z.estim_max.is_some_and(|v| !valid(v, 0.0, 1.0))
                || z.estim_max_relative.is_some_and(|v| !valid(v, 0.0, 2.0) || z.estim_max.is_some())
                || z.vibe_max.is_some_and(|v| !valid(v, 0.0, 1.0)) {
                return Err(err("invalid zone".to_string()));
            }
            out.push(bp_core::Zone {
                id: z.id,
                rect: bp_core::DetectRect { x: r.x, y: r.y, w: r.w, h: r.h },
                trigger,
                cover: z.cover,
                hold_ms: z.hold_ms,
                effect: bp_core::EffectOverride {
                    tempo: z.tempo,
                    intensity: z.intensity,
                    playback_speed: z.playback_speed,
                    stroke_speed: z.stroke_speed,
                    estim_max: z.estim_max,
                    estim_max_relative: z.estim_max_relative,
                    vibe_max: z.vibe_max,
                },
            });
        }
        self.inner.set_zones(enabled, out);
        Ok(())
    }

    /// Every zone's share and whether it is on. Cheap; poll it with `trackState`.
    #[napi]
    pub fn zone_state(&self) -> Vec<ZoneMatch> {
        self.inner
            .zone_state()
            .into_iter()
            .map(|m| ZoneMatch { id: m.id, share: m.share, active: m.active, leading: m.leading })
            .collect()
    }

    /// The axis follows the shared colour table again.
    #[napi]
    pub fn clear_hero_axis_colours(&self, axis: String) -> Result<()> {
        self.inner.clear_hero_axis_colours(self::axis(&axis)?);
        Ok(())
    }

    #[napi]
    pub fn hero_state(&self) -> HeroState {
        let h = self.inner.hero_state();
        HeroState {
            zone: h.zone.map(|z| TrackRegion {
                x: z.x,
                y: z.y,
                w: z.w,
                h: z.h,
            }),
            direction: h.direction.as_str().to_string(),
            found: h.found.map(|d| d.as_str().to_string()),
            notes: h
                .notes
                .iter()
                .map(|n| HeroNote {
                    pos: n.pos,
                    size: n.size,
                    rgb: n.rgb.iter().map(|&c| c as u32).collect(),
                })
                .collect(),
            colours: (0..bp_core::HERO_BUCKETS)
                .map(|b| HeroColour {
                    bucket: b as u32,
                    name: bp_core::HERO_BUCKET_NAMES[b].to_string(),
                    intensity: h.colours[b].intensity,
                    flourish: h.colours[b].flourish.as_str().to_string(),
                    smooth: h.colours[b].smooth,
                    ignore: h.colours[b].ignore,
                    seen: h.seen[b],
                })
                .collect(),
            next_hit_ms: h.next_hit_ms,
            hits: h.hits as f64,
        }
    }

    /// How often the detector looks between cuts, and the room left around its box.
    #[napi]
    pub fn set_detect_options(&self, interval_ms: f64, padding: f64) {
        self.inner.set_detect_options(bp_core::DetectOptions {
            interval_ms: interval_ms.max(100.0),
            padding: padding.clamp(0.0, 2.0),
        })
    }

    #[napi]
    pub fn set_track_options(&self, options: TrackOptions) {
        if let Some(pace) = options.pace {
            self.inner.set_pace(pace);
        }
        self.inner.set_track_options(options.to_core())
    }

    /// Loads a downloaded AI model by id (`kind` `motion` or `music`; `detector` goes through
    /// `setDetector`) from its weights and the metadata beside them, or unloads with nulls.
    /// `cacheDir` keeps the compiled CoreML graph and the music model's video passes between
    /// runs. Loading runs on its own thread; watch `modelState`.
    #[napi]
    pub fn set_model(
        &self,
        kind: String,
        model: Option<String>,
        path: Option<String>,
        metadata: Option<String>,
        cache_dir: Option<String>,
    ) -> Result<()> {
        let kind = bp_core::ModelKind::from_id(&kind)
            .ok_or_else(|| err(format!("unknown model kind {kind}")))?;
        if kind == bp_core::ModelKind::Detector {
            return self.set_detector(model, path, cache_dir);
        }
        let load = match (model, path, metadata) {
            (Some(id), Some(path), Some(metadata)) => {
                let spec = bp_core::AI_MODELS
                    .iter()
                    .find(|m| m.id == id && m.kind == kind)
                    .ok_or_else(|| err(format!("unknown {} model {id}", kind.id())))?;
                Some((
                    spec,
                    std::path::PathBuf::from(path),
                    std::path::PathBuf::from(metadata),
                    cache_dir.map(std::path::PathBuf::from),
                ))
            }
            _ => None,
        };
        self.inner.set_model(kind, load);
        Ok(())
    }

    /// What an AI model is doing. For `detector`, see `trackState().detector`.
    #[napi]
    pub fn model_state(&self, kind: String) -> Result<ModelState> {
        let kind = bp_core::ModelKind::from_id(&kind)
            .ok_or_else(|| err(format!("unknown model kind {kind}")))?;
        Ok(model_state_js(self.inner.model_state(kind)))
    }

    #[napi]
    pub fn track_state(&self) -> TrackState {
        let s = self.inner.track_state();
        TrackState {
            active: s.active,
            state: s.state.as_str().to_string(),
            region: s.region.map(region_js),
            auto: s.auto,
            detector: detector_js(s.detect),
            model: model_state_js(s.model),
            position: s.position,
            motion: s.motion.to_vec(),
            ahead_ms: s.ahead_ms,
            fps: s.fps,
            frames: s.frames as f64,
            cuts: s.cuts as f64,
            jumps: s.jumps as f64,
            drops: s.drops as f64,
        }
    }

    /// The last two seconds of tracked positions, for a trace view. Copies them, so ask
    /// while the view is open rather than every frame.
    #[napi]
    pub fn track_trace(&self) -> Vec<TrackSample> {
        self.inner
            .track_trace()
            .into_iter()
            .map(track_sample_js)
            .collect()
    }

    /// Every tracked sample from `sinceMs` onward, for saving a funscript.
    #[napi]
    pub fn track_samples(&self, since_ms: f64) -> Vec<TrackSample> {
        self.inner
            .track_samples(since_ms)
            .into_iter()
            .map(track_sample_js)
            .collect()
    }

    /// Runs the whole loaded file through with the tracking table as it stands and resolves
    /// with one script per axis, ready to write: the flow tracker, the detector on Auto and
    /// the Hero watcher see every frame; Beat axes take the analysed audio (load it first,
    /// or they are left out). Local files only, one run at a time; watch `generateState`.
    #[napi(ts_return_type = "Promise<GeneratedScript[]>")]
    pub fn generate(&self) -> Result<AsyncTask<Generate>> {
        let generation = self.inner.generate().map_err(err)?;
        Ok(AsyncTask::new(Generate {
            generation: Some(generation),
        }))
    }

    #[napi]
    pub fn generate_state(&self) -> GenerateState {
        let p = self.inner.generate_progress();
        let error = match &p.status {
            bp_core::GenerateStatus::Error(e) => Some(e.clone()),
            _ => None,
        };
        GenerateState {
            status: p.status.as_str().to_string(),
            error,
            time_ms: p.time_ms,
            duration_ms: p.duration_ms,
            fps: p.fps,
            frames: p.frames as f64,
            hits: p.hits as f64,
            provider: p.provider.map(str::to_string),
            model_ms: p.model_ms,
        }
    }

    /// Stops a running generation; its promise rejects.
    #[napi]
    pub fn generate_cancel(&self) {
        self.inner.generate_cancel()
    }

    /// Installs scripts generated for the loaded file (from `generate`, or saved from an
    /// earlier run) for outputs that host the script themselves: Howl and the Handy play
    /// them in place of the file's scripts on those axes. Every other output keeps the live
    /// tracker. An empty list puts the file's scripts back; a load clears them.
    #[napi]
    pub fn set_generated(&self, scripts: Vec<GeneratedInput>) -> Result<()> {
        let parsed = scripts
            .into_iter()
            .map(|s| {
                Ok((
                    axis(&s.axis)?,
                    bp_script::Script::parse(&s.json).map_err(err)?,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        self.inner.set_generated(parsed);
        Ok(())
    }

    /// Starts connecting and returns the output id; watch `state().outputs` for progress.
    #[napi]
    pub fn connect(&mut self, transport: Transport) -> Result<u32> {
        if transport.kind == "pishock" && !self.pishock_enabled { return Err(err("Supporter only".into())); }
        let p = transport
            .profile
            .as_deref()
            .map(profile)
            .transpose()?
            .unwrap_or_default();
        let id = self.inner.connect(transport.to_core()?, p);
        if transport.kind == "pishock" { self.pishock_outputs.push(id); }
        Ok(id)
    }

    /// Applies the host account entitlement and immediately drops PiShock outputs when revoked.
    #[napi]
    pub fn set_pishock_enabled(&mut self, enabled: bool) {
        self.pishock_enabled = enabled;
        if !enabled {
            for id in self.pishock_outputs.drain(..) { self.inner.disconnect(id); }
        }
    }

    /// Switches an output between the stroker and restim axis families.
    #[napi]
    pub fn set_output_profile(&self, id: u32, profile_name: String) -> Result<bool> {
        Ok(self.inner.set_output_profile(id, profile(&profile_name)?))
    }

    /// Device button presses since the last call.
    #[napi]
    pub fn take_inputs(&self) -> Vec<DeviceInput> {
        self.inner
            .take_inputs()
            .into_iter()
            .map(|i| DeviceInput {
                output: i.output,
                name: i.name,
            })
            .collect()
    }

    #[napi]
    pub fn disconnect(&mut self, id: u32) -> bool {
        self.pishock_outputs.retain(|kept| *kept != id);
        self.inner.disconnect(id)
    }

    /// Points a toy's feature at an axis, or off with null. Kept across reconnects. False for
    /// any other output.
    #[napi]
    pub fn set_output_feature_axis(
        &self,
        id: u32,
        feature: u32,
        axis_id: Option<String>,
    ) -> Result<bool> {
        let axis = axis_id.as_deref().map(axis).transpose()?;
        Ok(self.inner.set_output_feature_axis(id, feature, axis))
    }

    /// Gives a toy's level feature (vibrate, oscillate, constrict, spray, a one-way rotate,
    /// heat, light) its own map, or the default (the identity) with null. Kept across
    /// reconnects. False for any other output.
    #[napi]
    pub fn set_output_feature_level(&self, id: u32, feature: u32, level: Option<FeatureLevel>) -> Result<bool> {
        let level = level
            .map(|l| {
                if ![l.from, l.to, l.floor, l.cap].iter().all(|v| v.is_finite()) {
                    return Err(err("feature level values must be finite".into()));
                }
                Ok::<_, Error>(bp_devices::LevelMap { from: l.from, to: l.to, floor: l.floor, cap: l.cap }.validated())
            })
            .transpose()?;
        Ok(self.inner.set_output_feature_level(id, feature, level))
    }

    /// Whether levels (vibration, suction, a pump) rest while playback is paused, on every
    /// output. Off, they hold their last value the way a stroker holds its position. Estim
    /// mutes on pause either way. On until set.
    #[napi]
    pub fn set_stop_on_pause(&self, on: bool) {
        self.inner.set_stop_on_pause(on);
    }

    #[napi]
    pub fn stop_on_pause(&self) -> bool {
        self.inner.stop_on_pause()
    }

    /// Shakes another axis into an output's stroke, or stops with null. False for an unknown
    /// output or one that takes no per-tick position (a toy, the Handy, Howl, a Coyote).
    #[napi]
    pub fn set_output_vibration(&self, id: u32, vibration: Option<VibrationConfig>) -> Result<bool> {
        let vibration = vibration
            .map(|v| {
                if !v.depth.is_finite() || !v.hz.is_finite() {
                    return Err(err("vibration depth and hz must be finite".into()));
                }
                Ok::<_, Error>(bp_devices::Vibration {
                    source: axis(&v.source)?,
                    depth: v.depth.clamp(0.0, 1.0),
                    hz: v.hz.clamp(0.0, 50.0),
                })
            })
            .transpose()?;
        Ok(self.inner.set_output_vibration(id, vibration))
    }

    /// When an output gets each position against the video, in ms: negative early (for a
    /// slow device), positive late. False for an unknown output or one that plays the script
    /// itself (the Handy, Howl).
    #[napi]
    pub fn set_output_delay(&self, id: u32, ms: f64) -> Result<bool> {
        if !ms.is_finite() {
            return Err(err("delay must be finite".into()));
        }
        Ok(self.inner.set_output_delay(id, ms.clamp(-5000.0, 5000.0)))
    }

    /// Live per-channel strength on a Coyote output, 0..200. False for any other output.
    #[napi]
    pub fn set_coyote_strength(&self, id: u32, a: u8, b: u8) -> bool {
        self.inner.set_coyote_strength(id, a, b)
    }

    /// Live trigger on an OpenShock output, kept across reconnects. False for any other output.
    #[napi]
    pub fn set_openshock_trigger(&self, id: u32, trigger: OpenShockTrigger) -> Result<bool> {
        Ok(self.inner.set_openshock_trigger(id, trigger.to_core()?))
    }

    /// Temporary session output scale, 0..1. Zero stops output; one restores its configured range.
    #[napi]
    pub fn set_output_session_scale(&self, id: u32, scale: f64) -> bool {
        self.inner.set_output_session_scale(id, scale)
    }

    #[napi]
    pub fn set_output_clamp(&self, id: u32, axis_id: String, clamp: AxisClamp) -> Result<bool> {
        Ok(self.inner.set_output_clamp(
            id,
            axis(&axis_id)?,
            bp_devices::AxisClamp {
                enabled: clamp.enabled,
                min: clamp.min.clamp(0.0, 1.0),
                max: clamp.max.clamp(0.0, 1.0),
            },
        ))
    }

    /// Clamps in axis table order, or null for an unknown output.
    #[napi]
    pub fn output_clamps(&self, id: u32) -> Option<Vec<AxisClamp>> {
        self.inner.output_clamps(id).map(|c| {
            c.iter()
                .map(|c| AxisClamp {
                    enabled: c.enabled,
                    min: c.min,
                    max: c.max,
                })
                .collect()
        })
    }

    /// Session volume ramp on a restim output; turning it on starts it over. False for an
    /// unknown output.
    #[napi]
    pub fn set_output_ramp(&self, id: u32, config: RampConfig) -> bool {
        self.inner.set_output_ramp(
            id,
            bp_core::RampConfig {
                enabled: config.enabled,
                start: config.start,
                max: config.max,
                duration_ms: config.duration_ms,
            },
        )
    }

    #[napi]
    pub fn restart_output_ramp(&self, id: u32) -> bool {
        self.inner.restart_output_ramp(id)
    }

    /// The wizard's test on an output that has its own: Howl plays a five second sine, an
    /// OpenShock shocker gets one pulse. False for every other output: sweep the live axis for those.
    #[napi]
    pub fn test_output(&self, id: u32) -> bool {
        self.inner.test_output(id)
    }

    #[napi]
    pub fn output_ramp(&self, id: u32) -> Option<RampConfig> {
        self.inner.output_ramp(id).map(|c| RampConfig {
            enabled: c.enabled,
            start: c.start,
            max: c.max,
            duration_ms: c.duration_ms,
        })
    }

    /// Starts the Buttplug server that stands in for Intiface Central on `port` (12345 is
    /// what faptap.net and other clients expect), so a page's `LinearCmd` drives the stroke.
    /// Throws when the port is taken.
    #[napi]
    pub fn start_intiface(&self, port: u16) -> Result<()> {
        self.inner.start_intiface(port).map_err(err)
    }

    #[napi]
    pub fn stop_intiface(&self) {
        self.inner.stop_intiface()
    }

    /// Null while the server is off.
    #[napi]
    pub fn intiface_state(&self) -> Option<IntifaceState> {
        self.inner.intiface_status().map(|s| IntifaceState {
            port: s.port,
            clients: s.clients as u32,
            client: s.client,
        })
    }

    /// Where a restim parameter axis takes its value without a script. Applies while any
    /// restim output exists. Errors for an axis that is not a parameter.
    #[napi]
    pub fn set_param_source(&self, axis_id: String, source: ParamSource) -> Result<()> {
        let a = axis(&axis_id)?;
        if !self.inner.set_param_source(a, source.to_core()?) {
            return Err(err(format!("{axis_id} is not a restim parameter axis")));
        }
        Ok(())
    }

    #[napi]
    pub fn param_source(&self, axis_id: String) -> Result<ParamSource> {
        Ok(ParamSource::from_core(
            self.inner.param_source(axis(&axis_id)?),
        ))
    }

    #[napi]
    pub fn set_estim(&self, options: EstimOptions) -> Result<()> {
        let boost = match options.volume_boost {
            Some(b) => {
                let source = axis(&b.axis)?;
                if !matches!(source.kind(), bp_script::Kind::Position | bp_script::Kind::Rotation) {
                    return Err(err("volume boost requires a position or rotation axis".into()));
                }
                bp_devices::ramp::VolumeBoost { enabled: b.enabled, axis: source, amount: b.amount }
            }
            None => bp_devices::ramp::VolumeBoost::default(),
        };
        self.inner.set_estim(bp_core::EstimOptions {
            contrast: options.contrast,
            volume_floor: options.volume_floor.unwrap_or(bp_core::EstimOptions::default().volume_floor),
            volume_max: options.volume_max.unwrap_or(1.0),
            volume_boost: boost,
            params: options.params,
        });
        Ok(())
    }

    #[napi]
    pub fn estim(&self) -> EstimOptions {
        let o = self.inner.estim();
        EstimOptions {
            contrast: o.contrast,
            volume_floor: Some(o.volume_floor),
            volume_max: Some(o.volume_max),
            volume_boost: Some(EstimVolumeBoost { enabled: o.volume_boost.enabled, axis: o.volume_boost.axis.id().into(), amount: o.volume_boost.amount }),
            params: o.params,
        }
    }

    /// What a held Detection source is sending for the axis, null while it is not held or
    /// nothing has arrived yet.
    #[napi]
    pub fn param_hold(&self, axis_id: String) -> Result<Option<ParamHold>> {
        Ok(self
            .inner
            .param_hold(axis(&axis_id)?)
            .map(|(value, since_ms)| ParamHold { value, since_ms }))
    }

    /// Whether a held Detection source waits on scene cuts: a host that sends frames now and
    /// then while tracking is off should then send about ten a second.
    #[napi]
    pub fn wants_cuts(&self) -> bool {
        self.inner.wants_cuts()
    }

    /// Everything the UI shows at 60 Hz.
    #[napi]
    pub fn state(&self) -> EngineState {
        let s = self.inner.state();
        EngineState {
            time_ms: s.time_ms,
            duration_ms: s.duration_ms,
            paused: s.paused,
            rate: s.rate,
            loaded: s.loaded,
            following: s.following,
            video_width: s.video_width,
            video_height: s.video_height,
            axis_values: Float64Array::new(s.axis_values.to_vec()),
            axis_flags: Uint8Array::new(s.axis_flags.to_vec()),
            flags_version: s.flags_version as f64,
            error: s.error,
            outputs: s
                .outputs
                .into_iter()
                .map(|o| {
                    let (status, error) = match o.status {
                        bp_devices::Status::Connecting => ("connecting", None),
                        bp_devices::Status::Connected => ("connected", None),
                        bp_devices::Status::Error(e) => ("error", Some(e)),
                    };
                    OutputState {
                        sent_values: bp_script::Axis::ALL.into_iter().filter_map(|a| o.sent[a.index()].map(|v| (a.id().to_string(), v as f64 / 9999.0))).collect(),
                        id: o.id,
                        kind: o.kind.to_string(),
                        address: o.address,
                        profile: o.profile.as_str().to_string(),
                        status: status.to_string(),
                        error,
                        device: o.device,
                        tcode: o.tcode,
                        ramp: o.ramp.map(|r| RampProgress {
                            value: r.value,
                            elapsed_ms: r.elapsed_ms,
                            duration_ms: r.duration_ms,
                            start: r.start,
                            max: r.max,
                        }),
                        howl: o.howl.map(|h| HowlStatus {
                            playing: h.playing,
                            position: h.position,
                            title: h.title,
                            power_a: h.power_a,
                            power_b: h.power_b,
                            mute: h.mute,
                        }),
                        ossm: o.ossm.map(|s| OssmStatus {
                            state: s.state,
                            speed: s.speed,
                            position_mm: s.position_mm,
                        }),
                        features: o
                            .features
                            .into_iter()
                            .map(|f| OutputFeature {
                                index: f.index,
                                kind: f.kind.to_string(),
                                description: f.description,
                                axis: f.axis.map(|a| a.id().to_string()),
                                speed: f.speed,
                                level: f.level,
                                input: f.input,
                            })
                            .collect(),
                        battery: o.battery,
                    }
                })
                .collect(),
        }
    }

    /// Counters and timings for one output; null for an unknown id.
    #[napi]
    pub fn output_stats(&self, id: u32) -> Option<OutputStats> {
        self.inner.output_stats(id).map(|s| OutputStats {
            lines_sent: s.lines_sent as f64,
            write_us: s.write.into(),
            received: s.received,
        })
    }

    #[napi]
    pub fn tick_stats(&self) -> EngineTickStats {
        let t = self.inner.tick_stats();
        EngineTickStats {
            hz: t.hz,
            realtime: t.realtime,
            late_us: t.late.into(),
            work_us: t.work.into(),
        }
    }

    /// Whether anyone is looking at the frames. While false, mpv skips drawing and nothing
    /// is read back; audio and the clock carry on. Call with the window's visibility.
    #[napi]
    pub fn set_presenting(&self, on: bool) -> Result<()> {
        self.inner.set_presenting(on).map_err(err)
    }

    #[napi]
    pub fn video_fps(&self) -> f64 {
        self.inner.player.video_fps()
    }

    #[napi]
    pub fn hwdec(&self) -> String {
        self.inner.player.hwdec_current()
    }

    /// `auto` picks the platform decoder, `no` forces software; applies to the next video.
    #[napi]
    pub fn set_hwdec(&self, value: String) -> Result<()> {
        let v = match value.as_str() {
            "auto" => default_hwdec(),
            other => other,
        };
        self.inner.player.set_hwdec(v).map_err(err)
    }

    #[napi]
    pub fn enhance_capabilities(&self) -> EnhanceCapabilities {
        let c = self.inner.player.enhance_capabilities();
        EnhanceCapabilities {
            vsr: c.vsr,
            apple_vsr: c.apple_vsr,
            frame_gen: c.frame_gen,
            dlss: c.dlss,
            vsr_reason: c.vsr_reason,
            apple_vsr_reason: c.apple_vsr_reason,
            frame_gen_reason: c.frame_gen_reason,
            dlss_reason: c.dlss_reason,
            gpu: c.gpu,
        }
    }

    /// Applies upscaling and frame generation to the current video, no reload. Options the
    /// machine cannot honour stay inert; `enhanceState().reason` says why.
    #[napi]
    pub fn set_enhance(&self, options: EnhanceOptions) -> Result<()> {
        let upscaler = bp_player::Upscaler::parse(&options.upscaler)
            .ok_or_else(|| err(format!("unknown upscaler {}", options.upscaler)))?;
        let target_fps = options.target_fps.filter(|f| *f > 0.0);
        let dlss = match options.dlss {
            Some(d) => parse_dlss(d).map_err(err)?,
            None => bp_player::DlssOptions::default(),
        };
        self.inner
            .player
            .set_enhance(bp_player::EnhanceOptions {
                upscaler,
                target_fps,
                dlss,
            })
            .map_err(err)
    }

    /// What is in effect right now, for the player chip. Cheap; once a second is plenty.
    #[napi]
    pub fn enhance_state(&self) -> EnhanceState {
        let s = self.inner.player.enhance_state();
        EnhanceState {
            upscaler: s.upscaler.as_str().to_string(),
            upscaling: s.upscaling,
            factor: s.factor,
            source_width: s.source.0,
            source_height: s.source.1,
            output_width: s.output.0,
            output_height: s.output.1,
            frame_gen: s.frame_gen,
            target_fps: s.target_fps,
            reason: s.reason,
        }
    }

    /// The decoded picture width as mpv last reported it; also in `state()`.
    #[napi]
    pub fn video_width(&self) -> u32 {
        self.inner.video_size().0
    }

    #[napi]
    pub fn video_height(&self) -> u32 {
        self.inner.video_size().1
    }

    /// Whether frame bytes are BGRA (else RGBA).
    #[napi]
    pub fn bgra(&self) -> bool {
        self.inner.player.bgra()
    }

    #[napi]
    pub fn width(&self) -> u32 {
        self.inner.player.size().0
    }

    #[napi]
    pub fn height(&self) -> u32 {
        self.inner.player.size().1
    }

    /// Changes output size with three new buffers of the new size. The old buffers are
    /// released once the engine has switched over.
    #[napi]
    pub fn resize(&mut self, width: u32, height: u32, buffers: Vec<Uint8Array>) -> Result<()> {
        let ext = external(width, height, &buffers)?;
        self.inner
            .player
            .resize(width, height, Some(ext))
            .map_err(err)?;
        self.buffers = buffers;
        Ok(())
    }

    /// Index into the buffers of the newest unread frame, or -1.
    #[napi]
    pub fn acquire(&self) -> i32 {
        self.inner.player.acquire().map(|i| i as i32).unwrap_or(-1)
    }

    #[napi]
    pub fn stats(&self) -> RenderStats {
        let s = self.inner.player.stats();
        RenderStats {
            frames: s.frames as f64,
            dropped: s.dropped as f64,
            skipped: s.skipped as f64,
            render_errors: s.render_errors as f64,
            gl_errors: s.gl_errors as f64,
            last_gl_error: s.last_gl_error,
            render_ms: s.render.into(),
            readback_ms: s.readback.into(),
            interval_ms: s.interval.into(),
            present_ms: s.present.into(),
        }
    }

    /// Drains buffered mpv log lines.
    #[napi]
    pub fn take_log(&self) -> Vec<String> {
        self.inner.player.take_log()
    }

    #[napi]
    pub fn close(&mut self) {
        self.inner.close()
    }
}

fn default_hwdec() -> &'static str {
    if cfg!(target_os = "macos") {
        "videotoolbox"
    } else if cfg!(target_os = "windows") {
        "d3d11va"
    } else {
        "auto-safe"
    }
}

/// Reads and measures the scripts for a media file on a worker thread, then installs them
/// on the JS thread, for `load` and `loadScripts`.
/// Scripts for a file: the pool is scanned on a worker, then installed on the JS thread,
/// with the file itself when `start_seconds` is `Some` (a `load`) and alone for `loadScripts`.
pub struct LoadScripts {
    loader: bp_core::ScriptLoader,
    path: String,
    start_seconds: Option<Option<f64>>,
    variants: Vec<(bp_script::Axis, String)>,
    scripts_path: Option<String>,
    script_folders: Vec<String>,
    headers: Option<String>,
    cancelled: Arc<AtomicBool>,
}

impl Task for LoadScripts {
    type Output = Vec<bp_core::PoolEntry>;
    type JsValue = MediaInfo;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self
            .loader
            .pool_for(&self.path, self.scripts_path.as_deref(), &self.script_folders))
    }

    fn resolve(&mut self, _env: Env, pool: Self::Output) -> Result<Self::JsValue> {
        // An already-running scan cannot be canceled by libuv; it must not install its result.
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(Error::new(Status::Cancelled, "Media load cancelled"));
        }
        let m = match self.start_seconds {
            Some(start) => self
                .loader
                .load(
                    &self.path,
                    start,
                    pool,
                    &self.variants,
                    self.headers.as_deref(),
                )
                .map_err(err)?,
            None => self
                .loader
                .apply(std::path::Path::new(&self.path), pool, &self.variants),
        };
        Ok(MediaInfo {
            path: m.path.to_string_lossy().into_owned(),
            scripts: m.scripts.into_iter().map(script_info_js).collect(),
        })
    }
}

pub struct Prepare {
    loader: bp_core::ScriptLoader,
    path: String,
    scripts_path: Option<String>,
    script_folders: Vec<String>,
}

impl Task for Prepare {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        self.loader
            .prepare(&self.path, self.scripts_path.as_deref(), &self.script_folders);
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

pub struct ScanScripts {
    path: String,
    script_folders: Vec<String>,
}

pub struct Generate {
    generation: Option<bp_core::Generation>,
}

impl Task for Generate {
    type Output = Vec<GeneratedScript>;
    type JsValue = Vec<GeneratedScript>;

    fn compute(&mut self) -> Result<Self::Output> {
        let generation = self
            .generation
            .take()
            .ok_or_else(|| err("already run".into()))?;
        let scripts = generation.run().map_err(err)?;
        Ok(scripts
            .into_iter()
            .map(|(axis, script)| GeneratedScript {
                axis: axis.id().to_string(),
                suffix: if axis == bp_script::Axis::L0 {
                    String::new()
                } else {
                    axis.suffixes()[0].to_string()
                },
                actions: script.actions.len() as f64,
                duration_ms: script.actions.last().map_or(0.0, |a| a.at),
                json: script.to_json(),
            })
            .collect())
    }

    fn resolve(&mut self, _env: Env, scripts: Self::Output) -> Result<Self::JsValue> {
        Ok(scripts)
    }
}

impl Task for ScanScripts {
    type Output = Vec<bp_core::ScriptInfo>;
    type JsValue = Vec<ScriptInfo>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(bp_core::scan_scripts_with_folders(std::path::Path::new(&self.path), &self.script_folders))
    }

    fn resolve(&mut self, _env: Env, infos: Self::Output) -> Result<Self::JsValue> {
        Ok(infos.into_iter().map(script_info_js).collect())
    }
}

/// Scripts beside a media file without loading anything, for the library scanner. Reads
/// and parses on a worker thread.
#[napi(ts_return_type = "Promise<Array<ScriptInfo>>")]
pub fn scan_scripts(path: String, script_folders: Option<Vec<String>>) -> AsyncTask<ScanScripts> {
    AsyncTask::new(ScanScripts { path, script_folders: script_folders.unwrap_or_default() })
}

/// `{ L0: 'mouth' }` to axis pairs.
fn variant_pairs(
    variants: Option<HashMap<String, String>>,
) -> Result<Vec<(bp_script::Axis, String)>> {
    variants
        .unwrap_or_default()
        .into_iter()
        .map(|(a, v)| Ok((axis(&a)?, v)))
        .collect()
}

fn region_core(r: TrackRegion) -> bp_core::Region {
    bp_core::Region {
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
    }
}

fn region_js(r: bp_core::Region) -> TrackRegion {
    TrackRegion {
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
    }
}

fn found_js(f: bp_core::Found) -> FoundBox {
    FoundBox {
        x: f.rect.x,
        y: f.rect.y,
        w: f.rect.w,
        h: f.rect.h,
        class: f.class.to_string(),
        confidence: f.confidence as f64,
    }
}

fn detector_js(d: bp_core::DetectSnapshot) -> DetectorState {
    let (status, error) = match d.status {
        bp_core::DetectStatus::None => ("none", None),
        bp_core::DetectStatus::Loading => ("loading", None),
        bp_core::DetectStatus::Ready => ("ready", None),
        bp_core::DetectStatus::Error(e) => ("error", Some(e)),
    };
    DetectorState {
        status: status.to_string(),
        error,
        model: d.model.map(str::to_string),
        provider: d.provider.map(str::to_string),
        found: d.found.map(found_js),
        run_ms: d.run_ms,
        runs: d.runs as f64,
        coverage: d.coverage.to_vec(),
    }
}

fn model_state_js(m: bp_core::ModelSnapshot) -> ModelState {
    let (status, error) = match m.status {
        bp_core::ModelStatus::None => ("none", None),
        bp_core::ModelStatus::Loading => ("loading", None),
        bp_core::ModelStatus::Ready => ("ready", None),
        bp_core::ModelStatus::Error(e) => ("error", Some(e)),
    };
    ModelState {
        status: status.to_string(),
        error,
        model: m.id.map(str::to_string),
        version: m.version,
        provider: m.provider.map(str::to_string),
        fallback: m.fallback,
        warmup_ms: m.warmup_ms,
        run_ms: m.run_ms,
        too_slow: m.too_slow,
    }
}

/// Every model the app uses: the downloadable region detectors, then our bundled two.
/// `detectorModels` lists the detectors alone, as before.
#[napi]
pub fn models() -> Vec<ModelInfo> {
    let detectors = bp_core::MODELS.iter().map(|m| ModelInfo {
        id: m.id.to_string(),
        label: m.label.to_string(),
        kind: "detector".to_string(),
        version: String::new(),
        files: vec![ModelFile {
            file: m.file.to_string(),
            url: m.url.to_string(),
            sha256: m.sha256.to_string(),
        }],
        bundled: false,
        size_mb: m.size_mb,
        licence: m.licence.to_string(),
        licence_url: m.licence_url.to_string(),
        source_url: m.source_url.to_string(),
        consent: true,
    });
    let ours = bp_core::AI_MODELS.iter().map(|m| ModelInfo {
        id: m.id.to_string(),
        label: m.label.to_string(),
        kind: m.kind.id().to_string(),
        version: m.version.to_string(),
        files: m
            .files
            .iter()
            .map(|f| ModelFile {
                file: f.to_string(),
                url: String::new(),
                sha256: String::new(),
            })
            .collect(),
        bundled: true,
        size_mb: m.size_mb,
        licence: m.licence.to_string(),
        licence_url: m.licence_url.to_string(),
        source_url: m.source_url.to_string(),
        consent: false,
    });
    detectors.chain(ours).collect()
}

/// The region models alone, in preference order. Kept one release beside `models`.
#[napi]
pub fn detector_models() -> Vec<DetectorModel> {
    bp_core::MODELS
        .iter()
        .map(|m| DetectorModel {
            id: m.id.to_string(),
            label: m.label.to_string(),
            file: m.file.to_string(),
            input: m.input,
            url: m.url.to_string(),
            sha256: m.sha256.to_string(),
            size_mb: m.size_mb,
            licence: m.licence.to_string(),
            licence_url: m.licence_url.to_string(),
            source_url: m.source_url.to_string(),
        })
        .collect()
}

/// Style and depth of the Beat source's strokes, plus the per-video tempo factor.
#[napi(object)]
pub struct BeatOptions {
    /// Playback always uses strokes. Older style names migrate to strokes.
    pub style: String,
    pub volume_depth: bool,
    /// Add a fast bottom bounce on loud beats. Defaults to true.
    pub bounce: Option<bool>,
    /// Fraction of the preceding stroke, 0.01..1. Defaults to one sixth.
    pub bounce_depth: Option<f64>,
    /// Multiple of the main stroke speed, 0.5..6. Defaults to 3.
    pub bounce_speed: Option<f64>,
    /// 0.5 halves the tempo, 2 doubles it.
    pub tempo_factor: f64,
}

/// The music model's pass over the file, for axes on AI CH/PMV: `none`, `watching` (the
/// video pass, with `percent`), `modelling`, `ready` or `error`. Those axes play Beat's
/// script until it is ready.
#[napi(object)]
pub struct MusicState {
    pub status: String,
    pub percent: f64,
    pub error: Option<String>,
}

#[napi(object)]
pub struct BeatState {
    /// `none`, `analysing`, `ready` or `error`.
    pub status: String,
    pub error: Option<String>,
    /// Readiness of the complete file for export and the music model.
    pub full_status: String,
    pub full_error: Option<String>,
    /// Tempo after the factor.
    pub bpm: f64,
    pub beats: f64,
    pub style: String,
    pub volume_depth: bool,
    pub tempo_factor: f64,
    pub model: MusicState,
}

/// What a colour does: how deep its hits go, the pattern on top, how eased the legs are,
/// or nothing at all.
#[napi(object)]
pub struct HeroMusicRule {
    pub colour: Option<u32>,
    pub tolerance: Option<f64>,
    pub bucket: u32,
    pub duration_ms: f64,
    pub tempo: f64,
    pub intensity: f64,
    pub playback_speed: f64,
    pub stroke_speed: Option<f64>,
    pub estim_max: Option<f64>,
    pub estim_max_relative: Option<f64>,
    /// The vibration axis's output maximum while on.
    pub vibe_max: Option<f64>,
}

/// One zone effect from `setZones`: a box in 0..1 of the frame, its trigger (`colour` with
/// `buckets` in Hero bucket order, or `part` with a `detectionKinds()` id) and what it
/// overrides while it matches, held `holdMs` after. 1 and null leave a setting as it is.
#[napi(object)]
pub struct ZoneRule {
    pub colour_matches: Option<Vec<ZoneColourMatch>>,
    pub id: String,
    pub region: TrackRegion,
    /// `colour` or `part`.
    pub trigger: String,
    pub buckets: Vec<u32>,
    pub part: Option<String>,
    /// The share of the zone the colour must fill, or of the box and zone that must overlap.
    pub cover: f64,
    pub hold_ms: f64,
    pub tempo: f64,
    pub intensity: f64,
    pub playback_speed: f64,
    pub stroke_speed: Option<f64>,
    pub estim_max: Option<f64>,
    pub estim_max_relative: Option<f64>,
    pub vibe_max: Option<f64>,
}

#[napi(object)]
pub struct ZoneColourMatch {
    pub bucket: u32,
    pub colour: u32,
    pub tolerance: f64,
}

/// One zone's standing from `zoneState`.
#[napi(object)]
pub struct ZoneMatch {
    pub id: String,
    /// The last measured share, 0..1.
    pub share: f64,
    /// Matching now, or within its hold.
    pub active: bool,
    /// The zone whose override is in force.
    pub leading: bool,
}

#[napi(object)]
pub struct HeroColourRule {
    pub intensity: f64,
    /// One of the engine's flourish names: `none`, `hold`, `vibrate`, `double`, `triple`,
    /// `slam`, `bounce`, `rise`, `whip`, `shake`, `grind`.
    pub flourish: String,
    /// 0 straight legs, 1 fully eased.
    pub smooth: f64,
    pub ignore: bool,
}

/// One colour in the Hero source's shared table, with the hits seen in it.
#[napi(object)]
pub struct HeroColour {
    pub bucket: u32,
    pub name: String,
    pub intensity: f64,
    pub flourish: String,
    pub smooth: f64,
    pub ignore: bool,
    /// Hits seen in this colour so far.
    pub seen: u32,
}

#[napi(object)]
pub struct HeroNote {
    /// Position along the lane, 0..1 of the frame.
    pub pos: f64,
    pub size: f64,
    pub rgb: Vec<u32>,
}

#[napi(object)]
pub struct HeroState {
    pub zone: Option<TrackRegion>,
    /// The option: `auto` or a direction.
    pub direction: String,
    /// What is in use once Auto has decided; null while it is looking.
    pub found: Option<String>,
    pub notes: Vec<HeroNote>,
    pub colours: Vec<HeroColour>,
    pub next_hit_ms: Option<f64>,
    pub hits: f64,
}

/// One predicted landing from the Hero watcher.
#[napi(object)]
pub struct HeroHit {
    pub id: f64,
    pub at_ms: f64,
    pub bucket: u32,
    pub size: f64,
    pub settled: bool,
}

#[napi(object)]
pub struct HeroPush {
    pub hits: Vec<HeroHit>,
    pub direction: Option<String>,
    pub notes: u32,
}

/// The Hero note watcher on its own, for harnesses.
#[napi]
pub struct HeroWatcher {
    inner: bp_core::RawHero,
}

#[napi]
impl HeroWatcher {
    #[napi(constructor)]
    pub fn new(zone: TrackRegion, direction: String) -> Result<HeroWatcher> {
        let direction = bp_core::HeroDirection::from_str(&direction)
            .ok_or_else(|| err(format!("unknown direction {direction}")))?;
        Ok(HeroWatcher {
            inner: bp_core::RawHero::new(bp_core::HeroOptions {
                zone: bp_core::HeroRect {
                    x: zone.x,
                    y: zone.y,
                    w: zone.w,
                    h: zone.h,
                },
                direction,
            }),
        })
    }

    /// One packed RGB frame with its media time.
    #[napi]
    pub fn push(&mut self, rgb: Uint8Array, width: u32, height: u32, time_ms: f64) -> HeroPush {
        self.inner
            .push(&rgb, width as usize, height as usize, time_ms);
        HeroPush {
            hits: self
                .inner
                .hits()
                .iter()
                .map(|h| HeroHit {
                    id: h.id as f64,
                    at_ms: h.at_ms,
                    bucket: h.bucket as u32,
                    size: h.size,
                    settled: h.settled,
                })
                .collect(),
            direction: self.inner.direction().map(|d| d.as_str().to_string()),
            notes: self.inner.notes().len() as u32,
        }
    }
}

/// A beat analysis on its own, for harnesses: synchronous, on the calling thread.
#[napi(object)]
pub struct BeatTrackInfo {
    pub bpm: f64,
    pub beats: Vec<f64>,
    /// Loudness 0..1 per beat.
    pub loudness: Vec<f64>,
    /// Onset strength every `onsetHopMs` from the start: the curve the beats were tracked on.
    pub onset: Vec<f64>,
    pub onset_hop_ms: f64,
    /// Loudness 0..1 every `envelopeHopMs` from the start.
    pub envelope: Vec<f64>,
    pub envelope_hop_ms: f64,
    pub duration_ms: f64,
}

#[napi(object)]
pub struct BeatStrokeOptions {
    pub style: Option<String>,
    pub volume_depth: Option<bool>,
    pub tempo_factor: Option<f64>,
    pub flourishes: Option<bool>,
    /// Fraction of the preceding stroke, 0.01..1. Defaults to one sixth.
    pub bounce_depth: Option<f64>,
    /// Multiple of the main stroke speed, 0.5..6. Defaults to 3.
    pub bounce_speed: Option<f64>,
    pub fps: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub invert: Option<bool>,
    pub alternate: Option<bool>,
    pub min_speed: Option<f64>,
    pub max_speed: Option<f64>,
}

#[napi(object)]
pub struct BeatPoint {
    pub at: f64,
    /// Position units, 0..100, as in the editor and funscript files.
    pub pos: f64,
}

/// The same stroke generator used by playback and whole-file export.
#[napi]
pub fn beat_generate(track: BeatTrackInfo, options: BeatStrokeOptions) -> Vec<BeatPoint> {
    let defaults = bp_core::BeatGenerateOptions::default();
    let script = bp_core::beat_generate(&bp_core::BeatTrack {
        beats: track.beats,
        loudness: track.loudness,
        duration_ms: track.duration_ms,
        ..Default::default()
    }, bp_core::BeatGenerateOptions {
        style: options.style.as_deref().and_then(bp_core::BeatStyle::from_str).unwrap_or(defaults.style),
        volume_depth: options.volume_depth.unwrap_or(defaults.volume_depth),
        tempo_factor: options.tempo_factor.unwrap_or(defaults.tempo_factor),
        flourishes: options.flourishes.unwrap_or(defaults.flourishes),
        bounce_depth: options.bounce_depth.unwrap_or(defaults.bounce_depth),
        bounce_speed: options.bounce_speed.unwrap_or(defaults.bounce_speed),
        fps: options.fps.unwrap_or(defaults.fps),
        min: options.min.unwrap_or(0.0) / 100.0,
        max: options.max.unwrap_or(100.0) / 100.0,
        invert: options.invert.unwrap_or(false),
        alternate: options.alternate.unwrap_or(false),
        min_speed: options.min_speed.unwrap_or(defaults.min_speed),
        max_speed: options.max_speed.unwrap_or(defaults.max_speed),
        ..defaults
    });
    script.actions.into_iter().map(|a| BeatPoint { at: a.at, pos: (a.pos * 100.0).round() }).collect()
}

pub struct AnalyseBeats { path: String }

impl Task for AnalyseBeats {
    type Output = BeatTrackInfo;
    type JsValue = BeatTrackInfo;

    fn compute(&mut self) -> Result<Self::Output> { beat_analyse(self.path.clone()) }

    fn resolve(&mut self, _env: Env, result: Self::Output) -> Result<Self::JsValue> { Ok(result) }
}

/// Audio analysis off the renderer thread, for editor beat grids and fills.
#[napi(ts_return_type = "Promise<BeatTrackInfo>")]
pub fn beat_analyse_async(path: String) -> AsyncTask<AnalyseBeats> {
    AsyncTask::new(AnalyseBeats { path })
}

/// The analysis on the music model's 50 Hz grid (`bp_beat::grid50`), from `beatGrid50`: what
/// the training dumper writes as `a2.npz`, so the app and the cache share one implementation.
#[napi(object)]
pub struct BeatGridInfo {
    pub hop_ms: f64,
    pub onset: Vec<f64>,
    pub beat_sin: Vec<f64>,
    pub beat_cos: Vec<f64>,
    pub loudness: Vec<f64>,
    pub bpm: f64,
    pub beats: Vec<f64>,
    pub duration_ms: f64,
}

/// Analyses a raw mono f32le file at 22050 Hz and returns the track on the 50 Hz grid.
#[napi]
pub fn beat_grid50(path: String) -> Result<BeatGridInfo> {
    let bytes = std::fs::read(&path).map_err(|e| err(format!("{path}: {e}")))?;
    let samples: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let t = bp_core::beat_analyse(&samples);
    let g = bp_core::beat_grid50(&t);
    let wide = |v: &[f32]| v.iter().map(|&x| x as f64).collect();
    Ok(BeatGridInfo {
        hop_ms: bp_core::BEAT_GRID_HOP_MS,
        onset: wide(&g.onset),
        beat_sin: wide(&g.beat_sin),
        beat_cos: wide(&g.beat_cos),
        loudness: wide(&g.loudness),
        bpm: t.bpm,
        beats: t.beats,
        duration_ms: t.duration_ms,
    })
}

/// Analyses a raw mono f32le file at 22050 Hz and returns every beat.
#[napi]
pub fn beat_analyse(path: String) -> Result<BeatTrackInfo> {
    let bytes = std::fs::read(&path).map_err(|e| err(format!("{path}: {e}")))?;
    let samples: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let t = bp_core::beat_analyse(&samples);
    Ok(BeatTrackInfo {
        bpm: t.bpm,
        beats: t.beats,
        loudness: t.loudness,
        onset: t.onset.iter().map(|&v| v as f64).collect(),
        onset_hop_ms: bp_core::BEAT_ONSET_HOP_MS,
        envelope: t.envelope.iter().map(|&v| v as f64).collect(),
        envelope_hop_ms: bp_core::BEAT_ENVELOPE_HOP_MS,
        duration_ms: t.duration_ms,
    })
}

/// A detector on its own, for harnesses: loads on the calling thread and runs synchronously.
#[napi]
pub struct Detector {
    inner: bp_detect::Detector,
}

#[napi(object)]
pub struct DetectRun {
    pub found: Option<FoundBox>,
    /// The kind of the chosen box, in `detectionKinds()` terms, or null when nothing was found.
    pub kind: Option<String>,
    pub all: Vec<FoundBox>,
    /// Share of the frame each kind covers, in `detectionKinds()` order, this run only.
    pub coverage: Vec<f64>,
    pub run_ms: f64,
}

#[napi]
impl Detector {
    #[napi(constructor)]
    pub fn new(model: String, path: String, cache_dir: Option<String>) -> Result<Detector> {
        let spec = bp_core::MODELS
            .iter()
            .find(|m| m.id == model)
            .ok_or_else(|| err(format!("unknown model {model}")))?;
        let inner = bp_detect::Detector::load(
            spec,
            std::path::Path::new(&path),
            cache_dir.as_deref().map(std::path::Path::new),
        )
        .map_err(err)?;
        Ok(Detector { inner })
    }

    #[napi]
    pub fn provider(&self) -> String {
        self.inner.provider().to_string()
    }

    /// Runs the model on a packed RGB frame.
    #[napi]
    pub fn detect(&mut self, rgb: Uint8Array, width: u32, height: u32) -> Result<DetectRun> {
        let t0 = std::time::Instant::now();
        let dets = self
            .inner
            .detect(&rgb, width as usize, height as usize)
            .map_err(err)?;
        let to_js = |d: &bp_detect::Detection| FoundBox {
            x: d.rect.x,
            y: d.rect.y,
            w: d.rect.w,
            h: d.rect.h,
            class: d.class.to_string(),
            confidence: d.confidence as f64,
        };
        let found = bp_detect::choose(&dets, None, None);
        Ok(DetectRun {
            kind: found.and_then(|d| {
                bp_core::DetectKind::ALL
                    .iter()
                    .find(|k| k.matches(d.class))
                    .map(|k| k.id().to_string())
            }),
            found: found.as_ref().map(to_js),
            all: dets.iter().map(to_js).collect(),
            coverage: bp_detect::coverage(&dets).to_vec(),
            run_ms: t0.elapsed().as_secs_f64() * 1000.0,
        })
    }
}

/// The WD image tagger for the library: loads on the calling thread and runs synchronously on
/// the CPU, so the host keeps it on a worker. Stills are packed BGR at `WdTagger.inputSize()` square.
#[napi]
pub struct WdTagger {
    inner: bp_detect::Tagger,
}

#[napi]
impl WdTagger {
    #[napi(constructor)]
    pub fn new(path: String) -> Result<WdTagger> {
        let inner = bp_detect::Tagger::load(std::path::Path::new(&path)).map_err(err)?;
        Ok(WdTagger { inner })
    }

    /// Side of the square input, in pixels.
    #[napi]
    pub fn input_size() -> u32 {
        bp_detect::tagger::INPUT as u32
    }

    /// One batch: per still, the probability of every tag in the model's tag order.
    #[napi]
    pub fn tag(&mut self, stills: Vec<Uint8Array>) -> Result<Vec<Float32Array>> {
        let views: Vec<&[u8]> = stills.iter().map(|s| s.as_ref()).collect();
        let probs = self.inner.tag(&views).map_err(err)?;
        Ok(probs.into_iter().map(Float32Array::new).collect())
    }
}

fn track_sample_js(s: bp_core::Sample) -> TrackSample {
    TrackSample {
        time_ms: s.time_ms,
        pos: s.pos,
        motion: s.motion.to_vec(),
    }
}

/// The tracker on its own, for harnesses that feed decoded files: no engine, no devices, no
/// lag. `push` returns the frame's sample, or null while there is nothing to compare against.
#[napi]
pub struct Tracker {
    inner: bp_core::RawTracker,
}

#[napi]
impl Tracker {
    #[napi(constructor)]
    pub fn new(options: Option<TrackOptions>) -> Tracker {
        Tracker {
            inner: bp_core::RawTracker::new(options.unwrap_or_default().to_core()),
        }
    }

    #[napi]
    pub fn push(
        &mut self,
        gray: Uint8Array,
        width: u32,
        height: u32,
        time_ms: f64,
    ) -> Result<Option<TrackSample>> {
        let need = width as usize * height as usize;
        if gray.len() < need {
            return Err(err(format!(
                "frame is {} bytes, expected {need}",
                gray.len()
            )));
        }
        Ok(self
            .inner
            .push(&gray, width as usize, height as usize, time_ms)
            .map(track_sample_js))
    }

    #[napi]
    pub fn set_region(&mut self, region: Option<TrackRegion>) {
        self.inner.set_region(region.map(|r| bp_core::Region {
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
        }))
    }

    /// The last pushed frame's flow field: 192 grid points (16 by 12 across the region,
    /// row-major) of `u, v, dx, dy, err, textured` flattened, so 1152 values. `u, v` are the
    /// point's position in frame pixels, `dx, dy` its displacement since the previous frame,
    /// `err` the Lucas-Kanade residual and `textured` 1 where the point has structure.
    /// Displacements are zero on the first frame and on the first frame after a cut.
    #[napi]
    pub fn field(&self) -> Float32Array {
        let mut out = Vec::with_capacity(self.inner.field().len() * 6);
        for p in self.inner.field() {
            out.extend_from_slice(&[p.u, p.v, p.dx, p.dy, p.err, p.textured]);
        }
        Float32Array::new(out)
    }

    /// The last pushed frame's six raw component signals in `stroke, sway, surge, roll, pitch,
    /// twist` order, before sensitivity, the jump clamp and the integrator chains.
    #[napi]
    pub fn signals(&self) -> Float32Array {
        Float32Array::new(self.inner.signals().iter().map(|&v| v as f32).collect())
    }

    #[napi]
    pub fn set_options(&mut self, options: TrackOptions) {
        self.inner.set_options(options.to_core())
    }

    /// `idle`, `locating` or `tracking`.
    #[napi]
    pub fn phase(&self) -> String {
        self.inner.phase().as_str().to_string()
    }

    #[napi]
    pub fn cuts(&self) -> f64 {
        self.inner.cuts() as f64
    }

    #[napi]
    pub fn jumps(&self) -> f64 {
        self.inner.jumps() as f64
    }

    #[napi]
    pub fn drops(&self) -> f64 {
        self.inner.drops() as f64
    }
}

fn script_info_js(s: bp_core::ScriptInfo) -> ScriptInfo {
    ScriptInfo {
        axis: s.axis.id().to_string(),
        variant: s.variant,
        selected: s.selected,
        source: s.source.to_string_lossy().into_owned(),
        container: s.container.as_str().to_string(),
        actions: s.actions as u32,
        duration_ms: s.duration_ms,
        average_speed: s.average_speed,
        max_speed: s.max_speed,
        heatmap: s.heatmap,
        gaps: s
            .gaps
            .into_iter()
            .map(|(start_ms, end_ms)| Span { start_ms, end_ms })
            .collect(),
        chapters: s
            .chapters
            .into_iter()
            .map(|c| Chapter {
                name: c.name,
                start_ms: c.start_ms,
                end_ms: c.end_ms,
            })
            .collect(),
        bookmarks: s
            .bookmarks
            .into_iter()
            .map(|b| Bookmark {
                name: b.name,
                at_ms: b.at_ms,
            })
            .collect(),
    }
}

/// The axis table: id, name and rest value, in pipeline order.
#[napi(object)]
pub struct AxisInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
    /// `tcode` or `estim`.
    pub namespace: String,
    pub default_value: f64,
}

/// The engine's package version, for keying results that depend on how it generates.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn axes() -> Vec<AxisInfo> {
    bp_script::Axis::ALL
        .iter()
        .map(|a| AxisInfo {
            id: a.id().to_string(),
            name: a.name().to_string(),
            kind: format!("{:?}", a.kind()).to_lowercase(),
            namespace: format!("{:?}", a.namespace()).to_lowercase(),
            default_value: a.default_value(),
        })
        .collect()
}

#[napi(object)]
pub struct TickOptions {
    pub hz: Option<u32>,
    pub spin_us: Option<u32>,
}

#[napi(object)]
pub struct PercentilesUs {
    pub mean: f64,
    pub p50: u32,
    pub p95: u32,
    pub p99: u32,
    pub max: u32,
}

impl From<bp_devices::PercentilesUs> for PercentilesUs {
    fn from(p: bp_devices::PercentilesUs) -> PercentilesUs {
        PercentilesUs {
            mean: p.mean as f64,
            p50: p.p50,
            p95: p.p95,
            p99: p.p99,
            max: p.max,
        }
    }
}

#[napi(object)]
pub struct TickStats {
    pub ticks: f64,
    pub skipped: f64,
    pub write_errors: f64,
    pub bytes_written: f64,
    pub bytes_received: f64,
    pub lines_received: f64,
    pub realtime: bool,
    pub late_us: PercentilesUs,
    pub write_us: PercentilesUs,
}

#[napi]
pub struct TickLoop {
    inner: bp_devices::TickLoop,
}

fn tick_opts(o: Option<TickOptions>) -> bp_devices::TickOptions {
    let d = bp_devices::TickOptions::default();
    match o {
        Some(o) => bp_devices::TickOptions {
            hz: o.hz.unwrap_or(d.hz),
            spin_us: o.spin_us.unwrap_or(d.spin_us),
        },
        None => d,
    }
}

#[napi]
impl TickLoop {
    /// Streams TCode to a serial port at a fixed rate.
    #[napi(factory)]
    pub fn open(path: String, baud: u32, options: Option<TickOptions>) -> Result<TickLoop> {
        Ok(TickLoop {
            inner: bp_devices::TickLoop::open(&path, baud, tick_opts(options)).map_err(err)?,
        })
    }

    /// Same loop against a pty pair, for machines without a device attached.
    #[napi(factory)]
    pub fn loopback(options: Option<TickOptions>) -> Result<TickLoop> {
        Ok(TickLoop {
            inner: bp_devices::TickLoop::loopback(tick_opts(options)).map_err(err)?,
        })
    }

    #[napi]
    pub fn stats(&self) -> TickStats {
        let s = self.inner.snapshot();
        TickStats {
            ticks: s.ticks as f64,
            skipped: s.skipped as f64,
            write_errors: s.write_errors as f64,
            bytes_written: s.bytes_written as f64,
            bytes_received: s.bytes_received as f64,
            lines_received: s.lines_received as f64,
            realtime: s.realtime,
            late_us: s.late.into(),
            write_us: s.write.into(),
        }
    }

    #[napi]
    pub fn stop(&mut self) {
        self.inner.stop()
    }
}

#[napi]
pub fn list_ports() -> Vec<String> {
    bp_devices::list_ports()
}

/// What a serial port answered to `D0` and `D1`.
#[napi(object)]
pub struct ProbedPort {
    pub path: String,
    pub device: Option<String>,
    pub tcode: Option<String>,
    pub error: Option<String>,
}

pub struct ProbeTask {
    paths: Vec<String>,
    wait_ms: u32,
}

#[napi]
impl Task for ProbeTask {
    type Output = Vec<bp_devices::ProbedPort>;
    type JsValue = Vec<ProbedPort>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(bp_devices::probe_ports(
            &self.paths,
            std::time::Duration::from_millis(self.wait_ms as u64),
        ))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output
            .into_iter()
            .map(|p| ProbedPort {
                path: p.path,
                device: p.device,
                tcode: p.tcode,
                error: p.error,
            })
            .collect())
    }
}

/// Opens each port, asks `D0` and `D1`, and resolves with the answers after `waitMs`.
/// Ports an output already holds will report an error; skip those.
#[napi(ts_return_type = "Promise<Array<ProbedPort>>")]
pub fn probe_serial(paths: Vec<String>, wait_ms: Option<u32>) -> AsyncTask<ProbeTask> {
    AsyncTask::new(ProbeTask {
        paths,
        wait_ms: wait_ms.unwrap_or(3000),
    })
}

/// A device seen by `bleScan`. `kind` is `tcode`, `coyote` or `other`.
#[napi(object)]
pub struct BleDevice {
    pub name: String,
    pub address: String,
    pub kind: String,
}

pub struct BleScan {
    seconds: u32,
}

impl Task for BleScan {
    type Output = Vec<bp_devices::BleDevice>;
    type JsValue = Vec<BleDevice>;

    fn compute(&mut self) -> Result<Self::Output> {
        bp_devices::ble_scan(self.seconds).map_err(|e| err(e.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output
            .into_iter()
            .map(|d| BleDevice {
                name: d.name,
                address: d.address,
                kind: d.kind.to_string(),
            })
            .collect())
    }
}

/// Scanning through the embedded Buttplug server: on while the wizard's Bluetooth panel is
/// open. Starts the server on first use; devices it connects appear in `toyDevices`.
#[napi]
pub fn toy_scan(on: bool) {
    bp_devices::toy_hub().set_wizard_scanning(on)
}

/// Devices the embedded Buttplug server has connected, and its error when it could not start.
#[napi]
pub fn toy_devices() -> ToyScanState {
    let hub = bp_devices::toy_hub();
    ToyScanState {
        devices: hub
            .devices()
            .into_iter()
            .map(|d| ToyDevice {
                index: d.index,
                name: d.name,
                address: d.address,
                features: d
                    .features
                    .into_iter()
                    .map(|f| ToyFeature {
                        index: f.index,
                        kind: f.kind.as_str().to_string(),
                        description: f.description,
                    })
                    .collect(),
                battery: d.battery,
                bound: d.bound,
            })
            .collect(),
        error: hub.error(),
    }
}

/// Scans for BLE devices for `seconds` (1 to 60), for the device wizard.
#[napi(ts_return_type = "Promise<BleDevice[]>")]
pub fn ble_scan(seconds: u32) -> AsyncTask<BleScan> {
    AsyncTask::new(BleScan {
        seconds: seconds.clamp(1, 60),
    })
}

#[napi(object)]
pub struct VideoPlayerOptions {
    pub hwdec: Option<String>,
    /// Extra mpv options applied before init, as for `Engine`.
    pub mpv_options: Option<HashMap<String, String>>,
}

/// A bare video player: mpv and a render thread, no scripts, devices or audio. For a second
/// decode of the open file beside the engine's own, so two upscalers can be seen at once.
/// Frames come out exactly as the engine's do, into three host buffers of the output size.
#[napi]
pub struct VideoPlayer {
    inner: bp_player::Player,
    buffers: Vec<Uint8Array>,
}

#[napi]
impl VideoPlayer {
    #[napi(constructor)]
    pub fn new(
        width: u32,
        height: u32,
        buffers: Vec<Uint8Array>,
        options: Option<VideoPlayerOptions>,
    ) -> Result<VideoPlayer> {
        let ext = external(width, height, &buffers)?;
        let o = options.unwrap_or(VideoPlayerOptions {
            hwdec: None,
            mpv_options: None,
        });
        // No audio track is decoded: the engine's player carries the sound and the clock.
        let mut mpv_options = vec![("audio".to_string(), "no".to_string())];
        mpv_options.extend(o.mpv_options.into_iter().flatten());
        let inner = bp_player::Player::new(
            width,
            height,
            bp_player::PlayerOptions {
                hwdec: o.hwdec.map(|h| {
                    if h == "auto" {
                        default_hwdec().to_string()
                    } else {
                        h
                    }
                }),
                mpv_options,
                ..bp_player::PlayerOptions::default()
            },
            None,
        )
        .map_err(err)?;
        inner.resize(width, height, Some(ext)).map_err(err)?;
        Ok(VideoPlayer { inner, buffers })
    }

    /// Loads `path`, starting at `startSeconds` when given. Asynchronous, as in `Engine`.
    #[napi]
    pub fn load(&self, path: String, start_seconds: Option<f64>) -> Result<()> {
        self.inner.load(&path, start_seconds).map_err(err)
    }

    #[napi]
    pub fn play(&self) -> Result<()> {
        self.inner.play().map_err(err)
    }

    #[napi]
    pub fn pause(&self) -> Result<()> {
        self.inner.pause().map_err(err)
    }

    #[napi]
    pub fn seek(&self, seconds: f64) -> Result<()> {
        self.inner.seek(seconds).map_err(err)
    }

    #[napi]
    pub fn set_rate(&self, rate: f64) -> Result<()> {
        self.inner.set_rate(rate).map_err(err)
    }

    #[napi]
    pub fn time_pos(&self) -> f64 {
        self.inner.time_pos()
    }

    #[napi]
    pub fn paused(&self) -> bool {
        self.inner.paused()
    }

    #[napi]
    pub fn video_width(&self) -> u32 {
        self.inner.video_size().0
    }

    #[napi]
    pub fn video_height(&self) -> u32 {
        self.inner.video_size().1
    }

    /// As `Engine.setEnhance`, on this decode alone.
    #[napi]
    pub fn set_enhance(&self, options: EnhanceOptions) -> Result<()> {
        let upscaler = bp_player::Upscaler::parse(&options.upscaler)
            .ok_or_else(|| err(format!("unknown upscaler {}", options.upscaler)))?;
        let dlss = match options.dlss {
            Some(d) => parse_dlss(d).map_err(err)?,
            None => bp_player::DlssOptions::default(),
        };
        self.inner
            .set_enhance(bp_player::EnhanceOptions {
                upscaler,
                target_fps: options.target_fps.filter(|f| *f > 0.0),
                dlss,
            })
            .map_err(err)
    }

    #[napi]
    pub fn set_presenting(&self, on: bool) -> Result<()> {
        self.inner.set_presenting(on).map_err(err)
    }

    #[napi]
    pub fn bgra(&self) -> bool {
        self.inner.bgra()
    }

    /// As `Engine.resize`.
    #[napi]
    pub fn resize(&mut self, width: u32, height: u32, buffers: Vec<Uint8Array>) -> Result<()> {
        let ext = external(width, height, &buffers)?;
        self.inner.resize(width, height, Some(ext)).map_err(err)?;
        self.buffers = buffers;
        Ok(())
    }

    /// Index into the buffers of the newest unread frame, or -1.
    #[napi]
    pub fn acquire(&self) -> i32 {
        self.inner.acquire().map(|i| i as i32).unwrap_or(-1)
    }

    #[napi]
    pub fn take_log(&self) -> Vec<String> {
        self.inner.take_log()
    }

    #[napi]
    pub fn close(&mut self) {
        self.inner.close()
    }
}

// --- Editor ----------------------------------------------------------------------------------

/// A range to analyse for the editor. `region` is a box for this range alone, in 0..1 of the
/// frame; absent follows the tracker's region source.
#[napi(object)]
pub struct AnalyseOptions {
    pub start_ms: f64,
    pub end_ms: f64,
    pub region: Option<TrackRegion>,
    /// Run the movement model too, when loaded.
    pub model: Option<bool>,
    /// Run the Hero note watcher too, with the zone and colour rules as set (`setHeroOptions`).
    pub hero: Option<bool>,
    /// Keep a thumbnail every this many ms, `thumbWidth` (default 96) pixels wide.
    pub thumbs_every_ms: Option<f64>,
    pub thumb_width: Option<u32>,
}

/// A range analysis's progress: `idle`, `running`, `done`, `cancelled` or `error`.
#[napi(object)]
pub struct RangeState {
    pub status: String,
    pub error: Option<String>,
    pub start_ms: f64,
    pub end_ms: f64,
    pub time_ms: f64,
}

#[napi(object)]
pub struct RangeBox {
    pub time_ms: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// One axis's keyframes: times in ms and positions 0..1.
#[napi(object)]
pub struct AxisKeyframes {
    pub axis: String,
    pub at: Float64Array,
    pub pos: Float64Array,
}

/// A packed RGB thumbnail.
#[napi(object)]
pub struct RangeThumb {
    pub time_ms: f64,
    pub width: u32,
    pub height: u32,
    pub rgb: Uint8Array,
}

/// What a range analysis found. `motion` holds six values per entry of `times`, in the
/// tracker's component order (stroke, sway, surge, roll, pitch, twist), each about 0..1.
#[napi(object)]
pub struct RangeAnalysis {
    pub start_ms: f64,
    pub end_ms: f64,
    pub fps: f64,
    pub times: Float64Array,
    pub motion: Float64Array,
    pub cuts: Vec<f64>,
    pub boxes: Vec<RangeBox>,
    /// The movement model's keyframes per axis, when asked for and loaded.
    pub model: Vec<AxisKeyframes>,
    /// The Hero watcher's keyframes per axis, when asked for and a zone is set.
    pub hero: Vec<AxisKeyframes>,
    pub thumbs: Vec<RangeThumb>,
}

pub struct AnalyseRange {
    analyser: Option<bp_core::RangeAnalyser>,
    options: bp_core::RangeOptions,
}

impl Task for AnalyseRange {
    type Output = RangeAnalysis;
    type JsValue = RangeAnalysis;

    fn compute(&mut self) -> Result<Self::Output> {
        let analyser = self
            .analyser
            .take()
            .ok_or_else(|| err("already run".into()))?;
        let o = self.options.clone();
        let r = analyser.run(o.clone()).map_err(err)?;
        let mut motion = Vec::with_capacity(r.motion.len() * 6);
        for (_, m) in &r.motion {
            motion.extend_from_slice(m);
        }
        Ok(RangeAnalysis {
            start_ms: o.start_ms,
            end_ms: o.end_ms,
            fps: r.fps,
            times: Float64Array::new(r.motion.iter().map(|(t, _)| *t).collect()),
            motion: Float64Array::new(motion),
            cuts: r.cuts,
            boxes: r
                .boxes
                .into_iter()
                .map(|(time_ms, b)| RangeBox {
                    time_ms,
                    x: b.x,
                    y: b.y,
                    w: b.w,
                    h: b.h,
                })
                .collect(),
            model: r
                .model
                .into_iter()
                .map(|(axis, actions)| AxisKeyframes {
                    axis: axis.id().to_string(),
                    at: Float64Array::new(actions.iter().map(|a| a.at).collect()),
                    pos: Float64Array::new(actions.iter().map(|a| a.pos).collect()),
                })
                .collect(),
            hero: r
                .hero
                .into_iter()
                .map(|(axis, actions)| AxisKeyframes {
                    axis: axis.id().to_string(),
                    at: Float64Array::new(actions.iter().map(|a| a.at).collect()),
                    pos: Float64Array::new(actions.iter().map(|a| a.pos).collect()),
                })
                .collect(),
            thumbs: r
                .thumbs
                .into_iter()
                .map(|t| RangeThumb {
                    time_ms: t.time_ms,
                    width: t.width,
                    height: t.height,
                    rgb: Uint8Array::new(t.rgb),
                })
                .collect(),
        })
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(out)
    }
}

/// One script beside a media file with its keyframes, for the editor: times in ms,
/// positions 0..1, and the file's other `metadata` fields as a JSON object string.
#[napi(object)]
pub struct EditorScript {
    pub axis: String,
    pub variant: Option<String>,
    pub source: String,
    pub container: String,
    pub at: Float64Array,
    pub pos: Float64Array,
    pub chapters: Vec<Chapter>,
    pub bookmarks: Vec<Bookmark>,
    pub metadata: String,
}

pub struct ReadScripts {
    path: String,
    script_folders: Vec<String>,
}

impl Task for ReadScripts {
    type Output = Vec<bp_script::LoadedScript>;
    type JsValue = Vec<EditorScript>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(bp_script::find_scripts_with_folders(std::path::Path::new(&self.path), &self.script_folders))
    }

    fn resolve(&mut self, _env: Env, scripts: Self::Output) -> Result<Self::JsValue> {
        Ok(scripts
            .into_iter()
            .map(|s| EditorScript {
                axis: s.axis.id().to_string(),
                variant: s.variant,
                source: s.source.to_string_lossy().into_owned(),
                container: s.container.as_str().to_string(),
                at: Float64Array::new(s.script.actions.iter().map(|a| a.at).collect()),
                pos: Float64Array::new(s.script.actions.iter().map(|a| a.pos).collect()),
                chapters: s
                    .script
                    .chapters
                    .iter()
                    .map(|c| Chapter {
                        name: c.name.clone(),
                        start_ms: c.start_ms,
                        end_ms: c.end_ms,
                    })
                    .collect(),
                bookmarks: s
                    .script
                    .bookmarks
                    .iter()
                    .map(|b| Bookmark {
                        name: b.name.clone(),
                        at_ms: b.at_ms,
                    })
                    .collect(),
                metadata: serde_json::Value::Object(s.script.metadata).to_string(),
            })
            .collect())
    }
}

/// Every script beside a media file with its keyframes, variants included, for the editor.
/// Reads and parses on a worker thread.
#[napi(ts_return_type = "Promise<Array<EditorScript>>")]
pub fn read_scripts(path: String, script_folders: Option<Vec<String>>) -> AsyncTask<ReadScripts> {
    AsyncTask::new(ReadScripts { path, script_folders: script_folders.unwrap_or_default() })
}

/// One script as the editor holds it, for writing: times in ms, positions 0..1, the OFS
/// chapters and bookmarks, the other metadata fields as a JSON object string, and the media
/// length for `metadata.duration`.
#[napi(object)]
pub struct ScriptInput {
    pub at: Float64Array,
    pub pos: Float64Array,
    pub chapters: Option<Vec<Chapter>>,
    pub bookmarks: Option<Vec<Bookmark>>,
    pub metadata: Option<String>,
    pub duration_seconds: Option<f64>,
}

fn script_from_arrays(at: &[f64], pos: &[f64]) -> Result<bp_script::Script> {
    if at.len() != pos.len() {
        return Err(err(format!(
            "{} times for {} positions",
            at.len(),
            pos.len()
        )));
    }
    let mut actions: Vec<bp_script::Action> = at
        .iter()
        .zip(pos)
        .filter(|(t, p)| t.is_finite() && p.is_finite())
        .map(|(t, p)| bp_script::Action {
            at: t.max(0.0),
            pos: p.clamp(0.0, 1.0),
        })
        .collect();
    actions.sort_by(|a, b| a.at.total_cmp(&b.at));
    actions.dedup_by(|later, earlier| {
        if later.at == earlier.at {
            earlier.pos = later.pos;
            true
        } else {
            false
        }
    });
    Ok(bp_script::Script {
        actions,
        ..Default::default()
    })
}

fn script_from_input(input: &ScriptInput) -> Result<bp_script::Script> {
    let mut script = script_from_arrays(&input.at, &input.pos)?;
    script.chapters = input
        .chapters
        .iter()
        .flatten()
        .map(|c| bp_script::Chapter {
            name: c.name.clone(),
            start_ms: c.start_ms,
            end_ms: c.end_ms,
        })
        .collect();
    script.bookmarks = input
        .bookmarks
        .iter()
        .flatten()
        .map(|b| bp_script::Bookmark {
            name: b.name.clone(),
            at_ms: b.at_ms,
        })
        .collect();
    if let Some(text) = input.metadata.as_deref().filter(|t| !t.trim().is_empty()) {
        match serde_json::from_str::<serde_json::Value>(text).map_err(|e| err(e.to_string()))? {
            serde_json::Value::Object(map) => script.metadata = map,
            _ => return Err(err("metadata must be a JSON object".into())),
        }
    }
    Ok(script)
}

/// The funscript JSON for one script, through the engine's one writer.
#[napi]
pub fn funscript_json(script: ScriptInput) -> Result<String> {
    Ok(script_from_input(&script)?.to_json_with(script.duration_seconds))
}

/// An EroScripts 1.1 bundle: `root` (the stroke) with the other axes under `axes`.
#[napi]
pub fn funscript_bundle(root: ScriptInput, axes: Vec<AxisKeyframes>) -> Result<String> {
    let script = script_from_input(&root)?;
    let others = axes
        .iter()
        .map(|a| Ok((axis(&a.axis)?, script_from_arrays(&a.at, &a.pos)?)))
        .collect::<Result<Vec<_>>>()?;
    let refs: Vec<(bp_script::Axis, &bp_script::Script)> =
        others.iter().map(|(a, s)| (*a, s)).collect();
    Ok(script.to_bundle_json(&refs, root.duration_seconds))
}

/// Ramer-Douglas-Peucker over keyframes (times in ms, positions 0..1): the indices kept,
/// ascending. The one RDP beside the decoder's, so the editor carries no copy.
#[napi]
pub fn simplify_indices(at: Float64Array, pos: Float64Array, eps: f64) -> Result<Uint32Array> {
    if at.len() != pos.len() {
        return Err(err(format!(
            "{} times for {} positions",
            at.len(),
            pos.len()
        )));
    }
    Ok(Uint32Array::new(
        bp_script::rdp_indices(&at, &pos, eps)
            .into_iter()
            .map(|i| i as u32)
            .collect(),
    ))
}
