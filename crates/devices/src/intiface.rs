//! A Buttplug v3 server standing in for Intiface Central on `ws://127.0.0.1:12345`, so a
//! page that scripts an Intiface toy (faptap.net) drives our stroke axis instead. It offers
//! one device, "Better Player", with one linear actuator: each `LinearCmd` moves the stroke
//! to its position over its duration; `StopDeviceCmd`, `StopAllDevices` and the client going
//! away release the axis. The engine reads the stroke every tick with `stroke_at`.

use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tungstenite::{Message, WebSocket};

pub const DEFAULT_PORT: u16 = 12345;
const SERVER_NAME: &str = "Better Player";
/// How often the accept loop and a connection's read loop look at the stop flag.
const POLL: Duration = Duration::from_millis(50);

/// A commanded stroke: from where the axis was at the command toward `to` over the duration.
#[derive(Clone, Copy, Debug)]
struct Move {
    from: f64,
    to: f64,
    started: Instant,
    duration_ms: f64,
}

impl Move {
    fn at(&self, now: Instant) -> f64 {
        if self.duration_ms <= 0.0 {
            return self.to;
        }
        let u = (now.saturating_duration_since(self.started).as_secs_f64() * 1000.0 / self.duration_ms).min(1.0);
        self.from + (self.to - self.from) * u
    }
}

#[derive(Default)]
struct State {
    clients: usize,
    /// What the newest client called itself in `RequestServerInfo`.
    client: Option<String>,
    stroke: Option<Move>,
    error: Option<String>,
}

/// What the server is doing, for the UI.
#[derive(Clone, Debug, PartialEq)]
pub struct IntifaceStatus {
    pub port: u16,
    pub clients: usize,
    pub client: Option<String>,
    /// Why it is not listening (the port is taken) or the last connection failure.
    pub error: Option<String>,
}

pub struct IntifaceServer {
    port: u16,
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl IntifaceServer {
    /// Binds the loopback port and starts accepting. Fails at once when the port is taken
    /// (Intiface Central itself, most likely).
    pub fn start(port: u16) -> Result<IntifaceServer, String> {
        let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| match e.kind() {
            ErrorKind::AddrInUse => format!("port {port} is in use (is Intiface Central running?)"),
            _ => e.to_string(),
        })?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let state = Arc::new(Mutex::new(State::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (state, stop) = (state.clone(), stop.clone());
            thread::Builder::new()
                .name("bp-intiface".into())
                .spawn(move || accept_loop(listener, state, stop))
                .map_err(|e| e.to_string())?
        };
        Ok(IntifaceServer { port, state, stop, thread: Some(thread) })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The stroke a client is commanding right now, 0..1; `None` when nobody is.
    pub fn stroke_at(&self, now: Instant) -> Option<f64> {
        self.state.lock().unwrap().stroke.map(|m| m.at(now))
    }

    pub fn status(&self) -> IntifaceStatus {
        let s = self.state.lock().unwrap();
        IntifaceStatus { port: self.port, clients: s.clients, client: s.client.clone(), error: s.error.clone() }
    }
}

impl Drop for IntifaceServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn accept_loop(listener: TcpListener, state: Arc<Mutex<State>>, stop: Arc<AtomicBool>) {
    let mut connections: Vec<JoinHandle<()>> = Vec::new();
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                let (state, stop) = (state.clone(), stop.clone());
                if let Ok(t) = thread::Builder::new().name("bp-intiface-client".into()).spawn(move || serve(stream, state, stop)) {
                    connections.push(t);
                }
                connections.retain(|t| !t.is_finished());
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => thread::sleep(POLL),
            Err(e) => {
                state.lock().unwrap().error = Some(e.to_string());
                thread::sleep(POLL);
            }
        }
    }
    for t in connections {
        let _ = t.join();
    }
}

fn serve(stream: TcpStream, state: Arc<Mutex<State>>, stop: Arc<AtomicBool>) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(POLL));
    let _ = stream.set_nodelay(true);
    let mut ws = match tungstenite::accept(stream) {
        Ok(ws) => ws,
        Err(e) => {
            state.lock().unwrap().error = Some(format!("handshake: {e}"));
            return;
        }
    };
    state.lock().unwrap().clients += 1;
    while !stop.load(Ordering::Relaxed) {
        match ws.read() {
            Ok(Message::Text(text)) => {
                let replies = match serde_json::from_str::<Value>(text.as_str()) {
                    Ok(Value::Array(msgs)) => msgs.iter().filter_map(|m| handle(m, &state)).collect::<Vec<_>>(),
                    _ => vec![error(0, "expected a message array")],
                };
                if !replies.is_empty() && send(&mut ws, Value::Array(replies)).is_err() {
                    break;
                }
            }
            Ok(Message::Ping(p)) => {
                if ws.send(Message::Pong(p)).is_err() {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Binary(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
    }
    let _ = ws.close(None);
    let mut s = state.lock().unwrap();
    s.clients = s.clients.saturating_sub(1);
    // The last client gone takes its stroke with it, so the axis homes rather than holds.
    if s.clients == 0 {
        s.stroke = None;
        s.client = None;
    }
}

fn send(ws: &mut WebSocket<TcpStream>, msgs: Value) -> Result<(), tungstenite::Error> {
    ws.send(Message::Text(msgs.to_string().into()))?;
    ws.flush()
}

fn ok(id: u64) -> Value {
    json!({ "Ok": { "Id": id } })
}

fn error(id: u64, message: &str) -> Value {
    json!({ "Error": { "Id": id, "ErrorMessage": message, "ErrorCode": 3 } })
}

/// The one device on offer: a stroker with a single position actuator.
fn device() -> Value {
    json!({
        "DeviceIndex": 0,
        "DeviceName": SERVER_NAME,
        "DeviceDisplayName": SERVER_NAME,
        "DeviceMessageTimingGap": 10,
        "DeviceMessages": {
            "LinearCmd": [{ "StepCount": 100, "FeatureDescriptor": "Stroke", "ActuatorType": "Position" }],
            "StopDeviceCmd": {}
        }
    })
}

/// One client message to its reply; `None` for messages that get no reply.
fn handle(msg: &Value, state: &Mutex<State>) -> Option<Value> {
    let (name, body) = msg.as_object()?.iter().next()?;
    let id = body.get("Id").and_then(Value::as_u64).unwrap_or(0);
    Some(match name.as_str() {
        "RequestServerInfo" => {
            let client = body.get("ClientName").and_then(Value::as_str).unwrap_or("client").to_string();
            state.lock().unwrap().client = Some(client);
            json!({ "ServerInfo": { "Id": id, "ServerName": SERVER_NAME, "MessageVersion": 3, "MaxPingTime": 0 } })
        }
        "RequestDeviceList" => json!({ "DeviceList": { "Id": id, "Devices": [device()] } }),
        "StartScanning" | "StopScanning" | "Ping" | "ScalarCmd" | "RotateCmd" | "VibrateCmd" => ok(id),
        "LinearCmd" => {
            let vector = body.get("Vectors").and_then(Value::as_array).and_then(|v| v.first());
            let Some(position) = vector.and_then(|v| v.get("Position")).and_then(Value::as_f64) else {
                return Some(error(id, "LinearCmd needs a Position"));
            };
            let duration_ms = vector.and_then(|v| v.get("Duration")).and_then(Value::as_f64).unwrap_or(0.0).max(0.0);
            let now = Instant::now();
            let mut s = state.lock().unwrap();
            // The first command starts from its own position: the engine eases the axis into it.
            let from = s.stroke.map_or(position, |m| m.at(now));
            s.stroke = Some(Move { from, to: position.clamp(0.0, 1.0), started: now, duration_ms });
            ok(id)
        }
        "StopDeviceCmd" | "StopAllDevices" => {
            state.lock().unwrap().stroke = None;
            ok(id)
        }
        other => error(id, &format!("{other} is not supported")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(name: &str, body: Value) -> Value {
        let mut body = body;
        body["Id"] = json!(7);
        json!({ name: body })
    }

    #[test]
    fn handshake_lists_one_stroker() {
        let state = Mutex::new(State::default());
        let info = handle(&cmd("RequestServerInfo", json!({ "ClientName": "faptap", "MessageVersion": 3 })), &state).unwrap();
        assert_eq!(info["ServerInfo"]["MessageVersion"], 3);
        assert_eq!(state.lock().unwrap().client.as_deref(), Some("faptap"));
        let list = handle(&cmd("RequestDeviceList", json!({})), &state).unwrap();
        let devices = list["DeviceList"]["Devices"].as_array().unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0]["DeviceMessages"]["LinearCmd"][0]["ActuatorType"], "Position");
        assert_eq!(handle(&cmd("StartScanning", json!({})), &state).unwrap()["Ok"]["Id"], 7);
    }

    #[test]
    fn linear_commands_move_over_their_duration_and_stop_releases() {
        let state = Mutex::new(State::default());
        handle(&cmd("LinearCmd", json!({ "DeviceIndex": 0, "Vectors": [{ "Index": 0, "Duration": 1000, "Position": 0.8 }] })), &state).unwrap();
        let first = state.lock().unwrap().stroke.unwrap();
        assert_eq!((first.from, first.to), (0.8, 0.8), "the first command is the position itself");
        // A second command starts from where the first one is now.
        let mut s = state.lock().unwrap();
        s.stroke = Some(Move { from: 0.0, to: 1.0, started: Instant::now() - Duration::from_millis(500), duration_ms: 1000.0 });
        drop(s);
        handle(&cmd("LinearCmd", json!({ "DeviceIndex": 0, "Vectors": [{ "Index": 0, "Duration": 200, "Position": 0.0 }] })), &state).unwrap();
        let second = state.lock().unwrap().stroke.unwrap();
        assert!((second.from - 0.5).abs() < 0.05, "from the stroke's current point: {}", second.from);
        assert_eq!(second.to, 0.0);
        assert!(second.at(second.started + Duration::from_millis(100)) < second.from);
        assert_eq!(second.at(second.started + Duration::from_secs(1)), 0.0);
        handle(&cmd("StopDeviceCmd", json!({ "DeviceIndex": 0 })), &state).unwrap();
        assert!(state.lock().unwrap().stroke.is_none());
    }

    #[test]
    fn unknown_messages_get_an_error_with_the_same_id() {
        let state = Mutex::new(State::default());
        let e = handle(&cmd("RawWriteCmd", json!({})), &state).unwrap();
        assert_eq!(e["Error"]["Id"], 7);
    }

    #[test]
    fn serves_a_client_over_websocket() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let server = IntifaceServer::start(port).unwrap();
        let (mut ws, _) = tungstenite::connect(format!("ws://127.0.0.1:{port}")).unwrap();
        ws.send(Message::Text(json!([{ "RequestServerInfo": { "Id": 1, "ClientName": "test", "MessageVersion": 3 } }]).to_string().into())).unwrap();
        let reply: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(reply[0]["ServerInfo"]["Id"], 1);
        ws.send(Message::Text(json!([{ "LinearCmd": { "Id": 2, "DeviceIndex": 0, "Vectors": [{ "Index": 0, "Duration": 0, "Position": 0.25 }] } }]).to_string().into())).unwrap();
        let reply: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(reply[0]["Ok"]["Id"], 2);
        assert_eq!(server.stroke_at(Instant::now()), Some(0.25));
        assert_eq!(server.status().client.as_deref(), Some("test"));
        ws.close(None).unwrap();
        let _ = ws.read();
        let gone = Instant::now() + Duration::from_secs(2);
        while server.stroke_at(Instant::now()).is_some() && Instant::now() < gone {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(server.stroke_at(Instant::now()), None, "the client leaving releases the stroke");
    }
}
