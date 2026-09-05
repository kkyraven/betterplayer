use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Deserialize;


const RETRY: Duration = Duration::from_secs(2);

const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);

const READ_TIMEOUT: Duration = Duration::from_millis(100);

const KEEP_ALIVE: Duration = Duration::from_secs(1);

const MAX_FRAME: usize = 1 << 20;


#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowKind {
    DeoVr,
    HereSphere,
    Whirligig,
}

impl FollowKind {
    pub fn from_str(s: &str) -> Option<FollowKind> {
        match s {
            "deovr" => Some(FollowKind::DeoVr),
            "heresphere" => Some(FollowKind::HereSphere),
            "whirligig" => Some(FollowKind::Whirligig),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            FollowKind::DeoVr => "deovr",
            FollowKind::HereSphere => "heresphere",
            FollowKind::Whirligig => "whirligig",
        }
    }

    pub fn default_port(self) -> u16 {
        match self {
            FollowKind::DeoVr | FollowKind::HereSphere => 23554,
            FollowKind::Whirligig => 2000,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FollowStatus {
    Connecting,
    Connected,
    Error(String),
}


#[derive(Clone, Debug, PartialEq)]
pub enum FollowEvent {
    Path(Option<String>),
    Playing(bool),
    Time(f64),
    Duration(f64),
    Speed(f64),
    Status(FollowStatus),
}

#[derive(Clone, Debug)]
pub struct FollowState {
    pub kind: FollowKind,
    pub address: String,
    pub status: FollowStatus,

    pub path: Option<String>,
    pub playing: bool,
    pub time_ms: f64,
    pub duration_ms: f64,
    pub rate: f64,
}

pub type FollowSink = Arc<dyn Fn(FollowEvent) + Send + Sync>;



#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeoFrame {
    pub path: Option<String>,
    pub resource: Option<String>,

    pub player_state: Option<i32>,
    pub duration: Option<f64>,
    pub current_time: Option<f64>,
    pub playback_speed: Option<f64>,
}

impl DeoFrame {
    pub fn identity(&self) -> Option<String> {
        self.resource
            .clone()
            .or_else(|| self.path.clone())
            .filter(|s| !s.is_empty())
    }

    pub fn playing(&self) -> bool {
        self.player_state == Some(0)
    }
}



#[derive(Default)]
struct Frames {
    buf: Vec<u8>,
}

impl Frames {
    fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }


    fn next(&mut self) -> Result<Option<Vec<u8>>, String> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = i32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]);
        if len < 0 || len as usize > MAX_FRAME {
            return Err(format!("frame length {len} out of range"));
        }
        let len = len as usize;
        if self.buf.len() < 4 + len {
            return Ok(None);
        }
        let payload = self.buf[4..4 + len].to_vec();
        self.buf.drain(..4 + len);
        Ok(Some(payload))
    }
}



fn whirligig_line(line: &str) -> Vec<FollowEvent> {
    let line = line.trim_end_matches(['\r', '\n']);
    if let Some(rest) = line.strip_prefix("duration=") {
        return match rest.trim().parse::<f64>() {
            Ok(s) => vec![FollowEvent::Duration(s * 1000.0)],
            Err(_) => Vec::new(),
        };
    }
    match line.as_bytes().first() {
        Some(b'C') => {
            let path = line[1..].trim();
            vec![FollowEvent::Path(
                (!path.is_empty()).then(|| path.to_string()),
            )]
        }
        Some(b'S') => vec![FollowEvent::Playing(false)],
        Some(b'P') => match line[1..].trim().parse::<f64>() {
            Ok(s) => vec![FollowEvent::Time(s * 1000.0), FollowEvent::Playing(true)],
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    }
}

struct Inner {
    state: Mutex<FollowState>,
    stop: AtomicBool,
    sink: FollowSink,
}

impl Inner {
    fn stopping(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }



    fn emit(&self, e: FollowEvent) {
        {
            let mut s = self.state.lock().unwrap();
            match &e {
                FollowEvent::Path(p) => s.path = p.clone(),
                FollowEvent::Playing(p) => s.playing = *p,
                FollowEvent::Time(t) => s.time_ms = *t,
                FollowEvent::Duration(d) => s.duration_ms = *d,
                FollowEvent::Speed(r) => s.rate = *r,
                FollowEvent::Status(st) => s.status = st.clone(),
            }
        }
        (self.sink)(e);
    }



    fn apply(&self, e: FollowEvent) {
        let changed = {
            let s = self.state.lock().unwrap();
            match &e {
                FollowEvent::Path(p) => *p != s.path,
                FollowEvent::Playing(p) => *p != s.playing,
                FollowEvent::Duration(d) => *d != s.duration_ms,
                FollowEvent::Speed(r) => *r != s.rate,
                FollowEvent::Status(st) => *st != s.status,
                FollowEvent::Time(_) => true,
            }
        };
        if changed {
            self.emit(e);
        }
    }

    fn on_deo_frame(&self, f: &DeoFrame) {
        self.apply(FollowEvent::Path(f.identity()));
        if let Some(d) = f.duration {
            self.apply(FollowEvent::Duration(d * 1000.0));
        }
        if let Some(s) = f.playback_speed.filter(|s| *s > 0.0) {
            self.apply(FollowEvent::Speed(s));
        }
        if let Some(t) = f.current_time {
            self.apply(FollowEvent::Time(t * 1000.0));
        }
        self.apply(FollowEvent::Playing(f.playing()));
    }
}


pub struct Follow {
    inner: Arc<Inner>,
    thread: Option<JoinHandle<()>>,
}

impl Follow {

    pub fn start(kind: FollowKind, host: &str, port: u16, sink: FollowSink) -> Follow {
        let address = format!("{host}:{port}");
        let inner = Arc::new(Inner {
            state: Mutex::new(FollowState {
                kind,
                address: address.clone(),
                status: FollowStatus::Connecting,
                path: None,
                playing: false,
                time_ms: 0.0,
                duration_ms: 0.0,
                rate: 1.0,
            }),
            stop: AtomicBool::new(false),
            sink,
        });
        let spawned = {
            let inner = inner.clone();
            thread::Builder::new()
                .name("bp-follow".into())
                .spawn(move || run(&inner, kind, &address))
        };
        let thread = match spawned {
            Ok(t) => Some(t),
            Err(e) => {
                inner.apply(FollowEvent::Status(FollowStatus::Error(e.to_string())));
                None
            }
        };
        Follow { inner, thread }
    }

    pub fn state(&self) -> FollowState {
        self.inner.state.lock().unwrap().clone()
    }

    pub fn stop(&mut self) {
        self.inner.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Follow {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(inner: &Arc<Inner>, kind: FollowKind, address: &str) {
    while !inner.stopping() {
        inner.apply(FollowEvent::Status(FollowStatus::Connecting));
        let result = match connect(address) {
            Ok(stream) => {
                inner.apply(FollowEvent::Status(FollowStatus::Connected));
                match kind {
                    FollowKind::Whirligig => read_whirligig(inner, stream),
                    FollowKind::DeoVr | FollowKind::HereSphere => read_deo(inner, stream),
                }
            }
            Err(e) => Err(e),
        };
        if let Err(e) = result {
            inner.apply(FollowEvent::Status(FollowStatus::Error(e)));
        }
        if inner.stopping() {
            break;
        }

        inner.apply(FollowEvent::Playing(false));
        sleep_until_stop(inner, RETRY);
    }
}

fn connect(address: &str) -> Result<TcpStream, String> {
    let addr = address
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or_else(|| format!("cannot resolve {address}"))?;
    let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(READ_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

fn read_deo(inner: &Arc<Inner>, mut stream: TcpStream) -> Result<(), String> {
    let mut frames = Frames::default();
    let mut buf = [0u8; 8192];
    stream.write_all(&[0u8; 4]).map_err(|e| e.to_string())?;
    let mut last_ping = Instant::now();
    while !inner.stopping() {
        if last_ping.elapsed() >= KEEP_ALIVE {
            stream.write_all(&[0u8; 4]).map_err(|e| e.to_string())?;
            last_ping = Instant::now();
        }
        match stream.read(&mut buf) {
            Ok(0) => return Err("connection closed".into()),
            Ok(n) => {
                frames.push(&buf[..n]);
                while let Some(payload) = frames.next()? {
                    if payload.is_empty() {
                        inner.apply(FollowEvent::Path(None));
                        inner.apply(FollowEvent::Playing(false));
                        continue;
                    }
                    match serde_json::from_slice::<DeoFrame>(&payload) {
                        Ok(f) => inner.on_deo_frame(&f),
                        Err(e) => return Err(format!("bad frame: {e}")),
                    }
                }
            }
            Err(e) if timed_out(&e) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

fn read_whirligig(inner: &Arc<Inner>, mut stream: TcpStream) -> Result<(), String> {
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    while !inner.stopping() {
        match stream.read(&mut buf) {
            Ok(0) => return Err("connection closed".into()),
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                while let Some(i) = pending.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = pending.drain(..=i).collect();
                    for e in whirligig_line(&String::from_utf8_lossy(&line)) {
                        inner.apply(e);
                    }
                }
                if pending.len() > MAX_FRAME {
                    return Err("line too long".into());
                }
            }
            Err(e) if timed_out(&e) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}


fn timed_out(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    )
}

fn sleep_until_stop(inner: &Arc<Inner>, total: Duration) {
    let until = Instant::now() + total;
    while !inner.stopping() && Instant::now() < until {
        thread::sleep(READ_TIMEOUT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn frame(json: &str) -> Vec<u8> {
        let mut out = (json.len() as i32).to_le_bytes().to_vec();
        out.extend_from_slice(json.as_bytes());
        out
    }

    #[test]
    fn splits_length_prefixed_frames() {
        let mut f = Frames::default();
        assert_eq!(f.next().unwrap(), None);


        let mut bytes = frame(r#"{"path":"a.mp4"}"#);
        bytes.extend_from_slice(&[0u8; 4]);
        f.push(&bytes);
        let first = f.next().unwrap().expect("first frame");
        assert_eq!(
            serde_json::from_slice::<DeoFrame>(&first)
                .unwrap()
                .identity()
                .as_deref(),
            Some("a.mp4")
        );
        assert_eq!(f.next().unwrap(), Some(Vec::new()));
        assert_eq!(f.next().unwrap(), None);


        let bytes = frame(r#"{"currentTime":1.5}"#);
        f.push(&bytes[..6]);
        assert_eq!(f.next().unwrap(), None);
        f.push(&bytes[6..]);
        let payload = f.next().unwrap().expect("split frame");
        assert_eq!(
            serde_json::from_slice::<DeoFrame>(&payload)
                .unwrap()
                .current_time,
            Some(1.5)
        );

        f.push(&(-1i32).to_le_bytes());
        assert!(f.next().is_err());
    }

    #[test]
    fn heresphere_prefers_resource_over_path() {
        let f: DeoFrame =
            serde_json::from_str(r#"{"path":"/dl/1","resource":"/v/a.mp4","playerState":1}"#)
                .unwrap();
        assert_eq!(f.identity().as_deref(), Some("/v/a.mp4"));
        assert_eq!(f.path.as_deref(), Some("/dl/1"));
        assert!(!f.playing());
    }

    #[test]
    fn parses_whirligig_lines() {
        assert_eq!(
            whirligig_line("C /movies/a.mp4\r\n"),
            vec![FollowEvent::Path(Some("/movies/a.mp4".into()))]
        );
        assert_eq!(whirligig_line("C\n"), vec![FollowEvent::Path(None)]);
        assert_eq!(whirligig_line("S\n"), vec![FollowEvent::Playing(false)]);
        assert_eq!(
            whirligig_line("P 12.5\n"),
            vec![FollowEvent::Time(12_500.0), FollowEvent::Playing(true)]
        );
        assert_eq!(
            whirligig_line("duration=90.5\n"),
            vec![FollowEvent::Duration(90_500.0)]
        );
        assert!(whirligig_line("P nonsense\n").is_empty());
        assert!(whirligig_line("something else\n").is_empty());
    }

    #[test]
    fn follows_a_mock_deovr_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            s.write_all(&frame(r#"{"path":"/v/a.mp4","playerState":0,"duration":120,"currentTime":30,"playbackSpeed":1.0}"#)).unwrap();
            thread::sleep(Duration::from_millis(50));
            s.write_all(&frame(r#"{"path":"/v/a.mp4","playerState":1,"duration":120,"currentTime":31.5,"playbackSpeed":1.0}"#)).unwrap();

            thread::sleep(Duration::from_millis(500));
        });

        let events: Arc<Mutex<Vec<FollowEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: FollowSink = {
            let events = events.clone();
            Arc::new(move |e| events.lock().unwrap().push(e))
        };
        let mut follow = Follow::start(FollowKind::DeoVr, "127.0.0.1", port, sink);

        let until = Instant::now() + Duration::from_secs(5);
        while follow.state().time_ms != 31_500.0 && Instant::now() < until {
            thread::sleep(Duration::from_millis(10));
        }
        let state = follow.state();
        follow.stop();
        server.join().unwrap();

        assert_eq!(state.status, FollowStatus::Connected);
        assert_eq!(state.address, format!("127.0.0.1:{port}"));
        assert_eq!(state.path.as_deref(), Some("/v/a.mp4"));
        assert_eq!(state.duration_ms, 120_000.0);
        assert_eq!(state.time_ms, 31_500.0);
        assert!(!state.playing, "the second frame paused it");

        let events = events.lock().unwrap().clone();

        assert_eq!(events[0], FollowEvent::Status(FollowStatus::Connected));
        assert!(events.contains(&FollowEvent::Path(Some("/v/a.mp4".into()))));
        assert!(events.contains(&FollowEvent::Duration(120_000.0)));
        assert!(events.contains(&FollowEvent::Time(30_000.0)));
        assert!(events.contains(&FollowEvent::Playing(true)));
        assert!(events.contains(&FollowEvent::Playing(false)));

        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, FollowEvent::Path(_)))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, FollowEvent::Duration(_)))
                .count(),
            1
        );
    }
}
