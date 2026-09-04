//! The Handy over HSSP: the script is hosted (uploaded to the cloud or served from a LAN
//! thread), the device fetches it once, and we only send play, stop and time sync. Driving
//! it per action over the cloud is what makes other players stutter, so we never do it.
//!
//! Without an app key this speaks API v2, with one API v3, which adds `synctime` drift
//! correction and a playback rate. Every request runs on a worker thread; the tick thread
//! only queues commands.

use std::fmt::Write as _;
use std::io::{self, ErrorKind, Read, Write as _};
use std::net::{Ipv4Addr, TcpListener, TcpStream, UdpSocket};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bp_script::{Axis, Script};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use ureq::Agent;

use crate::output::TickContext;
use crate::tcode::AxisClamp;

const TIMEOUT: Duration = Duration::from_secs(5);
/// Clock offset samples and how many to drop from each end of the sorted list.
const OFFSET_SAMPLES: usize = 30;
const OFFSET_TRIM: usize = 3;
/// A position error this large is a seek, not drift, so the Handy is told to play again.
const SEEK_MS: f64 = 1000.0;
const SYNC_EVERY: Duration = Duration::from_secs(10);

/// Where the Handy fetches the script from: the Handy's own script host, or an HTTP thread
/// on this machine.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HandyHosting {
    Cloud,
    Lan,
}

/// API and upload hosts. The real Handy services in the app, a mock server in tests.
#[derive(Clone, Debug)]
struct Endpoints {
    v2: String,
    v3: String,
    upload: String,
}

impl Default for Endpoints {
    fn default() -> Endpoints {
        Endpoints {
            v2: "https://www.handyfeeling.com/api/handy/v2/".into(),
            v3: "https://www.handyfeeling.com/api/handy-rest/v3/".into(),
            upload: "https://www.handyfeeling.com/api/hosting/v2/upload".into(),
        }
    }
}

/// Work the HTTP thread does for the tick thread.
enum Cmd {
    /// Host these funscript bytes and point the Handy at them.
    Setup(Vec<u8>),
    Play { media_ms: f64, rate: f64 },
    Stop,
    Sync { media_ms: f64 },
    /// Device travel limits, 0..1.
    Slide { min: f64, max: f64 },
}

/// What the HTTP thread sends back, drained in `poll`.
enum Reply {
    /// The Handy has the script and can be played.
    Ready,
    Log(String),
    Error(String),
}

/// A connected Handy. Holds the command channel to the HTTP worker plus the playback state
/// the tick compares against.
pub struct HandyLink {
    cmd: Sender<Cmd>,
    reply: Receiver<Reply>,
    /// Model and firmware from `info`, shown as the output's device.
    pub device: String,
    v3: bool,
    ready: bool,
    playing: bool,
    /// Media time and wall clock at the last play, so drift and seeks are visible.
    play_ms: f64,
    play_at: Instant,
    rate: f64,
    slide: Option<(f64, f64)>,
    last_sync: Instant,
    sync_every: Duration,
}

impl HandyLink {
    /// Checks the firmware, switches to HSSP and measures the clock offset before returning.
    /// Blocks for the whole handshake; call it off the tick thread.
    pub fn connect(key: &str, app_key: Option<&str>, hosting: HandyHosting) -> io::Result<HandyLink> {
        Self::connect_to(key, app_key, hosting, Endpoints::default())
    }

    fn connect_to(key: &str, app_key: Option<&str>, hosting: HandyHosting, ep: Endpoints) -> io::Result<HandyLink> {
        let agent: Agent = Agent::config_builder().timeout_global(Some(TIMEOUT)).build().into();
        let v3 = app_key.is_some();
        let mut api = Api {
            agent,
            base: if v3 { ep.v3.clone() } else { ep.v2.clone() },
            key: key.to_string(),
            token: None,
            offset: 0.0,
            v3,
        };
        let device = api.handshake(app_key).map_err(io::Error::other)?;

        let (cmd, cmd_rx) = channel();
        let (reply_tx, reply) = channel();
        let upload = ep.upload.clone();
        thread::Builder::new()
            .name("bp-handy".into())
            .spawn(move || worker(api, hosting, upload, cmd_rx, reply_tx))
            .map_err(io::Error::other)?;

        let now = Instant::now();
        Ok(HandyLink {
            cmd,
            reply,
            device,
            v3,
            ready: false,
            playing: false,
            play_ms: 0.0,
            play_at: now,
            rate: 1.0,
            slide: None,
            last_sync: now,
            sync_every: SYNC_EVERY,
        })
    }

    /// Drains the worker's replies. Log lines go to the output's received list, errors put
    /// the output into its usual retry cycle.
    pub fn poll(&mut self) -> Result<Vec<String>, String> {
        let mut logs = Vec::new();
        loop {
            match self.reply.try_recv() {
                Ok(Reply::Ready) => {
                    self.ready = true;
                    self.playing = false;
                }
                Ok(Reply::Log(line)) => logs.push(line),
                Ok(Reply::Error(e)) => return Err(e),
                Err(TryRecvError::Empty) => return Ok(logs),
                Err(TryRecvError::Disconnected) => return Err("the Handy worker stopped".into()),
            }
        }
    }

    /// Hosts the stroke script for the Handy to fetch; `None` when the media has none.
    pub fn set_stroke(&mut self, script: Option<&Script>) {
        self.ready = false;
        if self.playing {
            self.playing = false;
            self.send(Cmd::Stop);
        }
        if let Some(script) = script.filter(|s| !s.is_empty()) {
            self.send(Cmd::Setup(funscript_json(script).into_bytes()));
        }
    }

    /// One tick of the playback state machine: start, stop, play again after a seek or a rate
    /// change, and the v3 drift correction. Never blocks.
    pub fn tick(&mut self, ctx: &TickContext, clamps: &[AxisClamp; Axis::COUNT]) {
        let c = clamps[Axis::L0.index()];
        let slide = if c.enabled { (c.min, c.max) } else { (0.0, 1.0) };
        if self.slide != Some(slide) {
            self.slide = Some(slide);
            self.send(Cmd::Slide { min: slide.0, max: slide.1 });
        }
        if !self.ready {
            return;
        }
        if !ctx.playing {
            if self.playing {
                self.playing = false;
                self.send(Cmd::Stop);
            }
            return;
        }
        let seeked = self.playing && (ctx.media_ms - self.expected_ms()).abs() > SEEK_MS;
        // v2 has no playback rate, so a rate change there shows up as drift instead.
        let rate_changed = self.playing && self.v3 && (ctx.rate - self.rate).abs() > 0.01;
        if !self.playing || seeked || rate_changed {
            self.playing = true;
            self.play_ms = ctx.media_ms;
            self.play_at = Instant::now();
            self.rate = ctx.rate;
            self.last_sync = Instant::now();
            self.send(Cmd::Play { media_ms: ctx.media_ms, rate: ctx.rate });
        } else if self.v3 && self.last_sync.elapsed() >= self.sync_every {
            self.last_sync = Instant::now();
            self.send(Cmd::Sync { media_ms: ctx.media_ms });
        }
    }

    /// Where the Handy should be now, from the last play command. v2 always advances at 1x.
    fn expected_ms(&self) -> f64 {
        let rate = if self.v3 { self.rate } else { 1.0 };
        self.play_ms + self.play_at.elapsed().as_secs_f64() * 1000.0 * rate
    }

    fn send(&self, cmd: Cmd) {
        let _ = self.cmd.send(cmd);
    }
}

impl Drop for HandyLink {
    /// Asks the Handy to stop and lets the worker finish on its own, so no thread waits.
    fn drop(&mut self) {
        self.send(Cmd::Stop);
    }
}

/// The HTTP thread: one request at a time, in the order the tick queued them. It ends when
/// the link is dropped and the command channel closes.
fn worker(api: Api, hosting: HandyHosting, upload: String, cmd: Receiver<Cmd>, reply: Sender<Reply>) {
    let mut lan: Option<LanScript> = None;
    for c in cmd {
        let done = match c {
            Cmd::Setup(bytes) => host(&api, hosting, &upload, &bytes, &mut lan).and_then(|url| {
                let _ = reply.send(Reply::Log(format!("script at {url}")));
                api.setup(&url, &bytes).map(|()| Some(Reply::Ready))
            }),
            Cmd::Play { media_ms, rate } => api.play(media_ms, rate).map(|()| None),
            Cmd::Stop => api.stop().map(|()| None),
            Cmd::Sync { media_ms } => api.sync(media_ms).map(|()| None),
            Cmd::Slide { min, max } => api.slide(min, max).map(|()| None),
        };
        let sent = match done {
            Ok(Some(r)) => reply.send(r),
            Ok(None) => Ok(()),
            Err(e) => reply.send(Reply::Error(e)),
        };
        if sent.is_err() {
            return;
        }
    }
}

/// Puts the script somewhere the Handy can fetch it and returns that URL.
fn host(api: &Api, hosting: HandyHosting, upload: &str, bytes: &[u8], lan: &mut Option<LanScript>) -> Result<String, String> {
    match hosting {
        HandyHosting::Cloud => {
            *lan = None;
            upload_script(&api.agent, upload, bytes)
        }
        HandyHosting::Lan => {
            let server = LanScript::start(bytes.to_vec())?;
            let url = server.url.clone();
            *lan = Some(server);
            Ok(url)
        }
    }
}

/// One HTTP conversation with the Handy: base URL, auth headers and the measured offset
/// between the Handy service's clock and ours.
struct Api {
    agent: Agent,
    base: String,
    key: String,
    token: Option<String>,
    offset: f64,
    v3: bool,
}

impl Api {
    /// Identifies the device, puts it in HSSP mode and learns the clock offset. Returns the
    /// device name for the UI.
    fn handshake(&mut self, app_key: Option<&str>) -> Result<String, String> {
        match app_key {
            Some(app_key) => {
                self.token = Some(self.issue_token(app_key)?);
                let device = self.get("info").map(|i| device_name(&i)).unwrap_or_else(|_| "Handy".into());
                let time = self.get("hstp/time")?;
                self.offset = time.get("clock_offset").and_then(Value::as_f64).unwrap_or(0.0);
                Ok(device)
            }
            None => {
                if self.get("connected")?.get("connected").and_then(Value::as_bool) != Some(true) {
                    return Err("the Handy is not online; check the connection key".into());
                }
                let info = self.get("info")?;
                if info.get("fwStatus").and_then(Value::as_i64) == Some(1) {
                    return Err("firmware update required; update the Handy in the Handy app".into());
                }
                self.put("mode", json!({ "mode": 1 }))?;
                self.offset = self.measure_offset()?;
                Ok(device_name(&info))
            }
        }
    }

    /// v3 trades the app key for a device token that every later request carries.
    fn issue_token(&self, app_key: &str) -> Result<String, String> {
        let path = "auth/token/issue";
        let url = format!("{}{path}?ttl=86400&to={}", self.base, self.key);
        let res = self.agent.get(url).header("X-Api-Key", app_key).call().map_err(|e| format!("{path}: {e}"))?;
        let v = read_json(path, res)?;
        v.get("token").and_then(Value::as_str).map(str::to_string).ok_or_else(|| format!("{path}: no token in the reply"))
    }

    /// 30 round trips to the server clock. Each sample assumes the reply is half a round trip
    /// old; the trimmed mean drops the three fastest and three slowest.
    fn measure_offset(&self) -> Result<f64, String> {
        let mut samples = Vec::with_capacity(OFFSET_SAMPLES);
        for _ in 0..OFFSET_SAMPLES {
            let sent = now_ms();
            let v = self.get("servertime")?;
            let received = now_ms();
            let server = v.get("serverTime").and_then(Value::as_f64).ok_or("servertime: no serverTime in the reply")?;
            samples.push(server + (received - sent) / 2.0 - received);
        }
        Ok(trimmed_mean(samples, OFFSET_TRIM))
    }

    /// v2 checks the script it fetched against a hash, v3 only takes the URL.
    fn setup(&self, url: &str, bytes: &[u8]) -> Result<(), String> {
        let body = if self.v3 { json!({ "url": url }) } else { json!({ "url": url, "sha256": sha256_hex(bytes) }) };
        self.put("hssp/setup", body).map(drop)
    }

    fn play(&self, media_ms: f64, rate: f64) -> Result<(), String> {
        let body = if self.v3 {
            json!({ "start_time": media_ms.round(), "server_time": self.server_ms(), "playback_rate": rate, "loop": false })
        } else {
            json!({ "estimatedServerTime": self.server_ms(), "startTime": media_ms.round() })
        };
        self.put("hssp/play", body).map(drop)
    }

    fn stop(&self) -> Result<(), String> {
        self.put("hssp/stop", json!({})).map(drop)
    }

    /// v3 drift correction: the Handy nudges its own position instead of restarting.
    fn sync(&self, media_ms: f64) -> Result<(), String> {
        self.put("hssp/synctime", json!({ "current_time": media_ms.round(), "server_time": self.server_ms(), "filter": 0.5 })).map(drop)
    }

    /// Travel limits, sent as percentages on v2 and fractions on v3.
    fn slide(&self, min: f64, max: f64) -> Result<(), String> {
        let body = if self.v3 { json!({ "min": min, "max": max }) } else { json!({ "min": (min * 100.0).round(), "max": (max * 100.0).round() }) };
        self.put("slide", body).map(drop)
    }

    /// Our clock in the service's terms, what `hssp/play` and `hssp/synctime` want.
    fn server_ms(&self) -> f64 {
        (now_ms() + self.offset).round()
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        let mut req = self.agent.get(format!("{}{path}", self.base)).header("X-Connection-Key", &self.key);
        if let Some(t) = &self.token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        let res = req.call().map_err(|e| format!("{path}: {e}"))?;
        read_json(path, res)
    }

    fn put(&self, path: &str, body: Value) -> Result<Value, String> {
        let mut req = self
            .agent
            .put(format!("{}{path}", self.base))
            .header("X-Connection-Key", &self.key)
            .header("Content-Type", "application/json");
        if let Some(t) = &self.token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        let res = req.send(body.to_string()).map_err(|e| format!("{path}: {e}"))?;
        read_json(path, res)
    }
}

fn read_json(path: &str, mut res: ureq::http::Response<ureq::Body>) -> Result<Value, String> {
    let body = res.body_mut().read_to_string().map_err(|e| format!("{path}: {e}"))?;
    parse_body(path, &body)
}

/// The Handy answers 200 with an `error` object when the device refuses, so the body counts
/// as much as the status.
fn parse_body(path: &str, body: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("{path}: {e}"))?;
    match v.get("error") {
        Some(e) => Err(format!("{path}: {}", e.get("message").and_then(Value::as_str).unwrap_or("the Handy refused the request"))),
        None => Ok(v),
    }
}

/// `Handy FW3 3.2.4` from the `info` reply: model, firmware generation and version.
fn device_name(info: &Value) -> String {
    let model = info.get("model").and_then(Value::as_str).unwrap_or("Handy");
    let fw = info.get("fwVersion").and_then(Value::as_str).unwrap_or("");
    match fw.split('.').next().filter(|major| !major.is_empty()) {
        Some(major) => format!("{model} FW{major} {fw}"),
        None => model.to_string(),
    }
}

/// Mean after dropping `trim` values from each end of the sorted samples.
fn trimmed_mean(mut samples: Vec<f64>, trim: usize) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    samples.sort_by(f64::total_cmp);
    let kept = if samples.len() > trim * 2 { &samples[trim..samples.len() - trim] } else { &samples[..] };
    kept.iter().sum::<f64>() / kept.len() as f64
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(64);
    for b in Sha256::digest(bytes) {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// The script as the Handy wants it: integer ms and 0..100 positions.
fn funscript_json(script: &Script) -> String {
    let mut s = String::from("{\"actions\":[");
    for (i, a) in script.actions.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        let pos = (a.pos * 100.0).round().clamp(0.0, 100.0) as i64;
        let _ = write!(s, "{{\"at\":{},\"pos\":{pos}}}", a.at.round() as i64);
    }
    s.push_str("]}");
    s
}

/// A one-file HTTP server the Handy fetches the script from, for users who would rather not
/// upload. Stops when dropped.
struct LanScript {
    url: String,
    stop: Arc<AtomicBool>,
}

impl LanScript {
    fn start(bytes: Vec<u8>) -> Result<LanScript, String> {
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| format!("script server: {e}"))?;
        let port = listener.local_addr().map_err(|e| format!("script server: {e}"))?.port();
        listener.set_nonblocking(true).map_err(|e| format!("script server: {e}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        thread::Builder::new()
            .name("bp-handy-host".into())
            .spawn(move || {
                while !done.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => serve(stream, &bytes),
                        Err(e) if e.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(20)),
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| format!("script server: {e}"))?;
        Ok(LanScript { url: format!("http://{}:{port}/script.funscript", lan_ip()), stop })
    }
}

impl Drop for LanScript {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Answers any request with the script. The Handy asks once and closes. The whole request is
/// read first: closing with bytes still unread resets the connection and the reply is lost.
fn serve(mut stream: TcpStream, bytes: &[u8]) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut request = Vec::new();
    let mut buf = [0u8; 512];
    while request.len() < 8192 && !request.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => request.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
    }
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(bytes);
    let _ = stream.flush();
}

/// The address the Handy can reach us on: the interface the routing table would use to reach
/// the internet. Nothing is sent.
fn lan_ip() -> String {
    UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|s| {
            s.connect(("8.8.8.8", 80))?;
            s.local_addr()
        })
        .map_or_else(|_| "127.0.0.1".into(), |a| a.ip().to_string())
}

/// Multipart upload to the Handy's script host. The reply carries the URL to hand to `setup`.
fn upload_script(agent: &Agent, url: &str, bytes: &[u8]) -> Result<String, String> {
    let boundary = format!("----betterplayer{:x}", now_ms() as u64);
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"script.funscript\"\r\nContent-Type: application/json\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let res = agent
        .post(url)
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .send(body)
        .map_err(|e| format!("upload: {e}"))?;
    let v = read_json("upload", res)?;
    v.get("url").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "upload: no url in the reply".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::BufRead;
    use std::io::BufReader;
    use std::sync::Mutex;

    /// One request the mock server saw.
    #[derive(Clone, Debug)]
    struct Req {
        method: String,
        path: String,
        headers: HashMap<String, String>,
        body: String,
    }

    /// A stand-in for handyfeeling.com: records every request and answers canned JSON keyed
    /// by the end of the path.
    struct Mock {
        base: String,
        seen: Arc<Mutex<Vec<Req>>>,
        stop: Arc<AtomicBool>,
    }

    impl Drop for Mock {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
        }
    }

    impl Mock {
        fn start() -> Mock {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let base = format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port());
            listener.set_nonblocking(true).unwrap();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let (r, s) = (seen.clone(), stop.clone());
            thread::spawn(move || {
                while !s.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let r = r.clone();
                            let s = s.clone();
                            thread::spawn(move || handle(stream, r, s));
                        }
                        Err(e) if e.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(2)),
                        Err(_) => break,
                    }
                }
            });
            Mock { base, seen, stop }
        }

        fn endpoints(&self) -> Endpoints {
            Endpoints { v2: self.base.clone(), v3: self.base.clone(), upload: format!("{}upload", self.base) }
        }

        fn requests(&self) -> Vec<Req> {
            self.seen.lock().unwrap().clone()
        }

        fn paths(&self) -> Vec<String> {
            self.requests().into_iter().map(|r| r.path).collect()
        }

        fn last(&self, path: &str) -> Req {
            self.requests().into_iter().rev().find(|r| r.path == path).unwrap_or_else(|| panic!("no request to {path}, saw {:?}", self.paths()))
        }

        fn count(&self, path: &str) -> usize {
            self.requests().iter().filter(|r| r.path == path).count()
        }

    }

    /// One keep-alive connection: requests in, canned JSON out, until the mock stops. Read
    /// timeouts mean idle or a split packet, never the end of the connection.
    fn handle(stream: TcpStream, seen: Arc<Mutex<Vec<Req>>>, stop: Arc<AtomicBool>) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut stream = stream;
        let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
        loop {
            let Some(line) = read_line(&mut reader, &stop) else { return };
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap_or_default().to_string();
            let target = parts.next().unwrap_or_default().to_string();
            let mut headers = HashMap::new();
            let mut length = 0usize;
            loop {
                let Some(h) = read_line(&mut reader, &stop) else { return };
                let h = h.trim_end();
                if h.is_empty() {
                    break;
                }
                if let Some((k, v)) = h.split_once(':') {
                    if k.eq_ignore_ascii_case("content-length") {
                        length = v.trim().parse().unwrap_or(0);
                    }
                    headers.insert(k.to_ascii_lowercase(), v.trim().to_string());
                }
            }
            let Some(body) = read_body(&mut reader, length, &stop) else { return };
            let target = target.trim_start_matches('/').to_string();
            let (path, query) = target.split_once('?').map_or((target.clone(), String::new()), |(p, q)| (p.to_string(), q.to_string()));
            let reply = canned(&path, &query, headers.get("x-connection-key").map_or("", String::as_str));
            seen.lock().unwrap().push(Req { method, path, headers, body: String::from_utf8_lossy(&body).to_string() });
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", reply.len());
            if stream.write_all(head.as_bytes()).is_err() || stream.write_all(reply.as_bytes()).is_err() {
                return;
            }
        }
    }

    fn read_line(reader: &mut BufReader<TcpStream>, stop: &AtomicBool) -> Option<String> {
        let mut line = String::new();
        loop {
            match reader.read_line(&mut line) {
                Ok(0) => return None,
                Ok(_) => return Some(line),
                Err(e) if timed_out(&e) => {
                    if stop.load(Ordering::Relaxed) {
                        return None;
                    }
                }
                Err(_) => return None,
            }
        }
    }

    fn read_body(reader: &mut BufReader<TcpStream>, length: usize, stop: &AtomicBool) -> Option<Vec<u8>> {
        let mut body = vec![0u8; length];
        let mut filled = 0;
        while filled < length {
            match reader.read(&mut body[filled..]) {
                Ok(0) => return None,
                Ok(n) => filled += n,
                Err(e) if timed_out(&e) => {
                    if stop.load(Ordering::Relaxed) {
                        return None;
                    }
                }
                Err(_) => return None,
            }
        }
        Some(body)
    }

    fn timed_out(e: &io::Error) -> bool {
        matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
    }

    /// Canned replies. The key `OLDFW` stands in for a Handy that needs a firmware update.
    fn canned(path: &str, query: &str, key: &str) -> String {
        match path {
            "connected" => json!({ "connected": true }).to_string(),
            "info" => {
                let status = if key == "OLDFW" { 1 } else { 0 };
                json!({ "fwVersion": "3.2.4", "fwStatus": status, "model": "Handy", "hwVersion": 3 }).to_string()
            }
            "servertime" => json!({ "serverTime": now_ms().round() + 5_000.0 }).to_string(),
            "hstp/time" => json!({ "time": now_ms().round(), "clock_offset": 7.0, "rtd": 40 }).to_string(),
            "auth/token/issue" => json!({ "token": format!("tok-{query}"), "renew": "" }).to_string(),
            "upload" => json!({ "success": true, "url": "https://handyfeeling.com/scripts/abc.funscript" }).to_string(),
            _ => json!({ "result": 1 }).to_string(),
        }
    }

    fn clamps() -> [AxisClamp; Axis::COUNT] {
        [AxisClamp::default(); Axis::COUNT]
    }

    fn ctx(media_ms: f64, paused: bool) -> TickContext {
        TickContext { media_ms, playing: !paused, rate: 1.0, interval_ms: 10 }
    }

    fn script() -> Script {
        Script::parse(r#"{"actions":[{"at":0,"pos":0},{"at":500,"pos":100}]}"#).unwrap()
    }

    /// Ticks and polls as the engine does until the mock has seen `n` requests to `path`.
    /// A `media_ms` of `None` follows the Handy's own position, so waiting is never a seek.
    fn run(link: &mut HandyLink, mock: &Mock, path: &str, n: usize, media_ms: Option<f64>, paused: bool) {
        for _ in 0..400 {
            link.poll().unwrap();
            let at = media_ms.unwrap_or_else(|| link.expected_ms());
            link.tick(&ctx(at, paused), &clamps());
            if mock.count(path) >= n {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("waited for {n} x {path}, saw {:?}", mock.paths());
    }

    #[test]
    fn v2_connect_identifies_sets_hssp_and_measures_the_clock() {
        let mock = Mock::start();
        let link = HandyLink::connect_to("KEY123", None, HandyHosting::Lan, mock.endpoints()).unwrap();
        assert_eq!(link.device, "Handy FW3 3.2.4");
        let paths = mock.paths();
        assert_eq!(paths[..3], ["connected", "info", "mode"]);
        assert_eq!(paths[3..].iter().filter(|p| *p == "servertime").count(), OFFSET_SAMPLES);
        let mode = mock.last("mode");
        assert_eq!(mode.method, "PUT");
        assert_eq!(mode.body, r#"{"mode":1}"#);
        assert_eq!(mode.headers.get("x-connection-key").unwrap(), "KEY123");
    }

    #[test]
    fn old_firmware_and_an_unreachable_service_are_reported() {
        let mock = Mock::start();
        let e = match HandyLink::connect_to("OLDFW", None, HandyHosting::Cloud, mock.endpoints()) {
            Err(e) => e.to_string(),
            Ok(_) => panic!("old firmware was accepted"),
        };
        assert!(e.contains("firmware update required"), "{e}");
        let ep = Endpoints { v2: "http://127.0.0.1:1/".into(), ..mock.endpoints() };
        assert!(HandyLink::connect_to("KEY", None, HandyHosting::Cloud, ep).is_err());
        assert_eq!(device_name(&json!({ "model": "Handy", "fwVersion": "4.0.1" })), "Handy FW4 4.0.1");
    }

    #[test]
    fn an_error_body_beats_the_status() {
        let e = parse_body("hssp/play", r#"{"error":{"code":1001,"message":"Device not connected"}}"#).unwrap_err();
        assert_eq!(e, "hssp/play: Device not connected");
        assert_eq!(parse_body("mode", r#"{"result":1}"#).unwrap()["result"], 1);
    }

    #[test]
    fn trimmed_mean_drops_the_outliers() {
        let mut samples = vec![100.0; 24];
        samples.extend([-9000.0, -8000.0, -7000.0, 7000.0, 8000.0, 9000.0]);
        assert_eq!(trimmed_mean(samples, OFFSET_TRIM), 100.0);
        assert_eq!(trimmed_mean(vec![1.0, 2.0], OFFSET_TRIM), 1.5);
        assert_eq!(trimmed_mean(Vec::new(), OFFSET_TRIM), 0.0);
    }

    #[test]
    fn lan_hosting_sets_up_with_the_local_url_and_hash() {
        let mock = Mock::start();
        let mut link = HandyLink::connect_to("KEY", None, HandyHosting::Lan, mock.endpoints()).unwrap();
        link.set_stroke(Some(&script()));
        run(&mut link, &mock, "hssp/setup", 1, Some(0.0), true);
        let body: Value = serde_json::from_str(&mock.last("hssp/setup").body).unwrap();
        let url = body["url"].as_str().unwrap();
        assert!(url.starts_with("http://") && url.ends_with("/script.funscript"), "{url}");
        let expected = sha256_hex(funscript_json(&script()).as_bytes());
        assert_eq!(body["sha256"].as_str().unwrap(), expected);
        // The clamp goes out as a percentage on v2.
        let slide: Value = serde_json::from_str(&mock.last("slide").body).unwrap();
        assert_eq!((slide["min"].as_f64(), slide["max"].as_f64()), (Some(0.0), Some(100.0)));
    }

    #[test]
    fn play_stops_on_pause_and_restarts_after_a_seek() {
        let mock = Mock::start();
        let mut link = HandyLink::connect_to("KEY", None, HandyHosting::Cloud, mock.endpoints()).unwrap();
        link.set_stroke(Some(&script()));
        run(&mut link, &mock, "hssp/play", 1, Some(4_000.0), false);
        let body: Value = serde_json::from_str(&mock.last("hssp/play").body).unwrap();
        assert_eq!(body["startTime"].as_f64(), Some(4_000.0));
        // The clock offset lands the estimated server time about five seconds ahead of ours.
        let ahead = body["estimatedServerTime"].as_f64().unwrap() - now_ms();
        assert!((ahead - 5_000.0).abs() < 500.0, "estimated server time {ahead} ms ahead");
        assert_eq!(mock.last("upload").method, "POST");

        run(&mut link, &mock, "hssp/stop", 1, Some(4_100.0), true);
        run(&mut link, &mock, "hssp/play", 2, Some(60_000.0), false);
        assert_eq!(serde_json::from_str::<Value>(&mock.last("hssp/play").body).unwrap()["startTime"].as_f64(), Some(60_000.0));
        // Playing on from where the Handy already is, is not a seek, so nothing else goes out.
        link.tick(&ctx(link.expected_ms() + 50.0, false), &clamps());
        thread::sleep(Duration::from_millis(50));
        assert_eq!(mock.count("hssp/play"), 2);
        run(&mut link, &mock, "hssp/play", 3, Some(75_000.0), false);
    }

    #[test]
    fn v3_takes_a_token_and_corrects_drift_with_synctime() {
        let mock = Mock::start();
        let mut link = HandyLink::connect_to("KEY", Some("APPKEY"), HandyHosting::Cloud, mock.endpoints()).unwrap();
        link.sync_every = Duration::from_millis(20);
        let issue = mock.last("auth/token/issue");
        assert_eq!(issue.headers.get("x-api-key").unwrap(), "APPKEY");
        assert_eq!(mock.paths()[..3], ["auth/token/issue", "info", "hstp/time"]);
        assert_eq!(mock.last("info").headers.get("authorization").unwrap(), "Bearer tok-ttl=86400&to=KEY");

        link.set_stroke(Some(&script()));
        run(&mut link, &mock, "hssp/play", 1, Some(1_000.0), false);
        let setup: Value = serde_json::from_str(&mock.last("hssp/setup").body).unwrap();
        assert_eq!(setup["url"].as_str(), Some("https://handyfeeling.com/scripts/abc.funscript"));
        assert!(setup.get("sha256").is_none());
        let play: Value = serde_json::from_str(&mock.last("hssp/play").body).unwrap();
        assert_eq!((play["start_time"].as_f64(), play["playback_rate"].as_f64(), play["loop"].as_bool()), (Some(1_000.0), Some(1.0), Some(false)));

        run(&mut link, &mock, "hssp/synctime", 1, None, false);
        let sync: Value = serde_json::from_str(&mock.last("hssp/synctime").body).unwrap();
        assert!(sync["current_time"].as_f64().unwrap() >= 1_000.0, "{sync}");
        assert_eq!(sync["filter"].as_f64(), Some(0.5));
        // Drift correction instead of another play.
        assert_eq!(mock.count("hssp/play"), 1);
    }

    #[test]
    fn actions_serialise_as_a_funscript_the_lan_server_hands_out() {
        let s = Script::parse(r#"{"actions":[{"at":0.4,"pos":0},{"at":250,"pos":99.6}]}"#).unwrap();
        let json = funscript_json(&s);
        assert_eq!(json, r#"{"actions":[{"at":0,"pos":0},{"at":250,"pos":100}]}"#);

        let server = LanScript::start(json.clone().into_bytes()).unwrap();
        let port = server.url.rsplit(':').next().unwrap().split('/').next().unwrap().to_string();
        let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).unwrap();
        stream.write_all(b"GET /script.funscript HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut got = String::new();
        stream.read_to_string(&mut got).unwrap();
        assert!(got.starts_with("HTTP/1.1 200 OK"), "{got}");
        assert!(got.contains("Content-Type: application/json"), "{got}");
        assert!(got.ends_with(&json), "{got}");
    }
}
