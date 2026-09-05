use std::collections::HashMap;

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
    pub render_errors: f64,
    pub gl_errors: f64,
    pub last_gl_error: u32,
    pub render_ms: Percentiles,

    pub readback_ms: Percentiles,
    pub interval_ms: Percentiles,

    pub present_ms: Percentiles,
}

#[napi(object)]
pub struct EngineOptions {

    pub hz: Option<u32>,
    pub spin_us: Option<u32>,
    pub hwdec: Option<String>,
    pub verbose: Option<bool>,


    pub bgra: Option<bool>,

    pub async_readback: Option<bool>,

    pub mpv_options: Option<HashMap<String, String>>,
}


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


#[napi(object)]
pub struct DlssOptions {

    pub nr_preset: String,

    pub nr_style: String,

    pub intensity: f64,

    pub local_tone: f64,

    pub local_structure: f64,

    pub skin_structure: f64,
    pub auto_mask: bool,

    pub model_preset: String,

    pub factor: f64,

    pub input_height: u32,

    pub rate: String,

    pub guide: String,

    pub buffer_seconds: f64,
}

#[napi(object)]
pub struct EnhanceOptions {


    pub upscaler: String,

    pub target_fps: Option<f64>,

    pub dlss: Option<DlssOptions>,
}


#[napi(object)]
pub struct EnhanceState {
    pub upscaler: String,

    pub upscaling: bool,

    pub factor: f64,
    pub source_width: u32,
    pub source_height: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub frame_gen: bool,
    pub target_fps: f64,

    pub reason: Option<String>,
}


fn parse_dlss(d: DlssOptions) -> std::result::Result<bp_player::DlssOptions, String> {
    let options = bp_player::DlssOptions {
        nr_preset: bp_player::NrPreset::parse(&d.nr_preset).ok_or_else(|| format!("unknown NR preset {}", d.nr_preset))?,
        nr_style: bp_player::NrStyle::parse(&d.nr_style).ok_or_else(|| format!("unknown NR style {}", d.nr_style))?,
        intensity: d.intensity as f32,
        local_tone: d.local_tone as f32,
        local_structure: d.local_structure as f32,
        skin_structure: d.skin_structure as f32,
        auto_mask: d.auto_mask,
        model_preset: bp_player::ModelPreset::parse(&d.model_preset).ok_or_else(|| format!("unknown model preset {}", d.model_preset))?,
        factor: d.factor,
        input_height: d.input_height,
        rate: bp_player::DlssRate::parse(&d.rate).ok_or_else(|| format!("unknown rate {}", d.rate))?,
        guide: bp_player::GuideQuality::parse(&d.guide).ok_or_else(|| format!("unknown guide quality {}", d.guide))?,
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

#[napi(object)]
pub struct ScriptInfo {
    pub axis: String,

    pub variant: Option<String>,

    pub selected: bool,
    pub source: String,
    pub container: String,
    pub actions: u32,
    pub duration_ms: f64,

    pub average_speed: f64,
    pub max_speed: f64,

    pub heatmap: Vec<f64>,
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

    pub min: f64,
    pub max: f64,

    pub amplitude: f64,
    pub invert: bool,

    pub interpolation: String,

    pub link: Option<String>,

    pub provider: String,

    pub provider_speed: f64,

    pub provider_period_ms: f64,
    pub provider_blend: f64,
    pub fill_gaps_over_ms: f64,

    pub auto_home_delay_ms: f64,
    pub auto_home_duration_ms: f64,

    pub speed_limit: f64,

    pub smart_limit_input: Option<String>,
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
        }
    }
}


#[napi(object)]
pub struct DeviceInput {
    pub output: u32,
    pub name: String,
}

#[napi(object)]
pub struct OutputState {
    pub id: u32,
    pub kind: String,
    pub address: String,

    pub profile: String,

    pub status: String,
    pub error: Option<String>,
    pub device: Option<String>,
    pub tcode: Option<String>,

    pub ramp: Option<RampProgress>,

    pub howl: Option<HowlStatus>,

    pub features: Vec<OutputFeature>,

    pub battery: Option<u8>,
}



#[napi(object)]
pub struct HowlStatus {
    pub playing: bool,
    pub position: f64,
    pub title: String,
    pub power_a: u8,
    pub power_b: u8,
    pub mute: bool,
}




#[napi(object)]
pub struct OutputFeature {
    pub index: u32,
    pub kind: String,
    pub description: String,
    pub axis: Option<String>,
    pub speed: bool,
}



#[napi(object)]
pub struct ToyDevice {
    pub index: u32,
    pub name: String,
    pub address: String,
    pub features: Vec<ToyFeature>,
    pub battery: Option<u8>,
    pub bound: bool,
}


#[napi(object)]
pub struct ToyFeature {
    pub index: u32,
    pub kind: String,
    pub description: String,
}


#[napi(object)]
pub struct ToyScanState {
    pub devices: Vec<ToyDevice>,
    pub error: Option<String>,
}


#[napi(object)]
pub struct IntifaceState {
    pub port: u16,

    pub clients: u32,

    pub client: Option<String>,
}



#[napi(object)]
pub struct OutputStats {
    pub lines_sent: f64,
    pub write_us: PercentilesUs,

    pub received: Vec<String>,
}


#[napi(object)]
pub struct EngineTickStats {
    pub hz: u32,
    pub realtime: bool,

    pub late_us: PercentilesUs,

    pub work_us: PercentilesUs,
}



#[napi(object)]
pub struct RampConfig {
    pub enabled: bool,
    pub start: f64,
    pub max: f64,
    pub duration_ms: f64,
}





#[napi(object)]
pub struct EstimOptions {
    pub contrast: f64,
    pub params: bool,
}

#[napi(object)]
pub struct RampProgress {

    pub value: f64,
    pub elapsed_ms: f64,
    pub duration_ms: f64,
    pub start: f64,
    pub max: f64,
}









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


#[napi(object)]
pub struct ParamHold {
    pub value: f64,
    pub since_ms: f64,
}


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
                let mut mask = 0u8;
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




pub const AXIS_FLAG_SCRIPT: u8 = bp_core::FLAG_SCRIPT;
pub const AXIS_FLAG_DERIVED: u8 = bp_core::FLAG_DERIVED;
pub const AXIS_FLAG_LIVE: u8 = bp_core::FLAG_LIVE;
pub const AXIS_FLAG_TRACKED: u8 = bp_core::FLAG_TRACKED;


#[napi(object)]
pub struct EngineState {
    pub time_ms: f64,
    pub duration_ms: f64,
    pub paused: bool,
    pub rate: f64,
    pub loaded: bool,

    pub following: bool,

    pub video_width: u32,
    pub video_height: u32,

    pub axis_values: Float64Array,

    pub axis_flags: Uint8Array,

    pub flags_version: f64,
    pub outputs: Vec<OutputState>,

    pub error: Option<String>,
}


#[napi(object)]
pub struct FollowState {

    pub kind: String,
    pub address: String,

    pub status: String,
    pub error: Option<String>,

    pub path: Option<String>,
    pub playing: bool,
    pub time_ms: f64,
    pub duration_ms: f64,
    pub rate: f64,
}





#[napi(object)]
pub struct TrackOptions {
    pub sensitivity: Option<f64>,
    pub pace: Option<f64>,

    pub cut_threshold: Option<f64>,

    pub ease_ms: Option<f64>,

    pub flourishes: Option<bool>,

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


fn track_axes(rows: Vec<TrackAxis>, mut table: bp_core::TrackAxes) -> Result<bp_core::TrackAxes> {
    for r in rows {
        let source = match r.source.as_str() {
            "video" => bp_core::TrackSource::Video,
            "beat" => bp_core::TrackSource::Beat,
            "hero" => bp_core::TrackSource::Hero,
            "ai-motion" => bp_core::TrackSource::AiMotion,
            "ai-music" => bp_core::TrackSource::AiMusic,
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


#[napi(object)]
pub struct TrackRegion {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}



#[napi(object)]
pub struct TrackSample {
    pub time_ms: f64,
    pub pos: f64,
    pub motion: Vec<f64>,
}


#[napi(object)]
pub struct GenerateState {


    pub status: String,
    pub error: Option<String>,

    pub time_ms: f64,
    pub duration_ms: f64,

    pub fps: f64,
    pub frames: f64,

    pub hits: f64,

    pub provider: Option<String>,
    pub model_ms: f64,
}


#[napi(object)]
pub struct GeneratedScript {
    pub axis: String,

    pub suffix: String,
    pub actions: f64,
    pub duration_ms: f64,
    pub json: String,
}


#[napi(object)]
pub struct GeneratedInput {
    pub axis: String,
    pub json: String,
}


#[napi(object)]
pub struct FoundBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub class: String,
    pub confidence: f64,
}


#[napi(object)]
pub struct DetectBoxes {
    pub runs: f64,
    pub boxes: Vec<FoundBox>,
}

#[napi(object)]
pub struct DetectorState {

    pub status: String,
    pub error: Option<String>,
    pub model: Option<String>,

    pub provider: Option<String>,

    pub found: Option<FoundBox>,
    pub run_ms: f64,
    pub runs: f64,

    pub coverage: Vec<f64>,
}



#[napi(object)]
pub struct ModelFile {
    pub file: String,
    pub url: String,
    pub sha256: String,
}




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


#[napi(object)]
pub struct ModelState {

    pub status: String,
    pub error: Option<String>,
    pub model: Option<String>,
    pub version: Option<String>,

    pub provider: Option<String>,
    pub fallback: Option<String>,

    pub warmup_ms: f64,
    pub run_ms: f64,

    pub too_slow: bool,
}



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

    pub state: String,

    pub region: Option<TrackRegion>,
    pub auto: bool,
    pub detector: DetectorState,

    pub model: ModelState,

    pub position: f64,

    pub motion: Vec<f64>,


    pub ahead_ms: Option<f64>,

    pub fps: f64,
    pub frames: f64,

    pub cuts: f64,
    pub jumps: f64,
    pub drops: f64,
}












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



#[napi]
pub struct Engine {
    inner: bp_core::Engine,

    buffers: Vec<Uint8Array>,
}


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
        Ok(Engine { inner, buffers })
    }









    #[napi(ts_return_type = "Promise<MediaInfo>")]
    pub fn load(
        &self,
        path: String,
        start_seconds: Option<f64>,
        variants: Option<HashMap<String, String>>,
        scripts_path: Option<String>,
        headers: Option<String>,
    ) -> Result<AsyncTask<LoadScripts>> {
        let variants = variant_pairs(variants)?;
        Ok(AsyncTask::new(LoadScripts {
            loader: self.inner.loader(),
            path,
            start_seconds: Some(start_seconds),
            variants,
            scripts_path,
            headers,
        }))
    }




    #[napi(ts_return_type = "Promise<void>")]
    pub fn prepare(&self, path: String, scripts_path: Option<String>) -> AsyncTask<Prepare> {
        AsyncTask::new(Prepare {
            loader: self.inner.loader(),
            path,
            scripts_path,
        })
    }



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


    #[napi]
    pub fn unload(&self) -> Result<()> {
        self.inner.unload().map_err(err)
    }



    #[napi(ts_return_type = "Promise<MediaInfo>")]
    pub fn load_scripts(
        &self,
        path: String,
        variants: Option<HashMap<String, String>>,
    ) -> Result<AsyncTask<LoadScripts>> {
        Ok(AsyncTask::new(LoadScripts {
            loader: self.inner.loader(),
            path,
            start_seconds: None,
            variants: variant_pairs(variants)?,
            scripts_path: None,
            headers: None,
        }))
    }




    #[napi]
    pub fn follow(&self, kind: String, host: String, port: Option<u16>) -> Result<()> {
        let kind = bp_core::FollowKind::from_str(&kind)
            .ok_or_else(|| err(format!("unknown follow kind {kind}")))?;
        self.inner.follow(kind, &host, port).map_err(err)
    }


    #[napi]
    pub fn unfollow(&self) {
        self.inner.unfollow()
    }



    #[napi]
    pub fn wants_frames(&self) -> bool {
        self.inner.wants_frames()
    }




    #[napi]
    pub fn set_detect_boxes(&self, wanted: bool) {
        self.inner.set_boxes_wanted(wanted)
    }




    #[napi]
    pub fn detect_boxes(&self, kinds: Vec<String>) -> DetectBoxes {
        let kinds: Vec<bp_core::DetectKind> = kinds.iter().filter_map(|k| bp_core::DetectKind::from_id(k)).collect();
        let (runs, boxes) = self.inner.detect_boxes(&kinds);
        DetectBoxes {
            runs: runs as f64,
            boxes: boxes.into_iter().map(found_js).collect(),
        }
    }


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


    #[napi]
    pub fn set_live(&self, axis_id: String, value: Option<f64>) -> Result<()> {
        self.inner.set_live(axis(&axis_id)?, value);
        Ok(())
    }






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


    #[napi]
    pub fn set_track_axes(&self, axes: Vec<TrackAxis>) -> Result<()> {
        let table = track_axes(axes, self.inner.track_axes())?;
        self.inner.set_track_axes(table);
        Ok(())
    }


    #[napi]
    pub fn track_stop(&self) {
        self.inner.track_stop()
    }





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


    #[napi]
    pub fn set_track_region(&self, region: Option<TrackRegion>) {
        self.inner.set_track_region(region.map(region_core))
    }



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



    #[napi]
    pub fn beat_load(&self, path: String) {
        self.inner.beat_load(std::path::PathBuf::from(path))
    }

    #[napi]
    pub fn beat_clear(&self) {
        self.inner.beat_clear()
    }

    #[napi]
    pub fn set_beat_options(&self, options: BeatOptions) -> Result<()> {
        let style = bp_core::BeatStyle::from_str(&options.style)
            .ok_or_else(|| err(format!("unknown beat style {}", options.style)))?;
        self.inner.set_beat_options(bp_core::BeatOptions {
            style,
            volume_depth: options.volume_depth,
            tempo_factor: options.tempo_factor.clamp(0.25, 4.0),
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
        BeatState {
            status: status.to_string(),
            error,
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



    #[napi]
    pub fn track_trace(&self) -> Vec<TrackSample> {
        self.inner
            .track_trace()
            .into_iter()
            .map(track_sample_js)
            .collect()
    }


    #[napi]
    pub fn track_samples(&self, since_ms: f64) -> Vec<TrackSample> {
        self.inner
            .track_samples(since_ms)
            .into_iter()
            .map(track_sample_js)
            .collect()
    }





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


    #[napi]
    pub fn generate_cancel(&self) {
        self.inner.generate_cancel()
    }





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


    #[napi]
    pub fn connect(&mut self, transport: Transport) -> Result<u32> {
        let p = transport
            .profile
            .as_deref()
            .map(profile)
            .transpose()?
            .unwrap_or_default();
        Ok(self.inner.connect(transport.to_core()?, p))
    }


    #[napi]
    pub fn set_output_profile(&self, id: u32, profile_name: String) -> Result<bool> {
        Ok(self.inner.set_output_profile(id, profile(&profile_name)?))
    }


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
    pub fn disconnect(&self, id: u32) -> bool {
        self.inner.disconnect(id)
    }



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


    #[napi]
    pub fn set_coyote_strength(&self, id: u32, a: u8, b: u8) -> bool {
        self.inner.set_coyote_strength(id, a, b)
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




    #[napi]
    pub fn start_intiface(&self, port: u16) -> Result<()> {
        self.inner.start_intiface(port).map_err(err)
    }

    #[napi]
    pub fn stop_intiface(&self) {
        self.inner.stop_intiface()
    }


    #[napi]
    pub fn intiface_state(&self) -> Option<IntifaceState> {
        self.inner.intiface_status().map(|s| IntifaceState {
            port: s.port,
            clients: s.clients as u32,
            client: s.client,
        })
    }



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
    pub fn set_estim(&self, options: EstimOptions) {
        self.inner.set_estim(bp_core::EstimOptions {
            contrast: options.contrast,
            params: options.params,
        })
    }

    #[napi]
    pub fn estim(&self) -> EstimOptions {
        let o = self.inner.estim();
        EstimOptions {
            contrast: o.contrast,
            params: o.params,
        }
    }



    #[napi]
    pub fn param_hold(&self, axis_id: String) -> Result<Option<ParamHold>> {
        Ok(self
            .inner
            .param_hold(axis(&axis_id)?)
            .map(|(value, since_ms)| ParamHold { value, since_ms }))
    }



    #[napi]
    pub fn wants_cuts(&self) -> bool {
        self.inner.wants_cuts()
    }


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
                        features: o
                            .features
                            .into_iter()
                            .map(|f| OutputFeature {
                                index: f.index,
                                kind: f.kind.to_string(),
                                description: f.description,
                                axis: f.axis.map(|a| a.id().to_string()),
                                speed: f.speed,
                            })
                            .collect(),
                        battery: o.battery,
                    }
                })
                .collect(),
        }
    }


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



    #[napi]
    pub fn set_enhance(&self, options: EnhanceOptions) -> Result<()> {
        let upscaler = bp_player::Upscaler::parse(&options.upscaler)
            .ok_or_else(|| err(format!("unknown upscaler {}", options.upscaler)))?;
        let target_fps = options.target_fps.filter(|f| *f > 0.0);
        let dlss = match options.dlss {
            Some(d) => parse_dlss(d).map_err(err)?,
            None => bp_player::DlssOptions::default(),
        };
        self.inner.player.set_enhance(bp_player::EnhanceOptions { upscaler, target_fps, dlss }).map_err(err)
    }


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


    #[napi]
    pub fn video_width(&self) -> u32 {
        self.inner.video_size().0
    }

    #[napi]
    pub fn video_height(&self) -> u32 {
        self.inner.video_size().1
    }


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
            render_errors: s.render_errors as f64,
            gl_errors: s.gl_errors as f64,
            last_gl_error: s.last_gl_error,
            render_ms: s.render.into(),
            readback_ms: s.readback.into(),
            interval_ms: s.interval.into(),
            present_ms: s.present.into(),
        }
    }


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





pub struct LoadScripts {
    loader: bp_core::ScriptLoader,
    path: String,
    start_seconds: Option<Option<f64>>,
    variants: Vec<(bp_script::Axis, String)>,
    scripts_path: Option<String>,
    headers: Option<String>,
}

impl Task for LoadScripts {
    type Output = Vec<bp_core::PoolEntry>;
    type JsValue = MediaInfo;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.loader.pool_for(&self.path, self.scripts_path.as_deref()))
    }

    fn resolve(&mut self, _env: Env, pool: Self::Output) -> Result<Self::JsValue> {
        let m = match self.start_seconds {
            Some(start) => self
                .loader
                .load(&self.path, start, pool, &self.variants, self.headers.as_deref())
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
}

impl Task for Prepare {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        self.loader.prepare(&self.path, self.scripts_path.as_deref());
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

pub struct ScanScripts {
    path: String,
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
        Ok(bp_core::scan_scripts(std::path::Path::new(&self.path)))
    }

    fn resolve(&mut self, _env: Env, infos: Self::Output) -> Result<Self::JsValue> {
        Ok(infos.into_iter().map(script_info_js).collect())
    }
}



#[napi(ts_return_type = "Promise<Array<ScriptInfo>>")]
pub fn scan_scripts(path: String) -> AsyncTask<ScanScripts> {
    AsyncTask::new(ScanScripts { path })
}


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


#[napi(object)]
pub struct BeatOptions {

    pub style: String,
    pub volume_depth: bool,

    pub tempo_factor: f64,
}




#[napi(object)]
pub struct MusicState {
    pub status: String,
    pub percent: f64,
    pub error: Option<String>,
}

#[napi(object)]
pub struct BeatState {

    pub status: String,
    pub error: Option<String>,

    pub bpm: f64,
    pub beats: f64,
    pub style: String,
    pub volume_depth: bool,
    pub tempo_factor: f64,
    pub model: MusicState,
}



#[napi(object)]
pub struct HeroColourRule {
    pub intensity: f64,


    pub flourish: String,

    pub smooth: f64,
    pub ignore: bool,
}


#[napi(object)]
pub struct HeroColour {
    pub bucket: u32,
    pub name: String,
    pub intensity: f64,
    pub flourish: String,
    pub smooth: f64,
    pub ignore: bool,

    pub seen: u32,
}

#[napi(object)]
pub struct HeroNote {

    pub pos: f64,
    pub size: f64,
    pub rgb: Vec<u32>,
}

#[napi(object)]
pub struct HeroState {
    pub zone: Option<TrackRegion>,

    pub direction: String,

    pub found: Option<String>,
    pub notes: Vec<HeroNote>,
    pub colours: Vec<HeroColour>,
    pub next_hit_ms: Option<f64>,
    pub hits: f64,
}


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


#[napi(object)]
pub struct BeatTrackInfo {
    pub bpm: f64,
    pub beats: Vec<f64>,

    pub loudness: Vec<f64>,

    pub onset: Vec<f64>,
    pub onset_hop_ms: f64,

    pub envelope: Vec<f64>,
    pub envelope_hop_ms: f64,
    pub duration_ms: f64,
}



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


#[napi]
pub struct Detector {
    inner: bp_detect::Detector,
}

#[napi(object)]
pub struct DetectRun {
    pub found: Option<FoundBox>,

    pub kind: Option<String>,
    pub all: Vec<FoundBox>,

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


    #[napi]
    pub fn input_size() -> u32 {
        bp_detect::tagger::INPUT as u32
    }


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






    #[napi]
    pub fn field(&self) -> Float32Array {
        let mut out = Vec::with_capacity(self.inner.field().len() * 6);
        for p in self.inner.field() {
            out.extend_from_slice(&[p.u, p.v, p.dx, p.dy, p.err, p.textured]);
        }
        Float32Array::new(out)
    }



    #[napi]
    pub fn signals(&self) -> Float32Array {
        Float32Array::new(self.inner.signals().iter().map(|&v| v as f32).collect())
    }

    #[napi]
    pub fn set_options(&mut self, options: TrackOptions) {
        self.inner.set_options(options.to_core())
    }


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


#[napi(object)]
pub struct AxisInfo {
    pub id: String,
    pub name: String,
    pub kind: String,

    pub namespace: String,
    pub default_value: f64,
}


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

    #[napi(factory)]
    pub fn open(path: String, baud: u32, options: Option<TickOptions>) -> Result<TickLoop> {
        Ok(TickLoop {
            inner: bp_devices::TickLoop::open(&path, baud, tick_opts(options)).map_err(err)?,
        })
    }


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



#[napi(ts_return_type = "Promise<Array<ProbedPort>>")]
pub fn probe_serial(paths: Vec<String>, wait_ms: Option<u32>) -> AsyncTask<ProbeTask> {
    AsyncTask::new(ProbeTask {
        paths,
        wait_ms: wait_ms.unwrap_or(3000),
    })
}


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



#[napi]
pub fn toy_scan(on: bool) {
    bp_devices::toy_hub().set_wizard_scanning(on)
}


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


#[napi(ts_return_type = "Promise<BleDevice[]>")]
pub fn ble_scan(seconds: u32) -> AsyncTask<BleScan> {
    AsyncTask::new(BleScan {
        seconds: seconds.clamp(1, 60),
    })
}

#[napi(object)]
pub struct VideoPlayerOptions {
    pub hwdec: Option<String>,

    pub mpv_options: Option<HashMap<String, String>>,
}




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

        let mut mpv_options = vec![("audio".to_string(), "no".to_string())];
        mpv_options.extend(o.mpv_options.into_iter().flatten());
        let inner = bp_player::Player::new(
            width,
            height,
            bp_player::PlayerOptions {
                hwdec: o.hwdec.map(|h| if h == "auto" { default_hwdec().to_string() } else { h }),
                mpv_options,
                ..bp_player::PlayerOptions::default()
            },
            None,
        )
        .map_err(err)?;
        inner.resize(width, height, Some(ext)).map_err(err)?;
        Ok(VideoPlayer { inner, buffers })
    }


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


    #[napi]
    pub fn resize(&mut self, width: u32, height: u32, buffers: Vec<Uint8Array>) -> Result<()> {
        let ext = external(width, height, &buffers)?;
        self.inner.resize(width, height, Some(ext)).map_err(err)?;
        self.buffers = buffers;
        Ok(())
    }


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
