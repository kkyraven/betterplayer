use bp_script::{Axis, Interpolation, Kind};

use crate::provider::Provider;

/// Per-axis settings, per video with a global default (PLAN §4).
#[derive(Clone, Debug, PartialEq)]
pub struct AxisSettings {
    pub enabled: bool,
    pub offset_ms: f64,
    /// Output range in device units, 0..1.
    pub min: f64,
    pub max: f64,
    /// Scale of the scripted motion around the axis rest value; 1 plays the script as written.
    pub amplitude: f64,
    pub invert: bool,
    pub interpolation: Interpolation,
    /// Play another axis's script on this axis.
    pub link: Option<Axis>,
    pub provider: Provider,
    /// 0 keeps the script, 1 is provider only, when both have a value.
    pub provider_blend: f64,
    /// Keyframe gaps longer than this are handed to the provider.
    pub fill_gaps_over_ms: f64,
    /// 0 disables auto-home.
    pub auto_home_delay_ms: f64,
    pub auto_home_duration_ms: f64,
    /// Full-range units per second, 0 disables.
    pub speed_limit: f64,
    pub smart_limit: Option<SmartLimit>,
}

impl AxisSettings {
    /// Defaults per axis: estim intensities and pulse parameters never auto-home, so a
    /// volume or carrier set by a script holds where the script left it. Parameters also
    /// have no speed limit: a carrier change lands at once unless the user asks for a ramp.
    pub fn default_for(axis: Axis) -> AxisSettings {
        let mut s = AxisSettings::default();
        if matches!(axis.kind(), Kind::EstimIntensity | Kind::EstimParam) {
            s.auto_home_delay_ms = 0.0;
        }
        if axis.kind() == Kind::EstimParam {
            s.speed_limit = 0.0;
        }
        s
    }
}

impl Default for AxisSettings {
    fn default() -> AxisSettings {
        AxisSettings {
            enabled: true,
            offset_ms: 0.0,
            min: 0.0,
            max: 1.0,
            amplitude: 1.0,
            invert: false,
            interpolation: Interpolation::Linear,
            link: None,
            provider: Provider::None,
            provider_blend: 0.0,
            fill_gaps_over_ms: 5000.0,
            auto_home_delay_ms: 5000.0,
            auto_home_duration_ms: 3000.0,
            speed_limit: 0.0,
            smart_limit: None,
        }
    }
}

/// Another axis's live value (0..100) maps through a piecewise-linear curve to a factor
/// (0..1) that scales this axis's motion around its home. The default reduces roll and
/// pitch as the stroke gets deep.
#[derive(Clone, Debug, PartialEq)]
pub struct SmartLimit {
    pub input: Axis,
    /// `(input, factor percent)` points, sorted by input.
    pub points: Vec<(f64, f64)>,
}

impl SmartLimit {
    pub fn default_for(input: Axis) -> SmartLimit {
        SmartLimit { input, points: vec![(25.0, 100.0), (90.0, 0.0)] }
    }

    pub fn factor(&self, input: f64) -> f64 {
        let p = &self.points;
        let Some(first) = p.first() else { return 1.0 };
        if input <= first.0 {
            return first.1 / 100.0;
        }
        for w in p.windows(2) {
            if input <= w[1].0 {
                let u = (input - w[0].0) / (w[1].0 - w[0].0).max(1e-9);
                return (w[0].1 + (w[1].1 - w[0].1) * u) / 100.0;
            }
        }
        p.last().map_or(1.0, |l| l.1 / 100.0)
    }
}
