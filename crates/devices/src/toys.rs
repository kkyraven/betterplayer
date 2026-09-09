//! Bluetooth toys through an embedded Buttplug server: one server and client for the process,
//! on their own tokio runtime thread, started on first use. The wizard scans through it; a
//! `Toy` output binds one of its devices (`Hub::bind`) and sends it values through `ToyLink`.
//!
//! Buttplug describes a device as features, each with one output (vibrate, rotate, position
//! and so on). Every feature follows one axis or is off; `default_axis` picks the axis until
//! the user changes it. An intensity feature on a position or rotation axis takes that axis's
//! speed (`follows_speed`), so a plain stroke script drives a vibrator; on an intensity axis it
//! takes the value. A position (and a two-way rotate) then goes through the axis's range clamp;
//! a level feature (everything else) goes through its own `LevelMap`: where along the input it
//! starts, where it reaches full, and the floor and cap of what the toy gets.

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

use crate::output::{CONNECT_GLIDE_MS, Keyframe};
use crate::tcode::AxisClamp;

/// How long a connecting output waits for its device before failing (and retrying).
pub const BIND_TIMEOUT: Duration = Duration::from_secs(15);
/// Commands go out at most this often per device, the rate BLE toys cope with.
const SEND_EVERY_MS: f64 = 100.0;
/// A keyframe already sent goes again when its arrival moved by more than this (a seek
/// within its segment, a rate change), not for tick jitter.
const KEYFRAME_SLIP: Duration = Duration::from_millis(40);
/// Axis speed an intensity feature reads as full: lengths of the axis per second.
const SPEED_FULL: f64 = 4.0;
/// Smoothing on the speed, so a 100 ms sample of a 10 ms tick does not flicker.
const SPEED_TAU_MS: f64 = 150.0;
const BATTERY_EVERY: Duration = Duration::from_secs(60);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
pub const TEST_MS: u32 = 3000;

/// What a feature does. Both of Buttplug's position outputs are `position` to the UI; a timed
/// position carries the interval as its duration so motion stays continuous.
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
    /// Buttplug output types in the order a feature is matched: a timed position wins over a
    /// plain one when a feature offers both.
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
    /// Buttplug's description, `Vibrator 1` or empty.
    pub description: String,
    /// A rotate whose range goes below zero turns both ways: direction from the half.
    pub signed: bool,
}

impl ToyFeature {
    /// A level rather than a place: vibrate, oscillate, constrict, spray, a one-way rotate, heat
    /// and light. Positions and a two-way rotate are places and keep the axis's range instead.
    pub fn is_level(&self) -> bool {
        !self.kind.is_position() && !(self.kind == FeatureKind::Rotate && self.signed)
    }
}

/// How a level feature turns its input (the axis's speed or value, 0 to 1) into what the toy
/// gets: nothing up to `from`, `floor` just past it, a straight line to `cap` at `to`, and `cap`
/// beyond. Zero in is always zero out, so a floor never turns silence into stimulation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LevelMap {
    /// Input level the toy starts at; below it the toy is off.
    pub from: f64,
    /// Input level the toy reaches `cap` at.
    pub to: f64,
    /// What the toy gets as it starts.
    pub floor: f64,
    /// The most the toy ever gets.
    pub cap: f64,
}

impl Default for LevelMap {
    fn default() -> LevelMap {
        LevelMap { from: 0.0, to: 1.0, floor: 0.0, cap: 1.0 }
    }
}

impl LevelMap {
    /// Everything within 0 to 1, `to` never below `from` and `cap` never below `floor`.
    pub fn validated(self) -> LevelMap {
        let unit = |v: f64| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 };
        let from = unit(self.from);
        let floor = unit(self.floor);
        LevelMap { from, to: unit(self.to).max(from), floor, cap: unit(self.cap).max(floor) }
    }

    /// The toy's level for an input level.
    pub fn apply(&self, input: f64) -> f64 {
        if input <= self.from || input <= 0.0 {
            return 0.0;
        }
        let span = self.to - self.from;
        let t = if span <= 1e-9 { 1.0 } else { ((input - self.from) / span).clamp(0.0, 1.0) };
        self.scale(t)
    }

    /// The output side alone: `floor` to `cap` over 0 to 1, zero staying zero. The wizard's
    /// test sweep uses this so a raised `from` cannot silence it.
    pub fn scale(&self, t: f64) -> f64 {
        if t <= 0.0 {
            return 0.0;
        }
        (self.floor + t.min(1.0) * (self.cap - self.floor)).clamp(0.0, 1.0)
    }
}

/// A device the embedded server has connected, for the wizard and for binding.
#[derive(Clone, Debug, PartialEq)]
pub struct ToyInfo {
    pub index: u32,
    pub name: String,
    /// The server's identifier: a MAC, or the CoreBluetooth id on macOS.
    pub address: String,
    pub features: Vec<ToyFeature>,
    pub battery: Option<u8>,
    /// Whether an output already drives it.
    pub bound: bool,
}

/// The axis a feature follows until the user picks another: positions and intensities follow
/// the stroke (intensities as its speed), a two-way rotate the twist, constrict suction, spray
/// lube; temperature and lights stay off.
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

/// Whether a feature on an axis takes the axis's speed rather than its value: intensities
/// (and a one-way rotate) on a position or rotation axis do.
pub fn follows_speed(f: &ToyFeature, axis: Axis) -> bool {
    if f.kind.is_position() || (f.kind == FeatureKind::Rotate && f.signed) {
        return false;
    }
    matches!(
        axis.kind(),
        Kind::Position | Kind::Rotation | Kind::EstimPosition
    )
}

/// One command per feature, newest wins; `Stop` releases every output of the device.
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
    /// The address each output waiting in `bind` asked for (empty when it has none); scanning
    /// stays on while any are, and a name match never takes a device one of them wants.
    waiting: Vec<String>,
    /// Why the server is not running: no adapter, no permission, a failed start.
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

/// The process's embedded server, started on the first call.
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

    /// The wizard's Bluetooth panel is open: scan while it is.
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

    /// Waits for this exact address, or a unique name when no address was saved.
    /// Blocks; call it off the tick thread.
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
            levels: vec![LevelMap::default(); n],
            inputs: vec![None; n],
            last: vec![None; n],
            speed: [0.0; Axis::COUNT],
            prev: [None; Axis::COUNT],
            since_send_ms: 0.0,
            glide_until: vec![None; n],
            keyframe: vec![None; n],
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

/// Saved addresses never fall back to names: a different toy must be added explicitly.
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

/// Load the bundled protocols, keeping OSSM exclusively on our dedicated BLE transport.
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

/// Builds the server and client, then serves scan requests and device events until the
/// client disconnects. Runs on the hub's runtime.
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
                // The adapter stopped on its own (a radio reset): pick up again while wanted.
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
                    // A scan the server refuses is the error the UI shows; the next request
                    // tries again, and one that works clears it. Bluetooth being off is not
                    // one: buttplug's manager waits for the adapter and logs the failure.
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
    // Percent commands and off require zero. Some heaters advertise only 37..42 degrees;
    // exposing those would offer an off setting that the protocol cannot send.
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

/// Serves one device: drains its mailbox to the newest command per feature and sends those in
/// turn, so a slow toy falls behind by one command, never a queue. Reads the battery once a
/// minute when the device reports it.
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
                // Read on its own task, so a slow answer never holds up the commands.
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

/// Reject further values before discarding pending writes from the failed connection.
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

/// One bound device. Values arrive every tick; commands leave every 100 ms.
pub struct ToyLink {
    hub: &'static Hub,
    tx: UnboundedSender<DevCmd>,
    pub info: ToyInfo,
    /// The axis each feature follows, by position in `info.features`.
    axes: Vec<Option<Axis>>,
    /// How each level feature maps its input; positions ignore theirs.
    levels: Vec<LevelMap>,
    /// Each feature's input level as of the last tick (before its map), while its axis drives
    /// it; for the UI's live marker.
    inputs: Vec<Option<f64>>,
    /// The last value sent per feature, in thousandths, so unchanged values stay home.
    last: Vec<Option<i32>>,
    speed: [f64; Axis::COUNT],
    prev: [Option<f64>; Axis::COUNT],
    since_send_ms: f64,
    /// Each timed actuator gets its own first-move glide.
    glide_until: Vec<Option<Instant>>,
    /// Per feature, the keyframe last sent (its video time) and when the toy was told to arrive.
    keyframe: Vec<Option<(f64, Instant)>>,
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

    /// Tests only this toy's assigned motion features. Heating, lights and spray stay untouched.
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

    /// Applies the user's axis choices over the defaults. Takes effect on the next send: a
    /// feature switched off rests, one that changed axis follows the new one.
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

    /// The user's level maps over the defaults, by feature index. Takes effect on the next send.
    pub fn set_levels(&mut self, overrides: &HashMap<u32, LevelMap>) {
        self.levels = self
            .info
            .features
            .iter()
            .map(|f| overrides.get(&f.index).copied().unwrap_or_default().validated())
            .collect();
    }

    /// Each feature with the axis it follows and its live input level (None while nothing
    /// drives it, and for a place rather than a level).
    pub fn axes(&self) -> impl Iterator<Item = (&ToyFeature, Option<Axis>, Option<f64>)> {
        self.info
            .features
            .iter()
            .zip(self.axes.iter().copied())
            .zip(self.inputs.iter().copied())
            .map(|((f, a), input)| (f, a, input.filter(|_| f.is_level())))
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

    /// Value a feature takes from its axis before the clamp: the axis's speed or its value.
    fn raw(&self, f: &ToyFeature, axis: Axis, values: &[f64; Axis::COUNT]) -> f64 {
        if follows_speed(f, axis) {
            (self.speed[axis.index()] / SPEED_FULL).min(1.0)
        } else {
            values[axis.index()].clamp(0.0, 1.0)
        }
    }

    /// Sends every feature whose value changed. A feature that is off, or whose axis is
    /// disabled, goes to rest once if it was ever driven. Returns whether anything went out.
    pub fn send(
        &mut self,
        values: &[f64; Axis::COUNT],
        clamps: &[AxisClamp; Axis::COUNT],
        interval_ms: u32,
        active: &[bool; Axis::COUNT],
    ) -> io::Result<bool> {
        self.send_scaled(values, clamps, interval_ms, active, 1.0, None)
    }

    /// As `send`, with the session scale on levels and the stroke's next `keyframe`: a timed
    /// position on L0 is sent one move per keyframe the moment it starts (again if its arrival
    /// slipped), instead of a stop-start sample every 100 ms. Everything else keeps the cadence.
    pub fn send_scaled(
        &mut self,
        values: &[f64; Axis::COUNT],
        clamps: &[AxisClamp; Axis::COUNT],
        interval_ms: u32,
        active: &[bool; Axis::COUNT],
        scale: f64,
        keyframe: Option<Keyframe>,
    ) -> io::Result<bool> {
        self.track_speed(values, interval_ms);
        for i in 0..Axis::COUNT {
            if !active[i] {
                self.speed[i] = 0.0;
                self.prev[i] = None;
            }
        }
        for i in 0..self.info.features.len() {
            let f = &self.info.features[i];
            self.inputs[i] = self.axes[i]
                .filter(|a| clamps[a.index()].enabled && active[a.index()])
                .map(|a| self.raw(f, a, values));
        }
        self.since_send_ms += interval_ms as f64;
        let due = self.since_send_ms >= SEND_EVERY_MS;
        if !due && keyframe.is_none() {
            return Ok(false);
        }
        let duration = self.since_send_ms.round() as u32;
        if due {
            self.since_send_ms = 0.0;
        }
        let now = Instant::now();
        // The test sweep only advances on the cadence, so its finishing rest is never skipped.
        let test = self
            .testing_since
            .filter(|_| due)
            .map(|start| now.duration_since(start).as_millis() as u32);
        let finishing_test = test.is_some_and(|ms| ms >= TEST_MS);
        if finishing_test {
            self.testing_since = None;
        }
        let testing = test.filter(|ms| *ms < TEST_MS);
        let l0 = Axis::L0.index();
        let keyed = keyframe.filter(|_| {
            self.testing_since.is_none() && scale != 0.0 && active[l0] && clamps[l0].enabled
        });
        let mut sent = false;
        for i in 0..self.info.features.len() {
            let f = &self.info.features[i];
            // A timed position on the stroke plays keyframes once its connect glide is over.
            if let Some(k) = keyed.filter(|_| {
                f.kind == FeatureKind::TimedPosition && self.axes[i] == Some(Axis::L0) && self.glide_until[i].is_some()
            }) {
                if self.glide_until[i].is_some_and(|t| now < t) {
                    continue;
                }
                let arrival = now + Duration::from_secs_f64(k.in_ms.max(0.0) / 1000.0);
                if self.keyframe[i].is_some_and(|(at, was)| at == k.at_ms && arrival.saturating_duration_since(was).max(was.saturating_duration_since(arrival)) <= KEYFRAME_SLIP) {
                    continue;
                }
                self.keyframe[i] = Some((k.at_ms, arrival));
                let c = clamps[l0];
                let pos = (c.min + k.pos.clamp(0.0, 1.0) * (c.max - c.min)).clamp(0.0, 1.0);
                let (unit, cmd) = command(f, pos, (k.in_ms.round() as u32).max(1));
                self.hub.send(self.info.index, &self.tx, f.index, cmd)?;
                self.last[i] = Some(unit);
                sent = true;
                continue;
            }
            self.keyframe[i] = None;
            if !due {
                continue;
            }
            let testable = !matches!(
                f.kind,
                FeatureKind::Temperature | FeatureKind::Led | FeatureKind::Spray
            );
            let level = self.levels[i];
            let driven = self.axes[i]
                .filter(|a| clamps[a.index()].enabled)
                .and_then(|a| {
                    let c = clamps[a.index()];
                    if scale == 0.0 { return None; }
                    if let Some(ms) = testing.filter(|_| testable) {
                        let phase = ms as f64 / TEST_MS as f64 * std::f64::consts::TAU;
                        return Some(if f.is_level() {
                            // The sweep shows the toy's own floor and cap, whatever `from` is.
                            level.scale(0.2 * (phase / 2.0).sin().max(0.0))
                        } else {
                            let raw = 0.5 - 0.2 * phase.sin();
                            (c.min + raw * (c.max - c.min)).clamp(0.0, 1.0)
                        });
                    }
                    if (finishing_test && testable) || !active[a.index()] {
                        return None;
                    }
                    let raw = self.raw(f, a, values);
                    Some(if f.is_level() {
                        level.apply(raw) * scale
                    } else {
                        (c.min + raw * (c.max - c.min)).clamp(0.0, 1.0)
                    })
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

/// Where a feature sits when nothing drives it: intensities at zero, a two-way rotate at its
/// middle. Positions have no rest; they stay put.
fn rest(f: &ToyFeature) -> Option<f64> {
    match f.kind {
        FeatureKind::Position | FeatureKind::TimedPosition => None,
        FeatureKind::Rotate if f.signed => Some(0.5),
        _ => Some(0.0),
    }
}

/// The command for a feature at `v` (0 to 1; a two-way rotate maps it to -1 to 1), with the
/// value in thousandths as sent, for skipping repeats.
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

    // An isolated hub per test, with a mailbox in place of physical hardware.
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
    fn stroke_speed_drives_vibration_but_a_level_floor_cannot_raise_silence() {
        let (mut link, mut rx) = fixture(&[FeatureKind::Vibrate]);
        // The stroke's own range is the position's business; the vibe has its own floor.
        let mut clamps = [AxisClamp::default(); Axis::COUNT];
        clamps[Axis::L0.index()].min = 0.3;
        link.set_levels(&HashMap::from([(0, LevelMap { floor: 0.3, ..LevelMap::default() })]));
        let mut values = [0.5; Axis::COUNT];
        link.send(&values, &clamps, 100, &[true; Axis::COUNT])
            .unwrap();
        assert_eq!(output_value(&mut rx).1, 0.0);
        assert_eq!(link.axes().next().unwrap().2, Some(0.0), "a still stroke is a zero input");
        for tick in 1..=200 {
            values[Axis::L0.index()] =
                0.5 + 0.5 * (tick as f64 * 0.01 * std::f64::consts::TAU * 2.0).sin();
            link.send(&values, &clamps, 10, &[true; Axis::COUNT])
                .unwrap();
        }
        assert!((link.speed[Axis::L0.index()] - SPEED_FULL).abs() < 0.6);
        let input = link.axes().next().unwrap().2.unwrap();
        assert!(input > 0.8, "full speed is a full input: {input}");
        while rx.try_recv().is_ok() {}
        link.send(&values, &clamps, 100, &[false; Axis::COUNT])
            .unwrap();
        assert_eq!(output_value(&mut rx).1, 0.0);
        assert_eq!(link.axes().next().unwrap().2, None, "no input while the axis is inactive");
    }

    #[test]
    fn level_map_windows_the_input_and_scales_the_output() {
        let m = LevelMap { from: 0.2, to: 0.6, floor: 0.3, cap: 0.9 };
        assert_eq!(m.apply(0.0), 0.0);
        assert_eq!(m.apply(0.2), 0.0, "off up to and including the start");
        assert!((m.apply(0.21) - 0.315).abs() < 1e-9, "starts at the floor");
        assert!((m.apply(0.4) - 0.6).abs() < 1e-9, "halfway across the window");
        assert!((m.apply(0.6) - 0.9).abs() < 1e-9);
        assert!((m.apply(1.0) - 0.9).abs() < 1e-9, "held at the cap past full");
        let d = LevelMap::default();
        assert_eq!(d.apply(0.0), 0.0);
        assert!((d.apply(0.37) - 0.37).abs() < 1e-9, "the default is the identity");
        // A window with no width is a switch at `from`; the cap is what it switches to.
        let step = LevelMap { from: 0.5, to: 0.5, floor: 0.2, cap: 0.8 };
        assert_eq!(step.apply(0.5), 0.0);
        assert!((step.apply(0.51) - 0.8).abs() < 1e-9);
        let bad = LevelMap { from: 0.7, to: 0.2, floor: 1.4, cap: f64::NAN }.validated();
        assert_eq!(bad, LevelMap { from: 0.7, to: 0.7, floor: 1.0, cap: 1.0 });
        assert!((m.scale(0.5) - 0.6).abs() < 1e-9);
        assert_eq!(m.scale(0.0), 0.0);
    }

    #[test]
    fn a_level_feature_takes_its_map_and_a_position_keeps_the_axis_range() {
        let (mut link, mut rx) = fixture(&[FeatureKind::Vibrate, FeatureKind::Position]);
        link.set_axes(&HashMap::from([(0, Some(Axis::V0)), (1, Some(Axis::L0))]));
        link.set_levels(&HashMap::from([(0, LevelMap { from: 0.5, to: 1.0, floor: 0.0, cap: 0.5 })]));
        let mut clamps = [AxisClamp::default(); Axis::COUNT];
        clamps[Axis::L0.index()] = AxisClamp { enabled: true, min: 0.2, max: 0.6 };
        clamps[Axis::V0.index()] = AxisClamp { enabled: true, min: 0.9, max: 1.0 };
        let mut values = [0.5; Axis::COUNT];
        link.send(&values, &clamps, 100, &[true; Axis::COUNT]).unwrap();
        assert_eq!(output_value(&mut rx), (0, 0.0), "a vibe at its start level is off, whatever V0's range says");
        assert_eq!(output_value(&mut rx), (1, 0.4), "the position is placed within L0's range");
        assert!(rx.try_recv().is_err());
        values[Axis::V0.index()] = 1.0;
        link.send(&values, &clamps, 100, &[true; Axis::COUNT]).unwrap();
        assert_eq!(output_value(&mut rx), (0, 0.5), "full input reaches the cap, not V0's range");
        assert!(rx.try_recv().is_err(), "an unchanged position is not resent");
        let input: Vec<Option<f64>> = link.axes().map(|(_, _, i)| i).collect();
        assert_eq!(input, vec![Some(1.0), None], "only levels report an input");
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
    fn stroke_keyframes_go_out_once_beside_the_cadence() {
        let (mut link, mut rx) = fixture(&[FeatureKind::TimedPosition, FeatureKind::Vibrate]);
        link.set_axes(&HashMap::from([(0, Some(Axis::L0)), (1, Some(Axis::V0))]));
        let clamps = [AxisClamp::default(); Axis::COUNT];
        let on = [true; Axis::COUNT];
        // The connect glide first; keyframes wait for it.
        link.send_scaled(&[0.5; Axis::COUNT], &clamps, 100, &on, 1.0, Some(Keyframe { at_ms: 1000.0, pos: 0.9, in_ms: 300.0 })).unwrap();
        assert!(matches!(rx.try_recv(), Ok(DevCmd::Output(0, ClientDeviceOutputCommand::HwPositionWithDuration(_, CONNECT_GLIDE_MS)))));
        assert_eq!(output_value(&mut rx), (1, 0.5));
        link.glide_until[0] = Some(Instant::now() - Duration::from_millis(1));
        // A keyframe goes out on an off-cadence tick, once; the vibrator waits for the cadence.
        let k = Keyframe { at_ms: 1000.0, pos: 0.9, in_ms: 300.0 };
        assert!(link.send_scaled(&[0.6; Axis::COUNT], &clamps, 10, &on, 1.0, Some(k)).unwrap());
        assert!(matches!(rx.try_recv(), Ok(DevCmd::Output(0, ClientDeviceOutputCommand::HwPositionWithDuration(ClientDeviceCommandValue::Percent(p), 300))) if (p - 0.9).abs() < 1e-9));
        assert!(rx.try_recv().is_err());
        assert!(!link.send_scaled(&[0.6; Axis::COUNT], &clamps, 10, &on, 1.0, Some(Keyframe { in_ms: 290.0, ..k })).unwrap());
        for _ in 0..8 {
            link.send_scaled(&[0.6; Axis::COUNT], &clamps, 10, &on, 1.0, Some(k)).unwrap();
        }
        assert_eq!(output_value(&mut rx), (1, 0.6));
        assert!(rx.try_recv().is_err());
        // The next keyframe, then a pause (no keyframe) sends the sampled stroke on the cadence.
        assert!(link.send_scaled(&[0.7; Axis::COUNT], &clamps, 10, &on, 1.0, Some(Keyframe { at_ms: 1300.0, pos: 0.1, in_ms: 250.0 })).unwrap());
        assert!(matches!(rx.try_recv(), Ok(DevCmd::Output(0, ClientDeviceOutputCommand::HwPositionWithDuration(ClientDeviceCommandValue::Percent(p), 250))) if (p - 0.1).abs() < 1e-9));
        assert!(link.send_scaled(&[0.7; Axis::COUNT], &clamps, 100, &on, 1.0, None).unwrap());
        assert!(matches!(rx.try_recv(), Ok(DevCmd::Output(0, ClientDeviceOutputCommand::HwPositionWithDuration(ClientDeviceCommandValue::Percent(p), d))) if (p - 0.7).abs() < 1e-9 && d >= 100));
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
