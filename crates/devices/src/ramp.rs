use bp_script::{Axis, Kind};

pub const DEFAULT_VOLUME_FLOOR: f64 = 0.75;
const FADE_MS: f64 = 2000.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VolumeBoost {
    pub enabled: bool,
    pub axis: Axis,

    pub amount: f64,
}

impl Default for VolumeBoost {
    fn default() -> Self {
        Self { enabled: false, axis: Axis::L1, amount: 0.2 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VolumeSettings {
    pub min: f64,
    pub max: f64,
    pub boost: VolumeBoost,
}

impl Default for VolumeSettings {
    fn default() -> Self {
        Self { min: DEFAULT_VOLUME_FLOOR, max: 1.0, boost: VolumeBoost::default() }
    }
}

impl VolumeSettings {
    pub fn validated(self) -> Self {
        let unit = |v: f64, fallback: f64| if v.is_finite() { v.clamp(0.0, 1.0) } else { fallback };
        let min = unit(self.min, DEFAULT_VOLUME_FLOOR);
        let axis_valid = matches!(self.boost.axis.kind(), Kind::Position | Kind::Rotation);
        Self {
            min,
            max: unit(self.max, 1.0).max(min),
            boost: VolumeBoost {
                enabled: self.boost.enabled && axis_valid,
                axis: if axis_valid { self.boost.axis } else { Axis::L1 },
                amount: unit(self.boost.amount, 0.0),
            },
        }
    }



    pub fn target(self, volume: f64, output_min: f64, output_max: f64, source: Option<f64>) -> f64 {
        if !volume.is_finite() || volume <= 0.0 { return 0.0; }
        let scaled = self.min + volume.clamp(0.0, 1.0) * (self.max - self.min);
        let base = (output_min + scaled * (output_max - output_min)).clamp(0.0, 1.0);
        if base <= 0.0 || !base.is_finite() { return 0.0; }
        let boost = if self.boost.enabled {
            source.filter(|v| v.is_finite()).unwrap_or(0.0).clamp(0.0, 1.0) * self.boost.amount
        } else { 0.0 };
        (base + boost).clamp(0.0, 1.0)
    }
}


#[derive(Debug, Default)]
pub(crate) struct Volume {
    active: bool,
    elapsed_ms: f64,
}

impl Volume {
    pub fn apply(&mut self, target: f64, active: bool, dt_ms: f64) -> f64 {
        if !active || target <= 0.0 || !target.is_finite() {
            *self = Self::default();
            return 0.0;
        }
        if self.active {
            self.elapsed_ms = (self.elapsed_ms + dt_ms).min(FADE_MS);
        }
        self.active = true;
        target * self.elapsed_ms / FADE_MS
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RampConfig {
    pub enabled: bool,

    pub start: f64,

    pub max: f64,
    pub duration_ms: f64,
}

impl Default for RampConfig {
    fn default() -> RampConfig {
        RampConfig {
            enabled: false,
            start: DEFAULT_VOLUME_FLOOR,
            max: 1.0,
            duration_ms: 20.0 * 60_000.0,
        }
    }
}


#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RampProgress {

    pub value: f64,
    pub elapsed_ms: f64,
    pub duration_ms: f64,
    pub start: f64,
    pub max: f64,
}

#[derive(Debug, Default)]
pub struct Ramp {
    config: RampConfig,
    elapsed_ms: f64,
}

impl Ramp {
    pub fn config(&self) -> RampConfig {
        self.config
    }


    pub fn set_config(&mut self, config: RampConfig) {
        if config.enabled && !self.config.enabled {
            self.elapsed_ms = 0.0;
        }
        let start = config.start.clamp(0.0, 1.0);
        self.config = RampConfig {
            start,
            max: config.max.clamp(start, 1.0),
            duration_ms: config.duration_ms.max(0.0),
            ..config
        };
    }

    pub fn restart(&mut self) {
        self.elapsed_ms = 0.0;
    }


    pub fn advance(&mut self, playing: bool, dt_ms: f64) {
        if self.config.enabled && playing {
            self.elapsed_ms = (self.elapsed_ms + dt_ms).min(self.config.duration_ms);
        }
    }


    pub fn value(&self) -> Option<f64> {
        let c = self.config;
        if !c.enabled {
            return None;
        }
        let u = if c.duration_ms > 0.0 {
            (self.elapsed_ms / c.duration_ms).min(1.0)
        } else {
            1.0
        };
        let max = c.max.max(c.start);
        Some(c.start + (max - c.start) * u)
    }




    pub fn apply(&self, values: &mut [f64; Axis::COUNT], driven: &mut [bool; Axis::COUNT]) {
        let Some(ramp) = self.value() else { return };
        let i = Axis::EV.index();
        let volume = if driven[i] { values[i] } else { 1.0 };
        values[i] = (ramp * volume).clamp(0.0, 1.0);
        driven[i] = true;
    }

    pub fn progress(&self) -> Option<RampProgress> {
        self.value().map(|value| RampProgress {
            value,
            elapsed_ms: self.elapsed_ms,
            duration_ms: self.config.duration_ms,
            start: self.config.start,
            max: self.config.max,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_scales_within_limits_and_boost_can_exceed_them() {
        let settings = VolumeSettings {
            min: 0.75, max: 0.85,
            boost: VolumeBoost { enabled: true, axis: Axis::L1, amount: 0.2 },
        };
        for (volume, source, expected) in [
            (0.2, None, 0.77), (0.5, None, 0.8), (1.0, None, 0.85),
            (0.5, Some(0.0), 0.8), (0.5, Some(0.5), 0.9), (0.5, Some(1.0), 1.0),
            (1.0, Some(1.0), 1.0), (0.0, Some(1.0), 0.0),
        ] {
            assert!((settings.target(volume, 0.0, 1.0, source) - expected).abs() < 1e-12);
        }
        assert!((settings.target(1.0, 0.0, 0.6, Some(1.0)) - 0.71).abs() < 1e-12,
            "boost is added after the output cap");
        assert_eq!(settings.target(1.0, 0.0, 0.0, Some(1.0)), 0.0);
        assert_eq!(settings.target(f64::NAN, 0.0, 1.0, Some(1.0)), 0.0);
        let off = VolumeSettings { boost: VolumeBoost { enabled: false, ..settings.boost }, ..settings };
        assert_eq!(off.target(1.0, 0.0, 1.0, Some(1.0)), 0.85);
    }

    #[test]
    fn volume_settings_keep_ordered_limits_and_reject_invalid_boost_inputs() {
        let settings = VolumeSettings {
            min: 0.9, max: 0.4,
            boost: VolumeBoost { enabled: true, axis: Axis::EV, amount: f64::NAN },
        }.validated();
        assert_eq!((settings.min, settings.max), (0.9, 0.9));
        assert!(!settings.boost.enabled);
        assert_eq!(settings.boost.amount, 0.0);
        let settings = VolumeSettings { min: f64::NAN, max: f64::INFINITY, ..settings }.validated();
        assert_eq!((settings.min, settings.max), (0.75, 1.0));
    }

    fn ramp() -> Ramp {
        let mut r = Ramp::default();
        r.set_config(RampConfig {
            enabled: true,
            start: 0.75,
            max: 0.9,
            duration_ms: 60_000.0,
        });
        r
    }

    #[test]
    fn holds_while_paused_and_reaches_the_maximum_at_the_duration() {
        let mut r = ramp();
        assert_eq!(r.value(), Some(0.75));
        r.advance(false, 30_000.0);
        assert_eq!(r.value(), Some(0.75), "paused time does not count");
        r.advance(true, 30_000.0);
        assert!((r.value().unwrap() - 0.825).abs() < 1e-9);
        r.advance(true, 30_000.0);
        assert!((r.value().unwrap() - 0.9).abs() < 1e-9);
        r.advance(true, 600_000.0);
        assert!(
            (r.value().unwrap() - 0.9).abs() < 1e-9,
            "never above the maximum"
        );
        assert_eq!(r.progress().unwrap().elapsed_ms, 60_000.0);
    }

    #[test]
    fn multiplies_a_volume_script_and_drives_full_without_one() {
        let mut r = ramp();
        r.advance(true, 30_000.0);
        let mut values = [0.5; Axis::COUNT];
        let mut driven = [false; Axis::COUNT];
        r.apply(&mut values, &mut driven);
        assert!(
            (values[Axis::EV.index()] - 0.825).abs() < 1e-9,
            "no script: the ramp alone"
        );
        assert!(driven[Axis::EV.index()]);
        driven[Axis::EV.index()] = true;
        values[Axis::EV.index()] = 0.5;
        r.apply(&mut values, &mut driven);
        assert!(
            (values[Axis::EV.index()] - 0.4125).abs() < 1e-9,
            "script 0.5 times ramp 0.825; the output applies the volume floor"
        );
        assert_eq!(values[Axis::L0.index()], 0.5, "other axes untouched");
    }

    #[test]
    fn ramp_end_cannot_be_below_its_start() {
        let mut r = Ramp::default();
        r.set_config(RampConfig { enabled: true, start: 0.8, max: 0.5, duration_ms: 1000.0 });
        assert_eq!(r.value(), Some(0.8));
        r.advance(true, 1000.0);
        assert_eq!(r.value(), Some(0.8));
        assert_eq!(r.config().max, 0.8);
    }

    #[test]
    fn restart_and_off() {
        let mut r = ramp();
        r.advance(true, 60_000.0);
        r.restart();
        assert_eq!(r.value(), Some(0.75));
        let mut off = r.config();
        off.enabled = false;
        r.set_config(off);
        assert_eq!(r.value(), None);
        let mut values = [0.5; Axis::COUNT];
        let mut driven = [false; Axis::COUNT];
        r.apply(&mut values, &mut driven);
        assert!(
            !driven[Axis::EV.index()],
            "off: volume is left to the script and restim"
        );

        r.advance(true, 60_000.0);
        off.enabled = true;
        r.set_config(off);
        assert_eq!(r.value(), Some(0.75));
    }
}
