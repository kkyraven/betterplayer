use std::collections::VecDeque;
use std::fmt::Write as _;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serialport::SerialPort;

pub mod ble;
pub mod buttplug;
pub mod coyote;
pub mod deadline;
pub mod handy;
pub mod howl;
pub mod intiface;
pub mod output;
pub mod probe;
pub mod ramp;
mod realtime;
pub mod tcode;
pub mod toys;
pub mod transport;

pub use ble::{BleDevice, scan as ble_scan};
pub use deadline::Pace;
pub use handy::HandyHosting;
pub use howl::HowlStatus;
pub use intiface::{IntifaceServer, IntifaceStatus, SERVER_NAME as INTIFACE_SERVER_NAME};
pub use output::{Media, Output, OutputSnapshot, OutputStats, Status, TickContext};
pub use probe::{ProbedPort, probe_ports};
pub use ramp::{Ramp, RampConfig, RampProgress};
pub use tcode::{AxisClamp, Profile};
pub use toys::{FeatureKind, ToyFeature, ToyInfo, hub as toy_hub};
pub use transport::Transport;

const WINDOW: usize = 10_000;

#[derive(Clone, Copy, Debug)]
pub struct TickOptions {
    pub hz: u32,

    pub spin_us: u32,
}

impl Default for TickOptions {
    fn default() -> TickOptions {
        TickOptions {
            hz: 100,
            spin_us: 500,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PercentilesUs {
    pub mean: f32,
    pub p50: u32,
    pub p95: u32,
    pub p99: u32,
    pub max: u32,
}

#[derive(Clone, Debug, Default)]
pub struct TickSnapshot {
    pub ticks: u64,
    pub skipped: u64,
    pub write_errors: u64,
    pub bytes_written: u64,
    pub bytes_received: u64,
    pub lines_received: u64,

    pub realtime: bool,

    pub late: PercentilesUs,

    pub write: PercentilesUs,
}

#[derive(Default)]
struct Samples {
    realtime: bool,
    ticks: u64,
    skipped: u64,
    write_errors: u64,
    bytes_written: u64,
    late_us: VecDeque<u32>,
    write_us: VecDeque<u32>,
}

pub struct TickLoop {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Samples>>,
    bytes_received: Arc<AtomicU64>,
    lines_received: Arc<AtomicU64>,
    tick: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
}

pub fn list_ports() -> Vec<String> {
    serialport::available_ports()
        .map(|ps| ps.into_iter().map(|p| p.port_name).collect())
        .unwrap_or_default()
}

impl TickLoop {
    pub fn open(path: &str, baud: u32, opts: TickOptions) -> Result<TickLoop, String> {
        let port = serialport::new(path, baud)
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(|e| format!("open {path}: {e}"))?;

        let reader = port.try_clone().map_err(|e| format!("clone {path}: {e}"))?;
        Ok(Self::start(port, Some(reader), opts))
    }


    #[cfg(unix)]
    pub fn loopback(opts: TickOptions) -> Result<TickLoop, String> {
        let (master, mut slave) =
            serialport::TTYPort::pair().map_err(|e| format!("pty pair: {e}"))?;
        slave
            .set_timeout(Duration::from_millis(100))
            .map_err(|e| e.to_string())?;
        Ok(Self::start(Box::new(master), Some(Box::new(slave)), opts))
    }

    #[cfg(not(unix))]
    pub fn loopback(_opts: TickOptions) -> Result<TickLoop, String> {
        Err("loopback needs a pty pair; use a real port on Windows".into())
    }

    fn start(
        port: Box<dyn SerialPort>,
        reader: Option<Box<dyn SerialPort>>,
        opts: TickOptions,
    ) -> TickLoop {
        let stop = Arc::new(AtomicBool::new(false));
        let samples = Arc::new(Mutex::new(Samples::default()));
        let bytes_received = Arc::new(AtomicU64::new(0));
        let lines_received = Arc::new(AtomicU64::new(0));

        let reader = reader.map(|mut r| {
            let stop = stop.clone();
            let bytes = bytes_received.clone();
            let lines = lines_received.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 4096];

                loop {
                    match r.read(&mut buf) {
                        Ok(n) => {
                            bytes.fetch_add(n as u64, Ordering::Relaxed);
                            let nl = buf[..n].iter().filter(|b| **b == b'\n').count();
                            lines.fetch_add(nl as u64, Ordering::Relaxed);
                        }
                        Err(e) if e.kind() == ErrorKind::TimedOut => {
                            if stop.load(Ordering::Relaxed) {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
        });

        let tick = {
            let stop = stop.clone();
            let samples = samples.clone();
            thread::Builder::new()
                .name("bp-tick".into())
                .spawn(move || tick_loop(port, opts, stop, samples))
                .expect("spawn tick thread")
        };

        TickLoop {
            stop,
            samples,
            bytes_received,
            lines_received,
            tick: Some(tick),
            reader,
        }
    }

    pub fn snapshot(&self) -> TickSnapshot {
        let s = self.samples.lock().unwrap();
        TickSnapshot {
            ticks: s.ticks,
            skipped: s.skipped,
            write_errors: s.write_errors,
            bytes_written: s.bytes_written,
            bytes_received: self.bytes_received.load(Ordering::Relaxed),
            lines_received: self.lines_received.load(Ordering::Relaxed),
            realtime: s.realtime,
            late: percentiles(&s.late_us),
            write: percentiles(&s.write_us),
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.tick.take() {
            let _ = h.join();
        }
        if let Some(h) = self.reader.take() {
            let _ = h.join();
        }
    }
}

impl Drop for TickLoop {
    fn drop(&mut self) {
        self.stop();
    }
}



fn tick_loop(
    mut port: Box<dyn SerialPort>,
    opts: TickOptions,
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Samples>>,
) {
    let hz = opts.hz.max(1);
    let period = Duration::from_micros(1_000_000 / hz as u64);
    let interval_ms = (1000 / hz).max(1);
    let spin = Duration::from_micros(opts.spin_us as u64);
    let start = Instant::now();
    let mut n: u32 = 0;
    let mut line = String::with_capacity(32);
    samples.lock().unwrap().realtime = realtime::promote(period).is_ok();

    while !stop.load(Ordering::Relaxed) {
        n += 1;
        let deadline = start + period * n;
        let now = Instant::now();
        if deadline > now + spin {
            thread::sleep(deadline - now - spin);
        }
        while Instant::now() < deadline {
            std::hint::spin_loop();
        }
        let fired = Instant::now();
        let late_us = fired.saturating_duration_since(deadline).as_micros() as u32;

        let t = fired.duration_since(start).as_secs_f64();
        let pos = (5000.0 + 4999.0 * (t * std::f64::consts::TAU * 0.5).sin()).round() as u32;
        line.clear();
        let _ = write!(line, "L0{pos:04}I{interval_ms}\n");

        let t0 = Instant::now();
        let ok = port.write_all(line.as_bytes()).is_ok();
        let write_us = t0.elapsed().as_micros() as u32;

        let mut s = samples.lock().unwrap();
        s.ticks += 1;
        if ok {
            s.bytes_written += line.len() as u64;
        } else {
            s.write_errors += 1;
        }
        push(&mut s.late_us, late_us);
        push(&mut s.write_us, write_us);


        let behind = Instant::now().saturating_duration_since(start + period * (n + 1));
        if behind > period {
            let skip = (behind.as_micros() / period.as_micros()) as u32;
            n += skip;
            s.skipped += skip as u64;
        }
    }
}

fn push(q: &mut VecDeque<u32>, v: u32) {
    if q.len() == WINDOW {
        q.pop_front();
    }
    q.push_back(v);
}

pub fn percentiles(q: &VecDeque<u32>) -> PercentilesUs {
    if q.is_empty() {
        return PercentilesUs::default();
    }
    let mut v: Vec<u32> = q.iter().copied().collect();
    v.sort_unstable();
    let at = |p: f32| v[((v.len() - 1) as f32 * p).round() as usize];
    PercentilesUs {
        mean: v.iter().map(|x| *x as f64).sum::<f64>() as f32 / v.len() as f32,
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        max: v[v.len() - 1],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn loopback_ticks_arrive_on_time() {
        let mut l = TickLoop::loopback(TickOptions {
            hz: 100,
            spin_us: 500,
        })
        .unwrap();
        thread::sleep(Duration::from_millis(600));
        l.stop();
        let s = l.snapshot();
        assert!(s.ticks >= 50, "ticks {}", s.ticks);
        assert_eq!(s.write_errors, 0);
        assert!(
            s.lines_received >= s.ticks - 2,
            "received {} of {}",
            s.lines_received,
            s.ticks
        );
        assert!(s.late.p95 < 2_000, "p95 late {}us", s.late.p95);
    }
}
