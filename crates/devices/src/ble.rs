//! Bluetooth LE: a blocking scan for the device wizard and `BleConn`, a connection that runs
//! btleplug on its own thread behind a command channel so the tick thread never waits on
//! radio work. `BleTcode` is the `Conn` for TCodeESP32 boards.

use std::collections::VecDeque;
use std::io::{self, ErrorKind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use btleplug::api::bleuuid::uuid_from_u16;
use btleplug::api::{BDAddr, Central, CharPropFlags, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Manager, Peripheral};
use futures_util::StreamExt;
use tokio::runtime::Builder;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use uuid::Uuid;

use crate::transport::{Conn, split_lines};

/// TCodeESP32's BLE service and the characteristic TCode lines are written to.
pub const TCODE_SERVICE: Uuid = Uuid::from_u128(0xff1b451d_3070_4276_9c81_5dc5ea1043bc);
pub const TCODE_WRITE: Uuid = Uuid::from_u128(0xc5f1543e_338d_47a0_8525_01e3c621359d);

/// DG-Lab Coyote v3: commands, responses, and the battery characteristic on its own service.
pub const COYOTE_SERVICE: Uuid = uuid_from_u16(0x180C);
pub const COYOTE_WRITE: Uuid = uuid_from_u16(0x150A);
pub const COYOTE_NOTIFY: Uuid = uuid_from_u16(0x150B);
pub const COYOTE_BATTERY_SERVICE: Uuid = uuid_from_u16(0x180A);
pub const COYOTE_BATTERY: Uuid = uuid_from_u16(0x1500);

/// The Coyote v3 advertises this name.
const COYOTE_NAME: &str = "47l121000";
/// BLE writes are capped at the default ATT payload; longer TCode lines go out in pieces.
const CHUNK: usize = 20;
/// Lines to a TCode board are spaced at least this far apart: a 7.5 to 30 ms connection
/// interval carries a couple of packets each, and a line is two or three.
const TCODE_LINE_MS: u32 = 25;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Notification and read payloads waiting for their owner, tagged with their characteristic.
type Queue = Arc<Mutex<VecDeque<(Uuid, Vec<u8>)>>>;

/// One advertising device, classified so the wizard can offer the right kind of output.
#[derive(Clone, Debug, PartialEq)]
pub struct BleDevice {
    pub name: String,
    pub address: String,
    /// `tcode`, `coyote` or `other`.
    pub kind: &'static str,
}

/// Advertised services and name decide what a device is.
fn classify(name: &str, services: &[Uuid]) -> &'static str {
    let lower = name.to_lowercase();
    if services.contains(&TCODE_SERVICE) || lower.contains("tcode") {
        "tcode"
    } else if lower.contains(COYOTE_NAME) || lower.contains("coyote") || services.contains(&COYOTE_SERVICE) {
        "coyote"
    } else {
        "other"
    }
}

/// CoreBluetooth hides the MAC, so the peripheral's own identifier stands in for it.
fn address(p: &Peripheral) -> String {
    let addr = p.address();
    if addr == BDAddr::default() { p.id().to_string() } else { addr.to_string() }
}

/// Scans every adapter for `seconds` and returns what advertised, named devices first.
/// Blocks; call it off the tick thread.
pub fn scan(seconds: u32) -> io::Result<Vec<BleDevice>> {
    runtime()?.block_on(async move {
        let manager = Manager::new().await.map_err(other)?;
        let adapters = manager.adapters().await.map_err(other)?;
        let adapter = adapters.into_iter().next().ok_or_else(|| io::Error::new(ErrorKind::NotFound, "no Bluetooth adapter"))?;
        adapter.start_scan(ScanFilter::default()).await.map_err(other)?;
        tokio::time::sleep(Duration::from_secs(seconds.clamp(1, 60) as u64)).await;
        let peripherals = adapter.peripherals().await.map_err(other)?;
        let _ = adapter.stop_scan().await;
        let mut out = Vec::new();
        for p in peripherals {
            let props = match p.properties().await {
                Ok(Some(props)) => props,
                _ => continue,
            };
            let name = props.local_name.or(props.advertisement_name).unwrap_or_default();
            out.push(BleDevice { kind: classify(&name, &props.services), name, address: address(&p) });
        }
        out.sort_by_key(|d| (d.kind == "other", d.name.is_empty(), d.name.to_lowercase()));
        Ok(out)
    })
}

/// A connected peripheral. Writes and subscriptions are messages to the BLE thread;
/// notification payloads queue up until the owner drains them.
pub struct BleConn {
    pub name: String,
    tx: UnboundedSender<Cmd>,
    queue: Queue,
    alive: Arc<AtomicBool>,
    /// One slot for the newest line; `Cmd::Flush` is queued once until the BLE thread takes it.
    latest: Arc<Mutex<Option<Vec<u8>>>>,
    flush_queued: Arc<AtomicBool>,
}

enum Cmd {
    Write(Vec<u8>),
    /// Write whatever is in the latest-line slot now.
    Flush,
    /// Read a characteristic once and subscribe to it when it notifies.
    Watch(Uuid),
    Close,
}

impl BleConn {
    /// Connects to the first device whose name or address starts with `target` (case
    /// insensitive), discovers services and subscribes to `notify_uuid`. Blocks until the
    /// device is ready.
    pub fn open(target: &str, service_uuid: Uuid, write_uuid: Uuid, notify_uuid: Uuid) -> io::Result<BleConn> {
        let (ready_tx, ready_rx) = sync_channel::<io::Result<String>>(1);
        let (tx, rx) = unbounded_channel();
        let queue = Arc::new(Mutex::new(VecDeque::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let latest = Arc::new(Mutex::new(None));
        let flush_queued = Arc::new(AtomicBool::new(false));
        let target = target.to_lowercase();
        let (q, a, l, f) = (queue.clone(), alive.clone(), latest.clone(), flush_queued.clone());
        thread::Builder::new()
            .name("bp-ble".into())
            .spawn(move || {
                let rt = match runtime() {
                    Ok(rt) => rt,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                rt.block_on(run(target, service_uuid, write_uuid, notify_uuid, ready_tx, rx, q, l, f));
                a.store(false, Ordering::Relaxed);
            })
            .map_err(other)?;
        let name = ready_rx.recv_timeout(CONNECT_TIMEOUT + Duration::from_secs(2)).map_err(|_| io::Error::new(ErrorKind::TimedOut, "BLE connect timed out"))??;
        Ok(BleConn { name, tx, queue, alive, latest, flush_queued })
    }

    /// Queues bytes for the write characteristic, in order, behind whatever is queued. Never blocks.
    pub fn write(&self, data: &[u8]) -> io::Result<()> {
        self.check()?;
        self.tx.send(Cmd::Write(data.to_vec())).map_err(|_| io::Error::new(ErrorKind::BrokenPipe, "BLE thread stopped"))
    }

    /// Replaces the line waiting to go out. A line the radio has not taken yet is dropped for
    /// this one, so a slow link falls behind by at most one line instead of queueing forever.
    pub fn write_latest(&self, data: &[u8]) -> io::Result<()> {
        self.check()?;
        *self.latest.lock().unwrap() = Some(data.to_vec());
        if !self.flush_queued.swap(true, Ordering::AcqRel) {
            self.tx.send(Cmd::Flush).map_err(|_| io::Error::new(ErrorKind::BrokenPipe, "BLE thread stopped"))?;
        }
        Ok(())
    }

    /// Reads a characteristic once and subscribes to it if it notifies. Values arrive in the
    /// notification queue tagged with their uuid. Missing characteristics are ignored.
    pub fn watch(&self, uuid: Uuid) {
        let _ = self.tx.send(Cmd::Watch(uuid));
    }

    /// Notification and read payloads received since the last call.
    pub fn take_notifications(&self) -> Vec<(Uuid, Vec<u8>)> {
        self.queue.lock().unwrap().drain(..).collect()
    }

    pub fn check(&self) -> io::Result<()> {
        if self.alive.load(Ordering::Relaxed) {
            Ok(())
        } else {
            Err(io::Error::new(ErrorKind::ConnectionAborted, "BLE disconnected"))
        }
    }
}

impl Drop for BleConn {
    fn drop(&mut self) {
        let _ = self.tx.send(Cmd::Close);
    }
}

/// One current-thread runtime per connection: connect, then serve commands and notifications
/// until the owner drops the connection or the device goes away.
async fn run(
    target: String,
    service_uuid: Uuid,
    write_uuid: Uuid,
    notify_uuid: Uuid,
    ready: std::sync::mpsc::SyncSender<io::Result<String>>,
    mut rx: UnboundedReceiver<Cmd>,
    queue: Queue,
    latest: Arc<Mutex<Option<Vec<u8>>>>,
    flush_queued: Arc<AtomicBool>,
) {
    let found = tokio::time::timeout(CONNECT_TIMEOUT, find(&target, service_uuid)).await;
    let peripheral = match found {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => return drop(ready.send(Err(e))),
        Err(_) => return drop(ready.send(Err(io::Error::new(ErrorKind::TimedOut, format!("no BLE device matching {target}"))))),
    };
    let name = match connect(&peripheral, notify_uuid).await {
        Ok(name) => name,
        Err(e) => {
            let _ = peripheral.disconnect().await;
            return drop(ready.send(Err(e)));
        }
    };
    let write = characteristic(&peripheral, write_uuid);
    let mut notifications = match peripheral.notifications().await {
        Ok(n) => n,
        Err(e) => return drop(ready.send(Err(other(e)))),
    };
    if ready.send(Ok(name)).is_err() {
        return;
    }

    // The stream drains on its own task so a slow write never loses notifications.
    let q = queue.clone();
    let pump = tokio::spawn(async move {
        while let Some(n) = notifications.next().await {
            let mut q = q.lock().unwrap();
            if q.len() < 200 {
                q.push_back((n.uuid, n.value));
            }
        }
    });

    while let Some(cmd) = rx.recv().await {
        match cmd {
            Cmd::Write(data) => {
                let Some(c) = &write else { break };
                let kind = if c.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE) { WriteType::WithoutResponse } else { WriteType::WithResponse };
                if peripheral.write(c, &data, kind).await.is_err() {
                    break;
                }
            }
            Cmd::Flush => {
                let data = latest.lock().unwrap().take();
                flush_queued.store(false, Ordering::Release);
                let Some(data) = data else { continue };
                let Some(c) = &write else { break };
                let kind = if c.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE) { WriteType::WithoutResponse } else { WriteType::WithResponse };
                let mut failed = false;
                for chunk in data.chunks(CHUNK) {
                    if peripheral.write(c, chunk, kind).await.is_err() {
                        failed = true;
                        break;
                    }
                }
                if failed {
                    break;
                }
            }
            Cmd::Watch(uuid) => {
                if let Some(c) = characteristic(&peripheral, uuid) {
                    if let Ok(value) = peripheral.read(&c).await {
                        queue.lock().unwrap().push_back((uuid, value));
                    }
                    if c.properties.contains(CharPropFlags::NOTIFY) {
                        let _ = peripheral.subscribe(&c).await;
                    }
                }
            }
            Cmd::Close => break,
        }
    }
    pump.abort();
    let _ = peripheral.disconnect().await;
}

/// Scans until a device's name or address starts with `target`, or the advertised service
/// matches when `target` is empty.
async fn find(target: &str, service_uuid: Uuid) -> io::Result<Peripheral> {
    let manager = Manager::new().await.map_err(other)?;
    let adapters = manager.adapters().await.map_err(other)?;
    let adapter = adapters.into_iter().next().ok_or_else(|| io::Error::new(ErrorKind::NotFound, "no Bluetooth adapter"))?;
    adapter.start_scan(ScanFilter::default()).await.map_err(other)?;
    loop {
        for p in adapter.peripherals().await.map_err(other)? {
            let Ok(Some(props)) = p.properties().await else { continue };
            let name = props.local_name.or(props.advertisement_name).unwrap_or_default().to_lowercase();
            let matches = if target.is_empty() {
                props.services.contains(&service_uuid)
            } else {
                name.starts_with(target) || address(&p).to_lowercase().starts_with(target)
            };
            if matches {
                let _ = adapter.stop_scan().await;
                return Ok(p);
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Connects, discovers services and subscribes to the notify characteristic. Returns the
/// device's advertised name.
async fn connect(p: &Peripheral, notify_uuid: Uuid) -> io::Result<String> {
    if !p.is_connected().await.unwrap_or(false) {
        p.connect().await.map_err(other)?;
    }
    p.discover_services().await.map_err(other)?;
    if let Some(c) = characteristic(p, notify_uuid).filter(|c| c.properties.contains(CharPropFlags::NOTIFY)) {
        p.subscribe(&c).await.map_err(other)?;
    }
    let name = p.properties().await.ok().flatten().and_then(|props| props.local_name).unwrap_or_else(|| p.id().to_string());
    Ok(name)
}

fn characteristic(p: &Peripheral, uuid: Uuid) -> Option<Characteristic> {
    p.characteristics().into_iter().find(|c| c.uuid == uuid)
}

fn runtime() -> io::Result<tokio::runtime::Runtime> {
    Builder::new_current_thread().enable_time().build()
}

fn other<E: std::fmt::Display>(e: E) -> io::Error {
    io::Error::other(e.to_string())
}

/// TCode over a TCodeESP32 board's BLE service: the newest line out in 20 byte pieces
/// (btleplug does not report the negotiated MTU), notifications back as lines.
pub struct BleTcode {
    conn: BleConn,
    partial: Vec<u8>,
}

/// Connects to a TCode board advertising the TCodeESP32 service.
pub fn tcode(target: &str) -> io::Result<BleTcode> {
    let conn = BleConn::open(target, TCODE_SERVICE, TCODE_WRITE, TCODE_WRITE)?;
    Ok(BleTcode { conn, partial: Vec::new() })
}

impl Conn for BleTcode {
    fn send(&mut self, line: &str) -> io::Result<()> {
        self.conn.write_latest(line.as_bytes())
    }

    fn min_interval_ms(&self) -> u32 {
        TCODE_LINE_MS
    }

    fn recv_lines(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        for (_, payload) in self.conn.take_notifications() {
            split_lines(&mut self.partial, &payload, &mut out);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_classify_by_service_and_name() {
        assert_eq!(classify("OSR2", &[TCODE_SERVICE]), "tcode");
        assert_eq!(classify("47L121000", &[]), "coyote");
        assert_eq!(classify("", &[COYOTE_SERVICE]), "coyote");
        assert_eq!(classify("Some Speaker", &[]), "other");
    }
}
