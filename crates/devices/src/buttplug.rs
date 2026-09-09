//! Buttplug v3 client over WebSocket (Intiface Central at `ws://127.0.0.1:12345`).
//! Stroke goes to every linear actuator, vibrate to every vibrator, twist to every
//! rotator. While a script drives the stroke each keyframe goes out once as a `LinearCmd`
//! to the next position over the time until it, which is the move a Handy, Keon or Launch
//! plays natively. Everything else (levels, a live stroke, a paused one) goes out every
//! 100 ms, the rate BLE toys cope with, with durations matching so motion stays continuous.

use std::collections::VecDeque;
use std::io::{self, ErrorKind};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use bp_script::Axis;
use serde_json::{Value, json};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::intiface;
use crate::output::{CONNECT_GLIDE_MS, Keyframe};
use crate::tcode::AxisClamp;
use crate::transport::{websocket, ws_send};

const SEND_EVERY_MS: f64 = 100.0;
/// A keyframe already sent goes again when its arrival moved by more than this (a seek
/// within its segment, a rate change), not for tick jitter.
const KEYFRAME_SLIP: Duration = Duration::from_millis(40);

struct Device {
    index: u64,
    name: String,
    linear: usize,
    vibrate: Vec<usize>,
    rotate: usize,
    last: [Option<u16>; 3],
    /// A device's first `LinearCmd` glides over `CONNECT_GLIDE_MS`; no stroke is sent until then.
    glide_until: Option<Instant>,
    /// The keyframe last sent (its video time) and when the device was told to arrive.
    keyframe: Option<(f64, Instant)>,
}

impl Device {
    /// The stroke to send this tick as (position, duration ms), if any. The first move glides;
    /// then a keyframe goes out once as it starts (again if its arrival slipped), and without
    /// one the sampled position goes out when `due`.
    fn stroke(
        &mut self,
        sampled: Option<f64>,
        keyframe: Option<(f64, Keyframe)>,
        due: bool,
        duration: u64,
        now: Instant,
    ) -> Option<(f64, u64)> {
        let unit = |v: f64| (v * 1000.0).round() as u16;
        if self.linear == 0 || self.glide_until.is_some_and(|t| now < t) {
            return None;
        }
        if self.last[0].is_none() {
            let v = sampled?;
            self.glide_until = Some(now + Duration::from_millis(CONNECT_GLIDE_MS as u64));
            self.last[0] = Some(unit(v));
            return Some((v, CONNECT_GLIDE_MS as u64));
        }
        match keyframe {
            Some((pos, k)) if sampled.is_some() => {
                let arrival = now + Duration::from_secs_f64(k.in_ms.max(0.0) / 1000.0);
                let same = self.keyframe.is_some_and(|(at, was)| {
                    at == k.at_ms && arrival.saturating_duration_since(was).max(was.saturating_duration_since(arrival)) <= KEYFRAME_SLIP
                });
                if same {
                    return None;
                }
                self.keyframe = Some((k.at_ms, arrival));
                self.last[0] = Some(unit(pos));
                Some((pos, (k.in_ms.round() as u64).max(1)))
            }
            _ => {
                self.keyframe = None;
                let v = sampled.filter(|_| due)?;
                if self.last[0] == Some(unit(v)) {
                    return None;
                }
                self.last[0] = Some(unit(v));
                Some((v, duration))
            }
        }
    }
}

pub struct Buttplug {
    ws: WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: u64,
    devices: Vec<Device>,
    changed: bool,
    log: VecDeque<String>,
    max_ping: Duration,
    last_ping: Instant,
    since_send_ms: f64,
}

impl Buttplug {
    /// Connects, completes the handshake, asks for the device list and starts scanning.
    /// Blocks up to a few seconds; call off the tick thread.
    pub fn connect(url: &str) -> io::Result<Buttplug> {
        let ws = websocket(url)?;
        let mut bp = Buttplug {
            ws,
            next_id: 1,
            devices: Vec::new(),
            changed: false,
            log: VecDeque::new(),
            max_ping: Duration::ZERO,
            last_ping: Instant::now(),
            since_send_ms: 0.0,
        };
        bp.send_msg(
            "RequestServerInfo",
            json!({ "ClientName": "Better Player", "MessageVersion": 3 }),
        )?;
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut ready = false;
        while !ready {
            if Instant::now() > deadline {
                return Err(io::Error::new(
                    ErrorKind::TimedOut,
                    "no ServerInfo from the Buttplug server",
                ));
            }
            for msg in bp.read_all()? {
                if let Some(info) = msg.get("ServerInfo") {
                    // Our own stand-in on the same port: connecting would loop L0 back to itself.
                    if info.get("ServerName").and_then(Value::as_str) == Some(intiface::SERVER_NAME) {
                        return Err(io::Error::other("this is the app's own Intiface server"));
                    }
                    let ms = info.get("MaxPingTime").and_then(Value::as_u64).unwrap_or(0);
                    bp.max_ping = Duration::from_millis(ms);
                    ready = true;
                } else if let Some(e) = msg.get("Error") {
                    return Err(io::Error::other(
                        e.get("ErrorMessage")
                            .and_then(Value::as_str)
                            .unwrap_or("handshake refused")
                            .to_string(),
                    ));
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        bp.send_msg("RequestDeviceList", json!({}))?;
        bp.send_msg("StartScanning", json!({}))?;
        Ok(bp)
    }

    fn send_msg(&mut self, name: &str, mut body: Value) -> io::Result<()> {
        body["Id"] = json!(self.next_id);
        self.next_id += 1;
        ws_send(&mut self.ws, &json!([{ name: body }]).to_string())
    }

    fn read_all(&mut self) -> io::Result<Vec<Value>> {
        let mut out = Vec::new();
        loop {
            match self.ws.read() {
                Ok(Message::Text(t)) => {
                    if let Ok(Value::Array(msgs)) = serde_json::from_str::<Value>(t.as_str()) {
                        out.extend(msgs);
                    }
                }
                Ok(Message::Close(_)) => {
                    return Err(io::Error::new(
                        ErrorKind::ConnectionAborted,
                        "server closed",
                    ));
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => break,
                Err(e) => return Err(io::Error::new(ErrorKind::BrokenPipe, e.to_string())),
            }
        }
        Ok(out)
    }

    /// Reads device events and keeps the server's ping alive. Call every tick.
    pub fn poll(&mut self) -> io::Result<()> {
        for msg in self.read_all()? {
            if let Some(list) = msg
                .get("DeviceList")
                .and_then(|d| d.get("Devices"))
                .and_then(Value::as_array)
            {
                self.devices = list.iter().filter_map(parse_device).collect();
                self.changed = true;
            } else if let Some(d) = msg.get("DeviceAdded") {
                if let Some(dev) = parse_device(d) {
                    self.devices.retain(|x| x.index != dev.index);
                    self.log.push_back(format!("added {}", dev.name));
                    self.devices.push(dev);
                    self.changed = true;
                }
            } else if let Some(d) = msg.get("DeviceRemoved") {
                let index = d
                    .get("DeviceIndex")
                    .and_then(Value::as_u64)
                    .unwrap_or(u64::MAX);
                self.devices.retain(|x| x.index != index);
                self.changed = true;
            } else if let Some(e) = msg.get("Error") {
                self.log.push_back(format!(
                    "error: {}",
                    e.get("ErrorMessage").and_then(Value::as_str).unwrap_or("?")
                ));
            }
        }
        if !self.max_ping.is_zero() && self.last_ping.elapsed() > self.max_ping / 2 {
            self.send_msg("Ping", json!({}))?;
            self.last_ping = Instant::now();
        }
        Ok(())
    }

    /// True once after the device set changed.
    pub fn devices_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }

    pub fn device_names(&self) -> String {
        if self.devices.is_empty() {
            "no devices".to_string()
        } else {
            self.devices
                .iter()
                .map(|d| d.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        }
    }

    pub fn take_log(&mut self) -> Vec<String> {
        self.log.drain(..).collect()
    }

    /// Sends stroke, vibrate and twist to every device that changed. An axis that is not
    /// `active` (paused, with the user stopping levels on pause) rests its vibrators and
    /// rotators at once, below any range floor; the stroke holds. A `keyframe` is sent as one
    /// move the moment it starts; levels and a sampled stroke wait for the 100 ms cadence.
    /// Returns whether anything was sent this tick.
    pub fn send(
        &mut self,
        values: &[f64; Axis::COUNT],
        clamps: &[AxisClamp; Axis::COUNT],
        interval_ms: u32,
        active: &[bool; Axis::COUNT],
        keyframe: Option<Keyframe>,
    ) -> io::Result<bool> {
        self.since_send_ms += interval_ms as f64;
        let due = self.since_send_ms >= SEND_EVERY_MS;
        let duration = self.since_send_ms.round() as u64;
        if due {
            self.since_send_ms = 0.0;
        }
        let ranged = |axis: Axis, v: f64| {
            let c = clamps[axis.index()];
            c.enabled.then(|| (c.min + v.clamp(0.0, 1.0) * (c.max - c.min)).clamp(0.0, 1.0))
        };
        let clamped = |axis: Axis| ranged(axis, values[axis.index()]);
        let level = |axis: Axis, rest: f64| clamped(axis).map(|v| if active[axis.index()] { v } else { rest });
        let stroke = clamped(Axis::L0);
        let keyframe = keyframe.and_then(|k| Some((ranged(Axis::L0, k.pos)?, k)));
        let vibrate = level(Axis::V0, 0.0);
        // Twist is a speed from the middle, so the middle is still.
        let twist = level(Axis::R0, 0.5);
        let mut batch = Vec::new();
        let now = Instant::now();
        for d in &mut self.devices {
            let unit = |v: f64| (v * 1000.0).round() as u16;
            if let Some((v, duration)) = d.stroke(stroke, keyframe, due, duration, now) {
                let vectors: Vec<Value> = (0..d.linear)
                    .map(|i| json!({ "Index": i, "Duration": duration, "Position": v }))
                    .collect();
                batch.push((
                    "LinearCmd",
                    json!({ "DeviceIndex": d.index, "Vectors": vectors }),
                ));
            }
            if !due {
                continue;
            }
            if let Some(v) = vibrate
                .filter(|_| !d.vibrate.is_empty())
                .filter(|v| d.last[1] != Some(unit(*v)))
            {
                d.last[1] = Some(unit(v));
                let scalars: Vec<Value> = d
                    .vibrate
                    .iter()
                    .map(|i| json!({ "Index": i, "Scalar": v, "ActuatorType": "Vibrate" }))
                    .collect();
                batch.push((
                    "ScalarCmd",
                    json!({ "DeviceIndex": d.index, "Scalars": scalars }),
                ));
            }
            if let Some(v) = twist
                .filter(|_| d.rotate > 0)
                .filter(|v| d.last[2] != Some(unit(*v)))
            {
                d.last[2] = Some(unit(v));
                let speed = ((v - 0.5).abs() * 2.0).min(1.0);
                let rotations: Vec<Value> = (0..d.rotate)
                    .map(|i| json!({ "Index": i, "Speed": speed, "Clockwise": v >= 0.5 }))
                    .collect();
                batch.push((
                    "RotateCmd",
                    json!({ "DeviceIndex": d.index, "Rotations": rotations }),
                ));
            }
        }
        if batch.is_empty() {
            return Ok(false);
        }
        let msgs: Vec<Value> = batch
            .into_iter()
            .map(|(name, mut body)| {
                body["Id"] = json!(self.next_id);
                self.next_id += 1;
                json!({ name: body })
            })
            .collect();
        ws_send(&mut self.ws, &Value::Array(msgs).to_string())?;
        Ok(true)
    }
}

impl Drop for Buttplug {
    fn drop(&mut self) {
        let _ = self.send_msg("StopAllDevices", json!({}));
        let _ = self.ws.close(None);
        let _ = self.ws.flush();
    }
}

fn parse_device(v: &Value) -> Option<Device> {
    let index = v.get("DeviceIndex")?.as_u64()?;
    let name = v.get("DeviceName")?.as_str()?.to_string();
    let msgs = v.get("DeviceMessages")?;
    let count = |k: &str| msgs.get(k).and_then(Value::as_array).map_or(0, Vec::len);
    let vibrate = msgs
        .get("ScalarCmd")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .enumerate()
                .filter(|(_, s)| s.get("ActuatorType").and_then(Value::as_str) == Some("Vibrate"))
                .map(|(i, _)| i)
                .collect()
        })
        .unwrap_or_default();
    Some(Device {
        index,
        name,
        linear: count("LinearCmd"),
        vibrate,
        rotate: count("RotateCmd"),
        last: [None; 3],
        glide_until: None,
        keyframe: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_list_entry_maps_to_actuators() {
        let v = json!({
            "DeviceIndex": 2, "DeviceName": "Kiiroo Keon",
            "DeviceMessages": {
                "LinearCmd": [{"StepCount": 100}],
                "ScalarCmd": [{"StepCount": 20, "ActuatorType": "Vibrate"}, {"StepCount": 3, "ActuatorType": "Constrict"}],
                "StopDeviceCmd": {}
            }
        });
        let d = parse_device(&v).unwrap();
        assert_eq!(
            (d.index, d.name.as_str(), d.linear, d.rotate),
            (2, "Kiiroo Keon", 1, 0)
        );
        assert_eq!(d.vibrate, vec![0]);
    }

    fn linear() -> Device {
        Device { index: 0, name: "Handy".into(), linear: 1, vibrate: Vec::new(), rotate: 0, last: [None; 3], glide_until: None, keyframe: None }
    }

    #[test]
    fn keyframes_go_out_once_as_they_start_and_samples_fill_in() {
        let mut d = linear();
        let t0 = Instant::now();
        // The first move glides, then nothing until the glide is over.
        assert_eq!(d.stroke(Some(0.5), None, true, 100, t0), Some((0.5, CONNECT_GLIDE_MS as u64)));
        assert_eq!(d.stroke(Some(0.6), None, true, 100, t0 + Duration::from_millis(100)), None);
        let t1 = t0 + Duration::from_millis(CONNECT_GLIDE_MS as u64);
        // A keyframe goes out as soon as it starts, whatever the cadence, and only once.
        let k = Keyframe { at_ms: 1000.0, pos: 0.9, in_ms: 300.0 };
        assert_eq!(d.stroke(Some(0.55), Some((0.9, k)), false, 10, t1), Some((0.9, 300)));
        let later = Keyframe { in_ms: 290.0, ..k };
        assert_eq!(d.stroke(Some(0.6), Some((0.9, later)), true, 100, t1 + Duration::from_millis(10)), None);
        // A seek within the segment changes its arrival and it goes again.
        let seek = Keyframe { in_ms: 500.0, ..k };
        assert_eq!(d.stroke(Some(0.6), Some((0.9, seek)), false, 10, t1 + Duration::from_millis(20)), Some((0.9, 500)));
        // Without a keyframe (paused, a live source) the sampled stroke goes out on the cadence.
        assert_eq!(d.stroke(Some(0.7), None, false, 10, t1 + Duration::from_millis(30)), None);
        assert_eq!(d.stroke(Some(0.7), None, true, 100, t1 + Duration::from_millis(100)), Some((0.7, 100)));
        // And the same keyframe goes out again after that, so a resume picks the move back up.
        assert_eq!(d.stroke(Some(0.7), Some((0.9, k)), false, 10, t1 + Duration::from_millis(110)), Some((0.9, 300)));
    }

    #[test]
    fn refuses_the_apps_own_intiface_server() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let _server = intiface::IntifaceServer::start(port).unwrap();
        let err = Buttplug::connect(&format!("ws://127.0.0.1:{port}")).err().unwrap();
        assert!(err.to_string().contains("own Intiface server"), "{err}");
    }
}
