//! Picture enhancement: upscaling and frame generation.
//!
//! Upscaling has two routes. `Sharp` swaps mpv's scaler for `ewa_lanczossharp` and works on
//! every platform and GPU, because mpv renders straight into the output-sized target so its
//! scaler is the upscaler. `Rtx` puts mpv's `d3d11vpp` filter in front of the renderer with
//! NVIDIA's RTX Video Super Resolution mode, Windows on an RTX card only. Frame generation
//! (NvOFFRUC) needs the Windows D3D11 render path, which is not built yet; the capability
//! probe says so and the option stays inert until it is.
//!
//! Everything is applied through mpv properties at runtime, so a change takes effect on the
//! current video without a reload. The factor for RTX is recomputed whenever the source size
//! (mpv's `video-params`) or the output size (`Player::resize`) moves.

use crate::mpv::Mpv;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Upscaler {
    #[default]
    Off,
    /// mpv's `ewa_lanczossharp` scaler, any platform.
    Sharp,
    /// RTX Video Super Resolution through `d3d11vpp`, Windows and NVIDIA only.
    Rtx,
}

impl Upscaler {
    pub fn as_str(self) -> &'static str {
        match self {
            Upscaler::Off => "off",
            Upscaler::Sharp => "sharp",
            Upscaler::Rtx => "rtx",
        }
    }

    pub fn parse(s: &str) -> Option<Upscaler> {
        match s {
            "off" => Some(Upscaler::Off),
            "sharp" => Some(Upscaler::Sharp),
            "rtx" => Some(Upscaler::Rtx),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EnhanceOptions {
    pub upscaler: Upscaler,
    /// Frame generation target in frames per second; `None` is off.
    pub target_fps: Option<f64>,
}

/// What this machine can do, probed once when the player starts.
#[derive(Clone, Debug)]
pub struct EnhanceCapabilities {
    /// RTX Video Super Resolution is available.
    pub vsr: bool,
    /// NvOFFRUC frame generation is available end to end.
    pub frame_gen: bool,
    /// One line each on why not, for the settings page.
    pub vsr_reason: Option<String>,
    pub frame_gen_reason: Option<String>,
    /// The GPU the probe found, when it found one.
    pub gpu: Option<String>,
}

impl EnhanceCapabilities {
    /// Neither feature, for one reason.
    pub fn none(reason: &str) -> EnhanceCapabilities {
        EnhanceCapabilities { vsr: false, frame_gen: false, vsr_reason: Some(reason.into()), frame_gen_reason: Some(reason.into()), gpu: None }
    }
}

/// What is in effect right now, for the player chip and the settings page.
#[derive(Clone, Debug, Default)]
pub struct EnhanceState {
    pub upscaler: Upscaler,
    /// An upscaling stage is active: the picture leaves larger than it was decoded.
    pub upscaling: bool,
    /// Output rows over source rows while upscaling, else 0.
    pub factor: f64,
    pub source: (u32, u32),
    pub output: (u32, u32),
    pub frame_gen: bool,
    pub target_fps: f64,
    /// Why what was asked for is not in effect.
    pub reason: Option<String>,
}

/// RTX VSR takes sources up to 1440p and produces up to 4K.
const VSR_MAX_SOURCE_ROWS: u32 = 1440;
const VSR_MAX_OUTPUT_ROWS: u32 = 2160;
/// mpv's own default for `scale`.
const DEFAULT_SCALE: &str = "lanczos";
const SHARP_SCALE: &str = "ewa_lanczossharp";

/// The mpv properties one configuration needs, so a change sets only what moved.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Applied {
    scale: String,
    vf: String,
}

pub struct Enhance {
    options: EnhanceOptions,
    caps: EnhanceCapabilities,
    source: (u32, u32),
    output: (u32, u32),
    applied: Applied,
}

impl Enhance {
    pub fn new(caps: EnhanceCapabilities, output: (u32, u32)) -> Enhance {
        Enhance { options: EnhanceOptions::default(), caps, source: (0, 0), output, applied: Applied { scale: DEFAULT_SCALE.into(), vf: String::new() } }
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

    /// Pushes the properties for the current options and sizes, only those that changed.
    fn apply(&mut self, mpv: &Mpv) -> Result<(), String> {
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
        let scale = if self.options.upscaler == Upscaler::Sharp { SHARP_SCALE } else { DEFAULT_SCALE };
        let vf = match self.vsr_factor() {
            Some(f) => vsr_filter(f),
            None => String::new(),
        };
        Applied { scale: scale.into(), vf }
    }

    /// The `d3d11vpp` scale factor when RTX upscaling applies right now.
    fn vsr_factor(&self) -> Option<f64> {
        if self.options.upscaler != Upscaler::Rtx || !self.caps.vsr {
            return None;
        }
        vsr_factor(self.source.1, self.output.1)
    }

    pub fn state(&self) -> EnhanceState {
        let mut reason = None;
        let upscaler = match self.options.upscaler {
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

/// Output rows over source rows, clamped to VSR's limits: the source at most 1440 rows, the
/// filter output at most 2160 rows, and never below 1. `None` when the factor rounds to 1 or
/// the sizes are not known yet.
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
        // Output above 4K is clamped to what VSR can produce.
        assert_eq!(vsr_factor(1080, 4320), Some(2.0));
        // Source larger than the output: nothing to do.
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
        EnhanceCapabilities { vsr: true, frame_gen: false, vsr_reason: None, frame_gen_reason: Some("no render path".into()), gpu: Some("RTX".into()) }
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
        // Sharp scaling is only an upscale when the output is larger than the source.
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
}
