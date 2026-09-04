//! Buttplug v3 client over WebSocket (Intiface Central at `ws://127.0.0.1:12345`).
//! Stroke goes to every linear actuator, vibrate to every vibrator, twist to every
//! rotator. Commands go out every 100 ms, the rate BLE toys cope with, with `LinearCmd`
//! durations matching so motion stays continuous.

use std::collections::VecDeque;
use std::io::{self, ErrorKind};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use bp_script::Axis;
use serde_json::{Value, json};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::output::CONNECT_GLIDE_MS;
use crate::tcode::AxisClamp;
use crate::transport::{websocket, ws_send};

const SEND_EVERY_MS: f64 = 100.0;

struct Device {
    index: u64,
    name: String,
    linear: usize,
    vibrate: Vec<usize>,
    rotate: usize,
    last: [Option<u16>; 3],
    /// A device's first `LinearCmd` glides over `CONNECT_GLIDE_MS`; no stroke is sent until then.
    glide_until: Option<Instant>,
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
        bp.send_msg("RequestServerInfo", json!({ "ClientName": "Better Player", "MessageVersion": 3 }))?;
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut ready = false;
        while !ready {
            if Instant::now() > deadline {
                return Err(io::Error::new(ErrorKind::TimedOut, "no ServerInfo from the Buttplug server"));
            }
            for msg in bp.read_all()? {
                if let Some(info) = msg.get("ServerInfo") {
                    let ms = info.get("MaxPingTime").and_then(Value::as_u64).unwrap_or(0);
                    bp.max_ping = Duration::from_millis(ms);
                    ready = true;
                } else if let Some(e) = msg.get("Error") {
                    return Err(io::Error::other(e.get("ErrorMessage").and_then(Value::as_str).unwrap_or("handshake refused").to_string()));
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
                Ok(Message::Close(_)) => return Err(io::Error::new(ErrorKind::ConnectionAborted, "server closed")),
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
            if let Some(list) = msg.get("DeviceList").and_then(|d| d.get("Devices")).and_then(Value::as_array) {
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
                let index = d.get("DeviceIndex").and_then(Value::as_u64).unwrap_or(u64::MAX);
                self.devices.retain(|x| x.index != index);
                self.changed = true;
            } else if let Some(e) = msg.get("Error") {
                self.log.push_back(format!("error: {}", e.get("ErrorMessage").and_then(Value::as_str).unwrap_or("?")));
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
            self.devices.iter().map(|d| d.name.as_str()).collect::<Vec<_>>().join(", ")
        }
    }

    pub fn take_log(&mut self) -> Vec<String> {
        self.log.drain(..).collect()
    }

    /// Sends stroke, vibrate and twist to every device that changed. Returns whether
    /// anything was sent this tick.
    pub fn send(&mut self, values: &[f64; Axis::COUNT], clamps: &[AxisClamp; Axis::COUNT], interval_ms: u32) -> io::Result<bool> {
        self.since_send_ms += interval_ms as f64;
        if self.since_send_ms < SEND_EVERY_MS {
            return Ok(false);
        }
        let duration = self.since_send_ms.round() as u64;
        self.since_send_ms = 0.0;
        let clamped = |axis: Axis| {
            let c = clamps[axis.index()];
            c.enabled.then(|| (c.min + values[axis.index()].clamp(0.0, 1.0) * (c.max - c.min)).clamp(0.0, 1.0))
        };
        let stroke = clamped(Axis::L0);
        let vibrate = clamped(Axis::V0);
        let twist = clamped(Axis::R0);
        let mut batch = Vec::new();
        let now = Instant::now();
        for d in &mut self.devices {
            let unit = |v: f64| (v * 1000.0).round() as u16;
            let gliding = d.glide_until.is_some_and(|t| now < t);
            if let Some(v) = stroke.filter(|_| d.linear > 0 && !gliding).filter(|v| d.last[0] != Some(unit(*v))) {
                let duration = if d.last[0].is_none() {
                    d.glide_until = Some(now + Duration::from_millis(CONNECT_GLIDE_MS as u64));
                    CONNECT_GLIDE_MS as u64
                } else {
                    duration
                };
                d.last[0] = Some(unit(v));
                let vectors: Vec<Value> = (0..d.linear).map(|i| json!({ "Index": i, "Duration": duration, "Position": v })).collect();
                batch.push(("LinearCmd", json!({ "DeviceIndex": d.index, "Vectors": vectors })));
            }
            if let Some(v) = vibrate.filter(|_| !d.vibrate.is_empty()).filter(|v| d.last[1] != Some(unit(*v))) {
                d.last[1] = Some(unit(v));
                let scalars: Vec<Value> = d.vibrate.iter().map(|i| json!({ "Index": i, "Scalar": v, "ActuatorType": "Vibrate" })).collect();
                batch.push(("ScalarCmd", json!({ "DeviceIndex": d.index, "Scalars": scalars })));
            }
            if let Some(v) = twist.filter(|_| d.rotate > 0).filter(|v| d.last[2] != Some(unit(*v))) {
                d.last[2] = Some(unit(v));
                let speed = ((v - 0.5).abs() * 2.0).min(1.0);
                let rotations: Vec<Value> = (0..d.rotate).map(|i| json!({ "Index": i, "Speed": speed, "Clockwise": v >= 0.5 })).collect();
                batch.push(("RotateCmd", json!({ "DeviceIndex": d.index, "Rotations": rotations })));
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
    Some(Device { index, name, linear: count("LinearCmd"), vibrate, rotate: count("RotateCmd"), last: [None; 3], glide_until: None })
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
        assert_eq!((d.index, d.name.as_str(), d.linear, d.rotate), (2, "Kiiroo Keon", 1, 0));
        assert_eq!(d.vibrate, vec![0]);
    }
}
