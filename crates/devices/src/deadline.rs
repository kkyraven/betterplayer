use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crate::realtime;



#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pace {
    Precise,
    Relaxed,
}

#[derive(Clone, Copy, Debug)]
pub struct Tick {
    pub n: u64,

    pub late_us: u32,

    pub dt_ms: f64,
    pub skipped: u32,

    pub realtime: bool,

    pub pace: Pace,

    pub fired: Instant,
}



pub fn run(hz: u32, spin_us: u32, stop: &AtomicBool, mut f: impl FnMut(Tick) -> Pace) {
    let hz = hz.max(1);
    let period = Duration::from_micros(1_000_000 / hz as u64);
    let spin = Duration::from_micros(spin_us as u64);
    let realtime = realtime::promote(period).is_ok();
    let start = Instant::now();
    let mut n: u64 = 0;
    let mut last = start;
    let mut pace = Pace::Precise;
    while !stop.load(Ordering::Relaxed) {
        n += 1;
        let deadline = start + period.mul_f64(n as f64);
        let now = Instant::now();
        match pace {
            Pace::Precise => {
                if deadline > now + spin {
                    thread::sleep(deadline - now - spin);
                }
                while Instant::now() < deadline {
                    std::hint::spin_loop();
                }
            }
            Pace::Relaxed => {
                if deadline > now {
                    thread::sleep(deadline - now);
                }
            }
        }
        let fired = Instant::now();
        let late_us = fired.saturating_duration_since(deadline).as_micros() as u32;
        let dt_ms = fired.duration_since(last).as_secs_f64() * 1000.0;
        last = fired;

        let behind = Instant::now().saturating_duration_since(start + period.mul_f64((n + 1) as f64));
        let skipped = if behind > period { (behind.as_micros() / period.as_micros()) as u32 } else { 0 };
        n += skipped as u64;

        pace = f(Tick {
            n,
            late_us,
            dt_ms,
            skipped,
            realtime,
            pace,
            fired,
        });
    }
}
