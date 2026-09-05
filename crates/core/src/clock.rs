use std::time::Instant;

pub struct Clock {
    reported_ms: f64,
    reported_at: Instant,
    paused: bool,
    idle: bool,
    speed: f64,
    internal_ms: f64,
    last_now: Instant,
    pub duration_ms: f64,
}

impl Clock {
    pub fn new() -> Clock {
        let now = Instant::now();
        Clock {
            reported_ms: 0.0,
            reported_at: now,
            paused: true,
            idle: true,
            speed: 1.0,
            internal_ms: 0.0,
            last_now: now,
            duration_ms: 0.0,
        }
    }

    pub fn report(&mut self, ms: f64) {
        self.reported_ms = ms;
        self.reported_at = Instant::now();
    }


    pub fn snap(&mut self) {
        self.internal_ms = self.reported_ms;
    }


    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
    }


    pub fn set_idle(&mut self, idle: bool) {
        self.reported_ms = self.target();
        self.reported_at = Instant::now();
        self.idle = idle;
    }

    pub fn set_speed(&mut self, speed: f64) {
        self.reported_ms = self.target();
        self.reported_at = Instant::now();
        self.speed = speed;
    }

    pub fn paused(&self) -> bool {
        self.paused
    }


    pub fn running(&self) -> bool {
        !self.idle
    }

    pub fn speed(&self) -> f64 {
        self.speed
    }

    fn rate(&self) -> f64 {
        if self.idle { 0.0 } else { self.speed }
    }

    fn target(&self) -> f64 {
        self.reported_ms + self.reported_at.elapsed().as_secs_f64() * 1000.0 * self.rate()
    }


    pub fn now(&mut self) -> f64 {
        let now = Instant::now();
        let dt = now.duration_since(self.last_now).as_secs_f64() * 1000.0;
        self.last_now = now;
        let target = self.target();
        let rate = self.rate();
        if rate == 0.0 {
            self.internal_ms = target;
        } else {
            let step = dt * rate;
            let err = target - self.internal_ms;
            if err.abs() > 1000.0 {
                self.internal_ms = target;
            } else {
                self.internal_ms += (step + err).clamp(0.9 * step, 1.1 * step);
            }
        }
        self.internal_ms
    }


    pub fn peek(&self) -> f64 {
        if self.rate() == 0.0 {
            self.target()
        } else {
            self.internal_ms
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;

    #[test]
    fn advances_and_slews_toward_reports() {
        let mut c = Clock::new();
        c.report(1000.0);
        c.set_idle(false);
        sleep(Duration::from_millis(20));
        let a = c.now();
        assert!(a > 1010.0 && a < 1100.0, "{a}");

        c.report(a - 30.0);
        sleep(Duration::from_millis(10));
        let b = c.now();
        assert!(b > a, "never runs backwards: {b} after {a}");

        c.report(50_000.0);
        assert!(c.now() >= 50_000.0);
    }
}
