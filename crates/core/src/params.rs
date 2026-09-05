use bp_detect::Kind;


#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hold {
    pub on_cut: bool,

    pub coverage_over: Option<f64>,

    pub jump: f64,
}


#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DetectionSource {

    pub kinds: u8,

    pub bias: f64,
    pub hold: Option<Hold>,
}

impl DetectionSource {
    pub fn new(kinds: u8) -> DetectionSource {
        DetectionSource {
            kinds,
            bias: 0.0,
            hold: None,
        }
    }


    pub fn coverage(&self, per_kind: &[f64; Kind::COUNT]) -> f64 {
        per_kind
            .iter()
            .enumerate()
            .filter(|(i, _)| self.kinds & (1 << i) != 0)
            .map(|(_, v)| *v)
            .sum::<f64>()
            .min(1.0)
    }


    pub fn shape(&self, coverage: f64) -> f64 {
        bias(coverage, self.bias)
    }
}



pub fn bias(v: f64, bias: f64) -> f64 {
    v.clamp(0.0, 1.0)
        .powf(2f64.powf(-2.0 * bias.clamp(-1.0, 1.0)))
}


#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HoldState {

    pub held: Option<(f64, f64)>,
    cuts_seen: u64,
    above: bool,
}

impl HoldState {



    pub fn step(
        &mut self,
        hold: &Hold,
        coverage: f64,
        shaped: f64,
        cuts: u64,
        media_ms: f64,
    ) -> f64 {
        let above = hold.coverage_over.is_some_and(|t| coverage >= t);
        let Some((held, _)) = self.held else {
            self.held = Some((shaped, media_ms));
            self.cuts_seen = cuts;
            self.above = above;
            return shaped;
        };
        let cut = hold.on_cut && cuts != self.cuts_seen;
        let peak = above && !self.above;
        self.cuts_seen = cuts;
        self.above = above;
        if !(cut || peak) {
            return held;
        }
        let jump = hold.jump.clamp(0.0, 1.0);
        let next = held + (shaped - held).clamp(-jump, jump);
        self.held = Some((next, media_ms));
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bias_keeps_the_ends_and_skews_the_middle() {
        for b in [-1.0, -0.5, 0.0, 0.5, 1.0] {
            assert_eq!(bias(0.0, b), 0.0);
            assert_eq!(bias(1.0, b), 1.0);
        }
        assert_eq!(bias(0.3, 0.0), 0.3);
        assert!(bias(0.3, 0.6) > 0.3, "positive bias reads higher");
        assert!(bias(0.3, -0.6) < 0.3, "negative bias reads lower");
        assert!(
            (bias(0.25, 0.5) - 0.5).abs() < 1e-9,
            "bias 0.5 is the square root"
        );
    }

    #[test]
    fn coverage_sums_the_chosen_kinds() {
        let per = [0.2, 0.5, 0.0, 0.9, 0.0, 0.0];
        assert!((DetectionSource::new(0b11).coverage(&per) - 0.7).abs() < 1e-9);
        assert_eq!(
            DetectionSource::new(0b1011).coverage(&per),
            1.0,
            "capped at full"
        );
        assert_eq!(DetectionSource::new(0).coverage(&per), 0.0);
    }

    #[test]
    fn hold_moves_only_on_a_cut_and_by_the_jump_at_most() {
        let hold = Hold {
            on_cut: true,
            coverage_over: None,
            jump: 0.2,
        };
        let mut st = HoldState::default();
        assert_eq!(
            st.step(&hold, 0.1, 0.1, 0, 0.0),
            0.1,
            "the first value is taken as it is"
        );
        assert_eq!(st.step(&hold, 0.9, 0.9, 0, 100.0), 0.1, "no cut: held");
        assert!(
            (st.step(&hold, 0.9, 0.9, 1, 200.0) - 0.3).abs() < 1e-9,
            "a cut moves it by the jump"
        );
        let (value, since) = st.held.unwrap();
        assert!((value - 0.3).abs() < 1e-9 && since == 200.0);
        assert!(
            (st.step(&hold, 0.35, 0.35, 2, 300.0) - 0.35).abs() < 1e-9,
            "a small move is taken whole"
        );
        assert!(
            (st.step(&hold, 0.0, 0.0, 3, 400.0) - 0.15).abs() < 1e-9,
            "down as well"
        );
    }

    #[test]
    fn hold_triggers_when_coverage_crosses_the_threshold_upward() {
        let hold = Hold {
            on_cut: false,
            coverage_over: Some(0.5),
            jump: 1.0,
        };
        let mut st = HoldState::default();
        assert_eq!(st.step(&hold, 0.1, 0.1, 0, 0.0), 0.1);
        assert_eq!(
            st.step(&hold, 0.4, 0.4, 5, 100.0),
            0.1,
            "below: held, and cuts do not count"
        );
        assert_eq!(
            st.step(&hold, 0.6, 0.6, 5, 200.0),
            0.6,
            "crossing up triggers"
        );
        assert_eq!(
            st.step(&hold, 0.8, 0.8, 5, 300.0),
            0.6,
            "staying above does not"
        );
        assert_eq!(
            st.step(&hold, 0.2, 0.2, 5, 400.0),
            0.6,
            "dropping below does not"
        );
        assert_eq!(
            st.step(&hold, 0.7, 0.7, 5, 500.0),
            0.7,
            "crossing again does"
        );
    }

    #[test]
    fn hold_starting_above_the_threshold_waits_for_the_next_crossing() {
        let hold = Hold {
            on_cut: false,
            coverage_over: Some(0.5),
            jump: 1.0,
        };
        let mut st = HoldState::default();
        assert_eq!(st.step(&hold, 0.9, 0.9, 0, 0.0), 0.9);
        assert_eq!(
            st.step(&hold, 0.95, 0.95, 0, 100.0),
            0.9,
            "already above: no trigger"
        );
    }
}
