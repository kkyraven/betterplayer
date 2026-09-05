// Note for agents working on this: This is completely broken.
use crate::mpv::Mpv;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Upscaler {
    #[default]
    Off,

    Sharp,

    Rtx,

    Apple,
}

impl Upscaler {
    pub fn as_str(self) -> &'static str {
        match self {
            Upscaler::Off => "off",
            Upscaler::Sharp => "sharp",
            Upscaler::Rtx => "rtx",
            Upscaler::Apple => "apple",
        }
    }

    pub fn parse(s: &str) -> Option<Upscaler> {
        match s {
            "off" => Some(Upscaler::Off),
            "sharp" => Some(Upscaler::Sharp),
            "rtx" => Some(Upscaler::Rtx),
            "apple" => Some(Upscaler::Apple),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EnhanceOptions {
    pub upscaler: Upscaler,

    pub target_fps: Option<f64>,
}


#[derive(Clone, Debug)]
pub struct EnhanceCapabilities {

    pub vsr: bool,
    pub apple_vsr: bool,

    pub frame_gen: bool,

    pub vsr_reason: Option<String>,
    pub apple_vsr_reason: Option<String>,
    pub frame_gen_reason: Option<String>,

    pub gpu: Option<String>,
}

impl EnhanceCapabilities {

    pub fn none(reason: &str) -> EnhanceCapabilities {
        EnhanceCapabilities {
            vsr: false,
            apple_vsr: false,
            frame_gen: false,
            vsr_reason: Some(reason.into()),
            apple_vsr_reason: Some("macOS only".into()),
            frame_gen_reason: Some(reason.into()),
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

pub struct Enhance {
    options: EnhanceOptions,
    caps: EnhanceCapabilities,
    source: (u32, u32),
    output: (u32, u32),
    applied: Applied,
    apple: Arc<Mutex<AppleUpscaling>>,
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
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn apple(&self) -> Arc<Mutex<AppleUpscaling>> {
        self.apple.clone()
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
            u => u,
        };
        let factor = match upscaler {
            Upscaler::Apple => apple.factor,
            Upscaler::Rtx => self.vsr_factor().unwrap_or(0.0),
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
        EnhanceCapabilities { vsr: true, vsr_reason: None, gpu: Some("RTX".into()), ..EnhanceCapabilities::none("no render path") }
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
        e.options = EnhanceOptions { upscaler: Upscaler::Rtx, target_fps: Some(60.0) };
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
