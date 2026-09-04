//! One connected device: connects off the tick thread, identifies the firmware with
//! `D0`/`D1` (TCode) or the device list (Buttplug), sends dirty axes every tick,
//! reconnects after errors. Lines the device sends that start with `#` (`#ok`, `#left`,
//! `#right`, `#edge`) are queued as inputs for the host to bind to actions.
//! Links that host the script themselves (the Handy) get the loaded scripts and the media
//! clock instead of per-tick axis values. A restim output can scale its volume by a session
//! ramp that counts playing time and restarts on every connect.

use std::collections::VecDeque;
use std::io;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, TryRecvError, channel};
use std::thread;
use std::time::{Duration, Instant};

use bp_script::{Axis, Script};

use crate::ramp::{Ramp, RampProgress};
use crate::tcode::{self, AxisClamp, Profile, Units};
use crate::transport::{self, Link, Transport};
use crate::{PercentilesUs, percentiles};

const RETRY: Duration = Duration::from_secs(2);
const IDENTIFY_WINDOW: Duration = Duration::from_secs(2);
/// A freshly connected stroker is somewhere unknown; TCode has no position readback. The
/// first line after a connect (or a profile switch) carries this interval so the firmware
/// eases from wherever it is, and nothing else is written until it has had the time to.
pub const CONNECT_GLIDE_MS: u32 = 1500;

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Connecting,
    Connected,
    Error(String),
}

/// What every output learns about the media on each tick.
#[derive(Clone, Copy, Debug)]
pub struct TickContext {
    pub media_ms: f64,
    pub playing: bool,
    pub rate: f64,
    /// Measured time since the previous tick, whole ms.
    pub interval_ms: u32,
}

enum State {
    Connecting(Receiver<io::Result<Link>>),
    Connected(Link),
    Error(String),
}

pub struct Output {
    pub id: u32,
    pub transport: Transport,
    pub profile: Profile,
    pub clamps: [AxisClamp; Axis::COUNT],
    /// Session volume ramp, applied to restim outputs only.
    pub ramp: Ramp,
    state: State,
    last: Units,
    line: String,
    retry_at: Instant,
    connected_at: Option<Instant>,
    /// Pending connect glide: when it ends, and whether its line has gone out yet.
    glide: Option<(Instant, bool)>,
    /// First reply after connect that is not telemetry, the `D0` answer on TCode boards.
    pub device: Option<String>,
    /// The `D1` answer, `TCode v0.3`.
    pub tcode: Option<String>,
    received: VecDeque<String>,
    inputs: VecDeque<String>,
    /// The stroke script, kept for a link that hosts it itself (the Handy) so one that
    /// connects mid-video still gets it.
    stroke: Option<Arc<Script>>,
    lines_sent: u64,
    write_us: VecDeque<u32>,
    /// When the last line went to a line transport, for links with a minimum spacing.
    last_line_at: Option<Instant>,
}

/// What the UI shows about an output every frame.
#[derive(Clone, Debug)]
pub struct OutputSnapshot {
    pub id: u32,
    pub kind: &'static str,
    pub address: String,
    pub profile: Profile,
    pub status: Status,
    pub device: Option<String>,
    pub tcode: Option<String>,
    /// The session ramp's progress, while it is on and the profile is restim.
    pub ramp: Option<RampProgress>,
}

/// Counters and timings for a diagnostics view, on request: sorting the write samples is
/// not something to do sixty times a second.
#[derive(Clone, Debug)]
pub struct OutputStats {
    pub lines_sent: u64,
    pub write: PercentilesUs,
    /// Newest first.
    pub received: Vec<String>,
}

impl Output {
    pub fn new(id: u32, transport: Transport, profile: Profile) -> Output {
        let mut o = Output {
            id,
            transport,
            profile,
            clamps: [AxisClamp::default(); Axis::COUNT],
            ramp: Ramp::default(),
            state: State::Error(String::new()),
            last: [None; Axis::COUNT],
            line: String::with_capacity(128),
            retry_at: Instant::now(),
            connected_at: None,
            glide: None,
            device: None,
            tcode: None,
            received: VecDeque::new(),
            inputs: VecDeque::new(),
            stroke: None,
            lines_sent: 0,
            write_us: VecDeque::new(),
            last_line_at: None,
        };
        o.connect();
        o
    }

    fn connect(&mut self) {
        let (tx, rx) = channel();
        let t = self.transport.clone();
        thread::spawn(move || {
            let _ = tx.send(transport::open(&t));
        });
        self.state = State::Connecting(rx);
    }

    /// Switches the axis family this output speaks; the next tick resends everything.
    pub fn set_profile(&mut self, profile: Profile) {
        self.profile = profile;
        self.last = [None; Axis::COUNT];
        self.begin_glide();
    }

    fn begin_glide(&mut self) {
        self.glide = Some((Instant::now() + Duration::from_millis(CONNECT_GLIDE_MS as u64), false));
    }

    /// Interval for the next TCode line while a glide is pending: the glide length for its
    /// first line, `None` (write nothing) until that has played out, then the tick's own.
    fn line_interval(&mut self, now: Instant, interval_ms: u32) -> Option<u32> {
        match self.glide {
            Some((until, false)) => {
                self.glide = Some((until, true));
                Some(CONNECT_GLIDE_MS)
            }
            Some((until, true)) if now < until => None,
            Some(_) => {
                self.glide = None;
                Some(interval_ms)
            }
            None => Some(interval_ms),
        }
    }

    /// Progresses the connection and reads replies. Call once per tick before `send`.
    pub fn poll(&mut self) {
        match &mut self.state {
            State::Connecting(rx) => match rx.try_recv() {
                Ok(Ok(mut link)) => {
                    self.last = [None; Axis::COUNT];
                    self.device = None;
                    self.tcode = None;
                    self.connected_at = Some(Instant::now());
                    self.begin_glide();
                    self.ramp.restart();
                    match &mut link {
                        Link::Lines(conn) => {
                            let _ = conn.send("D0\nD1\n");
                        }
                        Link::Coyote(coyote) => self.device = Some(coyote.device()),
                        Link::Handy(h) => {
                            self.device = Some(h.device.clone());
                            h.set_stroke(self.stroke.as_deref());
                        }
                        Link::Buttplug(_) => {}
                    }
                    self.state = State::Connected(link);
                }
                Ok(Err(e)) => self.fail(e.to_string()),
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => self.fail("connect thread died".into()),
            },
            State::Connected(Link::Lines(conn)) => {
                for line in conn.recv_lines() {
                    self.note(line);
                }
            }
            State::Connected(Link::Coyote(coyote)) => match coyote.poll() {
                Ok(true) => self.device = Some(coyote.device()),
                Ok(false) => {}
                Err(e) => self.fail(format!("coyote: {e}")),
            },
            State::Connected(Link::Buttplug(bp)) => match bp.poll() {
                Ok(()) => {
                    if bp.devices_changed() {
                        self.device = Some(bp.device_names());
                        for line in bp.take_log() {
                            self.note(line);
                        }
                    }
                }
                Err(e) => self.fail(format!("buttplug: {e}")),
            },
            State::Connected(Link::Handy(h)) => match h.poll() {
                Ok(lines) => {
                    for line in lines {
                        self.note(line);
                    }
                }
                Err(e) => self.fail(format!("handy: {e}")),
            },
            State::Error(_) => {
                if Instant::now() >= self.retry_at {
                    self.connect();
                }
            }
        }
    }

    fn fail(&mut self, message: String) {
        self.state = State::Error(message);
        self.retry_at = Instant::now() + RETRY;
        self.connected_at = None;
    }

    fn note(&mut self, line: String) {
        let l = line.trim();
        if l.is_empty() {
            return;
        }
        let fresh = self.connected_at.is_some_and(|t| t.elapsed() < IDENTIFY_WINDOW);
        if l.starts_with("TCode v") {
            self.tcode = Some(l.to_string());
        } else if fresh && self.device.is_none() && crate::probe::is_identity(l) {
            self.device = Some(l.to_string());
        }
        if let Some(input) = l.strip_prefix('#') {
            if self.inputs.len() < 64 {
                self.inputs.push_back(input.to_string());
            }
        }
        if self.received.len() == 20 {
            self.received.pop_front();
        }
        self.received.push_back(l.to_string());
    }

    /// Sends the axes that changed since the last line. Returns whether a line went out.
    pub fn send(&mut self, values: &[f64; Axis::COUNT], driven: &[bool; Axis::COUNT], ctx: &TickContext) -> bool {
        let t0 = Instant::now();
        // The ramp counts playing time while restim is connected and scales the volume it sends.
        let mut ramped = (*values, *driven);
        let (values, driven) = if self.profile == Profile::Restim && matches!(self.state, State::Connected(_)) {
            self.ramp.advance(ctx.playing, ctx.interval_ms as f64);
            self.ramp.apply(&mut ramped.0, &mut ramped.1);
            (&ramped.0, &ramped.1)
        } else {
            (values, driven)
        };
        // A link slower than the tick (BLE) gets lines at its own spacing, each carrying that
        // interval; the axes that moved meanwhile go out together on the next one.
        let interval_ms = match &self.state {
            State::Connected(Link::Lines(conn)) => {
                let min = conn.min_interval_ms();
                if min > 0 && self.last_line_at.is_some_and(|t| t0.duration_since(t) < Duration::from_millis(min as u64)) {
                    return false;
                }
                match self.line_interval(t0, ctx.interval_ms.max(min)) {
                    Some(ms) => ms,
                    None => return false,
                }
            }
            _ => ctx.interval_ms,
        };
        let mut write_us = None;
        let result = match &mut self.state {
            State::Connected(Link::Lines(conn)) => {
                if tcode::encode(self.profile, values, driven, &self.clamps, &mut self.last, interval_ms, &mut self.line) == 0 {
                    return false;
                }
                self.last_line_at = Some(t0);
                let r = conn.send(&self.line);
                write_us = conn.last_write_us();
                r
            }
            State::Connected(Link::Buttplug(bp)) => match bp.send(values, &self.clamps, ctx.interval_ms) {
                Ok(true) => Ok(()),
                Ok(false) => return false,
                Err(e) => Err(e),
            },
            State::Connected(Link::Coyote(coyote)) => {
                let volume = if driven[Axis::V0.index()] { values[Axis::V0.index()] } else { 1.0 };
                match coyote.send(values[Axis::L0.index()], volume, driven[Axis::L0.index()], ctx.playing, ctx.interval_ms) {
                    Ok(true) => Ok(()),
                    Ok(false) => return false,
                    Err(e) => Err(e),
                }
            }
            State::Connected(Link::Handy(h)) => {
                h.tick(ctx, &self.clamps);
                return false;
            }
            _ => return false,
        };
        match result {
            Ok(()) => {
                self.lines_sent += 1;
                if self.write_us.len() == 1000 {
                    self.write_us.pop_front();
                }
                // Transports with their own writer thread report the write itself, once it is done.
                self.write_us.push_back(write_us.unwrap_or(t0.elapsed().as_micros() as u32));
                true
            }
            Err(e) => {
                self.fail(format!("write: {e}"));
                false
            }
        }
    }

    /// Device button lines received since the last call, without their `#`.
    pub fn take_inputs(&mut self) -> Vec<String> {
        self.inputs.drain(..).collect()
    }

    /// Live strength change on a Coyote link. Returns whether this output took it.
    pub fn set_strength(&mut self, a: u8, b: u8) -> bool {
        if let Transport::Coyote { strength_a, strength_b, .. } = &mut self.transport {
            // Kept on the transport so a reconnect comes back at the same cap.
            (*strength_a, *strength_b) = (a, b);
        } else {
            return false;
        }
        if let State::Connected(Link::Coyote(coyote)) = &mut self.state {
            coyote.set_strength(a, b);
        }
        true
    }

    /// Hands the stroke script to a link that hosts it itself. Other links read the mixer
    /// output every tick and ignore this.
    pub fn set_scripts(&mut self, scripts: &[(Axis, Arc<Script>)]) {
        if !matches!(self.transport, Transport::Handy { .. }) {
            return;
        }
        self.stroke = scripts.iter().find(|(a, s)| *a == Axis::L0 && !s.is_empty()).map(|(_, s)| s.clone());
        if let State::Connected(Link::Handy(h)) = &mut self.state {
            h.set_stroke(self.stroke.as_deref());
        }
    }

    pub fn connected(&self) -> bool {
        matches!(self.state, State::Connected(_))
    }

    pub fn status(&self) -> Status {
        match &self.state {
            State::Connecting(_) => Status::Connecting,
            State::Connected(_) => Status::Connected,
            State::Error(e) => Status::Error(e.clone()),
        }
    }

    pub fn snapshot(&self) -> OutputSnapshot {
        OutputSnapshot {
            id: self.id,
            kind: self.transport.kind(),
            address: self.transport.address(),
            profile: self.profile,
            status: self.status(),
            device: self.device.clone(),
            tcode: self.tcode.clone(),
            ramp: (self.profile == Profile::Restim).then(|| self.ramp.progress()).flatten(),
        }
    }

    pub fn stats(&self) -> OutputStats {
        OutputStats { lines_sent: self.lines_sent, write: percentiles(&self.write_us), received: self.received.iter().rev().take(10).cloned().collect() }
    }

    /// Drops the connection on another thread so the tick never waits on a reader join.
    pub fn disconnect(self) {
        thread::spawn(move || drop(self));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glide_sends_one_long_line_then_holds() {
        let mut o = Output::new(1, Transport::Udp { host: "127.0.0.1".into(), port: 1 }, Profile::Stroker);
        o.begin_glide();
        let t0 = Instant::now();
        assert_eq!(o.line_interval(t0, 10), Some(CONNECT_GLIDE_MS));
        assert_eq!(o.line_interval(t0 + Duration::from_millis(500), 10), None);
        assert_eq!(o.line_interval(t0 + Duration::from_millis(CONNECT_GLIDE_MS as u64 + 1), 10), Some(10));
        assert_eq!(o.line_interval(t0 + Duration::from_millis(CONNECT_GLIDE_MS as u64 + 20), 10), Some(10));
    }
}
