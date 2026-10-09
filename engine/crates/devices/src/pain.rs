use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug)]
pub enum Shape {
    Saw,
    Sine,
    Square,
}

#[derive(Clone, Copy, Debug)]
pub struct Channel {
    pub shape: Shape,
    pub intensity: f64,
    pub rise_ms: f64,
    pub hold_ms: f64,
    pub fall_ms: f64,
    pub gap_ms: f64,
}

impl Channel {
    fn valid(&self) -> bool {
        let parts = [self.rise_ms, self.hold_ms, self.fall_ms, self.gap_ms];
        self.intensity.is_finite()
            && (0.0..=1.0).contains(&self.intensity)
            && parts.iter().all(|v| v.is_finite() && *v >= 0.0)
            && (20.0..=60_000.0).contains(&parts.iter().sum::<f64>())
    }

    pub fn value(&self, elapsed_ms: f64) -> f64 {
        let cycle = self.rise_ms + self.hold_ms + self.fall_ms + self.gap_ms;
        let mut at = elapsed_ms.rem_euclid(cycle);
        let curve = |t: f64| match self.shape {
            Shape::Saw => t,
            Shape::Sine => (1.0 - (std::f64::consts::PI * t).cos()) / 2.0,
            Shape::Square => 1.0,
        };
        let value = if self.rise_ms > 0.0 && at < self.rise_ms {
            curve(at / self.rise_ms)
        } else {
            at -= self.rise_ms;
            if at < self.hold_ms {
                1.0
            } else {
                at -= self.hold_ms;
                if self.fall_ms > 0.0 && at < self.fall_ms {
                    1.0 - curve(at / self.fall_ms)
                } else {
                    0.0
                }
            }
        };
        value * self.intensity
    }
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub name: String,
    pub volume_min: f64,
    pub volume_max: f64,
    pub channels: [Channel; 4],
}
impl Profile {
    fn valid(&self) -> bool {
        !self.name.trim().is_empty()
            && self.volume_min.is_finite()
            && self.volume_max.is_finite()
            && (0.0..=1.0).contains(&self.volume_min)
            && (self.volume_min..=1.0).contains(&self.volume_max)
            && self.channels.iter().all(Channel::valid)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub volume: f64,
    pub channels: [f64; 4],
    pub testing: bool,
}
#[derive(Clone, Debug)]
pub struct State {
    pub name: String,
    pub intensity: f64,
    pub remaining_ms: f64,
    pub testing: bool,
}
struct Active {
    profile: Profile,
    intensity: f64,
    start: Instant,
    end: Instant,
    testing: bool,
}
#[derive(Default)]
pub struct Runtime {
    active: Option<Active>,
}
impl Runtime {
    pub fn start(
        &mut self,
        profile: Profile,
        intensity: f64,
        seconds: f64,
        testing: bool,
        now: Instant,
    ) -> bool {
        if !profile.valid()
            || !intensity.is_finite()
            || !(0.0..=10.0).contains(&intensity)
            || !seconds.is_finite()
            || seconds <= 0.0
        {
            return false;
        }
        let Ok(duration) = Duration::try_from_secs_f64(if testing { 6.0 } else { seconds }) else {
            return false;
        };
        let Some(end) = now.checked_add(duration) else {
            return false;
        };
        self.active = Some(Active {
            profile,
            intensity,
            start: now,
            end,
            testing,
        });
        true
    }
    pub fn stop(&mut self) {
        self.active = None;
    }
    pub fn state(&self, now: Instant) -> Option<State> {
        let a = self.active.as_ref().filter(|a| now < a.end)?;
        let elapsed = now.saturating_duration_since(a.start).as_secs_f64();
        Some(State {
            name: a.profile.name.clone(),
            intensity: if a.testing {
                ((elapsed - 1.0) * 2.0).clamp(0.0, 10.0)
            } else {
                a.intensity
            },
            remaining_ms: a.end.duration_since(now).as_secs_f64() * 1000.0,
            testing: a.testing,
        })
    }
    pub fn sample(&mut self, now: Instant) -> Option<Frame> {
        if self.active.as_ref().is_some_and(|a| now >= a.end) {
            self.stop();
        }
        let a = self.active.as_ref()?;
        let elapsed = now.saturating_duration_since(a.start).as_secs_f64();
        let intensity = if a.testing {
            ((elapsed - 1.0) * 2.0).clamp(0.0, 10.0)
        } else {
            a.intensity
        };
        let onset = (elapsed / if a.testing { 1.0 } else { 0.5 }).min(1.0);
        let channels = a
            .profile
            .channels
            .map(|channel| channel.value(elapsed * 1000.0));
        let volume = (a.profile.volume_min
            + (a.profile.volume_max - a.profile.volume_min) * intensity / 10.0)
            * onset;
        Some(Frame {
            volume: if channels.iter().any(|v| *v > 0.0) {
                volume
            } else {
                0.0
            },
            channels,
            testing: a.testing,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> Profile {
        Profile {
            name: "Whip".into(),
            volume_min: 0.4,
            volume_max: 0.8,
            channels: [Channel {
                shape: Shape::Square,
                intensity: 1.0,
                rise_ms: 0.0,
                hold_ms: 200.0,
                fall_ms: 0.0,
                gap_ms: 200.0,
            }; 4],
        }
    }
    #[test]
    fn whip_has_two_hundred_ms_on_and_off_and_expires() {
        let now = Instant::now();
        let mut r = Runtime::default();
        assert!(r.start(profile(), 5.0, 2.0, false, now));
        assert_eq!(
            r.sample(now + Duration::from_millis(250)).unwrap().volume,
            0.0
        );
        let frame = r.sample(now + Duration::from_millis(500)).unwrap();
        assert!((frame.volume - 0.6).abs() < 1e-9);
        assert_eq!(frame.channels, [1.0; 4]);
        assert!(r.sample(now + Duration::from_secs(2)).is_none());
    }
    #[test]
    fn test_ramps_to_zero_in_one_second_then_to_ten_in_five() {
        let now = Instant::now();
        let mut r = Runtime::default();
        assert!(r.start(profile(), 0.0, 6.0, true, now));
        assert!((r.sample(now + Duration::from_millis(500)).unwrap().volume - 0.2).abs() < 1e-9);
        assert_eq!(
            r.state(now + Duration::from_secs(1)).unwrap().intensity,
            0.0
        );
        assert_eq!(
            r.state(now + Duration::from_millis(3500))
                .unwrap()
                .intensity,
            5.0
        );
        assert!(r.state(now + Duration::from_secs(6)).is_none());
        r.stop();
        assert!(r.sample(now).is_none());
    }
    #[test]
    fn shapes_use_independent_phase_lengths_and_amplitudes() {
        let mut channel = profile().channels[0];
        channel.shape = Shape::Saw;
        channel.rise_ms = 100.0;
        channel.hold_ms = 0.0;
        channel.gap_ms = 100.0;
        channel.intensity = 0.6;
        assert!((channel.value(50.0) - 0.3).abs() < 1e-9);
        assert_eq!(channel.value(150.0), 0.0);
        channel.shape = Shape::Sine;
        channel.fall_ms = 100.0;
        channel.gap_ms = 0.0;
        assert!((channel.value(50.0) - 0.3).abs() < 1e-9);
        assert!((channel.value(150.0) - 0.3).abs() < 1e-9);
    }
    #[test]
    fn invalid_profile_or_duration_does_not_replace_active_output() {
        let now = Instant::now();
        let mut r = Runtime::default();
        assert!(r.start(profile(), 5.0, 2.0, false, now));
        for seconds in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(!r.start(profile(), 5.0, seconds, false, now));
        }
        let mut bad = profile();
        bad.channels[0].gap_ms = -1.0;
        assert!(!r.start(bad, 5.0, 2.0, false, now));
        assert_eq!(r.state(now).unwrap().intensity, 5.0);
    }
}
