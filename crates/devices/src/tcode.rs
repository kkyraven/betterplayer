//! TCode v0.3 line encoding: four-digit magnitudes with an `I` interval, dirty axes only.
//! A profile says which axes an output speaks and under what wire id: strokers take the
//! TCode namespace, restim takes the estim namespace with alpha, beta and volume written
//! as `L0`, `L1` and `V0` (research 05). Electrodes go out as `E1`..`E4` beside alpha and
//! beta on every restim output; restim's three-phase modes ignore them and four-phase
//! FOC-Stim reads only them.

use std::fmt::Write as _;

use bp_script::{Axis, Namespace};

/// Per-output clamp: the device's usable travel for this axis, in device units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AxisClamp {
    pub enabled: bool,
    pub min: f64,
    pub max: f64,
}

impl Default for AxisClamp {
    fn default() -> AxisClamp {
        AxisClamp { enabled: true, min: 0.0, max: 1.0 }
    }
}

/// What family of device sits behind an output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Profile {
    #[default]
    Stroker,
    Restim,
}

impl Profile {
    pub fn from_str(s: &str) -> Option<Profile> {
        match s {
            "stroker" => Some(Profile::Stroker),
            "restim" => Some(Profile::Restim),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Profile::Stroker => "stroker",
            Profile::Restim => "restim",
        }
    }

    /// Wire id for an axis, or None when this profile never sends it.
    pub fn wire_id(self, axis: Axis) -> Option<&'static str> {
        match (self, axis.namespace()) {
            (Profile::Stroker, Namespace::Tcode) => Some(axis.id()),
            (Profile::Restim, Namespace::Estim) => Some(match axis {
                Axis::EA => "L0",
                Axis::EB => "L1",
                Axis::EV => "V0",
                other => other.id(),
            }),
            _ => None,
        }
    }

    /// Axes sent only while a script, provider or live value drives them, so restim keeps
    /// its own volume and pulse settings until a script says otherwise.
    pub fn when_driven(self, axis: Axis) -> bool {
        self == Profile::Restim && !matches!(axis, Axis::EA | Axis::EB)
    }

    /// Sent once when a when-driven axis stops being driven. Volume goes back to full so
    /// restim's master is the only volume again.
    pub fn release_value(self, axis: Axis) -> Option<f64> {
        (self == Profile::Restim && axis == Axis::EV).then_some(1.0)
    }

    /// Axes this profile can send, in table order.
    pub fn axes(self) -> impl Iterator<Item = Axis> {
        Axis::ALL.into_iter().filter(move |a| self.wire_id(*a).is_some())
    }
}

/// Last magnitude sent per axis, so unchanged axes are left out of the line.
pub type Units = [Option<u16>; Axis::COUNT];

/// Writes the dirty axes of `values` (0..1) into `line` as `L0xxxxIyy` commands separated
/// by spaces, newline terminated. Returns how many axes were written.
pub fn encode(
    profile: Profile,
    values: &[f64; Axis::COUNT],
    driven: &[bool; Axis::COUNT],
    clamps: &[AxisClamp; Axis::COUNT],
    last: &mut Units,
    interval_ms: u32,
    line: &mut String,
) -> usize {
    line.clear();
    let mut n = 0;
    for axis in profile.axes() {
        let i = axis.index();
        let c = clamps[i];
        let Some(id) = profile.wire_id(axis) else { continue };
        if !c.enabled {
            continue;
        }
        let v = if profile.when_driven(axis) && !driven[i] {
            match (last[i], profile.release_value(axis)) {
                (Some(_), Some(release)) => {
                    last[i] = None;
                    release
                }
                _ => continue,
            }
        } else {
            c.min + values[i].clamp(0.0, 1.0) * (c.max - c.min)
        };
        let u = (v.clamp(0.0, 1.0) * 9999.0).round() as u16;
        if last[i] == Some(u) {
            continue;
        }
        if n > 0 {
            line.push(' ');
        }
        let _ = write!(line, "{id}{u:04}I{interval_ms}");
        if driven[i] || !profile.when_driven(axis) {
            last[i] = Some(u);
        }
        n += 1;
    }
    if n > 0 {
        line.push('\n');
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_axes_only_with_clamps() {
        let mut values = [0.5; Axis::COUNT];
        values[Axis::V0.index()] = 0.0;
        let driven = [true; Axis::COUNT];
        let mut clamps = [AxisClamp::default(); Axis::COUNT];
        clamps[Axis::L0.index()] = AxisClamp { enabled: true, min: 0.2, max: 0.6 };
        clamps[Axis::A2.index()].enabled = false;
        let mut last = [None; Axis::COUNT];
        let mut line = String::new();
        assert_eq!(encode(Profile::Stroker, &values, &driven, &clamps, &mut last, 10, &mut line), 10);
        assert!(line.starts_with("L04000I10 L15000I10 "), "{line}");
        assert!(line.ends_with("A15000I10\n"), "{line}");
        assert!(!line.contains("A2"));
        assert!(!line.contains("EA") && !line.contains("C0"), "estim axes never reach a stroker: {line}");
        assert_eq!(encode(Profile::Stroker, &values, &driven, &clamps, &mut last, 10, &mut line), 0);
        assert_eq!(line, "");
        values[Axis::R0.index()] = 1.0;
        assert_eq!(encode(Profile::Stroker, &values, &driven, &clamps, &mut last, 11, &mut line), 1);
        assert_eq!(line, "R09999I11\n");
    }

    #[test]
    fn restim_writes_estim_axes_and_releases_volume() {
        let mut values = [0.5; Axis::COUNT];
        values[Axis::EV.index()] = 0.3;
        values[Axis::P0.index()] = 0.7;
        let mut driven = [false; Axis::COUNT];
        let clamps = [AxisClamp::default(); Axis::COUNT];
        let mut last = [None; Axis::COUNT];
        let mut line = String::new();
        // Nothing drives volume or pulse rate: only alpha and beta go out.
        assert_eq!(encode(Profile::Restim, &values, &driven, &clamps, &mut last, 10, &mut line), 2);
        assert_eq!(line, "L05000I10 L15000I10\n");
        // A volume script starts.
        driven[Axis::EV.index()] = true;
        assert_eq!(encode(Profile::Restim, &values, &driven, &clamps, &mut last, 10, &mut line), 1);
        assert_eq!(line, "V03000I10\n");
        // It ends: volume is handed back to restim at full, once.
        driven[Axis::EV.index()] = false;
        assert_eq!(encode(Profile::Restim, &values, &driven, &clamps, &mut last, 10, &mut line), 1);
        assert_eq!(line, "V09999I10\n");
        assert_eq!(encode(Profile::Restim, &values, &driven, &clamps, &mut last, 10, &mut line), 0);
        // Pulse rate is only ever sent while driven, and never released.
        driven[Axis::P0.index()] = true;
        assert_eq!(encode(Profile::Restim, &values, &driven, &clamps, &mut last, 10, &mut line), 1);
        assert_eq!(line, "P06999I10\n");
        driven[Axis::P0.index()] = false;
        assert_eq!(encode(Profile::Restim, &values, &driven, &clamps, &mut last, 10, &mut line), 0);
    }

    #[test]
    fn restim_carries_electrodes_beside_alpha_and_beta_while_driven() {
        let mut values = [0.5; Axis::COUNT];
        values[Axis::EA.index()] = 1.0;
        for a in [Axis::E1, Axis::E2, Axis::E3, Axis::E4] {
            values[a.index()] = 0.0;
        }
        values[Axis::E1.index()] = 1.0;
        let mut driven = [false; Axis::COUNT];
        for a in [Axis::EA, Axis::EB, Axis::E1, Axis::E2, Axis::E3, Axis::E4] {
            driven[a.index()] = true;
        }
        let clamps = [AxisClamp::default(); Axis::COUNT];
        let mut last = [None; Axis::COUNT];
        let mut line = String::new();
        assert_eq!(encode(Profile::Restim, &values, &driven, &clamps, &mut last, 10, &mut line), 6);
        assert_eq!(line, "L09999I10 L15000I10 E19999I10 E20000I10 E30000I10 E40000I10\n");
        // Derivation stops: the electrodes hold on the device, nothing is released.
        for a in [Axis::E1, Axis::E2, Axis::E3, Axis::E4] {
            driven[a.index()] = false;
        }
        assert_eq!(encode(Profile::Restim, &values, &driven, &clamps, &mut last, 10, &mut line), 0);
    }
}
