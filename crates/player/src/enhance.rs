// Note for agents working on this: This is completely broken.
use crate::mpv::Mpv;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Upscaler {
    #[default]
    Off,

    Sharp,

    Rtx,

    Dlss,

    Apple,
}

impl Upscaler {
    pub fn as_str(self) -> &'static str {
        match self {
            Upscaler::Off => "off",
            Upscaler::Sharp => "sharp",
            Upscaler::Rtx => "rtx",
            Upscaler::Dlss => "dlss",
            Upscaler::Apple => "apple",
        }
    }

    pub fn parse(s: &str) -> Option<Upscaler> {
        match s {
            "off" => Some(Upscaler::Off),
            "sharp" => Some(Upscaler::Sharp),
            "rtx" => Some(Upscaler::Rtx),
            "dlss" => Some(Upscaler::Dlss),
            "apple" => Some(Upscaler::Apple),
            _ => None,
        }
    }
}






pub const DLSS_INPUT_HEIGHTS: [u32; 5] = [480, 720, 1080, 1440, 2160];
pub const DLSS_STRENGTH_RANGE: (f32, f32) = (0.0, 2.0);

pub const DLSS_SKIN_RANGE: (f32, f32) = (-1.0, 2.0);
pub const DLSS_BUFFER_RANGE: (f64, f64) = (2.0, 30.0);


#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NrPreset {
    #[default]
    Default,
    One,
    Two,
    Three,
}

impl NrPreset {
    pub fn parse(s: &str) -> Option<NrPreset> {
        match s {
            "default" => Some(NrPreset::Default),
            "1" => Some(NrPreset::One),
            "2" => Some(NrPreset::Two),
            "3" => Some(NrPreset::Three),
            _ => None,
        }
    }


    pub fn code(self) -> u32 {
        self as u32
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NrStyle {
    #[default]
    Default,
    Natural,
    Cinematic,
}

impl NrStyle {
    pub fn parse(s: &str) -> Option<NrStyle> {
        match s {
            "default" => Some(NrStyle::Default),
            "natural" => Some(NrStyle::Natural),
            "cinematic" => Some(NrStyle::Cinematic),
            _ => None,
        }
    }


    pub fn code(self) -> u32 {
        self as u32
    }
}


#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ModelPreset {
    #[default]
    Default,
    J,
    K,
    L,
    M,
}

impl ModelPreset {
    pub fn parse(s: &str) -> Option<ModelPreset> {
        match s {
            "default" => Some(ModelPreset::Default),
            "j" => Some(ModelPreset::J),
            "k" => Some(ModelPreset::K),
            "l" => Some(ModelPreset::L),
            "m" => Some(ModelPreset::M),
            _ => None,
        }
    }


    pub fn code(self) -> u32 {
        match self {
            ModelPreset::Default => 0,
            ModelPreset::J => 10,
            ModelPreset::K => 11,
            ModelPreset::L => 12,
            ModelPreset::M => 13,
        }
    }
}


#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum DlssRate {

    #[default]
    Auto,

    Source,
    Fixed(f64),
}

impl DlssRate {
    pub fn parse(s: &str) -> Option<DlssRate> {
        match s {
            "auto" => Some(DlssRate::Auto),
            "source" => Some(DlssRate::Source),
            other => other.parse::<f64>().ok().filter(|f| *f > 0.0 && f.is_finite()).map(DlssRate::Fixed),
        }
    }
}


#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GuideQuality {

    #[default]
    Fast,

    Quality,
}

impl GuideQuality {
    pub fn parse(s: &str) -> Option<GuideQuality> {
        match s {
            "fast" => Some(GuideQuality::Fast),
            "quality" => Some(GuideQuality::Quality),
            _ => None,
        }
    }


    pub fn flow_width(self) -> u32 {
        match self {
            GuideQuality::Fast => 320,
            GuideQuality::Quality => 640,
        }
    }
}



#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DlssOptions {
    pub nr_preset: NrPreset,
    pub nr_style: NrStyle,

    pub intensity: f32,

    pub local_tone: f32,

    pub local_structure: f32,

    pub skin_structure: f32,

    pub auto_mask: bool,
    pub model_preset: ModelPreset,

    pub factor: f64,

    pub input_height: u32,
    pub rate: DlssRate,
    pub guide: GuideQuality,

    pub buffer_seconds: f64,
}

impl Default for DlssOptions {
    fn default() -> DlssOptions {
        DlssOptions {
            nr_preset: NrPreset::Default,
            nr_style: NrStyle::Default,
            intensity: 1.0,
            local_tone: 1.0,
            local_structure: 1.0,
            skin_structure: -1.0,
            auto_mask: false,
            model_preset: ModelPreset::Default,
            factor: 1.5,
            input_height: 720,
            rate: DlssRate::Auto,
            guide: GuideQuality::Fast,
            buffer_seconds: 6.0,
        }
    }
}

impl DlssOptions {

    pub fn validate(&self) -> Result<(), String> {
        fn within(name: &str, v: f32, (lo, hi): (f32, f32)) -> Result<(), String> {
            if v.is_finite() && (lo..=hi).contains(&v) {
                Ok(())
            } else {
                Err(format!("{name} must be between {lo} and {hi}, not {v}"))
            }
        }
        within("intensity", self.intensity, DLSS_STRENGTH_RANGE)?;
        within("local tone", self.local_tone, DLSS_STRENGTH_RANGE)?;
        within("local structure", self.local_structure, DLSS_STRENGTH_RANGE)?;
        within("skin structure", self.skin_structure, DLSS_SKIN_RANGE)?;
        if dlss_mode(self.factor).is_none() {
            return Err(format!("scaling factor {} is not one of NVIDIA's DLSS modes", self.factor));
        }
        if !DLSS_INPUT_HEIGHTS.contains(&self.input_height) {
            return Err(format!("processing height {} is not one of the offered sizes", self.input_height));
        }
        let (lo, hi) = DLSS_BUFFER_RANGE;
        if !(self.buffer_seconds.is_finite() && (lo..=hi).contains(&self.buffer_seconds)) {
            return Err(format!("playback buffer must be between {lo} and {hi} seconds, not {}", self.buffer_seconds));
        }
        Ok(())
    }
}



pub fn dlss_mode(factor: f64) -> Option<(&'static str, u32)> {
    const MODES: [(f64, &str, u32); 5] = [(1.0, "DLAA", 5), (1.5, "Quality", 2), (1.724, "Balanced", 1), (2.0, "Performance", 0), (3.0, "Ultra Performance", 3)];
    MODES.iter().find(|(f, _, _)| (f - factor).abs() < 1e-6).map(|(_, name, pq)| (*name, *pq))
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EnhanceOptions {
    pub upscaler: Upscaler,

    pub target_fps: Option<f64>,

    pub dlss: DlssOptions,
}


#[derive(Clone, Debug)]
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

impl EnhanceCapabilities {

    pub fn none(reason: &str) -> EnhanceCapabilities {
        EnhanceCapabilities {
            vsr: false,
            apple_vsr: false,
            frame_gen: false,
            dlss: false,
            vsr_reason: Some(reason.into()),
            apple_vsr_reason: Some("macOS only".into()),
            frame_gen_reason: Some(reason.into()),
            dlss_reason: Some(reason.into()),
            gpu: None,
        }
    }
}


#[derive(Clone, Debug, Default)]
pub struct EnhanceState {
    pub upscaler: Upscaler,

    pub upscaling: bool,

    pub factor: f64,
    pub source: (u32, u32),
    pub output: (u32, u32),
    pub frame_gen: bool,
    pub target_fps: f64,

    pub reason: Option<String>,
}


const VSR_MAX_SOURCE_ROWS: u32 = 1440;
const VSR_MAX_OUTPUT_ROWS: u32 = 2160;

const DEFAULT_SCALE: &str = "lanczos";
const SHARP_SCALE: &str = "ewa_lanczossharp";


#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Applied {
    scale: String,
    vf: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct AppleRequest {
    pub enabled: bool,
    pub source: (u32, u32),
    pub output: (u32, u32),
}



#[derive(Default)]
pub(crate) struct AppleUpscaling {
    pub request: AppleRequest,
    pub factor: f64,
    pub reason: Option<String>,
}



#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct DlssRequest {
    pub enabled: bool,
    pub source: (u32, u32),
    pub options: DlssOptions,
}



#[derive(Default)]
pub(crate) struct DlssShared {
    pub request: DlssRequest,
    pub factor: f64,
    pub reason: Option<String>,
}

pub struct Enhance {
    options: EnhanceOptions,
    caps: EnhanceCapabilities,
    source: (u32, u32),
    output: (u32, u32),
    applied: Applied,
    apple: Arc<Mutex<AppleUpscaling>>,
    dlss: Arc<Mutex<DlssShared>>,
}

impl Enhance {
    pub fn new(caps: EnhanceCapabilities, output: (u32, u32)) -> Enhance {
        Enhance {
            options: EnhanceOptions::default(),
            caps,
            source: (0, 0),
            output,
            applied: Applied { scale: DEFAULT_SCALE.into(), vf: String::new() },
            apple: Arc::default(),
            dlss: Arc::default(),
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn apple(&self) -> Arc<Mutex<AppleUpscaling>> {
        self.apple.clone()
    }

    #[cfg(windows)]
    pub(crate) fn dlss(&self) -> Arc<Mutex<DlssShared>> {
        self.dlss.clone()
    }

    pub fn capabilities(&self) -> EnhanceCapabilities {
        self.caps.clone()
    }

    pub fn options(&self) -> EnhanceOptions {
        self.options
    }

    pub fn set_options(&mut self, mpv: &Mpv, options: EnhanceOptions) -> Result<(), String> {
        self.options = options;
        self.apply(mpv)
    }

    pub fn set_source(&mut self, mpv: &Mpv, source: (u32, u32)) -> Result<(), String> {
        self.source = source;
        self.apply(mpv)
    }

    pub fn set_output(&mut self, mpv: &Mpv, output: (u32, u32)) -> Result<(), String> {
        self.output = output;
        self.apply(mpv)
    }


    fn apply(&mut self, mpv: &Mpv) -> Result<(), String> {
        {
            let request = AppleRequest { enabled: self.options.upscaler == Upscaler::Apple && self.caps.apple_vsr, source: self.source, output: self.output };
            let mut apple = self.apple.lock().unwrap();
            if apple.request != request {
                *apple = AppleUpscaling { request, ..AppleUpscaling::default() };
            }
        }
        {
            let request = DlssRequest { enabled: self.options.upscaler == Upscaler::Dlss && self.caps.dlss, source: self.source, options: self.options.dlss };
            let mut dlss = self.dlss.lock().unwrap();
            if dlss.request != request {
                *dlss = DlssShared { request, ..DlssShared::default() };
            }
        }
        let want = self.desired();
        if want.scale != self.applied.scale {
            mpv.set_property("scale", &want.scale)?;
            self.applied.scale = want.scale.clone();
        }
        if want.vf != self.applied.vf {
            mpv.set_property("vf", &want.vf)?;
            self.applied.vf = want.vf.clone();
        }
        Ok(())
    }

    fn desired(&self) -> Applied {
        let scale = if matches!(self.options.upscaler, Upscaler::Sharp | Upscaler::Apple) { SHARP_SCALE } else { DEFAULT_SCALE };
        let vf = match self.vsr_factor() {
            Some(f) => vsr_filter(f),
            None => String::new(),
        };
        Applied { scale: scale.into(), vf }
    }


    fn vsr_factor(&self) -> Option<f64> {
        if self.options.upscaler != Upscaler::Rtx || !self.caps.vsr {
            return None;
        }
        vsr_factor(self.source.1, self.output.1)
    }

    pub fn state(&self) -> EnhanceState {
        let mut reason = None;
        let apple = self.apple.lock().unwrap();
        let dlss = self.dlss.lock().unwrap();
        let upscaler = match self.options.upscaler {
            Upscaler::Apple if !self.caps.apple_vsr => {
                reason = self.caps.apple_vsr_reason.clone();
                Upscaler::Sharp
            }
            Upscaler::Apple if apple.factor == 0.0 => {
                reason = apple.reason.clone();
                Upscaler::Sharp
            }
            Upscaler::Rtx if !self.caps.vsr => {
                reason = self.caps.vsr_reason.clone();
                Upscaler::Off
            }
            Upscaler::Rtx if self.source.1 > VSR_MAX_SOURCE_ROWS => {
                reason = Some(format!("RTX Video takes sources up to {VSR_MAX_SOURCE_ROWS}p"));
                Upscaler::Off
            }
            Upscaler::Dlss if !self.caps.dlss => {
                reason = self.caps.dlss_reason.clone();
                Upscaler::Off
            }


            Upscaler::Dlss => {
                if dlss.factor == 0.0 {
                    reason = dlss.reason.clone();
                }
                Upscaler::Dlss
            }
            u => u,
        };
        let factor = match upscaler {
            Upscaler::Apple => apple.factor,
            Upscaler::Rtx => self.vsr_factor().unwrap_or(0.0),

            Upscaler::Dlss => dlss.factor,
            Upscaler::Sharp if self.source.1 > 0 && self.output.1 > self.source.1 => self.output.1 as f64 / self.source.1 as f64,
            _ => 0.0,
        };
        let frame_gen_wanted = self.options.target_fps.is_some();
        if frame_gen_wanted && !self.caps.frame_gen && reason.is_none() {
            reason = self.caps.frame_gen_reason.clone();
        }
        EnhanceState {
            upscaler,
            upscaling: factor > 0.0,
            factor,
            source: self.source,
            output: self.output,
            frame_gen: frame_gen_wanted && self.caps.frame_gen,
            target_fps: self.options.target_fps.unwrap_or(0.0),
            reason,
        }
    }
}




pub fn vsr_factor(source_rows: u32, output_rows: u32) -> Option<f64> {
    if source_rows == 0 || output_rows == 0 || source_rows > VSR_MAX_SOURCE_ROWS {
        return None;
    }
    let f = (output_rows as f64 / source_rows as f64).min(VSR_MAX_OUTPUT_ROWS as f64 / source_rows as f64);
    let f = (f * 100.0).round() / 100.0;
    (f > 1.0).then_some(f)
}

pub fn vsr_filter(factor: f64) -> String {
    format!("d3d11vpp=scale={factor:.2}:scaling-mode=nvidia")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factor_fits_the_output_and_vsr_limits() {
        assert_eq!(vsr_factor(1080, 1440), Some(1.33));
        assert_eq!(vsr_factor(720, 2160), Some(3.0));

        assert_eq!(vsr_factor(1080, 4320), Some(2.0));

        assert_eq!(vsr_factor(1440, 1080), None);
        assert_eq!(vsr_factor(1080, 1084), None, "a factor that rounds to 1 clears the filter");
        assert_eq!(vsr_factor(2160, 4320), None, "above VSR's input limit");
        assert_eq!(vsr_factor(0, 1440), None);
    }

    #[test]
    fn filter_string_matches_mpv_syntax() {
        assert_eq!(vsr_filter(1.5), "d3d11vpp=scale=1.50:scaling-mode=nvidia");
    }

    fn unsupported() -> EnhanceCapabilities {
        EnhanceCapabilities::none("Windows only")
    }

    fn rtx() -> EnhanceCapabilities {
        EnhanceCapabilities { vsr: true, vsr_reason: None, dlss_reason: Some("runtime not installed".into()), gpu: Some("RTX".into()), ..EnhanceCapabilities::none("no render path") }
    }

    #[test]
    fn dlss_without_the_runtime_falls_back_with_its_reason() {
        let mut e = Enhance::new(rtx(), (2560, 1440));
        e.source = (1920, 1080);
        e.options.upscaler = Upscaler::Dlss;

        assert_eq!(e.desired(), Applied { scale: DEFAULT_SCALE.into(), vf: String::new() });
        let s = e.state();
        assert_eq!(s.upscaler, Upscaler::Off);
        assert!(!s.upscaling);
        assert_eq!(s.reason.as_deref(), Some("runtime not installed"));

        e.caps.dlss = true;
        e.caps.dlss_reason = None;
        assert_eq!(e.state().upscaler, Upscaler::Dlss);
        assert!(!e.state().upscaling, "no factor reported yet");
        e.dlss.lock().unwrap().factor = 1.5;
        assert_eq!(e.state().factor, 1.5);
        assert!(e.state().upscaling);
        {
            let mut dlss = e.dlss.lock().unwrap();
            dlss.factor = 0.0;
            dlss.reason = Some("Unsupported video size".into());
        }
        assert_eq!(e.state().upscaler, Upscaler::Dlss);
        assert!(!e.state().upscaling);
        assert_eq!(e.state().reason.as_deref(), Some("Unsupported video size"));
    }

    #[test]
    fn dlss_options_parse_and_validate_like_the_runtime() {
        assert_eq!(NrPreset::parse("2"), Some(NrPreset::Two));
        assert_eq!(NrPreset::Three.code(), 3);
        assert_eq!(NrStyle::parse("cinematic").map(NrStyle::code), Some(2));
        assert_eq!(ModelPreset::parse("k").map(ModelPreset::code), Some(11));
        assert_eq!(ModelPreset::Default.code(), 0);
        assert_eq!(DlssRate::parse("60"), Some(DlssRate::Fixed(60.0)));
        assert_eq!(DlssRate::parse("source"), Some(DlssRate::Source));
        assert_eq!(DlssRate::parse("-1"), None);
        assert_eq!(GuideQuality::parse("quality").map(GuideQuality::flow_width), Some(640));
        assert_eq!(dlss_mode(1.724), Some(("Balanced", 1)));
        assert_eq!(dlss_mode(1.7), None);

        let mut o = DlssOptions::default();
        assert_eq!(o.validate(), Ok(()));
        o.skin_structure = -1.0;
        assert_eq!(o.validate(), Ok(()), "-1 is skin structure's native default");
        o.intensity = -0.1;
        assert!(o.validate().unwrap_err().starts_with("intensity"));
        o = DlssOptions { factor: 1.7, ..DlssOptions::default() };
        assert!(o.validate().unwrap_err().contains("scaling factor"));
        o = DlssOptions { input_height: 900, ..DlssOptions::default() };
        assert!(o.validate().unwrap_err().contains("processing height"));
        o = DlssOptions { buffer_seconds: 31.0, ..DlssOptions::default() };
        assert!(o.validate().unwrap_err().contains("playback buffer"));
    }

    #[test]
    fn desired_properties_follow_options_and_sizes() {
        let mut e = Enhance::new(rtx(), (2560, 1440));
        e.source = (1920, 1080);
        assert_eq!(e.desired(), Applied { scale: DEFAULT_SCALE.into(), vf: String::new() });
        e.options.upscaler = Upscaler::Rtx;
        assert_eq!(e.desired().vf, "d3d11vpp=scale=1.33:scaling-mode=nvidia");
        assert!(e.state().upscaling);
        e.options.upscaler = Upscaler::Sharp;
        assert_eq!(e.desired(), Applied { scale: SHARP_SCALE.into(), vf: String::new() });
        assert!(e.state().upscaling);

        e.output = (960, 540);
        assert!(!e.state().upscaling);
    }

    #[test]
    fn unsupported_rtx_falls_back_with_the_reason() {
        let mut e = Enhance::new(unsupported(), (2560, 1440));
        e.source = (1920, 1080);
        e.options = EnhanceOptions { upscaler: Upscaler::Rtx, target_fps: Some(60.0), dlss: DlssOptions::default() };
        assert_eq!(e.desired().vf, "");
        let s = e.state();
        assert_eq!(s.upscaler, Upscaler::Off);
        assert!(!s.frame_gen);
        assert_eq!(s.reason.as_deref(), Some("Windows only"));
    }

    #[test]
    fn apple_reports_processed_frames_and_preserves_sharp_fallback() {
        let mut e = Enhance::new(EnhanceCapabilities { apple_vsr: true, apple_vsr_reason: None, ..unsupported() }, (1280, 720));
        e.source = (640, 360);
        e.options.upscaler = Upscaler::Apple;
        assert_eq!(e.desired().scale, SHARP_SCALE);
        assert!(e.desired().vf.is_empty());
        assert_eq!(e.state().upscaler, Upscaler::Sharp, "loading is not reported as AI processing");
        e.apple.lock().unwrap().factor = 2.0;
        assert_eq!(e.state().upscaler, Upscaler::Apple);
        assert_eq!(e.state().factor, 2.0);
        {
            let mut apple = e.apple.lock().unwrap();
            apple.factor = 0.0;
            apple.reason = Some("Unsupported video size".into());
        }
        assert_eq!(e.state().upscaler, Upscaler::Sharp);
        assert_eq!(e.state().reason.as_deref(), Some("Unsupported video size"));
        e.caps = unsupported();
        assert_eq!(e.state().upscaler, Upscaler::Sharp);
        assert_eq!(e.state().reason.as_deref(), Some("macOS only"));
        assert_eq!(Upscaler::parse("apple"), Some(Upscaler::Apple));
    }
}
// Note for agents working on this: This is completely broken.
