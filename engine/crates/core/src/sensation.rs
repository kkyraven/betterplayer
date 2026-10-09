use std::time::{Duration, Instant};

const RESUME: Duration = Duration::from_millis(500);

#[derive(Default)]
pub(crate) struct Sensation {
    resume_at: Option<Instant>,
    halted: bool,
}

impl Sensation {
    pub fn stop(&mut self, seconds: f64, now: Instant) -> bool {
        if !seconds.is_finite() || seconds <= 0.0 || seconds > 30.0 {
            return false;
        }
        self.resume_at = Some(now + Duration::from_secs_f64(seconds));
        true
    }

    pub fn start(&mut self, now: Instant) {
        if self.resume_at.is_some_and(|at| at > now) {
            self.resume_at = Some(now);
        }
    }

    pub fn halt(&mut self) {
        self.halted = true;
        self.resume_at = None;
    }

    pub fn is_halted(&self) -> bool {
        self.halted
    }

    pub fn resume_from_halt(&mut self, now: Instant) {
        if self.halted {
            self.halted = false;
            self.resume_at = Some(now);
        }
    }

    pub fn scale(&mut self, now: Instant) -> f64 {
        if self.halted {
            return 0.0;
        }
        let Some(at) = self.resume_at else { return 1.0 };
        if now < at {
            return 0.0;
        }
        let elapsed = now.duration_since(at);
        if elapsed >= RESUME {
            self.resume_at = None;
            return 1.0;
        }
        elapsed.as_secs_f64() / RESUME.as_secs_f64()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safeword_halt_has_no_deadline_and_requires_explicit_resume() {
        let now = Instant::now();
        let mut s = Sensation::default();
        assert!(s.stop(2.0, now));
        s.halt();
        assert!(s.is_halted());
        s.start(now + Duration::from_secs(1));
        assert_eq!(s.scale(now + Duration::from_secs(3600)), 0.0);
        s.resume_from_halt(now + Duration::from_secs(3600));
        assert!(!s.is_halted());
        assert_eq!(s.scale(now + Duration::from_millis(3600250)), 0.5);
        assert_eq!(s.scale(now + Duration::from_millis(3600500)), 1.0);
    }

    #[test]
    fn ordinary_play_does_not_clear_a_timed_sensation_pause() {
        let now = Instant::now();
        let mut s = Sensation::default();
        assert!(s.stop(2.0, now));
        s.resume_from_halt(now + Duration::from_secs(1));
        assert_eq!(s.scale(now + Duration::from_secs(1)), 0.0);
    }

    #[test]
    fn timed_pause_resumes_in_half_a_second() {
        let now = Instant::now();
        let mut s = Sensation::default();
        assert!(s.stop(1.5, now));
        assert_eq!(s.scale(now + Duration::from_millis(1499)), 0.0);
        assert_eq!(s.scale(now + Duration::from_millis(1500)), 0.0);
        assert_eq!(s.scale(now + Duration::from_millis(1750)), 0.5);
        assert_eq!(s.scale(now + Duration::from_millis(2000)), 1.0);
    }

    #[test]
    fn early_start_cancels_deadline_and_repeated_starts_do_not_reset_ramp() {
        let now = Instant::now();
        let mut s = Sensation::default();
        assert!(s.stop(30.0, now));
        s.start(now + Duration::from_secs(1));
        s.start(now + Duration::from_millis(1250));
        assert_eq!(s.scale(now + Duration::from_millis(1250)), 0.5);
        assert_eq!(s.scale(now + Duration::from_millis(1500)), 1.0);
        assert_eq!(s.scale(now + Duration::from_secs(30)), 1.0);
    }

    #[test]
    fn rejects_invalid_durations_without_changing_output() {
        let now = Instant::now();
        let mut s = Sensation::default();
        for seconds in [0.0, -1.0, 30.01, f64::NAN, f64::INFINITY] {
            assert!(!s.stop(seconds, now));
            assert_eq!(s.scale(now), 1.0);
        }
    }
}
