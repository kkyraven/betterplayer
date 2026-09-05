use bp_script::{Axis, Interpolation, Kind};

use crate::provider::Provider;


#[derive(Clone, Debug, PartialEq)]
pub struct AxisSettings {
    pub enabled: bool,
    pub offset_ms: f64,

    pub min: f64,
    pub max: f64,

    pub amplitude: f64,
    pub invert: bool,
    pub interpolation: Interpolation,

    pub link: Option<Axis>,
    pub provider: Provider,

    pub provider_blend: f64,

    pub fill_gaps_over_ms: f64,

    pub auto_home_delay_ms: f64,
    pub auto_home_duration_ms: f64,

    pub speed_limit: f64,
    pub smart_limit: Option<SmartLimit>,


    pub extend_range: bool,
}

impl AxisSettings {



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
            extend_range: false,
        }
    }
}




#[derive(Clone, Debug, PartialEq)]
pub struct SmartLimit {
    pub input: Axis,

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
