use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{self, ErrorKind};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use bp_script::{Axis, Kind};
use buttplug_client::device::{ClientDeviceCommandValue, ClientDeviceOutputCommand};
use buttplug_client::{ButtplugClient, ButtplugClientDevice, ButtplugClientEvent};
use buttplug_client_in_process::ButtplugInProcessClientConnectorBuilder;
use buttplug_core::message::{DeviceFeatureOutput, InputType, OutputType};
use buttplug_server::ButtplugServerBuilder;
use buttplug_server::device::{ServerDeviceManager, ServerDeviceManagerBuilder};
use buttplug_server_device_config::DeviceConfigurationManagerBuilder;
use buttplug_server_hwmgr_btleplug::BtlePlugCommunicationManagerBuilder;
use futures_util::StreamExt;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use crate::output::CONNECT_GLIDE_MS;
use crate::tcode::AxisClamp;


pub const BIND_TIMEOUT: Duration = Duration::from_secs(15);

const SEND_EVERY_MS: f64 = 100.0;

const SPEED_FULL: f64 = 4.0;

const SPEED_TAU_MS: f64 = 150.0;
const BATTERY_EVERY: Duration = Duration::from_secs(60);



#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeatureKind {
    Vibrate,
    Rotate,
    Oscillate,
    Constrict,
    Position,
    TimedPosition,
    Spray,
    Temperature,
    Led,
}

impl FeatureKind {


    const ALL: [(OutputType, FeatureKind); 9] = [
        (
            OutputType::HwPositionWithDuration,
            FeatureKind::TimedPosition,
        ),
        (OutputType::Position, FeatureKind::Position),
        (OutputType::Vibrate, FeatureKind::Vibrate),
        (OutputType::Rotate, FeatureKind::Rotate),
        (OutputType::Oscillate, FeatureKind::Oscillate),
        (OutputType::Constrict, FeatureKind::Constrict),
        (OutputType::Spray, FeatureKind::Spray),
        (OutputType::Temperature, FeatureKind::Temperature),
        (OutputType::Led, FeatureKind::Led),
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            FeatureKind::Vibrate => "vibrate",
            FeatureKind::Rotate => "rotate",
            FeatureKind::Oscillate => "oscillate",
            FeatureKind::Constrict => "constrict",
            FeatureKind::Position | FeatureKind::TimedPosition => "position",
            FeatureKind::Spray => "spray",
            FeatureKind::Temperature => "temperature",
            FeatureKind::Led => "led",
        }
    }

    fn is_position(self) -> bool {
        matches!(self, FeatureKind::Position | FeatureKind::TimedPosition)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToyFeature {
    pub index: u32,
    pub kind: FeatureKind,

    pub description: String,

    pub signed: bool,
}


#[derive(Clone, Debug, PartialEq)]
pub struct ToyInfo {
    pub index: u32,
    pub name: String,

    pub address: String,
    pub features: Vec<ToyFeature>,
    pub battery: Option<u8>,

    pub bound: bool,
}




pub fn default_axis(f: &ToyFeature) -> Option<Axis> {
    match f.kind {
        FeatureKind::Position
        | FeatureKind::TimedPosition
        | FeatureKind::Vibrate
        | FeatureKind::Oscillate => Some(Axis::L0),
        FeatureKind::Rotate => Some(if f.signed { Axis::R0 } else { Axis::L0 }),
        FeatureKind::Constrict => Some(Axis::A1),
        FeatureKind::Spray => Some(Axis::A2),
        FeatureKind::Temperature | FeatureKind::Led => None,
    }
}



pub fn follows_speed(f: &ToyFeature, axis: Axis) -> bool {
    if f.kind.is_position() || (f.kind == FeatureKind::Rotate && f.signed) {
        return false;
    }
    matches!(
        axis.kind(),
        Kind::Position | Kind::Rotation | Kind::EstimPosition
    )
}


enum DevCmd {
    Output(u32, ClientDeviceOutputCommand),
    Stop,
}

enum Cmd {
    Scan(bool),
}

struct Entry {
    info: ToyInfo,
    tx: UnboundedSender<DevCmd>,
}

#[derive(Default)]
struct State {
    devices: BTreeMap<u32, Entry>,
    bound: HashSet<u32>,
    wizard_scanning: bool,


    waiting: Vec<String>,

    error: Option<String>,
}

impl State {
    fn want_scan(&self) -> bool {
        self.wizard_scanning || !self.waiting.is_empty()
    }
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

pub struct Hub {
    shared: Arc<Shared>,
    tx: UnboundedSender<Cmd>,
}

static HUB: OnceLock<Hub> = OnceLock::new();


pub fn hub() -> &'static Hub {
    HUB.get_or_init(Hub::start)
}

impl Hub {
    fn start() -> Hub {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
        });
        let (tx, rx) = unbounded_channel();
        let s = shared.clone();
        let spawned = thread::Builder::new()
            .name("bp-toys".into())
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => return s.fail(format!("runtime: {e}")),
                };
                let outcome = rt.block_on(run(s.clone(), rx));
                s.fail(
                    outcome
                        .err()
                        .unwrap_or_else(|| "server stopped".to_string()),
                );
            });
        if let Err(e) = spawned {
            shared.fail(format!("thread: {e}"));
        }
        Hub { shared, tx }
    }

    fn push_scan(&self, state: &State) {
        let _ = self.tx.send(Cmd::Scan(state.want_scan()));
    }


    pub fn set_wizard_scanning(&self, on: bool) {
        let mut s = self.shared.state.lock().unwrap();
        if s.wizard_scanning != on {
            s.wizard_scanning = on;
            self.push_scan(&s);
        }
    }

    pub fn devices(&self) -> Vec<ToyInfo> {
        let s = self.shared.state.lock().unwrap();
        s.devices
            .values()
            .map(|e| ToyInfo {
                bound: s.bound.contains(&e.info.index),
                ..e.info.clone()
            })
            .collect()
    }

    pub fn error(&self) -> Option<String> {
        self.shared.state.lock().unwrap().error.clone()
    }



    pub fn bind(
        &'static self,
        address: &str,
        name: &str,
        timeout: Duration,
    ) -> io::Result<ToyLink> {
        let deadline = Instant::now() + timeout;
        let mut s = self.shared.state.lock().unwrap();
        s.waiting.push(address.to_string());
        self.push_scan(&s);
        let found = loop {
            if let Some(e) = &s.error {
                break Err(io::Error::other(e.clone()));
            }
            if let Some(index) = pick(&s, address, name) {
                s.bound.insert(index);
                break Ok(s.devices[&index].info.clone());
            }
            let now = Instant::now();
            if now >= deadline {
                break Err(io::Error::new(
                    ErrorKind::TimedOut,
                    format!(
                        "{} not found; is it on?",
                        if name.is_empty() { address } else { name }
                    ),
                ));
            }
            s = self
                .shared
                .changed
                .wait_timeout(s, deadline - now)
                .unwrap()
                .0;
        };
        if let Some(i) = s.waiting.iter().position(|a| a == address) {
            s.waiting.swap_remove(i);
        }
        self.push_scan(&s);
        drop(s);
        let info = found?;
        let n = info.features.len();
        Ok(ToyLink {
            hub: self,
            info,
            axes: vec![None; n],
            last: vec![None; n],
            speed: [0.0; Axis::COUNT],
            prev: [None; Axis::COUNT],
            since_send_ms: 0.0,
            moved: false,
            glide_until: None,
        })
    }

    fn release(&self, index: u32) {
        let mut s = self.shared.state.lock().unwrap();
        s.bound.remove(&index);
        if let Some(e) = s.devices.get(&index) {
            let _ = e.tx.send(DevCmd::Stop);
        }
        self.shared.changed.notify_all();
    }

    fn send(&self, index: u32, feature: u32, cmd: ClientDeviceOutputCommand) -> io::Result<()> {
        let s = self.shared.state.lock().unwrap();
        let e = s
            .devices
            .get(&index)
            .ok_or_else(|| io::Error::new(ErrorKind::ConnectionAborted, "disconnected"))?;
        e.tx.send(DevCmd::Output(feature, cmd))
            .map_err(|_| io::Error::new(ErrorKind::ConnectionAborted, "disconnected"))
    }
}

impl Shared {
    fn fail(&self, message: String) {
        let mut s = self.state.lock().unwrap();
        s.error = Some(message);
        s.devices.clear();
        self.changed.notify_all();
    }
}



fn pick(s: &State, address: &str, name: &str) -> Option<u32> {
    let free = || {
        s.devices
            .values()
            .filter(|e| !s.bound.contains(&e.info.index))
    };
    if !address.is_empty() {
        if let Some(e) = free().find(|e| e.info.address == address) {
            return Some(e.info.index);
        }
    }
    if name.is_empty() {
        return None;
    }
    let wanted = |a: &str| !a.is_empty() && s.waiting.iter().any(|w| w == a);
    free()
        .find(|e| e.info.name.eq_ignore_ascii_case(name) && !wanted(&e.info.address))
        .map(|e| e.info.index)
}



async fn run(shared: Arc<Shared>, mut rx: UnboundedReceiver<Cmd>) -> Result<(), String> {
    let dcm = DeviceConfigurationManagerBuilder::default()
        .finish()
        .map_err(|e| format!("device config: {e}"))?;
    let mut dmb = ServerDeviceManagerBuilder::new(dcm);
    dmb.comm_manager(BtlePlugCommunicationManagerBuilder::default());
    let dm = Arc::new(dmb.finish().map_err(|e| format!("device manager: {e}"))?);
    let server = ButtplugServerBuilder::with_shared_device_manager(dm.clone())
        .name("Better Player")
        .finish()
        .map_err(|e| format!("server: {e}"))?;
    let connector = ButtplugInProcessClientConnectorBuilder::default()
        .server(server)
        .finish();
    let client = ButtplugClient::new("Better Player");
    let mut events = client.event_stream();
    client
        .connect(connector)
        .await
        .map_err(|e| format!("connect: {e}"))?;
    let mut scanning = false;
    loop {
        tokio::select! {
            ev = events.next() => match ev {
                Some(ButtplugClientEvent::DeviceAdded(d)) => add_device(&shared, &dm, d),
                Some(ButtplugClientEvent::DeviceRemoved(d)) => remove_device(&shared, d.index()),

                Some(ButtplugClientEvent::ScanningFinished) if scanning => {
                    let _ = client.start_scanning().await;
                }
                Some(ButtplugClientEvent::ServerDisconnect) | None => return Err("server stopped".into()),
                Some(_) => {}
            },
            cmd = rx.recv() => match cmd {
                Some(Cmd::Scan(on)) if on != scanning => {
                    scanning = on;
                    let r = if on { client.start_scanning().await } else { client.stop_scanning().await };



                    let mut s = shared.state.lock().unwrap();
                    match r {
                        Ok(()) => s.error = None,
                        Err(e) => {
                            scanning = false;
                            s.error = Some(format!("scan: {e}"));
                        }
                    }
                    drop(s);
                    shared.changed.notify_all();
                }
                Some(Cmd::Scan(_)) => {}
                None => return Ok(()),
            },
        }
    }
}

fn features_of(d: &ButtplugClientDevice) -> Vec<ToyFeature> {
    d.device_features()
        .values()
        .filter_map(|cf| {
            let f = cf.feature();
            let (_, kind) = FeatureKind::ALL.iter().find(|(t, _)| f.contains_output(*t))?;
            let signed = matches!(f.get_output(OutputType::Rotate), Some(DeviceFeatureOutput::Rotate(p)) if p.value().start() < 0);
            Some(ToyFeature { index: f.feature_index(), kind: *kind, description: f.description().clone(), signed })
        })
        .collect()
}

fn add_device(shared: &Arc<Shared>, dm: &ServerDeviceManager, d: ButtplugClientDevice) {
    let address = dm
        .device_info(d.index())
        .map(|i| i.identifier().address().clone())
        .unwrap_or_default();
    let name = d
        .display_name()
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| d.name().clone());
    let info = ToyInfo {
        index: d.index(),
        name,
        address,
        features: features_of(&d),
        battery: None,
        bound: false,
    };
    let (tx, rx) = unbounded_channel();
    tokio::spawn(device_task(d, rx, shared.clone()));
    let mut s = shared.state.lock().unwrap();
    s.error = None;
    s.devices.insert(info.index, Entry { info, tx });
    shared.changed.notify_all();
}

fn remove_device(shared: &Arc<Shared>, index: u32) {
    let mut s = shared.state.lock().unwrap();
    s.devices.remove(&index);
    shared.changed.notify_all();
}




async fn device_task(
    device: ButtplugClientDevice,
    mut rx: UnboundedReceiver<DevCmd>,
    shared: Arc<Shared>,
) {
    let has_battery = device.input_available(InputType::Battery);
    let mut next_battery = tokio::time::Instant::now();
    loop {
        let first = if has_battery {
            tokio::select! {
                c = rx.recv() => c,

                _ = tokio::time::sleep_until(next_battery) => {
                    next_battery += BATTERY_EVERY;
                    let (device, shared) = (device.clone(), shared.clone());
                    tokio::spawn(async move {
                        if let Ok(level) = device.battery().await {
                            let mut s = shared.state.lock().unwrap();
                            if let Some(e) = s.devices.get_mut(&device.index()) {
                                e.info.battery = Some(level.min(100) as u8);
                            }
                        }
                    });
                    continue;
                }
            }
        } else {
            rx.recv().await
        };
        let Some(first) = first else { break };
        let mut latest: BTreeMap<u32, ClientDeviceOutputCommand> = BTreeMap::new();
        let mut stop = false;
        let mut take = |c: DevCmd| match c {
            DevCmd::Output(f, cmd) => {
                latest.insert(f, cmd);
            }
            DevCmd::Stop => {
                latest.clear();
                stop = true;
            }
        };
        take(first);
        while let Ok(c) = rx.try_recv() {
            take(c);
        }
        if stop {
            let _ = device.stop().await;
        }
        for (index, cmd) in latest {
            if let Some(f) = device.device_features().get(&index) {


                let _ = f.run_output(&cmd).await;
            }
        }
    }
}


pub struct ToyLink {
    hub: &'static Hub,
    pub info: ToyInfo,

    axes: Vec<Option<Axis>>,

    last: Vec<Option<i32>>,
    speed: [f64; Axis::COUNT],
    prev: [Option<f64>; Axis::COUNT],
    since_send_ms: f64,


    moved: bool,
    glide_until: Option<Instant>,
}

impl ToyLink {

    pub fn alive(&self) -> bool {
        self.hub
            .shared
            .state
            .lock()
            .unwrap()
            .devices
            .contains_key(&self.info.index)
    }

    pub fn battery(&self) -> Option<u8> {
        self.hub
            .shared
            .state
            .lock()
            .unwrap()
            .devices
            .get(&self.info.index)
            .and_then(|e| e.info.battery)
    }



    pub fn set_axes(&mut self, overrides: &HashMap<u32, Option<Axis>>) {
        self.axes = self
            .info
            .features
            .iter()
            .map(|f| {
                overrides
                    .get(&f.index)
                    .copied()
                    .unwrap_or_else(|| default_axis(f))
            })
            .collect();
    }


    pub fn axes(&self) -> impl Iterator<Item = (&ToyFeature, Option<Axis>)> {
        self.info.features.iter().zip(self.axes.iter().copied())
    }

    fn track_speed(&mut self, values: &[f64; Axis::COUNT], interval_ms: u32) {
        let dt = interval_ms.max(1) as f64;
        let alpha = dt / (SPEED_TAU_MS + dt);
        for i in 0..Axis::COUNT {
            let v = values[i].clamp(0.0, 1.0);
            if let Some(p) = self.prev[i] {
                let inst = (v - p).abs() * 1000.0 / dt;
                self.speed[i] += (inst - self.speed[i]) * alpha;
            }
            self.prev[i] = Some(v);
        }
    }


    fn raw(&self, f: &ToyFeature, axis: Axis, values: &[f64; Axis::COUNT]) -> f64 {
        if follows_speed(f, axis) {
            (self.speed[axis.index()] / SPEED_FULL).min(1.0)
        } else {
            values[axis.index()].clamp(0.0, 1.0)
        }
    }



    pub fn send(
        &mut self,
        values: &[f64; Axis::COUNT],
        clamps: &[AxisClamp; Axis::COUNT],
        interval_ms: u32,
    ) -> io::Result<bool> {
        self.track_speed(values, interval_ms);
        self.since_send_ms += interval_ms as f64;
        if self.since_send_ms < SEND_EVERY_MS {
            return Ok(false);
        }
        let duration = self.since_send_ms.round() as u32;
        self.since_send_ms = 0.0;
        let now = Instant::now();
        let gliding = self.glide_until.is_some_and(|t| now < t);
        let mut sent = false;
        for i in 0..self.info.features.len() {
            let f = &self.info.features[i];
            let driven = self.axes[i].filter(|a| clamps[a.index()].enabled).map(|a| {
                let c = clamps[a.index()];
                (c.min + self.raw(f, a, values) * (c.max - c.min)).clamp(0.0, 1.0)
            });
            let v = match driven {
                Some(v) => v,
                None if self.last[i].is_some() => match rest(f) {
                    Some(r) => r,
                    None => continue,
                },
                None => continue,
            };
            let timed = f.kind == FeatureKind::TimedPosition;
            if timed && gliding {
                continue;
            }
            let first = timed && !self.moved;
            let (unit, cmd) = command(f, v, if first { CONNECT_GLIDE_MS } else { duration });
            if self.last[i] == Some(unit) {
                continue;
            }
            if first {
                self.moved = true;
                self.glide_until = Some(now + Duration::from_millis(CONNECT_GLIDE_MS as u64));
            }
            self.last[i] = Some(unit);
            self.hub.send(self.info.index, f.index, cmd)?;
            sent = true;
        }
        Ok(sent)
    }
}



fn rest(f: &ToyFeature) -> Option<f64> {
    match f.kind {
        FeatureKind::Position | FeatureKind::TimedPosition => None,
        FeatureKind::Rotate if f.signed => Some(0.5),
        _ => Some(0.0),
    }
}



fn command(f: &ToyFeature, v: f64, duration: u32) -> (i32, ClientDeviceOutputCommand) {
    use ClientDeviceCommandValue::Percent;
    use ClientDeviceOutputCommand as C;
    let cmd = match f.kind {
        FeatureKind::TimedPosition => C::HwPositionWithDuration(Percent(v), duration),
        FeatureKind::Position => C::Position(Percent(v)),
        FeatureKind::Rotate if f.signed => {
            let s = ((v - 0.5) * 2.0).clamp(-1.0, 1.0);
            return (per_mille(s), C::Rotate(Percent(s)));
        }
        FeatureKind::Rotate => C::Rotate(Percent(v)),
        FeatureKind::Vibrate => C::Vibrate(Percent(v)),
        FeatureKind::Oscillate => C::Oscillate(Percent(v)),
        FeatureKind::Constrict => C::Constrict(Percent(v)),
        FeatureKind::Spray => C::Spray(Percent(v)),
        FeatureKind::Temperature => C::Temperature(Percent(v)),
        FeatureKind::Led => C::Led(Percent(v)),
    };
    (per_mille(v), cmd)
}

fn per_mille(v: f64) -> i32 {
    (v * 1000.0).round() as i32
}

impl Drop for ToyLink {
    fn drop(&mut self) {
        self.hub.release(self.info.index);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feature(kind: FeatureKind, signed: bool) -> ToyFeature {
        ToyFeature {
            index: 0,
            kind,
            description: String::new(),
            signed,
        }
    }

    #[test]
    fn defaults_follow_the_stroke_except_two_way_rotation() {
        assert_eq!(
            default_axis(&feature(FeatureKind::TimedPosition, false)),
            Some(Axis::L0)
        );
        assert_eq!(
            default_axis(&feature(FeatureKind::Vibrate, false)),
            Some(Axis::L0)
        );
        assert_eq!(
            default_axis(&feature(FeatureKind::Rotate, true)),
            Some(Axis::R0)
        );
        assert_eq!(
            default_axis(&feature(FeatureKind::Rotate, false)),
            Some(Axis::L0)
        );
        assert_eq!(default_axis(&feature(FeatureKind::Led, false)), None);
    }

    #[test]
    fn intensities_take_speed_on_position_axes_and_value_elsewhere() {
        let vibe = feature(FeatureKind::Vibrate, false);
        assert!(follows_speed(&vibe, Axis::L0));
        assert!(follows_speed(&vibe, Axis::R1));
        assert!(!follows_speed(&vibe, Axis::V0));
        assert!(!follows_speed(
            &feature(FeatureKind::Position, false),
            Axis::L0
        ));
        assert!(!follows_speed(
            &feature(FeatureKind::Rotate, true),
            Axis::R0
        ));
        assert!(follows_speed(
            &feature(FeatureKind::Rotate, false),
            Axis::L0
        ));
    }

    #[test]
    fn a_full_stroke_every_half_second_is_full_speed() {
        let mut link = ToyLink {
            hub: hub_for_tests(),
            info: ToyInfo {
                index: 0,
                name: String::new(),
                address: String::new(),
                features: Vec::new(),
                battery: None,
                bound: false,
            },
            axes: Vec::new(),
            last: Vec::new(),
            speed: [0.0; Axis::COUNT],
            prev: [None; Axis::COUNT],
            since_send_ms: 0.0,
            moved: false,
            glide_until: None,
        };


        let mut values = [0.5; Axis::COUNT];
        let mut t = 0.0;
        for _ in 0..200 {
            t += 0.01;
            values[Axis::L0.index()] = 0.5 + 0.5 * (t * std::f64::consts::TAU * 2.0).sin();
            link.track_speed(&values, 10);
        }
        let s = link.speed[Axis::L0.index()];
        assert!((s - SPEED_FULL).abs() < 0.6, "speed {s}");
        assert_eq!(link.speed[Axis::L1.index()], 0.0);
    }

    fn toy(index: u32, address: &str, features: Vec<ToyFeature>) -> ToyInfo {
        ToyInfo {
            index,
            name: "Hush".into(),
            address: address.into(),
            features,
            battery: None,
            bound: false,
        }
    }

    #[test]
    fn a_name_match_never_takes_a_device_another_output_waits_for() {
        let (tx, _rx) = unbounded_channel();
        let mut s = State::default();
        s.devices.insert(
            0,
            Entry {
                info: toy(0, "X", Vec::new()),
                tx,
            },
        );

        s.waiting = vec!["X".into(), "Y".into()];
        assert_eq!(pick(&s, "Y", "Hush"), None);
        assert_eq!(pick(&s, "X", "Hush"), Some(0));

        s.waiting = vec!["Z".into()];
        assert_eq!(pick(&s, "Z", "Hush"), Some(0));
        s.bound.insert(0);
        assert_eq!(pick(&s, "Z", "Hush"), None);
    }

    #[test]
    fn a_feature_switched_off_rests_at_zero() {
        let hub = hub_for_tests();
        let (tx, mut rx) = unbounded_channel();
        let vibe = ToyFeature {
            index: 3,
            kind: FeatureKind::Vibrate,
            description: String::new(),
            signed: false,
        };
        let info = toy(7, "V", vec![vibe]);
        hub.shared.state.lock().unwrap().devices.insert(
            7,
            Entry {
                info: info.clone(),
                tx,
            },
        );
        let mut link = ToyLink {
            hub,
            info,
            axes: vec![None],
            last: vec![None],
            speed: [0.0; Axis::COUNT],
            prev: [None; Axis::COUNT],
            since_send_ms: 0.0,
            moved: false,
            glide_until: None,
        };
        let clamps = [AxisClamp {
            enabled: true,
            min: 0.0,
            max: 1.0,
        }; Axis::COUNT];
        let mut values = [0.0; Axis::COUNT];

        assert!(!link.send(&values, &clamps, 100).unwrap());

        link.set_axes(&HashMap::from([(3, Some(Axis::A0))]));
        values[Axis::A0.index()] = 0.6;
        assert!(link.send(&values, &clamps, 100).unwrap());
        assert!(
            matches!(rx.try_recv(), Ok(DevCmd::Output(3, ClientDeviceOutputCommand::Vibrate(ClientDeviceCommandValue::Percent(v)))) if (v - 0.6).abs() < 1e-9)
        );

        link.set_axes(&HashMap::from([(3, None)]));
        assert!(link.send(&values, &clamps, 100).unwrap());
        assert!(
            matches!(rx.try_recv(), Ok(DevCmd::Output(3, ClientDeviceOutputCommand::Vibrate(ClientDeviceCommandValue::Percent(v)))) if v == 0.0)
        );
        assert!(!link.send(&values, &clamps, 100).unwrap());
        assert!(rx.try_recv().is_err());
    }


    fn hub_for_tests() -> &'static Hub {
        static H: OnceLock<Hub> = OnceLock::new();
        H.get_or_init(|| {
            let (tx, _rx) = unbounded_channel();
            Hub {
                shared: Arc::new(Shared {
                    state: Mutex::new(State::default()),
                    changed: Condvar::new(),
                }),
                tx,
            }
        })
    }
}
