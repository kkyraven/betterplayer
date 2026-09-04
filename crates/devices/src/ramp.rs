//! Session volume ramp for a restim output: `V0` starts low and rises to a cap over a set
//! playing time, so the first minutes are gentle and the level the user calibrated in
//! restim is reached without touching the master knob. Counts playing time only, rises
//! linearly and never above the maximum, and restarts on reconnect or by request. restim's
//! master volume, inactivity ramp and hard limits still multiply on top.

use bp_script::Axis;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RampConfig {
    pub enabled: bool,
    /// Volume at the start, 0..1.
    pub start: f64,
    /// Volume the ramp ends at, 0..1.
    pub max: f64,
    pub duration_ms: f64,
}

impl Default for RampConfig {
    fn default() -> RampConfig {
        RampConfig { enabled: false, start: 0.3, max: 1.0, duration_ms: 20.0 * 60_000.0 }
    }
}

/// Where the ramp is, for the UI.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RampProgress {
    /// The multiplier in force, 0..1.
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

    /// Applies new settings. Turning the ramp on starts it from the beginning.
    pub fn set_config(&mut self, config: RampConfig) {
        if config.enabled && !self.config.enabled {
            self.elapsed_ms = 0.0;
        }
        self.config = RampConfig { start: config.start.clamp(0.0, 1.0), max: config.max.clamp(0.0, 1.0), duration_ms: config.duration_ms.max(0.0), ..config };
    }

    pub fn restart(&mut self) {
        self.elapsed_ms = 0.0;
    }

    /// Counts `dt_ms` of playing time; paused time does not move it.
    pub fn advance(&mut self, playing: bool, dt_ms: f64) {
        if self.config.enabled && playing {
            self.elapsed_ms = (self.elapsed_ms + dt_ms).min(self.config.duration_ms);
        }
    }

    /// The multiplier in force, `None` while the ramp is off.
    pub fn value(&self) -> Option<f64> {
        let c = self.config;
        if !c.enabled {
            return None;
        }
        let u = if c.duration_ms > 0.0 { (self.elapsed_ms / c.duration_ms).min(1.0) } else { 1.0 };
        let max = c.max.max(c.start);
        Some(c.start + (max - c.start) * u)
    }

    /// Scales the volume axis by the ramp: the `.volume` script's value when one drives it,
    /// full otherwise. Volume counts as driven while the ramp is on. Nothing changes when
    /// the ramp is off.
    pub fn apply(&self, values: &mut [f64; Axis::COUNT], driven: &mut [bool; Axis::COUNT]) {
        let Some(ramp) = self.value() else { return };
        let i = Axis::EV.index();
        let volume = if driven[i] { values[i] } else { 1.0 };
        values[i] = (ramp * volume).clamp(0.0, 1.0);
        driven[i] = true;
    }

    pub fn progress(&self) -> Option<RampProgress> {
        self.value().map(|value| RampProgress { value, elapsed_ms: self.elapsed_ms, duration_ms: self.config.duration_ms, start: self.config.start, max: self.config.max })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp() -> Ramp {
        let mut r = Ramp::default();
        r.set_config(RampConfig { enabled: true, start: 0.3, max: 0.9, duration_ms: 60_000.0 });
        r
    }

    #[test]
    fn holds_while_paused_and_reaches_the_maximum_at_the_duration() {
        let mut r = ramp();
        assert_eq!(r.value(), Some(0.3));
        r.advance(false, 30_000.0);
        assert_eq!(r.value(), Some(0.3), "paused time does not count");
        r.advance(true, 30_000.0);
        assert!((r.value().unwrap() - 0.6).abs() < 1e-9);
        r.advance(true, 30_000.0);
        assert!((r.value().unwrap() - 0.9).abs() < 1e-9);
        r.advance(true, 600_000.0);
        assert!((r.value().unwrap() - 0.9).abs() < 1e-9, "never above the maximum");
        assert_eq!(r.progress().unwrap().elapsed_ms, 60_000.0);
    }

    #[test]
    fn multiplies_a_volume_script_and_drives_full_without_one() {
        let mut r = ramp();
        r.advance(true, 30_000.0);
        let mut values = [0.5; Axis::COUNT];
        let mut driven = [false; Axis::COUNT];
        r.apply(&mut values, &mut driven);
        assert!((values[Axis::EV.index()] - 0.6).abs() < 1e-9, "no script: the ramp alone");
        assert!(driven[Axis::EV.index()]);
        driven[Axis::EV.index()] = true;
        values[Axis::EV.index()] = 0.5;
        r.apply(&mut values, &mut driven);
        assert!((values[Axis::EV.index()] - 0.3).abs() < 1e-9, "script 0.5 times ramp 0.6");
        assert_eq!(values[Axis::L0.index()], 0.5, "other axes untouched");
    }

    #[test]
    fn restart_and_off() {
        let mut r = ramp();
        r.advance(true, 60_000.0);
        r.restart();
        assert_eq!(r.value(), Some(0.3));
        let mut off = r.config();
        off.enabled = false;
        r.set_config(off);
        assert_eq!(r.value(), None);
        let mut values = [0.5; Axis::COUNT];
        let mut driven = [false; Axis::COUNT];
        r.apply(&mut values, &mut driven);
        assert!(!driven[Axis::EV.index()], "off: volume is left to the script and restim");
        // Turning it on again starts over.
        r.advance(true, 60_000.0);
        off.enabled = true;
        r.set_config(off);
        assert_eq!(r.value(), Some(0.3));
    }
}
