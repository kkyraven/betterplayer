//! The deadline loop every fixed-rate output shares: sleep until just before the deadline,
//! spin the rest, skip missed ticks after a stall rather than bursting to catch up. A tick
//! with nothing to write asks for the relaxed pace, which sleeps through the deadline and
//! costs no CPU.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crate::realtime;

/// How the next deadline is met. `Precise` sleeps until `spin_us` before it and spins the
/// rest; `Relaxed` sleeps through it, a millisecond or so late on most schedulers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pace {
    Precise,
    Relaxed,
}

#[derive(Clone, Copy, Debug)]
pub struct Tick {
    pub n: u64,
    /// Microseconds past the deadline.
    pub late_us: u32,
    /// Measured time since the previous tick fired.
    pub dt_ms: f64,
    pub skipped: u32,
    /// Whether the thread got a realtime scheduling class.
    pub realtime: bool,
    /// The pace this tick was woken at; `late_us` only means something for `Precise`.
    pub pace: Pace,
    /// When the tick fired, so the callback can time its own work.
    pub fired: Instant,
}

/// Runs `f` at `hz` until `stop` is set; each call returns the pace for the next deadline.
/// Promotes the calling thread to realtime where the platform allows.
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
        let deadline = start + period * n as u32;
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

        let behind = Instant::now().saturating_duration_since(start + period * (n as u32 + 1));
        let skipped = if behind > period { (behind.as_micros() / period.as_micros()) as u32 } else { 0 };
        n += skipped as u64;

        pace = f(Tick { n, late_us, dt_ms, skipped, realtime, pace, fired });
    }
}
