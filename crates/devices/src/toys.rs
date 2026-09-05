use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{self, ErrorKind};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use bp_script::{Axis, Kind};
use buttplug_client::device::{ClientDeviceCommandValue, ClientDeviceOutputCommand};
use buttplug_client::{ButtplugClient, ButtplugClientDevice, ButtplugClientEvent};
use buttplug_client_in_process::ButtplugInProcessClientConnectorBuilder;
use buttplug_core::message::{DeviceFeature, DeviceFeatureOutput, InputType, OutputType};
use buttplug_server::ButtplugServerBuilder;
use buttplug_server::device::{ServerDeviceManager, ServerDeviceManagerBuilder};
use buttplug_server_device_config::{
    DeviceConfigurationManager, DeviceConfigurationManagerBuilder, load_protocol_configs,
};
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
const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
pub const TEST_MS: u32 = 3000;



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


pub(crate) enum DevCmd {
    Output(u32, ClientDeviceOutputCommand),
    Stop,
}

enum Cmd {
    Scan(bool),
}

struct Entry {
    info: ToyInfo,
    tx: UnboundedSender<DevCmd>,
    error: Arc<Mutex<Option<String>>>,
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
        let s = self.shared.state.lock().unwrap();
        s.error.clone().or_else(|| {
            s.devices
                .values()
                .find_map(|e| e.error.lock().unwrap().clone())
        })
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
                let entry = s.devices.get_mut(&index).unwrap();
                *entry.error.lock().unwrap() = None;
                break Ok((entry.info.clone(), entry.tx.clone()));
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
        let (info, tx) = found?;
        let n = info.features.len();
        Ok(ToyLink {
            hub: self,
            tx,
            info,
            axes: vec![None; n],
            last: vec![None; n],
            speed: [0.0; Axis::COUNT],
            prev: [None; Axis::COUNT],
            since_send_ms: 0.0,
            glide_until: vec![None; n],
            testing_since: None,
        })
    }

    fn release(&self, index: u32, tx: &UnboundedSender<DevCmd>) {
        let mut s = self.shared.state.lock().unwrap();
        if !s.devices.get(&index).is_some_and(|e| e.tx.same_channel(tx)) {
            return;
        }
        s.bound.remove(&index);
        if let Some(e) = s.devices.get(&index) {
            let _ = e.tx.send(DevCmd::Stop);
        }
        self.shared.changed.notify_all();
    }

    fn send(
        &self,
        index: u32,
        tx: &UnboundedSender<DevCmd>,
        feature: u32,
        cmd: ClientDeviceOutputCommand,
    ) -> io::Result<()> {
        let s = self.shared.state.lock().unwrap();
        let e = s
            .devices
            .get(&index)
            .filter(|e| e.tx.same_channel(tx))
            .ok_or_else(|| io::Error::new(ErrorKind::ConnectionAborted, "disconnected"))?;
        if let Some(error) = &*e.error.lock().unwrap() {
            return Err(io::Error::other(error.clone()));
        }
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
    let mut free = s
        .devices
        .values()
        .filter(|e| !s.bound.contains(&e.info.index));
    if !address.is_empty() {
        return free
            .find(|e| e.info.address == address)
            .map(|e| e.info.index);
    }
    if name.is_empty() {
        return None;
    }
    let mut matches = free
        .filter(|e| e.info.name.eq_ignore_ascii_case(name) && !s.waiting.contains(&e.info.address));
    let first = matches.next()?;
    matches.next().is_none().then_some(first.info.index)
}


fn device_config() -> Result<DeviceConfigurationManager, String> {
    let all = load_protocol_configs(&None, &None, false)
        .map_err(|e| format!("device config: {e}"))?
        .finish()
        .map_err(|e| format!("device config: {e}"))?;
    let mut builder = DeviceConfigurationManagerBuilder::default();
    for (protocol, specifiers) in all.base_communication_specifiers() {
        if protocol != "ossm" {
            builder.communication_specifier(protocol, specifiers);
        }
    }
    for (identifier, definition) in all.base_device_definitions() {
        builder.base_device_definition(identifier, definition.clone());
    }
    builder.finish().map_err(|e| format!("device config: {e}"))
}



async fn run(shared: Arc<Shared>, mut rx: UnboundedReceiver<Cmd>) -> Result<(), String> {
    let dcm = device_config()?;
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
        .filter_map(|cf| feature_of(cf.feature()))
        .collect()
}

fn feature_of(f: &DeviceFeature) -> Option<ToyFeature> {


    let (_, kind) = FeatureKind::ALL.iter().find(|(t, _)| {
        f.get_output_limits(*t)
            .is_some_and(|limits| limits.step_limit().contains(0))
    })?;
    let signed = matches!(f.get_output(OutputType::Rotate), Some(DeviceFeatureOutput::Rotate(p)) if p.value().start() < 0);
    Some(ToyFeature {
        index: f.feature_index(),
        kind: *kind,
        description: f.description().clone(),
        signed,
    })
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
    let error = Arc::new(Mutex::new(None));
    tokio::spawn(device_task(d, rx, shared.clone(), error.clone()));
    let mut s = shared.state.lock().unwrap();
    s.error = None;
    s.devices.insert(info.index, Entry { info, tx, error });
    shared.changed.notify_all();
}

fn remove_device(shared: &Arc<Shared>, index: u32) {
    let mut s = shared.state.lock().unwrap();
    s.devices.remove(&index);
    s.bound.remove(&index);
    shared.changed.notify_all();
}




async fn device_task(
    device: ButtplugClientDevice,
    mut rx: UnboundedReceiver<DevCmd>,
    shared: Arc<Shared>,
    error: Arc<Mutex<Option<String>>>,
) {
    let has_battery = device.input_available(InputType::Battery);
    let mut next_battery = tokio::time::Instant::now();
    loop {
        let first = if has_battery {
            tokio::select! {
                c = rx.recv() => c,

                _ = tokio::time::sleep_until(next_battery) => {
                    next_battery += BATTERY_EVERY;
                    let (device, shared, error) = (device.clone(), shared.clone(), error.clone());
                    tokio::spawn(async move {
                        if let Ok(Ok(level)) = tokio::time::timeout(COMMAND_TIMEOUT, device.battery()).await {
                            let mut s = shared.state.lock().unwrap();
                            if let Some(e) = s.devices.get_mut(&device.index()).filter(|e| Arc::ptr_eq(&e.error, &error)) {
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
            if let Err(e) = command_result(device.stop()).await {
                record_failure(&shared, &error, &mut rx, format!("stop: {e}"));
                continue;
            }
        }
        for (index, cmd) in latest {
            if let Some(f) = device.device_features().get(&index) {
                if let Err(e) = command_result(f.run_output(&cmd)).await {
                    record_failure(&shared, &error, &mut rx, format!("write: {e}"));
                    if let Err(stop_error) = command_result(device.stop()).await {
                        *error.lock().unwrap() = Some(format!("write: {e}; stop: {stop_error}"));
                    }
                    break;
                }
            }
        }
    }
}

async fn command_result(
    command: impl std::future::Future<Output = Result<(), buttplug_client::ButtplugClientError>>,
) -> Result<(), String> {
    tokio::time::timeout(COMMAND_TIMEOUT, command)
        .await
        .map_err(|_| "device command timed out".to_string())?
        .map_err(|e| e.to_string())
}


fn record_failure(
    shared: &Shared,
    error: &Mutex<Option<String>>,
    rx: &mut UnboundedReceiver<DevCmd>,
    message: String,
) {
    let _state = shared.state.lock().unwrap();
    *error.lock().unwrap() = Some(message);
    while rx.try_recv().is_ok() {}
    shared.changed.notify_all();
}


pub struct ToyLink {
    hub: &'static Hub,
    tx: UnboundedSender<DevCmd>,
    pub info: ToyInfo,

    axes: Vec<Option<Axis>>,

    last: Vec<Option<i32>>,
    speed: [f64; Axis::COUNT],
    prev: [Option<f64>; Axis::COUNT],
    since_send_ms: f64,

    glide_until: Vec<Option<Instant>>,
    testing_since: Option<Instant>,
}

impl ToyLink {
    pub fn error(&self) -> Option<String> {
        let s = self.hub.shared.state.lock().unwrap();
        match s
            .devices
            .get(&self.info.index)
            .filter(|e| e.tx.same_channel(&self.tx))
        {
            Some(e) => e.error.lock().unwrap().clone(),
            None => Some("disconnected".into()),
        }
    }


    pub fn test(&mut self) {
        self.testing_since = Some(Instant::now());
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
        active: &[bool; Axis::COUNT],
    ) -> io::Result<bool> {
        self.track_speed(values, interval_ms);
        for i in 0..Axis::COUNT {
            if !active[i] {
                self.speed[i] = 0.0;
                self.prev[i] = None;
            }
        }
        self.since_send_ms += interval_ms as f64;
        if self.since_send_ms < SEND_EVERY_MS {
            return Ok(false);
        }
        let duration = self.since_send_ms.round() as u32;
        self.since_send_ms = 0.0;
        let now = Instant::now();
        let test = self
            .testing_since
            .map(|start| now.duration_since(start).as_millis() as u32);
        let finishing_test = test.is_some_and(|ms| ms >= TEST_MS);
        if finishing_test {
            self.testing_since = None;
        }
        let testing = test.filter(|ms| *ms < TEST_MS);
        let mut sent = false;
        for i in 0..self.info.features.len() {
            let f = &self.info.features[i];
            let testable = !matches!(
                f.kind,
                FeatureKind::Temperature | FeatureKind::Led | FeatureKind::Spray
            );
            let driven = self.axes[i]
                .filter(|a| clamps[a.index()].enabled)
                .and_then(|a| {
                    let c = clamps[a.index()];
                    let raw = if let Some(ms) = testing.filter(|_| testable) {
                        let phase = ms as f64 / TEST_MS as f64 * std::f64::consts::TAU;
                        if f.kind.is_position() || (f.kind == FeatureKind::Rotate && f.signed) {
                            0.5 - 0.2 * phase.sin()
                        } else {
                            0.2 * (phase / 2.0).sin().max(0.0)
                        }
                    } else if (finishing_test && testable) || !active[a.index()] {
                        return None;
                    } else {
                        self.raw(f, a, values)
                    };

                    if !f.kind.is_position()
                        && !(f.kind == FeatureKind::Rotate && f.signed)
                        && raw <= 0.0
                    {
                        return Some(0.0);
                    }
                    Some((c.min + raw * (c.max - c.min)).clamp(0.0, 1.0))
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
            if timed && self.glide_until[i].is_some_and(|t| now < t) {
                continue;
            }
            let first = timed && self.glide_until[i].is_none();
            let (unit, cmd) = command(f, v, if first { CONNECT_GLIDE_MS } else { duration });
            if self.last[i] == Some(unit) {
                continue;
            }
            self.hub.send(self.info.index, &self.tx, f.index, cmd)?;
            if first {
                self.glide_until[i] = Some(now + Duration::from_millis(CONNECT_GLIDE_MS as u64));
            }
            self.last[i] = Some(unit);
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
        self.hub.release(self.info.index, &self.tx);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;


    pub(crate) fn fixture(kinds: &[FeatureKind]) -> (ToyLink, UnboundedReceiver<DevCmd>) {
        let (tx, _rx) = unbounded_channel();
        let hub = Box::leak(Box::new(Hub {
            shared: Arc::new(Shared {
                state: Mutex::new(State::default()),
                changed: Condvar::new(),
            }),
            tx,
        }));
        let (tx, rx) = unbounded_channel();
        let info = ToyInfo {
            index: 42,
            name: "Same name".into(),
            address: "A".into(),
            battery: None,
            bound: false,
            features: kinds
                .iter()
                .enumerate()
                .map(|(i, kind)| ToyFeature {
                    index: i as u32,
                    kind: *kind,
                    signed: *kind == FeatureKind::Rotate,
                    description: String::new(),
                })
                .collect(),
        };
        hub.shared.state.lock().unwrap().devices.insert(
            42,
            Entry {
                info,
                tx,
                error: Arc::new(Mutex::new(None)),
            },
        );
        let mut link = hub.bind("A", "Same name", Duration::ZERO).unwrap();
        link.set_axes(&HashMap::new());
        (link, rx)
    }

    pub(crate) fn output_value(rx: &mut UnboundedReceiver<DevCmd>) -> (u32, f64) {
        let DevCmd::Output(index, cmd) = rx.try_recv().expect("output command") else {
            panic!("unexpected stop")
        };
        use ClientDeviceOutputCommand as C;
        let value = match cmd {
            C::Vibrate(v)
            | C::Rotate(v)
            | C::Oscillate(v)
            | C::Constrict(v)
            | C::Position(v)
            | C::HwPositionWithDuration(v, _)
            | C::Spray(v)
            | C::Temperature(v)
            | C::Led(v) => v,
        };
        let ClientDeviceCommandValue::Percent(value) = value else {
            panic!("expected percent")
        };
        (index, value)
    }

    #[test]
    fn bundled_protocols_are_loaded_and_ossm_is_excluded() {
        let config = device_config().unwrap();
        let protocols = config.base_communication_specifiers();
        for name in ["lovense", "kiiroo-v2", "svakom-sam", "vorze-sa"] {
            assert!(protocols.contains_key(name), "missing {name}");
        }
        assert!(!protocols.contains_key("ossm"));
        assert!(!config.base_device_definitions().is_empty());
    }

    #[test]
    fn positive_minimum_heaters_are_not_offered_as_controllable_features() {
        let heater = |min| {
            serde_json::from_value::<DeviceFeature>(serde_json::json!({
                "FeatureIndex": 2,
                "Output": { "Temperature": { "Value": [min, 42] } }
            }))
            .unwrap()
        };
        assert!(feature_of(&heater(37)).is_none());
        let supported = feature_of(&heater(0)).unwrap();
        assert_eq!(supported.kind, FeatureKind::Temperature);
        assert_eq!(default_axis(&supported), None);
    }

    #[tokio::test]
    async fn embedded_server_accepts_commands_for_simulated_toy_families() {
        tokio::time::timeout(Duration::from_secs(5), async {
            use buttplug_server_device_config::SimulatedDeviceConfigEntry;
            let mut config = load_protocol_configs(&None, &None, false).unwrap();
            config.simulated_devices(
                [
                    "simulated-1vibe",
                    "simulated-2vibe",
                    "simulated-rotator",
                    "simulated-oscillator",
                    "simulated-stroker",
                ]
                .into_iter()
                .map(|name| SimulatedDeviceConfigEntry::new(name, None))
                .collect(),
            );
            let mut manager = ServerDeviceManagerBuilder::new(config.finish().unwrap());
            manager
                .add_simulated_devices_if_configured()
                .emit_output_observations(true);
            let manager = Arc::new(manager.finish().unwrap());
            let mut observations = Box::pin(manager.output_observation_stream().unwrap());
            let server = ButtplugServerBuilder::with_shared_device_manager(manager.clone())
                .finish()
                .unwrap();
            let connector = ButtplugInProcessClientConnectorBuilder::default()
                .server(server)
                .finish();
            let client = ButtplugClient::new("toy regression test");
            let mut events = client.event_stream();
            client.connect(connector).await.unwrap();
            let (placeholder, _rx) = fixture(&[]);
            let hub = placeholder.hub;
            drop(placeholder);
            hub.shared.state.lock().unwrap().devices.clear();
            client.start_scanning().await.unwrap();
            while hub.devices().len() < 5 {
                if let Some(ButtplugClientEvent::DeviceAdded(device)) = events.next().await {
                    add_device(&hub.shared, &manager, device);
                }
            }
            let mut links = Vec::new();
            let mut expected = HashMap::new();
            for info in hub.devices() {
                let mut link = hub.bind(&info.address, &info.name, Duration::ZERO).unwrap();
                let overrides = info
                    .features
                    .iter()
                    .map(|f| (f.index, Some(Axis::V0)))
                    .collect();
                link.set_axes(&overrides);
                for feature in &info.features {
                    let raw = if feature.signed {
                        -50.0
                    } else if feature.kind.is_position() {
                        250.0
                    } else {
                        25.0
                    };
                    expected.insert((info.index, feature.index), raw);
                }
                link.send(
                    &[0.25; Axis::COUNT],
                    &[AxisClamp::default(); Axis::COUNT],
                    100,
                    &[true; Axis::COUNT],
                )
                .unwrap();
                links.push(link);
            }
            assert_eq!(expected.len(), 6, "dual-motor toy exposes both motors");
            while !expected.is_empty() {
                let seen = observations.next().await.unwrap();
                let value = expected
                    .remove(&(seen.device_index, seen.feature_index))
                    .expect("expected feature");
                assert!(
                    (seen.value - value).abs() < 0.001,
                    "{}: {} != {value}",
                    seen.output_type,
                    seen.value
                );
            }
            assert_eq!(hub.error(), None);
            drop(links);
            client.disconnect().await.unwrap();
        })
        .await
        .expect("simulated toy commands completed");
    }

    #[test]
    fn address_never_falls_back_and_name_must_be_unique() {
        let (link, _rx) = fixture(&[]);
        let mut state = link.hub.shared.state.lock().unwrap();
        state.bound.clear();
        state.waiting = vec!["B".into()];
        assert_eq!(pick(&state, "B", "Same name"), None);
        assert_eq!(pick(&state, "A", "Same name"), Some(42));
        state.waiting.clear();
        assert_eq!(pick(&state, "", "Same name"), Some(42));
        let (tx, _rx) = unbounded_channel();
        state.devices.insert(
            43,
            Entry {
                info: ToyInfo {
                    index: 43,
                    address: "B".into(),
                    ..link.info.clone()
                },
                tx,
                error: Arc::new(Mutex::new(None)),
            },
        );
        assert_eq!(pick(&state, "", "Same name"), None);
    }

    #[test]
    fn defaults_and_speed_rule_cover_every_output_kind() {
        for (_, kind) in FeatureKind::ALL {
            let (link, _rx) = fixture(&[kind]);
            let feature = &link.info.features[0];
            let expected = match kind {
                FeatureKind::Rotate => Some(Axis::R0),
                FeatureKind::Constrict => Some(Axis::A1),
                FeatureKind::Spray => Some(Axis::A2),
                FeatureKind::Temperature | FeatureKind::Led => None,
                _ => Some(Axis::L0),
            };
            assert_eq!(default_axis(feature), expected);
            assert_eq!(
                follows_speed(feature, Axis::L0),
                !kind.is_position() && kind != FeatureKind::Rotate
            );
            assert!(!follows_speed(feature, Axis::V0));
        }
    }

    #[test]
    fn stroke_speed_drives_vibration_but_range_minimum_cannot_raise_silence() {
        let (mut link, mut rx) = fixture(&[FeatureKind::Vibrate]);
        let mut clamps = [AxisClamp::default(); Axis::COUNT];
        clamps[Axis::L0.index()].min = 0.3;
        let mut values = [0.5; Axis::COUNT];
        link.send(&values, &clamps, 100, &[true; Axis::COUNT])
            .unwrap();
        assert_eq!(output_value(&mut rx).1, 0.0);
        for tick in 1..=200 {
            values[Axis::L0.index()] =
                0.5 + 0.5 * (tick as f64 * 0.01 * std::f64::consts::TAU * 2.0).sin();
            link.send(&values, &clamps, 10, &[true; Axis::COUNT])
                .unwrap();
        }
        assert!((link.speed[Axis::L0.index()] - SPEED_FULL).abs() < 0.6);
        while rx.try_recv().is_ok() {}
        link.send(&values, &clamps, 100, &[false; Axis::COUNT])
            .unwrap();
        assert_eq!(output_value(&mut rx).1, 0.0);
    }

    #[test]
    fn each_timed_actuator_gets_a_glide_and_holds_it() {
        let (mut link, mut rx) = fixture(&[FeatureKind::TimedPosition, FeatureKind::TimedPosition]);
        link.send(
            &[0.5; Axis::COUNT],
            &[AxisClamp::default(); Axis::COUNT],
            100,
            &[true; Axis::COUNT],
        )
        .unwrap();
        for _ in 0..2 {
            assert!(matches!(
                rx.try_recv(),
                Ok(DevCmd::Output(
                    _,
                    ClientDeviceOutputCommand::HwPositionWithDuration(_, CONNECT_GLIDE_MS)
                ))
            ));
        }
        assert!(
            !link
                .send(
                    &[0.7; Axis::COUNT],
                    &[AxisClamp::default(); Axis::COUNT],
                    100,
                    &[true; Axis::COUNT]
                )
                .unwrap()
        );
    }

    #[test]
    fn all_feature_kinds_rest_when_switched_off() {
        for (_, kind) in FeatureKind::ALL {
            let (mut link, mut rx) = fixture(&[kind]);
            link.set_axes(&HashMap::from([(0, Some(Axis::V0))]));
            link.send(
                &[0.6; Axis::COUNT],
                &[AxisClamp::default(); Axis::COUNT],
                100,
                &[true; Axis::COUNT],
            )
            .unwrap();
            output_value(&mut rx);
            link.set_axes(&HashMap::from([(0, None)]));
            let sent = link
                .send(
                    &[0.6; Axis::COUNT],
                    &[AxisClamp::default(); Axis::COUNT],
                    100,
                    &[true; Axis::COUNT],
                )
                .unwrap();
            assert_eq!(sent, !kind.is_position());
            if sent {
                assert_eq!(output_value(&mut rx).1, 0.0);
            }
        }
    }

    #[test]
    fn cadence_skips_duplicates_and_disabled_axis_stops() {
        let (mut link, mut rx) = fixture(&[FeatureKind::Vibrate]);
        link.set_axes(&HashMap::from([(0, Some(Axis::V0))]));
        let mut clamps = [AxisClamp::default(); Axis::COUNT];
        for _ in 0..9 {
            assert!(
                !link
                    .send(&[0.6; Axis::COUNT], &clamps, 10, &[true; Axis::COUNT])
                    .unwrap()
            );
        }
        assert!(
            link.send(&[0.6; Axis::COUNT], &clamps, 10, &[true; Axis::COUNT])
                .unwrap()
        );
        assert_eq!(output_value(&mut rx).1, 0.6);
        assert!(
            !link
                .send(&[0.6; Axis::COUNT], &clamps, 100, &[true; Axis::COUNT])
                .unwrap()
        );
        clamps[Axis::V0.index()].enabled = false;
        link.send(&[0.6; Axis::COUNT], &clamps, 100, &[true; Axis::COUNT])
            .unwrap();
        assert_eq!(output_value(&mut rx).1, 0.0);
    }

    #[test]
    fn hardware_failure_is_visible_and_pending_values_are_discarded() {
        let (mut link, mut rx) = fixture(&[FeatureKind::Vibrate]);
        link.set_axes(&HashMap::from([(0, Some(Axis::V0))]));
        link.send(
            &[0.6; Axis::COUNT],
            &[AxisClamp::default(); Axis::COUNT],
            100,
            &[true; Axis::COUNT],
        )
        .unwrap();
        let error = link.hub.shared.state.lock().unwrap().devices[&42]
            .error
            .clone();
        record_failure(&link.hub.shared, &error, &mut rx, "write rejected".into());
        assert!(rx.try_recv().is_err());
        assert_eq!(link.error().as_deref(), Some("write rejected"));
        assert_eq!(link.hub.error().as_deref(), Some("write rejected"));
        assert!(
            link.send(
                &[0.7; Axis::COUNT],
                &[AxisClamp::default(); Axis::COUNT],
                100,
                &[true; Axis::COUNT]
            )
            .is_err()
        );
    }

    #[test]
    fn a_disconnected_mailbox_is_reported_without_caching_the_failed_value() {
        let (mut link, rx) = fixture(&[FeatureKind::Vibrate]);
        drop(rx);
        link.set_axes(&HashMap::from([(0, Some(Axis::V0))]));
        for _ in 0..2 {
            assert!(
                link.send(
                    &[0.5; Axis::COUNT],
                    &[AxisClamp::default(); Axis::COUNT],
                    100,
                    &[true; Axis::COUNT]
                )
                .is_err()
            );
        }
    }

    #[test]
    fn drop_stops_and_releases_only_its_own_connection() {
        let (link, mut rx) = fixture(&[]);
        let hub = link.hub;
        drop(link);
        assert!(matches!(rx.try_recv(), Ok(DevCmd::Stop)));
        assert!(!hub.devices()[0].bound);
        let old = hub.bind("A", "Same name", Duration::ZERO).unwrap();
        remove_device(&hub.shared, 42);
        let (tx, mut replacement_rx) = unbounded_channel();
        hub.shared.state.lock().unwrap().devices.insert(
            42,
            Entry {
                info: old.info.clone(),
                tx,
                error: Arc::new(Mutex::new(None)),
            },
        );
        let replacement = hub.bind("A", "Same name", Duration::ZERO).unwrap();
        assert_eq!(old.error().as_deref(), Some("disconnected"));
        drop(old);
        assert!(replacement_rx.try_recv().is_err());
        assert!(hub.devices()[0].bound);
        drop(replacement);
    }

    #[test]
    fn test_sweeps_assigned_motion_features_only_and_stops() {
        let (mut link, mut rx) = fixture(&[
            FeatureKind::Vibrate,
            FeatureKind::Rotate,
            FeatureKind::Constrict,
            FeatureKind::Temperature,
            FeatureKind::Spray,
        ]);
        link.test();
        link.testing_since = Some(Instant::now() - Duration::from_millis(750));
        link.send(
            &[0.5; Axis::COUNT],
            &[AxisClamp::default(); Axis::COUNT],
            100,
            &[false; Axis::COUNT],
        )
        .unwrap();
        for expected in 0..3 {
            assert_eq!(output_value(&mut rx).0, expected);
        }
        assert!(rx.try_recv().is_err());
        link.testing_since = Some(Instant::now() - Duration::from_millis(TEST_MS as u64));
        link.send(
            &[0.5; Axis::COUNT],
            &[AxisClamp::default(); Axis::COUNT],
            100,
            &[false; Axis::COUNT],
        )
        .unwrap();
        for expected in 0..3 {
            assert_eq!(output_value(&mut rx), (expected, 0.0));
        }
        assert!(rx.try_recv().is_err());
    }
}
