use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use bp_player::{AudioDevice, AudioEvent, AudioOut};

pub const FADE: Duration = Duration::from_secs(1);
const LEAD_S: f64 = 0.12;
const MAX_LEAD: f64 = 8.0;
const STABLE: Duration = Duration::from_secs(5);
const JUMP_S: f64 = 0.3;
const LOST_S: f64 = 0.25;
const SETTLE: Duration = Duration::from_millis(400);
const NUDGE_FROM_S: f64 = 0.02;
const NUDGE_UNTIL_S: f64 = 0.004;
const MAX_NUDGE: f64 = 0.03;
const MIN_SPEED: f64 = 0.25;
const MAX_SPEED: f64 = 4.0;
const SEEK_NEAR_S: f64 = 0.5;
const SEEK_TIMEOUT: Duration = Duration::from_millis(1500);
const END_S: f64 = 0.05;
const PASS: Duration = Duration::from_millis(20);
const IDLE: Duration = Duration::from_millis(100);
const DEVICE_REREAD: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Default, PartialEq)]
pub struct EstimAudioOptions {
    pub device: Option<String>,
    pub delay_ms: f64,
    pub volume: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EstimAudioSource {
    pub media: String,
    pub path: String,
    pub swap_channels: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum EstimAudioStatus {
    Off,
    Missing,
    Idle,
    Ready,
    Playing,
    Error(String),
}

impl EstimAudioStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            EstimAudioStatus::Off => "off",
            EstimAudioStatus::Missing => "missing",
            EstimAudioStatus::Idle => "idle",
            EstimAudioStatus::Ready => "ready",
            EstimAudioStatus::Playing => "playing",
            EstimAudioStatus::Error(_) => "error",
        }
    }
}

pub(crate) type ClockRead = Box<dyn Fn(&str) -> (f64, bool, f64, f64) + Send>;

#[derive(Default)]
struct Wanted {
    options: EstimAudioOptions,
    source: Option<EstimAudioSource>,
}

pub(crate) struct EstimAudio {
    wanted: Arc<Mutex<Wanted>>,
    status: Arc<Mutex<EstimAudioStatus>>,
    out: Arc<Mutex<Option<Arc<AudioOut>>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl EstimAudio {
    pub fn start(clock: ClockRead) -> Result<EstimAudio, String> {
        let wanted = Arc::new(Mutex::new(Wanted::default()));
        let status = Arc::new(Mutex::new(EstimAudioStatus::Off));
        let out = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let run = Run { wanted: wanted.clone(), status: status.clone(), out: out.clone(), stop: stop.clone(), clock };
            thread::Builder::new().name("bp-estim-audio".into()).spawn(move || run.run()).map_err(|e| e.to_string())?
        };
        Ok(EstimAudio { wanted, status, out, stop, thread: Some(thread) })
    }

    pub fn set_options(&self, options: EstimAudioOptions) {
        self.wanted.lock().unwrap().options = options;
    }

    pub fn options(&self) -> EstimAudioOptions {
        self.wanted.lock().unwrap().options.clone()
    }

    pub fn set_source(&self, source: Option<EstimAudioSource>) {
        self.wanted.lock().unwrap().source = source;
    }

    pub fn status(&self) -> EstimAudioStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn devices(&self) -> Result<Vec<AudioDevice>, String> {
        Ok(player(&self.out)?.devices())
    }

    pub fn close(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        if let Some(out) = self.out.lock().unwrap().take() {
            let _ = out.set_gain(0.0);
            let _ = out.stop();
        }
    }
}

impl Drop for EstimAudio {
    fn drop(&mut self) {
        self.close();
    }
}

fn player(out: &Mutex<Option<Arc<AudioOut>>>) -> Result<Arc<AudioOut>, String> {
    let mut slot = out.lock().unwrap();
    if let Some(out) = slot.as_ref() {
        return Ok(out.clone());
    }
    let made = Arc::new(AudioOut::new()?);
    *slot = Some(made.clone());
    Ok(made)
}

struct Run {
    wanted: Arc<Mutex<Wanted>>,
    status: Arc<Mutex<EstimAudioStatus>>,
    out: Arc<Mutex<Option<Arc<AudioOut>>>>,
    stop: Arc<AtomicBool>,
    clock: ClockRead,
}

#[derive(Default)]
struct Held {
    device: Option<String>,
    devices: Option<Vec<AudioDevice>>,
    devices_at: Option<Instant>,
    present: bool,
    file: Option<String>,
    open: bool,
    ends_due: u32,
    ready: bool,
    duration: f64,
    swapped: bool,
    failed: Option<String>,
    was_running: bool,
}

impl Run {
    fn run(self) {
        let mut steer = Steer::new();
        let mut held = Held::default();
        while !self.stop.load(Ordering::Relaxed) {
            let rest = self.pass(&mut steer, &mut held);
            thread::sleep(rest);
        }
    }

    fn set_status(&self, status: EstimAudioStatus) {
        *self.status.lock().unwrap() = status;
    }

    fn pass(&self, steer: &mut Steer, held: &mut Held) -> Duration {
        let (options, source) = {
            let w = self.wanted.lock().unwrap();
            (w.options.clone(), w.source.clone())
        };
        let (media_ms, running, speed, level) = (self.clock)(source.as_ref().map_or("", |s| s.media.as_str()));
        let current = self.out.lock().unwrap().clone();
        if let Some(out) = &current {
            if steer.playing() && (!running || level <= 0.0) {
                let _ = out.set_gain(0.0);
                steer.silenced();
            }
        }
        let Some(device) = options.device.clone() else {
            if let Some(out) = current {
                close_file(&out, steer, held);
                held.device = None;
            }
            self.set_status(EstimAudioStatus::Off);
            return IDLE;
        };
        let out = match player(&self.out) {
            Ok(out) => out,
            Err(e) => {
                self.set_status(EstimAudioStatus::Error(e));
                return Duration::from_secs(1);
            }
        };
        let mut restarted = false;
        loop {
            match out.next_event(0.0) {
                AudioEvent::None => break,
                AudioEvent::Loaded { path, duration } => {
                    if held.ends_due == 0 && path.is_some() && path == held.file {
                        held.ready = true;
                        held.duration = duration;
                    }
                }
                AudioEvent::Restarted => restarted |= held.ends_due == 0,
                AudioEvent::Ended { error } => {
                    if held.ends_due > 0 {
                        held.ends_due -= 1;
                    } else if held.open {
                        held.open = false;
                        held.ready = false;
                        held.failed = Some(error.unwrap_or_else(|| "ended".into()));
                        steer.reset();
                    }
                }
                AudioEvent::DevicesChanged => held.devices = None,
                AudioEvent::FilterFailed => {
                    let _ = out.set_gain(0.0);
                    let _ = out.set_paused(true);
                    steer.reset();
                    held.ready = false;
                    held.failed = Some("the channel swap failed".into());
                }
                AudioEvent::Shutdown => {
                    *self.out.lock().unwrap() = None;
                    *held = Held::default();
                    steer.reset();
                    self.set_status(EstimAudioStatus::Error("the audio player stopped".into()));
                    return Duration::from_secs(1);
                }
            }
        }
        let reread = held.devices.is_none() || (!held.present && held.devices_at.is_some_and(|at| at.elapsed() >= DEVICE_REREAD));
        if reread {
            held.devices = Some(out.devices());
            held.devices_at = Some(Instant::now());
        }
        held.present = held.devices.as_ref().is_some_and(|list| list.iter().any(|d| d.name == device));
        if !held.present {
            close_file(&out, steer, held);
            held.device = None;
            self.set_status(EstimAudioStatus::Missing);
            return IDLE;
        }
        if held.device.as_deref() != Some(device.as_str()) {
            close_file(&out, steer, held);
            if let Err(e) = out.set_device(&device) {
                self.set_status(EstimAudioStatus::Error(e));
                return IDLE;
            }
            held.device = Some(device);
        }

        let wanted_file = source.as_ref().map(|s| s.path.clone());
        let retry = held.failed.is_some() && running && !held.was_running;
        held.was_running = running;
        if wanted_file != held.file || retry {
            close_file(&out, steer, held);
            if let Some(path) = &wanted_file {
                let _ = out.set_gain(0.0);
                match out.load(path) {
                    Ok(()) => held.open = true,
                    Err(e) => held.failed = Some(e),
                }
            }
            held.file = wanted_file;
        }
        let Some(source) = source else {
            self.set_status(EstimAudioStatus::Idle);
            return IDLE;
        };
        if source.swap_channels != held.swapped {
            let _ = out.set_gain(0.0);
            let _ = out.set_paused(true);
            steer.reset();
            let _ = out.set_swapped(source.swap_channels);
            held.swapped = source.swap_channels;
        }
        if let Some(e) = &held.failed {
            self.set_status(EstimAudioStatus::Error(e.clone()));
            return PASS;
        }

        let input = Input {
            target: (media_ms - options.delay_ms * speed) / 1000.0,
            running,
            speed,
            ready: held.ready,
            duration: held.duration,
            position: if steer.wants_position() { out.position() } else { None },
            restarted,
            volume: options.volume.clamp(0.0, 1.0) * level.clamp(0.0, 1.0),
        };
        let mut seek_failed = false;
        for command in steer.step(&input, Instant::now()) {
            match command {
                Command::Pause => drop(out.set_paused(true)),
                Command::Play => drop(out.set_paused(false)),
                Command::Seek(s) => seek_failed |= out.seek(s.max(0.0)).is_err(),
                Command::Speed(s) => drop(out.set_speed(s)),
                Command::Gain(g) => drop(out.set_gain(g)),
            }
        }
        if seek_failed {
            steer.reset();
        }
        self.set_status(if steer.playing() { EstimAudioStatus::Playing } else { EstimAudioStatus::Ready });
        PASS
    }
}

fn close_file(out: &AudioOut, steer: &mut Steer, held: &mut Held) {
    if held.open {
        let _ = out.set_gain(0.0);
        if out.stop().is_ok() {
            held.ends_due += 1;
        }
        held.open = false;
    }
    steer.reset();
    held.file = None;
    held.ready = false;
    held.duration = 0.0;
    held.failed = None;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Command {
    Pause,
    Play,
    Seek(f64),
    Speed(f64),
    Gain(f64),
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Input {
    pub target: f64,
    pub running: bool,
    pub speed: f64,
    pub ready: bool,
    pub duration: f64,
    pub position: Option<f64>,
    pub restarted: bool,
    pub volume: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    Stopped,
    Seeking { since: Instant, to: f64 },
    Waiting { at: f64 },
    Playing { since: Instant },
}

pub(crate) struct Steer {
    phase: Phase,
    last: Option<(f64, Instant)>,
    drift: f64,
    nudging: bool,
    speed: f64,
    gain: f64,
    gain_at: Option<Instant>,
    lead: f64,
}

impl Steer {
    pub fn new() -> Steer {
        Steer { phase: Phase::Stopped, last: None, drift: 0.0, nudging: false, speed: 1.0, gain: 0.0, gain_at: None, lead: 1.0 }
    }

    pub fn reset(&mut self) {
        *self = Steer { speed: self.speed, ..Steer::new() };
    }

    pub fn silenced(&mut self) {
        self.gain = 0.0;
    }

    pub fn playing(&self) -> bool {
        matches!(self.phase, Phase::Playing { .. })
    }

    pub fn wants_position(&self) -> bool {
        !matches!(self.phase, Phase::Stopped)
    }

    pub fn step(&mut self, input: &Input, now: Instant) -> Vec<Command> {
        let mut out = Vec::new();
        let end = if input.duration > 0.0 { input.duration - END_S } else { f64::INFINITY };
        let speed_ok = (MIN_SPEED..=MAX_SPEED).contains(&input.speed);
        if !(input.running && input.ready && speed_ok && input.target >= 0.0 && input.target < end) {
            self.stop(&mut out);
            self.last = None;
            return out;
        }
        if let Some((target, at)) = self.last {
            let expected = target + now.duration_since(at).as_secs_f64() * input.speed;
            if (input.target - expected).abs() > JUMP_S {
                self.stop(&mut out);
            }
        }
        self.last = Some((input.target, now));
        if let Phase::Seeking { since, to } = self.phase {
            let timed_out = now.duration_since(since) >= SEEK_TIMEOUT;
            match input.position {
                Some(p) if (input.restarted || timed_out) && (p - to).abs() < SEEK_NEAR_S => self.phase = Phase::Waiting { at: p },
                None if input.restarted => self.phase = Phase::Waiting { at: to },
                _ if timed_out => self.phase = Phase::Stopped,
                _ => {}
            }
        }
        match self.phase {
            Phase::Stopped => {
                self.gain(0.0, &mut out);
                self.speed(input.speed, &mut out);
                let to = input.target + LEAD_S * self.lead * input.speed;
                out.push(Command::Seek(to));
                self.phase = Phase::Seeking { since: now, to };
            }
            Phase::Seeking { .. } => {}
            Phase::Waiting { at } => {
                if input.target >= at - PASS.as_secs_f64() / 4.0 {
                    out.push(Command::Play);
                    self.phase = Phase::Playing { since: now };
                    self.gain_at = Some(now);
                    self.drift = 0.0;
                    self.nudging = false;
                }
            }
            Phase::Playing { since } => {
                let played = now.duration_since(since);
                let fade = (played.as_secs_f64() / FADE.as_secs_f64()).min(1.0);
                let mut speed = input.speed;
                if played >= STABLE {
                    self.lead = 1.0;
                }
                if let (true, Some(position)) = (played >= SETTLE, input.position) {
                    self.drift = self.drift * 0.8 + (position - input.target) * 0.2;
                    if self.drift.abs() > LOST_S {
                        self.lead = (self.lead * 2.0).min(MAX_LEAD);
                        self.stop(&mut out);
                        return out;
                    }
                    if self.drift.abs() > NUDGE_FROM_S {
                        self.nudging = true;
                    } else if self.drift.abs() < NUDGE_UNTIL_S {
                        self.nudging = false;
                    }
                    if self.nudging {
                        speed = (speed * (1.0 + (-self.drift * 0.5).clamp(-MAX_NUDGE, MAX_NUDGE))).clamp(MIN_SPEED, MAX_SPEED);
                    }
                }
                let rise = self.gain_at.map_or(0.0, |at| input.volume * now.duration_since(at).as_secs_f64() / FADE.as_secs_f64());
                self.gain_at = Some(now);
                self.gain((input.volume * fade).min(self.gain + rise), &mut out);
                self.speed(speed, &mut out);
            }
        }
        out
    }

    fn stop(&mut self, out: &mut Vec<Command>) {
        if self.phase == Phase::Stopped {
            return;
        }
        self.gain(0.0, out);
        out.push(Command::Pause);
        self.phase = Phase::Stopped;
        self.nudging = false;
    }

    fn gain(&mut self, gain: f64, out: &mut Vec<Command>) {
        let gain = gain.clamp(0.0, 1.0);
        if (gain - self.gain).abs() > 0.0005 || (gain == 0.0 && self.gain != 0.0) {
            self.gain = gain;
            out.push(Command::Gain(gain));
        }
    }

    fn speed(&mut self, speed: f64, out: &mut Vec<Command>) {
        if (speed - self.speed).abs() > 0.0005 {
            self.speed = speed;
            out.push(Command::Speed(speed));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(target: f64) -> Input {
        Input { target, running: true, speed: 1.0, ready: true, duration: 600.0, position: None, restarted: false, volume: 0.8 }
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn gains(commands: &[Command]) -> Vec<f64> {
        commands.iter().filter_map(|c| if let Command::Gain(g) = c { Some(*g) } else { None }).collect()
    }

    fn started(steer: &mut Steer, t0: Instant) -> Instant {
        let first = steer.step(&input(10.0), t0);
        assert!(first.contains(&Command::Seek(10.0 + LEAD_S)), "{first:?}");
        let t1 = t0 + ms(40);
        let restarted = Input { target: 10.04, restarted: true, position: Some(10.0 + LEAD_S), ..input(10.04) };
        assert!(!steer.step(&restarted, t1).contains(&Command::Play), "waits for the clock");
        let t2 = t0 + ms(120);
        let reached = Input { position: Some(10.0 + LEAD_S), ..input(10.12) };
        assert!(steer.step(&reached, t2).contains(&Command::Play));
        assert!(steer.playing());
        t2
    }

    #[test]
    fn starts_silent_and_fades_in_over_a_second() {
        let mut steer = Steer::new();
        let t0 = Instant::now();
        let t2 = started(&mut steer, t0);
        let gain_at = |steer: &mut Steer, after: u64| {
            let t = t2 + ms(after);
            let target = 10.12 + after as f64 / 1000.0;
            gains(&steer.step(&Input { position: Some(target), ..input(target) }, t)).first().copied()
        };
        let half = gain_at(&mut steer, 500).unwrap();
        assert!((half - 0.4).abs() < 0.01, "{half}");
        let full = gain_at(&mut steer, 1000).unwrap();
        assert!((full - 0.8).abs() < 1e-9, "{full}");
        assert_eq!(gain_at(&mut steer, 1200), None, "nothing sent once at the level");
    }

    #[test]
    fn a_pause_is_silent_then_paused_and_the_resume_fades_again() {
        let mut steer = Steer::new();
        let t0 = Instant::now();
        let t2 = started(&mut steer, t0);
        let t3 = t2 + ms(1500);
        steer.step(&Input { position: Some(11.62), ..input(11.62) }, t3);
        let paused = steer.step(&Input { running: false, ..input(11.64) }, t3 + ms(20));
        assert_eq!(paused, vec![Command::Gain(0.0), Command::Pause]);
        assert!(steer.step(&Input { running: false, ..input(11.64) }, t3 + ms(40)).is_empty(), "rests quietly");
        let resumed = steer.step(&input(11.64), t3 + ms(5000));
        assert!(resumed.iter().any(|c| matches!(c, Command::Seek(_))), "{resumed:?}");
        assert!(gains(&resumed).iter().all(|g| *g == 0.0));
    }

    #[test]
    fn a_seek_on_the_clock_starts_over() {
        let mut steer = Steer::new();
        let t0 = Instant::now();
        let t2 = started(&mut steer, t0);
        steer.step(&Input { position: Some(10.32), ..input(10.32) }, t2 + ms(200));
        let jumped = steer.step(&Input { position: Some(10.34), ..input(120.0) }, t2 + ms(220));
        assert_eq!(&jumped[..2], &[Command::Gain(0.0), Command::Pause]);
        assert!(jumped.contains(&Command::Seek(120.0 + LEAD_S)), "{jumped:?}");
    }

    #[test]
    fn small_drift_is_nudged_and_a_stall_starts_over_further_ahead() {
        let mut steer = Steer::new();
        let t0 = Instant::now();
        let t2 = started(&mut steer, t0);
        let mut sent = None;
        for i in 0..20u64 {
            let after = 500 + i * 20;
            let target = 10.12 + after as f64 / 1000.0;
            for c in steer.step(&Input { position: Some(target - 0.05), ..input(target) }, t2 + ms(after)) {
                if let Command::Speed(s) = c {
                    sent = Some(s);
                }
            }
        }
        let speed = sent.expect("nudged");
        assert!(speed > 1.0 && speed <= 1.0 + MAX_NUDGE, "{speed}");
        let mut seek = None;
        for i in 0..20u64 {
            let after = 1000 + i * 20;
            let target = 10.12 + after as f64 / 1000.0;
            for c in steer.step(&Input { position: Some(target - 0.5), ..input(target) }, t2 + ms(after)) {
                if let Command::Seek(to) = c {
                    seek = Some(to - target);
                }
            }
            if seek.is_some() {
                break;
            }
        }
        let lead = seek.expect("started over");
        assert!((lead - 2.0 * LEAD_S).abs() < 1e-9, "{lead}");
    }

    #[test]
    fn rests_outside_the_file_before_it_opens_and_outside_the_speeds_mpv_plays() {
        let mut steer = Steer::new();
        let t0 = Instant::now();
        assert!(steer.step(&Input { ready: false, ..input(10.0) }, t0).is_empty());
        assert!(steer.step(&input(-0.5), t0 + ms(20)).is_empty(), "delay before the file starts");
        assert!(steer.step(&input(599.99), t0 + ms(40)).is_empty(), "past the end");
        assert!(steer.step(&Input { speed: 0.2, ..input(10.0) }, t0 + ms(60)).is_empty(), "muted by mpv below 0.25");
        let fast = steer.step(&Input { speed: 3.0, ..input(10.0) }, t0 + ms(80));
        assert!(fast.contains(&Command::Seek(10.0 + LEAD_S * 3.0)), "{fast:?}");
    }

    #[test]
    fn a_nudge_never_takes_the_speed_below_what_mpv_plays() {
        let mut steer = Steer::new();
        let t0 = Instant::now();
        let slow = |target: f64| Input { speed: MIN_SPEED, ..input(target) };
        steer.step(&slow(10.0), t0);
        let to = 10.0 + LEAD_S * MIN_SPEED;
        steer.step(&Input { restarted: true, position: Some(to), ..slow(10.0) }, t0 + ms(20));
        steer.step(&Input { position: Some(to), ..slow(to) }, t0 + ms(140));
        assert!(steer.playing());
        for i in 0..30u64 {
            let after = 600 + i * 20;
            let target = to + (after - 140) as f64 / 1000.0 * MIN_SPEED;
            for c in steer.step(&Input { position: Some(target + 0.05), ..slow(target) }, t0 + ms(after)) {
                if let Command::Speed(s) = c {
                    assert!(s >= MIN_SPEED, "{s}");
                }
            }
        }
    }

    #[test]
    fn a_seek_that_lands_elsewhere_is_sent_again() {
        let mut steer = Steer::new();
        let t0 = Instant::now();
        steer.step(&input(10.0), t0);
        let stale = steer.step(&Input { restarted: true, position: Some(3.0), ..input(10.02) }, t0 + ms(20));
        assert!(!stale.contains(&Command::Play), "{stale:?}");
        let again = steer.step(&Input { position: Some(3.0), ..input(11.52) }, t0 + SEEK_TIMEOUT + ms(20));
        assert!(again.iter().any(|c| matches!(c, Command::Seek(_))), "{again:?}");
    }

    #[test]
    fn the_level_follows_volume_changes_and_a_halt_and_rises_at_the_fades_pace() {
        let mut steer = Steer::new();
        let t0 = Instant::now();
        let t2 = started(&mut steer, t0);
        let at = |after: u64, volume: f64, steer: &mut Steer| {
            let target = 10.12 + after as f64 / 1000.0;
            steer.step(&Input { volume, position: Some(target), ..input(target) }, t2 + ms(after))
        };
        at(1100, 0.8, &mut steer);
        assert_eq!(at(1120, 0.79, &mut steer), vec![Command::Gain(0.79)], "1% steps arrive");
        assert_eq!(at(1140, 0.0, &mut steer), vec![Command::Gain(0.0)], "a halt silences it");
        let rising = gains(&at(1160, 0.5, &mut steer));
        assert!(rising.len() == 1 && (rising[0] - 0.01).abs() < 1e-6, "{rising:?}");
    }
}
