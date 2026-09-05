use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, TryRecvError, channel};
use std::thread;
use std::time::{Duration, Instant};

use bp_script::{Axis, Script};

use crate::howl::HowlStatus;
use crate::openshock::OpenShockTrigger;
use crate::ossm::OssmStatus;
use crate::ramp::{Ramp, RampProgress, Volume, VolumeSettings};
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

    pub manual_axes: [bool; Axis::COUNT],

    pub estim_manual: bool,

    pub estim_volume: VolumeSettings,
    pub rate: f64,

    pub interval_ms: u32,
}




#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vibration {
    pub source: Axis,
    pub depth: f64,
    pub hz: f64,
}

impl Vibration {

    pub fn offset(&self, source_value: f64, phase: &mut f64, dt_ms: f64) -> f64 {
        *phase = (*phase + std::f64::consts::TAU * self.hz.max(0.0) * dt_ms / 1000.0).rem_euclid(std::f64::consts::TAU);
        self.depth.max(0.0) * source_value.clamp(0.0, 1.0) * phase.sin()
    }
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
    volume: Volume,
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



    slider: Option<f64>,


    hosted: Option<(Vec<(Axis, Arc<Script>)>, Media)>,
    lines_sent: u64,
    write_us: VecDeque<u32>,

    last_line_at: Option<Instant>,

    feature_axes: HashMap<u32, Option<Axis>>,
    vibration: Option<Vibration>,
    vibration_phase: f64,
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

    pub ossm: Option<OssmStatus>,

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
            volume: Volume::default(),
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
            slider: None,
            hosted: None,
            lines_sent: 0,
            write_us: VecDeque::new(),
            last_line_at: None,
            feature_axes: HashMap::new(),
            vibration: None,
            vibration_phase: 0.0,
        };
        o.connect();
        o
    }

    fn connect(&mut self) {
        let (tx, rx) = channel();
        let t = self.transport.clone();
        let previous = std::mem::replace(&mut self.state, State::Connecting(rx));
        thread::spawn(move || {

            drop(previous);
            let _ = tx.send(transport::open(&t));
        });
    }


    pub fn set_profile(&mut self, profile: Profile) {
        if self.profile != profile {
            self.mute_restim();
            if self.profile == Profile::Restim {
                self.connect();
            }
        }
        self.profile = profile;
        self.last = [None; Axis::COUNT];
        self.begin_glide();
    }

    fn begin_glide(&mut self) {
        self.volume = Volume::default();
        if self.profile == Profile::Restim {
            self.glide = None;
            return;
        }
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
                        Link::Ossm(o) => self.device = Some(o.name().to_string()),
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
                        Link::OpenShock(o) => self.device = Some(o.device.clone()),
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
            State::Connected(Link::Ossm(o)) => match o.poll() {
                Ok(lines) => {
                    for line in lines {
                        self.note(line);
                    }
                }
                Err(e) => self.fail(format!("ossm: {e}")),
            },
            State::Connected(Link::Howl(h)) => {
                if let Err(e) = h.poll() {
                    self.fail(format!("howl: {e}"));
                }
            }
            State::Connected(Link::Toy(toy)) => {
                if let Some(error) = toy.error() {
                    self.fail(error);
                }
            }
            State::Connected(Link::OpenShock(o)) => {
                if let Err(e) = o.poll() {
                    self.fail(format!("openshock: {e}"));
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
        if let Some(v) = slider_value(l) {
            self.slider = Some(v);
        } else if let Some(input) = l.strip_prefix('#') {
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
        let mut clamps = self.clamps;
        let (values, driven) =
            if self.profile == Profile::Restim && matches!(self.state, State::Connected(_)) {
                self.ramp.advance(ctx.playing, ctx.interval_ms as f64);
                self.ramp.apply(&mut ramped.0, &mut ramped.1);
                let i = Axis::EV.index();
                let c = self.clamps[i];
                let volume = if ramped.1[i] { ramped.0[i] } else { 1.0 };
                let boost_axis = ctx.estim_volume.boost.axis.index();
                let boost_source = driven[boost_axis].then_some(values[boost_axis]);
                let target = ctx.estim_volume.target(volume, c.min, c.max, boost_source);

                let source_active = [Axis::EA, Axis::EB, Axis::EV, Axis::E1, Axis::E2, Axis::E3, Axis::E4]
                    .into_iter().any(|a| driven[a.index()] && self.clamps[a.index()].enabled);
                let active = c.enabled && source_active && (ctx.playing || ctx.estim_manual);
                ramped.0[i] = self.volume.apply(target, active, ctx.interval_ms as f64);
                ramped.1[i] = true;

                clamps[i] = AxisClamp::default();
                (&ramped.0, &ramped.1)
            } else {
                (values, driven)
            };



        let shaken: [f64; Axis::COUNT];
        let values = match self.vibration {
            Some(v) if self.profile == Profile::Stroker && driven[v.source.index()] && matches!(self.state, State::Connected(Link::Lines(_) | Link::Ossm(_))) => {
                let offset = v.offset(values[v.source.index()], &mut self.vibration_phase, ctx.interval_ms as f64);
                let mut out = *values;
                let i = Axis::L0.index();
                out[i] = (out[i] + offset).clamp(0.0, 1.0);
                shaken = out;
                &shaken
            }
            _ => values,
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
                    &clamps,
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
            State::Connected(Link::Ossm(o)) => {
                let c = self.clamps[Axis::L0.index()];
                if !c.enabled {
                    return false;
                }
                match o.send(c.min + values[Axis::L0.index()].clamp(0.0, 1.0) * (c.max - c.min)) {
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
                let active = std::array::from_fn(|i| driven[i] && (ctx.playing || ctx.manual_axes[i]));
                match toy.send(values, &self.clamps, ctx.interval_ms, &active) {
                    Ok(true) => Ok(()),
                    Ok(false) => return false,
                    Err(e) => Err(e),
                }
            }
            State::Connected(Link::OpenShock(o)) => {
                if !o.tick(values, driven, ctx.playing) {
                    return false;
                }
                Ok(())
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


    pub fn slider(&self) -> Option<f64> {
        self.slider
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


    pub fn set_openshock_trigger(&mut self, trigger: OpenShockTrigger) -> bool {
        if let Transport::OpenShock { trigger: kept, .. } = &mut self.transport {

            *kept = trigger;
        } else {
            return false;
        }
        if let State::Connected(Link::OpenShock(o)) = &mut self.state {
            o.set_trigger(trigger);
        }
        true
    }



    pub fn set_vibration(&mut self, vibration: Option<Vibration>) -> bool {
        if !matches!(
            self.transport,
            Transport::Serial { .. } | Transport::Udp { .. } | Transport::Tcp { .. } | Transport::WebSocket { .. } | Transport::Ble { .. } | Transport::Ossm { .. }
        ) {
            return false;
        }
        self.vibration = vibration;
        self.vibration_phase = 0.0;
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
            State::Connected(Link::Toy(toy)) => {
                toy.test();
                true
            }
            State::Connected(Link::OpenShock(o)) => o.pulse(),
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
            ossm: match &self.state {
                State::Connected(Link::Ossm(o)) => Some(o.status.clone()),
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

    fn mute_restim(&mut self) {
        if self.profile == Profile::Restim {
            if let State::Connected(Link::Lines(conn)) = &mut self.state {
                let _ = conn.send("V00000I0\n");
            }
        }
    }


    pub fn disconnect(mut self) {
        self.mute_restim();
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

    fn restim() -> (Output, std::net::UdpSocket) {
        let receiver = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let mut output = Output::new(1, Transport::Udp {
            host: "127.0.0.1".into(), port: receiver.local_addr().unwrap().port(),
        }, Profile::Restim);
        let deadline = Instant::now() + Duration::from_secs(1);
        while !output.connected() {
            assert!(Instant::now() < deadline);
            output.poll();
            thread::sleep(Duration::from_millis(1));
        }
        (output, receiver)
    }

    fn context() -> TickContext {
        TickContext { media_ms: 0.0, playing: true, manual_axes: [false; Axis::COUNT], estim_manual: false, estim_volume: crate::ramp::VolumeSettings::default(), rate: 1.0, interval_ms: 10 }
    }

    fn volume_units(o: &Output) -> u16 {
        o.last[Axis::EV.index()].expect("restim always owns volume")
    }

    #[test]
    fn restim_fades_volume_for_two_seconds_and_scales_the_combined_ramp_and_script() {
        let (mut o, _receiver) = restim();
        o.ramp.set_config(crate::RampConfig { enabled: true, start: 0.75, max: 0.75, duration_ms: 1000.0 });
        let mut values = [0.5; Axis::COUNT];
        let mut driven = [false; Axis::COUNT];
        driven[Axis::EA.index()] = true;
        driven[Axis::EV.index()] = true;
        values[Axis::EV.index()] = 0.1;
        let ctx = context();
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0, "first command is silent");
        assert!(o.line.contains("V00000I10"), "no stroker connection delay: {}", o.line);
        for _ in 0..100 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 3843, "halfway through the fade");
        for _ in 0..100 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 7687, "script times ramp scaled into the 75..100% range");
        let alpha = o.last[Axis::EA.index()];
        values[Axis::EV.index()] = 0.0;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0, "explicit silence bypasses the floor");
        values[Axis::EV.index()] = 0.1;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0, "stimulation after silence fades again");
        assert_eq!(o.last[Axis::EA.index()], alpha, "volume does not scale steering");
    }

    #[test]
    fn restim_mutes_on_pause_and_fades_on_resume_manual_test_and_reconnect() {
        let (mut o, _receiver) = restim();
        let values = [0.5; Axis::COUNT];
        let mut driven = [false; Axis::COUNT];
        driven[Axis::EA.index()] = true;
        let mut ctx = context();
        for _ in 0..201 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 9999, "fade applies with the session ramp off and no volume script");
        ctx.playing = false;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0);
        ctx.playing = true;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0);
        for _ in 0..100 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 5000);

        o.begin_glide();
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0);
        ctx.playing = false;
        o.send(&values, &driven, &ctx);
        ctx.estim_manual = true;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0);
        for _ in 0..200 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 9999);
        ctx.estim_manual = false;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0);
        ctx.playing = true;
        driven[Axis::EA.index()] = false;
        for _ in 0..201 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 0, "playing without a stimulation source stays silent");
        o.ramp.set_config(crate::RampConfig { enabled: true, ..Default::default() });
        for _ in 0..201 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 0, "the session ramp alone cannot start stimulation");
    }

    #[test]
    fn restim_manual_test_requires_an_enabled_source_on_this_output() {
        let (mut o, _receiver) = restim();
        let values = [0.5; Axis::COUNT];
        let mut driven = [false; Axis::COUNT];
        driven[Axis::EA.index()] = true;
        o.clamps[Axis::EA.index()].enabled = false;
        let ctx = TickContext { playing: false, estim_manual: true, ..context() };
        for _ in 0..201 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 0);
        o.clamps[Axis::EA.index()].enabled = true;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0, "enabling the source starts a new fade");
        for _ in 0..200 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 9999);
    }

    #[test]
    fn restim_sends_silence_before_profile_change_and_disconnect() {
        for disconnect in [false, true] {
            let (mut o, receiver) = restim();
            let values = [0.5; Axis::COUNT];
            let mut driven = [false; Axis::COUNT];
            driven[Axis::EA.index()] = true;
            for _ in 0..201 { o.send(&values, &driven, &context()); }
            receiver.set_nonblocking(true).unwrap();
            let mut buffer = [0; 1024];
            while receiver.recv(&mut buffer).is_ok() {}
            receiver.set_nonblocking(false).unwrap();
            receiver.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
            if disconnect { o.disconnect(); } else { o.set_profile(Profile::Stroker); }
            let n = receiver.recv(&mut buffer).unwrap();
            assert_eq!(&buffer[..n], b"V00000I0\n");
        }
    }

    #[test]
    fn profile_change_drains_a_queued_restim_mute_before_reconnecting() {
        struct QueuedConn {
            pending: String,
            flushed: Arc<std::sync::Mutex<String>>,
        }
        impl transport::Conn for QueuedConn {
            fn send(&mut self, line: &str) -> io::Result<()> {
                self.pending = line.into();
                Ok(())
            }
            fn recv_lines(&mut self) -> Vec<String> { Vec::new() }
        }
        impl Drop for QueuedConn {
            fn drop(&mut self) { *self.flushed.lock().unwrap() = self.pending.clone(); }
        }
        let (mut o, _receiver) = restim();
        let flushed = Arc::new(std::sync::Mutex::new(String::new()));
        o.state = State::Connected(Link::Lines(Box::new(QueuedConn {
            pending: "V09999I10\n".into(), flushed: flushed.clone(),
        })));
        o.set_profile(Profile::Stroker);
        assert!(!o.connected(), "new profile cannot overwrite the queued mute");
        let deadline = Instant::now() + Duration::from_secs(1);
        while !o.connected() {
            assert!(Instant::now() < deadline);
            o.poll();
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(*flushed.lock().unwrap(), "V00000I0\n");
    }

    #[test]
    fn restim_volume_range_can_change_during_stimulation() {
        let (mut o, _receiver) = restim();
        let mut values = [0.5; Axis::COUNT];
        let mut driven = [false; Axis::COUNT];
        driven[Axis::EV.index()] = true;
        values[Axis::EV.index()] = 0.1;
        let mut ctx = context();
        for _ in 0..201 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 7749);
        ctx.estim_volume.min = 0.4;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 4600);
        ctx.estim_volume.min = 0.0;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 1000);
        ctx.estim_volume.min = 0.9;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 9099);
    }

    #[test]
    fn restim_boost_follows_only_the_selected_driven_axis_and_preserves_fades_and_silence() {
        let (mut o, _receiver) = restim();
        let mut values = [0.5; Axis::COUNT];
        let mut driven = [false; Axis::COUNT];
        driven[Axis::EV.index()] = true;
        values[Axis::L1.index()] = 1.0;
        let mut ctx = context();
        ctx.estim_volume.max = 0.85;
        ctx.estim_volume.boost.enabled = true;
        for _ in 0..201 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 7999, "inactive surge adds nothing");
        driven[Axis::L1.index()] = true;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 9999, "surge adds twenty points past the normal limit");
        ctx.estim_volume.boost.axis = Axis::L2;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 7999, "changing the source removes the old boost");
        driven[Axis::L2.index()] = true;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 8999, "half sway adds ten points");
        values[Axis::EV.index()] = 0.0;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0, "boost never overrides explicit silence");
        values[Axis::EV.index()] = 0.5;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0);
        for _ in 0..100 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 4500, "boost passes through the two-second fade");
        ctx.playing = false;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0);
        ctx.playing = true;
        driven[Axis::EV.index()] = false;
        for _ in 0..201 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 0, "a boost source alone cannot start stimulation");
    }

    #[test]
    fn restim_keeps_output_caps_and_range_minimum_cannot_raise_silence() {
        let (mut o, _receiver) = restim();
        o.clamps[Axis::EV.index()] = AxisClamp { enabled: true, min: 0.4, max: 0.6 };
        let values = [0.5; Axis::COUNT];
        let mut driven = [false; Axis::COUNT];
        driven[Axis::EA.index()] = true;
        let mut ctx = context();
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0);
        for _ in 0..200 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 5999, "an explicit output cap wins over the floor");
        ctx.playing = false;
        o.send(&values, &driven, &ctx);
        assert_eq!(volume_units(&o), 0);
        ctx.playing = true;
        o.clamps[Axis::EV.index()].enabled = false;
        for _ in 0..201 { o.send(&values, &driven, &ctx); }
        assert_eq!(volume_units(&o), 0, "a disabled volume axis stays silent");
    }

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



fn slider_value(line: &str) -> Option<f64> {
    if let Some(rest) = line.strip_prefix("#pos").or_else(|| line.strip_prefix("#slider")) {
        let text = rest.trim();
        let v: f64 = text.parse().ok()?;
        if !v.is_finite() || v < 0.0 {
            return None;
        }
        return Some(if text.contains('.') || v <= 1.0 { v.min(1.0) } else if v <= 100.0 { v / 100.0 } else { (v / 999.0).min(1.0) });
    }
    let digits = line.strip_prefix("L0")?;
    if digits.is_empty() || digits.len() > 4 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let v: f64 = digits.parse().ok()?;
    let full = 10f64.powi(digits.len() as i32) - 1.0;
    Some((v / full).min(1.0))
}

#[cfg(test)]
mod vibration_tests {
    use super::*;

    #[test]
    fn a_driven_source_shakes_the_stroke_and_a_resting_one_leaves_it() {
        let mut o = Output::new(1, Transport::Udp { host: "127.0.0.1".into(), port: 1 }, Profile::Stroker);
        o.set_vibration(Some(Vibration { source: Axis::V0, depth: 0.1, hz: 10.0 }));

        let mut phase = 0.0;
        let v = o.vibration.unwrap();
        let steps: Vec<i32> = (0..4).map(|_| (v.offset(1.0, &mut phase, 25.0) * 1000.0).round() as i32).collect();
        assert_eq!(steps, vec![100, 0, -100, 0]);

        assert!((v.offset(0.5, &mut phase, 25.0) - 0.05).abs() < 1e-9);
        assert_eq!(v.offset(0.0, &mut phase, 25.0), 0.0);
    }
}

#[cfg(test)]
mod slider_tests {
    use super::slider_value;

    #[test]
    fn reads_the_three_slider_forms() {
        assert_eq!(slider_value("#pos 0.25"), Some(0.25));
        assert_eq!(slider_value("#slider 50"), Some(0.5));
        assert_eq!(slider_value("#pos 999"), Some(1.0));
        assert_eq!(slider_value("L0500"), Some(500.0 / 999.0));
        assert_eq!(slider_value("L05000"), Some(5000.0 / 9999.0));
        assert_eq!(slider_value("#ok"), None);
        assert_eq!(slider_value("L0"), None);
        assert_eq!(slider_value("TCode v0.3"), None);
    }
}

#[cfg(test)]
mod toy_tests {
    use super::*;
    use crate::toys::{tests::{fixture, output_value}, FeatureKind};

    #[test]
    fn pause_and_source_release_stop_toys_but_manual_overrides_work() {
        let receiver = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let (mut link, mut rx) = fixture(&[FeatureKind::Vibrate]);
        link.set_axes(&HashMap::from([(0, Some(Axis::V0))]));
        let mut output = Output::new(1, Transport::Udp { host: "127.0.0.1".into(), port: receiver.local_addr().unwrap().port() }, Profile::Stroker);
        output.state = State::Connected(Link::Toy(link));
        let mut ctx = TickContext { media_ms: 0.0, playing: true, manual_axes: [false; Axis::COUNT], estim_manual: false, estim_volume: crate::ramp::VolumeSettings::default(), rate: 1.0, interval_ms: 100 };
        let mut driven = [false; Axis::COUNT];
        driven[Axis::V0.index()] = true;
        let values = [0.6; Axis::COUNT];
        output.send(&values, &driven, &ctx);
        assert_eq!(output_value(&mut rx).1, 0.6);
        ctx.playing = false;
        output.send(&values, &driven, &ctx);
        assert_eq!(output_value(&mut rx).1, 0.0);
        ctx.manual_axes[Axis::V0.index()] = true;
        output.send(&values, &driven, &ctx);
        assert_eq!(output_value(&mut rx).1, 0.6);
        driven[Axis::V0.index()] = false;
        output.send(&values, &driven, &ctx);
        assert_eq!(output_value(&mut rx).1, 0.0);
        assert!(output.test(), "toy test must bypass the renderer's global sweep");
    }
}
