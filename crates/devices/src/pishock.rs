//! PiShock account devices over the V2 broker. The worker reads a latest-value mailbox;
//! commands expire rather than accumulating when the network stalls.
use crate::openshock::{OpenShockControl, OpenShockTrigger};
use bp_script::Axis;
use serde_json::{Value, json};
use std::{
    io,
    net::{TcpStream, ToSocketAddrs},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, stream::MaybeTlsStream};

const PULSE: Duration = Duration::from_millis(300);
const REPEAT: Duration = Duration::from_millis(200);
const POLL: Duration = Duration::from_millis(20);

#[derive(Clone, Copy, PartialEq, Debug)]
struct Command {
    control: OpenShockControl,
    intensity: u8,
}
#[derive(Default)]
struct Mailbox {
    command: Option<(Command, Instant)>,
    test: Option<(Command, Instant)>,
}
impl Mailbox {
    fn desired(&self, now: Instant) -> Option<Command> {
        self.test
            .filter(|(_, until)| *until > now)
            .or(self.command.filter(|(_, until)| *until > now))
            .map(|(c, _)| c)
    }
}

pub struct PiShockLink {
    mailbox: Arc<Mutex<Mailbox>>,
    closed: Arc<AtomicBool>,
    errors: Receiver<String>,
    trigger: OpenShockTrigger,
    was_playing: bool,
    pub device: String,
}

fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn payload(client: u32, shocker: u32, user: u32, command: Option<Command>) -> Value {
    let (mode, intensity, duration) = match command {
        Some(c) => (
            match c.control {
                OpenShockControl::Shock => "s",
                OpenShockControl::Vibrate => "v",
                OpenShockControl::Sound => "b",
            },
            c.intensity,
            300,
        ),
        None => ("e", 0, 0),
    };
    json!({"Operation":"PUBLISH","PublishCommands":[{"Target":format!("c{client}-ops"),"Body":{
        "id":shocker,"m":mode,"i":intensity,"d":duration,"r":true,
        "l":{"u":user,"ty":"api","w":false,"h":false,"o":"BetterPlayer"}
    }}]})
}

fn handshake(
    url: &str,
    timeout: Duration,
) -> io::Result<tungstenite::WebSocket<MaybeTlsStream<TcpStream>>> {
    let failed = || io::Error::other("PiShock connection failed");
    let request = url.into_client_request().map_err(|_| failed())?;
    let uri = request.uri();
    let host = uri.host().ok_or_else(failed)?;
    let port = uri
        .port_u16()
        .unwrap_or(if uri.scheme_str() == Some("wss") {
            443
        } else {
            80
        });
    let addresses = (host, port).to_socket_addrs().map_err(|_| failed())?;
    let deadline = Instant::now() + timeout;
    let mut stream = None;
    for address in addresses {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if let Ok(tcp) = TcpStream::connect_timeout(&address, remaining) {
            stream = Some(tcp);
            break;
        }
    }
    let stream = stream.ok_or_else(failed)?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(failed());
    }
    stream.set_read_timeout(Some(remaining))?;
    stream.set_write_timeout(Some(remaining))?;
    stream.set_nodelay(true)?;
    // Never expose transport errors containing the credential-bearing URL.
    tungstenite::client_tls_with_config(request, stream, None, None)
        .map(|(socket, _)| socket)
        .map_err(|_| failed())
}

impl PiShockLink {
    pub fn connect(
        username: &str,
        key: &str,
        user: u32,
        client: u32,
        shocker: u32,
        trigger: OpenShockTrigger,
    ) -> io::Result<Self> {
        if username.trim().is_empty()
            || key.trim().is_empty()
            || user == 0
            || client == 0
            || shocker == 0
        {
            return Err(io::Error::other(
                "PiShock credentials or device IDs are missing",
            ));
        }
        let url = format!(
            "wss://broker.pishock.com/v2?Username={}&ApiKey={}",
            encode_component(username),
            encode_component(key)
        );
        Self::connect_url(&url, user, client, shocker, trigger)
    }

    fn connect_url(
        url: &str,
        user: u32,
        client: u32,
        shocker: u32,
        trigger: OpenShockTrigger,
    ) -> io::Result<Self> {
        let mut socket = handshake(url, Duration::from_secs(5))?;
        let tcp: &TcpStream = match socket.get_mut() {
            MaybeTlsStream::Plain(s) => s,
            MaybeTlsStream::NativeTls(s) => s.get_ref(),
            _ => return Err(io::Error::other("Unsupported PiShock TLS transport")),
        };
        tcp.set_read_timeout(Some(POLL))?;
        tcp.set_write_timeout(Some(Duration::from_millis(200)))?;
        let mailbox = Arc::new(Mutex::new(Mailbox::default()));
        let closed = Arc::new(AtomicBool::new(false));
        let (error_tx, errors) = mpsc::channel();
        let (pending, stop) = (mailbox.clone(), closed.clone());
        thread::Builder::new()
            .name("bp-pishock".into())
            .spawn(move || {
                let mut active: Option<Command> = None;
                let mut last = None;
                let mut last_test = None;
                let mut ping = Instant::now();
                let mut pending_reply: Option<Instant> = None;
                let result: Result<(), ()> = (|| {
                    loop {
                        let now = Instant::now();
                        let closing = stop.load(Ordering::Acquire);
                        let (desired, test_until) = if closing {
                            (None, None)
                        } else {
                            let mailbox = pending.lock().unwrap();
                            (
                                mailbox.desired(now),
                                mailbox
                                    .test
                                    .filter(|(_, until)| *until > now)
                                    .map(|(_, until)| until),
                            )
                        };
                        if pending_reply
                            .is_some_and(|at| now.duration_since(at) > Duration::from_secs(5))
                        {
                            return Err(());
                        }
                        if active.is_some() && desired != active {
                            socket
                                .send(Message::Text(
                                    payload(client, shocker, user, None).to_string().into(),
                                ))
                                .map_err(|_| ())?;
                            pending_reply.get_or_insert(now);
                            active = None;
                            continue;
                        }
                        if desired.is_some()
                            && (test_until.is_none() || test_until != last_test)
                            && last.is_none_or(|at| now.duration_since(at) >= REPEAT)
                        {
                            socket
                                .send(Message::Text(
                                    payload(client, shocker, user, desired).to_string().into(),
                                ))
                                .map_err(|_| ())?;
                            pending_reply.get_or_insert(now);
                            active = desired;
                            last = Some(now);
                            last_test = test_until;
                        }
                        if closing {
                            let _ = socket.close(None);
                            return Ok(());
                        }
                        if ping.elapsed() >= Duration::from_secs(20) {
                            socket
                                .send(Message::Text(
                                    json!({"Operation":"PING"}).to_string().into(),
                                ))
                                .map_err(|_| ())?;
                            pending_reply.get_or_insert(now);
                            ping = now;
                        }
                        match socket.read() {
                            Ok(Message::Text(text)) => {
                                let value: Value = serde_json::from_str(&text).map_err(|_| ())?;
                                if value.get("IsError").and_then(Value::as_bool) != Some(false) {
                                    return Err(());
                                }
                                pending_reply = None;
                            }
                            Ok(Message::Close(_)) => return Err(()),
                            Ok(Message::Ping(_)) => {
                                socket.flush().map_err(|_| ())?;
                            }
                            Ok(_) => {}
                            Err(tungstenite::Error::Io(e))
                                if matches!(
                                    e.kind(),
                                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                                ) => {}
                            Err(_) => return Err(()),
                        }
                    }
                })();
                if result.is_err() {
                    // A failed write may still be buffered by tungstenite. Never write again
                    // on this socket: even an end command could flush that old pulse first.
                    let _ = error_tx.send("PiShock connection or command failed".into());
                }
            })?;
        Ok(Self {
            mailbox,
            closed,
            errors,
            trigger,
            was_playing: false,
            device: format!("PiShock {shocker}"),
        })
    }

    pub fn poll(&mut self) -> Result<(), String> {
        match self.errors.try_recv() {
            Ok(e) => Err(e),
            Err(mpsc::TryRecvError::Empty) => Ok(()),
            Err(mpsc::TryRecvError::Disconnected) => Err("PiShock worker stopped".into()),
        }
    }
    pub fn set_trigger(&mut self, trigger: OpenShockTrigger) {
        *self.mailbox.lock().unwrap() = Mailbox::default();
        self.trigger = trigger;
    }
    pub fn tick_scaled(
        &mut self,
        values: &[f64; Axis::COUNT],
        driven: &[bool; Axis::COUNT],
        playing: bool,
        scale: f64,
    ) -> bool {
        let i = self.trigger.axis.index();
        let intensity = (f64::from(self.trigger.intensity) * scale.clamp(0.0, 1.0)).floor() as u8;
        let command = (playing
            && driven[i]
            && values[i].is_finite()
            && self.trigger.past(values[i])
            && intensity > 0)
            .then_some((
                Command {
                    control: self.trigger.control,
                    intensity,
                },
                Instant::now() + PULSE,
            ));
        let mut mailbox = self.mailbox.lock().unwrap();
        if (self.was_playing && !playing) || !scale.is_finite() || scale <= 0.0 {
            mailbox.test = None;
        }
        self.was_playing = playing;
        mailbox.command = command;
        command.is_some()
    }
    pub fn pulse(&mut self, scale: f64) -> bool {
        let intensity = (f64::from(self.trigger.intensity) * scale.clamp(0.0, 1.0)).floor() as u8;
        if intensity == 0 {
            return false;
        }
        self.mailbox.lock().unwrap().test = Some((
            Command {
                control: self.trigger.control,
                intensity,
            },
            Instant::now() + PULSE,
        ));
        true
    }
}
impl Drop for PiShockLink {
    fn drop(&mut self) {
        *self.mailbox.lock().unwrap() = Mailbox::default();
        self.closed.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unresponsive_handshake_times_out() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (release, wait) = mpsc::channel::<()>();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            let _ = wait.recv_timeout(Duration::from_secs(2));
        });
        let started = Instant::now();
        assert!(handshake(&url, Duration::from_millis(50)).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        let _ = release.send(());
        server.join().unwrap();
    }

    #[test]
    fn expires_old_commands_and_keeps_test_pulses_separate() {
        let now = Instant::now();
        let c = Command {
            control: OpenShockControl::Vibrate,
            intensity: 10,
        };
        let mut mailbox = Mailbox {
            command: Some((c, now + PULSE)),
            test: None,
        };
        assert_eq!(mailbox.desired(now), Some(c));
        assert_eq!(mailbox.desired(now + PULSE), None);
        mailbox.test = Some((c, now + PULSE));
        mailbox.command = None;
        assert_eq!(mailbox.desired(now), Some(c));
        assert_eq!(mailbox.desired(now + PULSE), None);
    }

    #[test]
    fn broker_receives_pulse_then_end_on_pause_and_disconnect() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (sent, received) = mpsc::channel();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            while let Ok(message) = ws.read() {
                if let Message::Text(text) = message {
                    let v: Value = serde_json::from_str(&text).unwrap();
                    sent.send(v).unwrap();
                    ws.send(Message::Text(
                        json!({"IsError":false,"Message":"Publish successful."})
                            .to_string()
                            .into(),
                    ))
                    .unwrap();
                }
            }
        });
        let mut link =
            PiShockLink::connect_url(&url, 56, 12, 34, OpenShockTrigger::default()).unwrap();
        let mut values = [0.0; Axis::COUNT];
        let mut driven = [false; Axis::COUNT];
        values[Axis::L0.index()] = 1.0;
        driven[Axis::L0.index()] = true;
        assert!(!link.tick_scaled(&values, &driven, true, 1.0));
        assert!(received.recv_timeout(Duration::from_millis(60)).is_err());
        values[Axis::S0.index()] = 1.0;
        driven[Axis::S0.index()] = true;
        assert!(link.tick_scaled(&values, &driven, true, 1.0));
        let read_mode = || {
            received.recv_timeout(Duration::from_secs(2)).unwrap()["PublishCommands"][0]["Body"]["m"].as_str().unwrap().to_string()
        };
        assert_eq!(read_mode(), "v");
        link.tick_scaled(&values, &driven, false, 1.0);
        assert_eq!(read_mode(), "e");
        // The wizard can test while paused without the next tick cancelling its pulse.
        assert!(link.pulse(1.0));
        link.tick_scaled(&values, &driven, false, 1.0);
        assert_eq!(read_mode(), "v");
        link.tick_scaled(&values, &driven, false, 0.0);
        assert_eq!(read_mode(), "e");
        assert!(!link.pulse(0.0));
        assert!(received.recv_timeout(Duration::from_millis(60)).is_err());
        assert!(link.pulse(0.5));
        let pulse = received.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(pulse["PublishCommands"][0]["Body"]["i"], 12);
        // A manual test is one 300 ms pulse, not a second pulse at the repeat interval.
        assert_eq!(read_mode(), "e");
        assert!(link.pulse(1.0));
        assert_eq!(read_mode(), "v");
        drop(link);
        assert_eq!(read_mode(), "e");
        server.join().unwrap();
    }

    #[test]
    fn broker_payloads_and_credentials() {
        let p = payload(
            12,
            34,
            56,
            Some(Command {
                control: OpenShockControl::Shock,
                intensity: 7,
            }),
        );
        assert_eq!(p["PublishCommands"][0]["Target"], "c12-ops");
        assert_eq!(p["PublishCommands"][0]["Body"]["d"], 300);
        assert_eq!(p["PublishCommands"][0]["Body"]["m"], "s");
        assert_eq!(
            payload(12, 34, 56, None)["PublishCommands"][0]["Body"]["m"],
            "e"
        );
        assert_eq!(encode_component("name +&?"), "name%20%2B%26%3F");
    }
}
