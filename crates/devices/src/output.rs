use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, TryRecvError, channel};
use std::thread;
use std::time::{Duration, Instant};

use bp_script::{Axis, Script};

use crate::howl::HowlStatus;
use crate::ramp::{Ramp, RampProgress};
use crate::tcode::{self, AxisClamp, Profile, Units};
use crate::toys::follows_speed;
use crate::transport::{self, Link, Transport};
use crate::{PercentilesUs, percentiles};

const RETRY: Duration = Duration::from_secs(2);
const IDENTIFY_WINDOW: Duration = Duration::from_secs(2);



pub const CONNECT_GLIDE_MS: u32 = 1500;

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Connecting,
    Connected,
    Error(String),
}


#[derive(Clone, Debug, Default, PartialEq)]
pub struct Media {

    pub title: String,

    pub hwl: Option<PathBuf>,
}


#[derive(Clone, Copy, Debug)]
pub struct TickContext {
    pub media_ms: f64,
    pub playing: bool,
    pub rate: f64,

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

    pub ramp: Ramp,
    state: State,
    last: Units,
    line: String,
    retry_at: Instant,
    connected_at: Option<Instant>,

    glide: Option<(Instant, bool)>,

    pub device: Option<String>,

    pub tcode: Option<String>,
    received: VecDeque<String>,
    inputs: VecDeque<String>,


    hosted: Option<(Vec<(Axis, Arc<Script>)>, Media)>,
    lines_sent: u64,
    write_us: VecDeque<u32>,

    last_line_at: Option<Instant>,

    feature_axes: HashMap<u32, Option<Axis>>,
}


#[derive(Clone, Debug)]
pub struct FeatureSnapshot {
    pub index: u32,

    pub kind: &'static str,
    pub description: String,
    pub axis: Option<Axis>,

    pub speed: bool,
}


#[derive(Clone, Debug)]
pub struct OutputSnapshot {
    pub id: u32,
    pub kind: &'static str,
    pub address: String,
    pub profile: Profile,
    pub status: Status,
    pub device: Option<String>,
    pub tcode: Option<String>,

    pub ramp: Option<RampProgress>,

    pub howl: Option<HowlStatus>,

    pub features: Vec<FeatureSnapshot>,
    pub battery: Option<u8>,
}



#[derive(Clone, Debug)]
pub struct OutputStats {
    pub lines_sent: u64,
    pub write: PercentilesUs,

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
            hosted: None,
            lines_sent: 0,
            write_us: VecDeque::new(),
            last_line_at: None,
            feature_axes: HashMap::new(),
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


    pub fn set_profile(&mut self, profile: Profile) {
        self.profile = profile;
        self.last = [None; Axis::COUNT];
        self.begin_glide();
    }

    fn begin_glide(&mut self) {
        self.glide = Some((
            Instant::now() + Duration::from_millis(CONNECT_GLIDE_MS as u64),
            false,
        ));
    }



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
                            h.set_stroke(stroke(self.hosted.as_ref()));
                        }
                        Link::Howl(h) => {
                            self.device = Some("Howl".into());
                            if let Some((scripts, media)) = &self.hosted {
                                h.set_source(scripts, media);
                            }
                        }
                        Link::Buttplug(_) => {}
                        Link::Toy(toy) => toy.set_axes(&self.feature_axes),
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
            State::Connected(Link::Howl(h)) => {
                if let Err(e) = h.poll() {
                    self.fail(format!("howl: {e}"));
                }
            }
            State::Connected(Link::Toy(toy)) => {
                if !toy.alive() {
                    self.fail("disconnected".into());
                }
            }
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
        let fresh = self
            .connected_at
            .is_some_and(|t| t.elapsed() < IDENTIFY_WINDOW);
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


    pub fn send(
        &mut self,
        values: &[f64; Axis::COUNT],
        driven: &[bool; Axis::COUNT],
        ctx: &TickContext,
    ) -> bool {
        let t0 = Instant::now();

        let mut ramped = (*values, *driven);
        let (values, driven) =
            if self.profile == Profile::Restim && matches!(self.state, State::Connected(_)) {
                self.ramp.advance(ctx.playing, ctx.interval_ms as f64);
                self.ramp.apply(&mut ramped.0, &mut ramped.1);
                (&ramped.0, &ramped.1)
            } else {
                (values, driven)
            };


        let interval_ms = match &self.state {
            State::Connected(Link::Lines(conn)) => {
                let min = conn.min_interval_ms();
                if min > 0
                    && self
                        .last_line_at
                        .is_some_and(|t| t0.duration_since(t) < Duration::from_millis(min as u64))
                {
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
                if tcode::encode(
                    self.profile,
                    values,
                    driven,
                    &self.clamps,
                    &mut self.last,
                    interval_ms,
                    &mut self.line,
                ) == 0
                {
                    return false;
                }
                self.last_line_at = Some(t0);
                let r = conn.send(&self.line);
                write_us = conn.last_write_us();
                r
            }
            State::Connected(Link::Buttplug(bp)) => {
                match bp.send(values, &self.clamps, ctx.interval_ms) {
                    Ok(true) => Ok(()),
                    Ok(false) => return false,
                    Err(e) => Err(e),
                }
            }
            State::Connected(Link::Coyote(coyote)) => {
                let volume = if driven[Axis::V0.index()] {
                    values[Axis::V0.index()]
                } else {
                    1.0
                };
                match coyote.send(
                    values[Axis::L0.index()],
                    volume,
                    driven[Axis::L0.index()],
                    ctx.playing,
                    ctx.interval_ms,
                ) {
                    Ok(true) => Ok(()),
                    Ok(false) => return false,
                    Err(e) => Err(e),
                }
            }
            State::Connected(Link::Handy(h)) => {
                h.tick(ctx, &self.clamps);
                return false;
            }
            State::Connected(Link::Howl(h)) => {
                h.tick(ctx);
                return false;
            }
            State::Connected(Link::Toy(toy)) => {
                match toy.send(values, &self.clamps, ctx.interval_ms) {
                    Ok(true) => Ok(()),
                    Ok(false) => return false,
                    Err(e) => Err(e),
                }
            }
            _ => return false,
        };
        match result {
            Ok(()) => {
                self.lines_sent += 1;
                if self.write_us.len() == 1000 {
                    self.write_us.pop_front();
                }

                self.write_us
                    .push_back(write_us.unwrap_or(t0.elapsed().as_micros() as u32));
                true
            }
            Err(e) => {
                self.fail(format!("write: {e}"));
                false
            }
        }
    }


    pub fn take_inputs(&mut self) -> Vec<String> {
        self.inputs.drain(..).collect()
    }


    pub fn set_strength(&mut self, a: u8, b: u8) -> bool {
        if let Transport::Coyote {
            strength_a,
            strength_b,
            ..
        } = &mut self.transport
        {

            (*strength_a, *strength_b) = (a, b);
        } else {
            return false;
        }
        if let State::Connected(Link::Coyote(coyote)) = &mut self.state {
            coyote.set_strength(a, b);
        }
        true
    }



    pub fn set_feature_axis(&mut self, index: u32, axis: Option<Axis>) -> bool {
        if !matches!(self.transport, Transport::Toy { .. }) {
            return false;
        }
        self.feature_axes.insert(index, axis);
        if let State::Connected(Link::Toy(toy)) = &mut self.state {
            toy.set_axes(&self.feature_axes);
        }
        true
    }



    pub fn set_scripts(&mut self, scripts: &[(Axis, Arc<Script>)], media: &Media) {
        if !matches!(
            self.transport,
            Transport::Handy { .. } | Transport::Howl { .. }
        ) {
            return;
        }
        self.hosted = Some((scripts.to_vec(), media.clone()));
        match &mut self.state {
            State::Connected(Link::Handy(h)) => h.set_stroke(stroke(self.hosted.as_ref())),
            State::Connected(Link::Howl(h)) => h.set_source(scripts, media),
            _ => {}
        }
    }



    pub fn test(&mut self) -> bool {
        match &mut self.state {
            State::Connected(Link::Howl(h)) => {
                h.test();
                true
            }
            _ => false,
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
        let (features, battery) = match &self.state {
            State::Connected(Link::Toy(toy)) => (
                toy.axes()
                    .map(|(f, axis)| FeatureSnapshot {
                        index: f.index,
                        kind: f.kind.as_str(),
                        description: f.description.clone(),
                        axis,
                        speed: axis.is_some_and(|a| follows_speed(f, a)),
                    })
                    .collect(),
                toy.battery(),
            ),
            _ => (Vec::new(), None),
        };
        OutputSnapshot {
            id: self.id,
            kind: self.transport.kind(),
            address: self.transport.address(),
            profile: self.profile,
            status: self.status(),
            device: self.device.clone(),
            tcode: self.tcode.clone(),
            ramp: (self.profile == Profile::Restim)
                .then(|| self.ramp.progress())
                .flatten(),
            howl: match &self.state {
                State::Connected(Link::Howl(h)) => Some(h.status.clone()),
                _ => None,
            },
            features,
            battery,
        }
    }

    pub fn stats(&self) -> OutputStats {
        OutputStats {
            lines_sent: self.lines_sent,
            write: percentiles(&self.write_us),
            received: self.received.iter().rev().take(10).cloned().collect(),
        }
    }


    pub fn disconnect(self) {
        thread::spawn(move || drop(self));
    }
}


fn stroke(hosted: Option<&(Vec<(Axis, Arc<Script>)>, Media)>) -> Option<&Script> {
    hosted?
        .0
        .iter()
        .find(|(a, s)| *a == Axis::L0 && !s.is_empty())
        .map(|(_, s)| s.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glide_sends_one_long_line_then_holds() {
        let mut o = Output::new(
            1,
            Transport::Udp {
                host: "127.0.0.1".into(),
                port: 1,
            },
            Profile::Stroker,
        );
        o.begin_glide();
        let t0 = Instant::now();
        assert_eq!(o.line_interval(t0, 10), Some(CONNECT_GLIDE_MS));
        assert_eq!(o.line_interval(t0 + Duration::from_millis(500), 10), None);
        assert_eq!(
            o.line_interval(t0 + Duration::from_millis(CONNECT_GLIDE_MS as u64 + 1), 10),
            Some(10)
        );
        assert_eq!(
            o.line_interval(t0 + Duration::from_millis(CONNECT_GLIDE_MS as u64 + 20), 10),
            Some(10)
        );
    }
}
