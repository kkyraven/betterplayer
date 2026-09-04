//! Axis table from PLAN §4. Ids are TCode ids so device output, funscript suffix matching
//! and restim compatibility share one vocabulary. Estim axes are a second namespace so a
//! stroker profile and a restim profile can both be active; on the wire a restim output
//! writes alpha, beta and volume as `L0`, `L1` and `V0`.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Axis {
    L0,
    L1,
    L2,
    R0,
    R1,
    R2,
    V0,
    V1,
    A0,
    A1,
    A2,
    /// Estim alpha, position on the electrode disc.
    EA,
    /// Estim beta.
    EB,
    /// Estim volume, multiplied with restim's master.
    EV,
    /// Carrier frequency.
    C0,
    /// Pulse frequency.
    P0,
    /// Pulse width.
    P1,
    /// Pulse interval jitter.
    P2,
    /// Pulse rise time.
    P3,
    E1,
    E2,
    E3,
    E4,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Position,
    Rotation,
    Intensity,
    Aux,
    EstimPosition,
    EstimIntensity,
    EstimParam,
}

/// Which device family an axis belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Namespace {
    Tcode,
    Estim,
}

impl Axis {
    pub const ALL: [Axis; 23] = [
        Axis::L0, Axis::L1, Axis::L2, Axis::R0, Axis::R1, Axis::R2,
        Axis::V0, Axis::V1, Axis::A0, Axis::A1, Axis::A2,
        Axis::EA, Axis::EB, Axis::EV, Axis::C0, Axis::P0, Axis::P1, Axis::P2, Axis::P3,
        Axis::E1, Axis::E2, Axis::E3, Axis::E4,
    ];
    pub const COUNT: usize = Self::ALL.len();

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn from_index(i: usize) -> Option<Axis> {
        Self::ALL.get(i).copied()
    }

    /// Internal id, `L0` or `EA`.
    pub fn id(self) -> &'static str {
        match self {
            Axis::L0 => "L0", Axis::L1 => "L1", Axis::L2 => "L2",
            Axis::R0 => "R0", Axis::R1 => "R1", Axis::R2 => "R2",
            Axis::V0 => "V0", Axis::V1 => "V1",
            Axis::A0 => "A0", Axis::A1 => "A1", Axis::A2 => "A2",
            Axis::EA => "EA", Axis::EB => "EB", Axis::EV => "EV",
            Axis::C0 => "C0", Axis::P0 => "P0", Axis::P1 => "P1", Axis::P2 => "P2", Axis::P3 => "P3",
            Axis::E1 => "E1", Axis::E2 => "E2", Axis::E3 => "E3", Axis::E4 => "E4",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Axis::L0 => "Stroke", Axis::L1 => "Surge", Axis::L2 => "Sway",
            Axis::R0 => "Twist", Axis::R1 => "Roll", Axis::R2 => "Pitch",
            Axis::V0 => "Vibrate", Axis::V1 => "Pump",
            Axis::A0 => "Valve", Axis::A1 => "Suction", Axis::A2 => "Lube",
            Axis::EA => "Alpha", Axis::EB => "Beta", Axis::EV => "Volume",
            Axis::C0 => "Carrier", Axis::P0 => "Pulse rate", Axis::P1 => "Pulse width", Axis::P2 => "Pulse jitter", Axis::P3 => "Pulse rise",
            Axis::E1 => "Electrode 1", Axis::E2 => "Electrode 2", Axis::E3 => "Electrode 3", Axis::E4 => "Electrode 4",
        }
    }

    pub fn kind(self) -> Kind {
        match self {
            Axis::L0 | Axis::L1 | Axis::L2 => Kind::Position,
            Axis::R0 | Axis::R1 | Axis::R2 => Kind::Rotation,
            Axis::V0 | Axis::V1 => Kind::Intensity,
            Axis::A0 | Axis::A1 | Axis::A2 => Kind::Aux,
            Axis::EA | Axis::EB => Kind::EstimPosition,
            Axis::EV | Axis::E1 | Axis::E2 | Axis::E3 | Axis::E4 => Kind::EstimIntensity,
            Axis::C0 | Axis::P0 | Axis::P1 | Axis::P2 | Axis::P3 => Kind::EstimParam,
        }
    }

    pub fn namespace(self) -> Namespace {
        match self.kind() {
            Kind::Position | Kind::Rotation | Kind::Intensity | Kind::Aux => Namespace::Tcode,
            Kind::EstimPosition | Kind::EstimIntensity | Kind::EstimParam => Namespace::Estim,
        }
    }

    pub fn is_estim(self) -> bool {
        self.namespace() == Namespace::Estim
    }

    /// Rest value, 0..1. Position, rotation and estim position rest in the middle, pulse
    /// parameters in the middle of restim's range, intensities at zero.
    pub fn default_value(self) -> f64 {
        match self.kind() {
            Kind::Position | Kind::Rotation | Kind::EstimPosition | Kind::EstimParam => 0.5,
            Kind::Intensity | Kind::Aux | Kind::EstimIntensity => 0.0,
        }
    }

    /// Funscript file suffixes that select this axis, lowercase. `L0` also takes no suffix.
    pub fn suffixes(self) -> &'static [&'static str] {
        match self {
            Axis::L0 => &["stroke", "l0", "up", "raw"],
            Axis::L1 => &["surge", "l1", "forward"],
            Axis::L2 => &["sway", "l2", "left"],
            Axis::R0 => &["twist", "r0", "yaw"],
            Axis::R1 => &["roll", "r1"],
            Axis::R2 => &["pitch", "r2"],
            Axis::V0 => &["vib", "v0"],
            Axis::V1 => &["pump", "v1"],
            Axis::A0 => &["valve", "a0"],
            Axis::A1 => &["suck", "a1", "suckmanual"],
            Axis::A2 => &["lube", "a2"],
            Axis::EA => &["alpha"],
            Axis::EB => &["beta"],
            Axis::EV => &["volume"],
            Axis::C0 => &["frequency", "c0"],
            Axis::P0 => &["pulse_frequency", "p0"],
            Axis::P1 => &["pulse_width", "p1"],
            Axis::P2 => &["pulse_interval_random", "p2"],
            Axis::P3 => &["pulse_rise_time", "p3"],
            Axis::E1 => &["e1"],
            Axis::E2 => &["e2"],
            Axis::E3 => &["e3"],
            Axis::E4 => &["e4"],
        }
    }

    /// Axis for a funscript suffix or bundle id, case-insensitive. Empty selects `L0`.
    pub fn from_suffix(s: &str) -> Option<Axis> {
        let s = s.trim().to_ascii_lowercase();
        if s.is_empty() {
            return Some(Axis::L0);
        }
        Self::ALL.iter().copied().find(|a| a.suffixes().contains(&s.as_str()))
    }

    pub fn from_id(s: &str) -> Option<Axis> {
        Self::ALL.iter().copied().find(|a| a.id().eq_ignore_ascii_case(s))
    }
}

impl fmt::Display for Axis {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.id())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffixes_and_ids_round_trip() {
        assert_eq!(Axis::from_suffix(""), Some(Axis::L0));
        assert_eq!(Axis::from_suffix("Roll"), Some(Axis::R1));
        assert_eq!(Axis::from_suffix("suckManual"), Some(Axis::A1));
        assert_eq!(Axis::from_suffix("alpha"), Some(Axis::EA));
        assert_eq!(Axis::from_suffix("pulse_frequency"), Some(Axis::P0));
        assert_eq!(Axis::from_suffix("nope"), None);
        for a in Axis::ALL {
            assert_eq!(Axis::from_id(a.id()), Some(a));
            assert_eq!(Axis::from_index(a.index()), Some(a));
        }
        assert!(Axis::EA.is_estim() && !Axis::L0.is_estim());
    }
}
