use std::fmt::Write as _;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use bp_script::{Action, Axis, Script};
use serde_json::{Value, json};
use ureq::Agent;

use crate::output::{Media, TickContext};


pub const PORT: u16 = 4695;
const TIMEOUT: Duration = Duration::from_secs(5);

const SEEK_MS: f64 = 1000.0;

const STATUS_EVERY: Duration = Duration::from_secs(5);

const TEST_MS: f64 = 5000.0;

const EXTRA_AXES: [Axis; 5] = [Axis::L1, Axis::L2, Axis::R0, Axis::R1, Axis::R2];


#[derive(Clone, Debug, Default, PartialEq)]
pub struct HowlStatus {
    pub playing: bool,

    pub position: f64,
    pub title: String,
    pub power_a: u8,
    pub power_b: u8,
    pub mute: bool,
}



#[derive(Clone, Debug)]
enum Source {
    Funscript { title: String, json: String },
    Hwl { title: String, path: PathBuf },
}

enum Cmd {
    Load(Source),
    Play { media_ms: f64 },
    Seek { media_ms: f64 },
    Stop,
    Status,
    Test,
}

enum Reply {

    Ready(HowlStatus),
    Status(HowlStatus),
    Error(String),
}



pub struct HowlLink {
    cmd: Sender<Cmd>,
    reply: Receiver<Reply>,
    pub status: HowlStatus,
    source: Option<Source>,
    ready: bool,
    playing: bool,

    play_ms: f64,
    play_at: Instant,
    last_status: Instant,
    status_every: Duration,

    test_until: Option<Instant>,
}

impl HowlLink {


    pub fn connect(host: &str, key: &str) -> io::Result<HowlLink> {
        Self::connect_to(format!("http://{host}:{PORT}/"), key)
    }

    fn connect_to(base: String, key: &str) -> io::Result<HowlLink> {
        let agent: Agent = Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .http_status_as_error(false)
            .build()
            .into();
        let api = Api {
            agent,
            base,
            key: key.to_string(),
        };
        let status = api
            .post("status", json!({}))
            .map(|v| parse_status(&v))
            .map_err(io::Error::other)?;
        let (cmd, cmd_rx) = channel();
        let (reply_tx, reply) = channel();
        thread::Builder::new()
            .name("bp-howl".into())
            .spawn(move || worker(api, cmd_rx, reply_tx))
            .map_err(io::Error::other)?;
        let now = Instant::now();
        Ok(HowlLink {
            cmd,
            reply,
            status,
            source: None,
            ready: false,
            playing: false,
            play_ms: 0.0,
            play_at: now,
            last_status: now,
            status_every: STATUS_EVERY,
            test_until: None,
        })
    }


    pub fn poll(&mut self) -> Result<(), String> {
        loop {
            match self.reply.try_recv() {
                Ok(Reply::Ready(status)) => {
                    self.ready = true;
                    self.playing = false;
                    self.status = status;
                }
                Ok(Reply::Status(status)) => self.status = status,
                Ok(Reply::Error(e)) => return Err(e),
                Err(TryRecvError::Empty) => return Ok(()),
                Err(TryRecvError::Disconnected) => return Err("the Howl worker stopped".into()),
            }
        }
    }




    pub fn set_source(&mut self, scripts: &[(Axis, Arc<Script>)], media: &Media) {
        self.ready = false;
        if self.playing {
            self.playing = false;
            self.send(Cmd::Stop);
        }
        self.source = match &media.hwl {
            Some(path) => Some(Source::Hwl {
                title: media.title.clone(),
                path: path.clone(),
            }),
            None => howl_json(scripts).map(|json| Source::Funscript {
                title: media.title.clone(),
                json,
            }),
        };
        if let Some(source) = &self.source {
            self.send(Cmd::Load(source.clone()));
        }
    }



    pub fn test(&mut self) {
        self.ready = false;
        self.playing = false;
        self.test_until = Some(Instant::now() + Duration::from_millis(TEST_MS as u64));
        self.send(Cmd::Test);
    }



    pub fn tick(&mut self, ctx: &TickContext) {
        if self.last_status.elapsed() >= self.status_every {
            self.last_status = Instant::now();
            self.send(Cmd::Status);
        }
        if let Some(until) = self.test_until {
            if Instant::now() < until {
                return;
            }
            self.test_until = None;
            if let Some(source) = &self.source {
                self.send(Cmd::Load(source.clone()));
            }
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
        if !self.playing {
            self.playing = true;
            self.mark(ctx.media_ms);
            self.send(Cmd::Play {
                media_ms: ctx.media_ms,
            });
        } else if (ctx.media_ms - self.expected_ms()).abs() > SEEK_MS {
            self.mark(ctx.media_ms);
            self.send(Cmd::Seek {
                media_ms: ctx.media_ms,
            });
        }
    }

    fn mark(&mut self, media_ms: f64) {
        self.play_ms = media_ms;
        self.play_at = Instant::now();
    }


    fn expected_ms(&self) -> f64 {
        self.play_ms + self.play_at.elapsed().as_secs_f64() * 1000.0
    }

    fn send(&self, cmd: Cmd) {
        let _ = self.cmd.send(cmd);
    }
}

impl Drop for HowlLink {

    fn drop(&mut self) {
        self.send(Cmd::Stop);
    }
}



fn worker(api: Api, cmd: Receiver<Cmd>, reply: Sender<Reply>) {
    for c in cmd {
        let done = match c {
            Cmd::Load(source) => load_body(&source)
                .and_then(|(path, body)| api.post(path, body))
                .map(|v| Reply::Ready(parse_status(&v))),
            Cmd::Play { media_ms } => api
                .post("start_player", json!({ "from": seconds(media_ms) }))
                .map(|v| Reply::Status(parse_status(&v))),
            Cmd::Seek { media_ms } => api
                .post("seek", json!({ "position": seconds(media_ms) }))
                .map(|v| Reply::Status(parse_status(&v))),
            Cmd::Stop => api
                .post("stop_player", json!({}))
                .map(|v| Reply::Status(parse_status(&v))),
            Cmd::Status => api
                .post("status", json!({}))
                .map(|v| Reply::Status(parse_status(&v))),
            Cmd::Test => api
                .post(
                    "load_funscript",
                    json!({ "title": "Test", "funscript": test_json(), "play": true }),
                )
                .map(|v| Reply::Status(parse_status(&v))),
        };
        let sent = match done {
            Ok(r) => reply.send(r),
            Err(e) => reply.send(Reply::Error(e)),
        };
        if sent.is_err() {
            return;
        }
    }
}


fn load_body(source: &Source) -> Result<(&'static str, Value), String> {
    Ok(match source {
        Source::Funscript { title, json } => (
            "load_funscript",
            json!({ "title": title, "funscript": json, "loop": false, "play": false }),
        ),
        Source::Hwl { title, path } => {
            let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
            (
                "load_hwl",
                json!({ "title": title, "hwl": base64::engine::general_purpose::STANDARD.encode(bytes), "loop": false, "play": false }),
            )
        }
    })
}


fn seconds(media_ms: f64) -> f64 {
    media_ms.round() / 1000.0
}



struct Api {
    agent: Agent,
    base: String,
    key: String,
}

impl Api {
    fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        let mut res = self
            .agent
            .post(format!("{}{path}", self.base))
            .header("Authorization", format!("Bearer {}", self.key))
            .header("Content-Type", "application/json")
            .send(body.to_string())
            .map_err(|e| {
                format!("Howl is not reachable ({e}); turn on remote access in Howl's settings")
            })?;
        let code = res.status().as_u16();
        let text = res
            .body_mut()
            .read_to_string()
            .map_err(|e| format!("{path}: {e}"))?;
        parse_reply(path, code, &text)
    }
}


fn parse_reply(path: &str, code: u16, body: &str) -> Result<Value, String> {
    if code == 401 {
        return Err("Howl rejected the key".into());
    }
    let v: Value = serde_json::from_str(body).map_err(|e| format!("{path}: {e}"))?;
    if code >= 400 {
        let message = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Howl refused the request");
        return Err(format!("{path}: {message}"));
    }
    Ok(v)
}

fn parse_status(v: &Value) -> HowlStatus {
    let player = v.get("player");
    let options = v.get("options");
    fn field<'a>(o: Option<&'a Value>, k: &str) -> Option<&'a Value> {
        o.and_then(|o| o.get(k))
    }
    HowlStatus {
        playing: field(player, "playing")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        position: field(player, "position")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        title: field(player, "title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        power_a: field(options, "power_a")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(200) as u8,
        power_b: field(options, "power_b")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(200) as u8,
        mute: field(options, "mute")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}



fn howl_json(scripts: &[(Axis, Arc<Script>)]) -> Option<String> {
    let find = |axis: Axis| {
        scripts
            .iter()
            .find(|(a, s)| *a == axis && !s.is_empty())
            .map(|(_, s)| s.as_ref())
    };
    let stroke = find(Axis::L0)?;
    let mut s = String::from("{\"actions\":");
    write_actions(&mut s, stroke);
    let extras: Vec<(Axis, &Script)> = EXTRA_AXES
        .iter()
        .filter_map(|&a| find(a).map(|s| (a, s)))
        .collect();
    if !extras.is_empty() {
        s.push_str(",\"axes\":[");
        for (i, (axis, script)) in extras.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            let _ = write!(s, "{{\"id\":\"{}\",\"actions\":", axis.id());
            write_actions(&mut s, script);
            s.push('}');
        }
        s.push(']');
    }
    s.push('}');
    Some(s)
}


fn write_actions(s: &mut String, script: &Script) {
    s.push('[');
    for (i, a) in script.actions.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        let pos = (a.pos * 100.0).round().clamp(0.0, 100.0) as i64;
        let _ = write!(s, "{{\"at\":{},\"pos\":{pos}}}", a.at.round() as i64);
    }
    s.push(']');
}


fn test_json() -> String {
    let actions: Vec<Action> = (0..=(TEST_MS / 100.0) as usize)
        .map(|i| {
            let at = i as f64 * 100.0;
            Action {
                at,
                pos: 0.5 - 0.4 * (at / 2500.0 * std::f64::consts::TAU).sin(),
            }
        })
        .collect();
    let mut s = String::from("{\"actions\":");
    write_actions(
        &mut s,
        &Script {
            actions,
            ..Script::default()
        },
    );
    s.push('}');
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
    use std::net::{Ipv4Addr, TcpListener, TcpStream};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    const KEY: &str = "ABCDEFGH1234";

    #[derive(Clone, Debug)]
    struct Req {
        path: String,
        auth: String,
        body: Value,
    }



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
            let base = format!(
                "http://127.0.0.1:{}/",
                listener.local_addr().unwrap().port()
            );
            listener.set_nonblocking(true).unwrap();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let (r, s) = (seen.clone(), stop.clone());
            thread::spawn(move || {
                while !s.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let (r, s) = (r.clone(), s.clone());
                            thread::spawn(move || handle(stream, r, s));
                        }
                        Err(e) if e.kind() == ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(_) => break,
                    }
                }
            });
            Mock { base, seen, stop }
        }

        fn requests(&self) -> Vec<Req> {
            self.seen.lock().unwrap().clone()
        }

        fn paths(&self) -> Vec<String> {
            self.requests().into_iter().map(|r| r.path).collect()
        }

        fn last(&self, path: &str) -> Req {
            self.requests()
                .into_iter()
                .rev()
                .find(|r| r.path == path)
                .unwrap_or_else(|| panic!("no request to {path}, saw {:?}", self.paths()))
        }

        fn count(&self, path: &str) -> usize {
            self.requests().iter().filter(|r| r.path == path).count()
        }
    }


    fn handle(stream: TcpStream, seen: Arc<Mutex<Vec<Req>>>, stop: Arc<AtomicBool>) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut stream = stream;
        let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
        loop {
            let Some(line) = read_line(&mut reader, &stop) else {
                return;
            };
            let target = line
                .split_whitespace()
                .nth(1)
                .unwrap_or_default()
                .trim_start_matches('/')
                .to_string();
            let mut headers = HashMap::new();
            let mut length = 0usize;
            loop {
                let Some(h) = read_line(&mut reader, &stop) else {
                    return;
                };
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
            let mut body = vec![0u8; length];
            let mut filled = 0;
            while filled < length {
                match reader.read(&mut body[filled..]) {
                    Ok(0) => return,
                    Ok(n) => filled += n,
                    Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                        if stop.load(Ordering::Relaxed) {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
            let auth = headers.get("authorization").cloned().unwrap_or_default();
            let (code, reply) = if auth != format!("Bearer {KEY}") {
                (401, json!({ "error": { "message": "Unauthorized" } }))
            } else if target == "load_funscript"
                && serde_json::from_slice::<Value>(&body).ok().and_then(|b| {
                    b["funscript"]
                        .as_str()
                        .map(|f| f.contains("\"actions\":[]"))
                }) == Some(true)
            {
                (
                    400,
                    json!({ "error": { "message": "Invalid funscript file" } }),
                )
            } else {
                (
                    200,
                    json!({ "options": { "power_a": 12, "power_b": 30, "power_a_limit": 70, "power_b_limit": 70, "mute": false, "auto_increase_power": false, "swap_channels": false }, "player": { "playing": target == "start_player", "position": 4.0, "title": "clip", "duration": 90.0 } }),
                )
            };
            seen.lock().unwrap().push(Req {
                path: target,
                auth,
                body: serde_json::from_slice(&body).unwrap_or(Value::Null),
            });
            let reply = reply.to_string();
            let head = format!(
                "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                reply.len()
            );
            if stream.write_all(head.as_bytes()).is_err()
                || stream.write_all(reply.as_bytes()).is_err()
            {
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
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                    if stop.load(Ordering::Relaxed) {
                        return None;
                    }
                }
                Err(_) => return None,
            }
        }
    }

    fn ctx(media_ms: f64, paused: bool) -> TickContext {
        TickContext {
            manual_axes: [false; Axis::COUNT],
            estim_manual: false,
            estim_volume: crate::ramp::VolumeSettings::default(),
            media_ms,
            playing: !paused,
            rate: 1.0,
            interval_ms: 10,
        }
    }

    fn script(json: &str) -> Arc<Script> {
        Arc::new(Script::parse(json).unwrap())
    }

    fn scripts() -> Vec<(Axis, Arc<Script>)> {
        vec![
            (
                Axis::L0,
                script(r#"{"actions":[{"at":0,"pos":0},{"at":500,"pos":100}]}"#),
            ),
            (
                Axis::R0,
                script(r#"{"actions":[{"at":0.4,"pos":20},{"at":250,"pos":80}]}"#),
            ),
            (
                Axis::A0,
                script(r#"{"actions":[{"at":0,"pos":0},{"at":100,"pos":100}]}"#),
            ),
        ]
    }

    fn media() -> Media {
        Media {
            title: "clip".into(),
            hwl: None,
        }
    }



    fn run(
        link: &mut HowlLink,
        mock: &Mock,
        path: &str,
        n: usize,
        media_ms: Option<f64>,
        paused: bool,
    ) {
        for _ in 0..400 {
            link.poll().unwrap();
            let at = media_ms.unwrap_or_else(|| link.expected_ms());
            link.tick(&ctx(at, paused));
            if mock.count(path) >= n {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("waited for {n} x {path}, saw {:?}", mock.paths());
    }



    fn settle(link: &mut HowlLink, done: impl Fn(&HowlLink) -> bool) {
        for _ in 0..400 {
            link.poll().unwrap();
            if done(link) {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("the reply never came");
    }

    #[test]
    fn connect_checks_the_key_and_reads_the_status() {
        let mock = Mock::start();
        let link = HowlLink::connect_to(mock.base.clone(), KEY).unwrap();
        assert_eq!(mock.paths(), ["status"]);
        assert_eq!(mock.last("status").auth, format!("Bearer {KEY}"));
        assert_eq!(
            link.status,
            HowlStatus {
                playing: false,
                position: 4.0,
                title: "clip".into(),
                power_a: 12,
                power_b: 30,
                mute: false
            }
        );

        let e = HowlLink::connect_to(mock.base.clone(), "WRONG")
            .err()
            .map(|e| e.to_string());
        assert_eq!(e.as_deref(), Some("Howl rejected the key"));
        let e = HowlLink::connect_to("http://127.0.0.1:1/".into(), KEY)
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
        assert!(e.starts_with("Howl is not reachable"), "{e}");
    }

    #[test]
    fn load_then_play_seek_and_stop_follow_the_clock() {
        let mock = Mock::start();
        let mut link = HowlLink::connect_to(mock.base.clone(), KEY).unwrap();
        link.set_source(&scripts(), &media());
        run(&mut link, &mock, "start_player", 1, Some(4_000.0), false);
        let load = mock.last("load_funscript");
        assert_eq!(load.body["title"], "clip");
        assert_eq!(
            (load.body["loop"].as_bool(), load.body["play"].as_bool()),
            (Some(false), Some(false))
        );
        assert_eq!(
            load.body["funscript"].as_str(),
            howl_json(&scripts()).as_deref()
        );
        assert_eq!(mock.last("start_player").body["from"].as_f64(), Some(4.0));
        settle(&mut link, |l| l.status.playing);


        run(&mut link, &mock, "seek", 1, Some(60_000.0), false);
        assert_eq!(mock.last("seek").body["position"].as_f64(), Some(60.0));
        link.tick(&ctx(link.expected_ms() + 50.0, false));
        thread::sleep(Duration::from_millis(50));
        assert_eq!((mock.count("seek"), mock.count("start_player")), (1, 1));

        run(&mut link, &mock, "stop_player", 1, Some(60_100.0), true);
        run(&mut link, &mock, "start_player", 2, Some(75_000.0), false);
        assert_eq!(mock.last("start_player").body["from"].as_f64(), Some(75.0));
    }

    #[test]
    fn nothing_to_play_stops_and_idles() {
        let mock = Mock::start();
        let mut link = HowlLink::connect_to(mock.base.clone(), KEY).unwrap();
        link.set_source(&scripts(), &media());
        run(&mut link, &mock, "start_player", 1, Some(0.0), false);
        link.set_source(&[], &media());
        run(&mut link, &mock, "stop_player", 1, Some(0.0), false);
        thread::sleep(Duration::from_millis(50));
        link.poll().unwrap();
        link.tick(&ctx(0.0, false));
        thread::sleep(Duration::from_millis(50));
        assert_eq!(
            (mock.count("load_funscript"), mock.count("start_player")),
            (1, 1)
        );
    }

    #[test]
    fn a_refused_load_fails_the_link() {
        let mock = Mock::start();
        let mut link = HowlLink::connect_to(mock.base.clone(), KEY).unwrap();
        link.send(Cmd::Load(Source::Funscript {
            title: "x".into(),
            json: r#"{"actions":[]}"#.into(),
        }));
        let mut err = None;
        for _ in 0..200 {
            if let Err(e) = link.poll() {
                err = Some(e);
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            err.as_deref(),
            Some("load_funscript: Invalid funscript file")
        );
    }

    #[test]
    fn status_is_polled_and_the_test_reloads_the_source() {
        let mock = Mock::start();
        let mut link = HowlLink::connect_to(mock.base.clone(), KEY).unwrap();
        link.status_every = Duration::from_millis(20);
        run(&mut link, &mock, "status", 3, Some(0.0), true);

        link.set_source(&scripts(), &media());
        run(&mut link, &mock, "load_funscript", 1, Some(0.0), true);
        link.test();
        link.test_until = Some(Instant::now() + Duration::from_millis(30));
        run(&mut link, &mock, "load_funscript", 3, Some(0.0), true);
        assert_eq!(
            mock.requests()
                .iter()
                .filter(|r| r.path == "load_funscript")
                .map(|r| r.body["title"].as_str().unwrap().to_string())
                .collect::<Vec<_>>(),
            ["clip", "Test", "clip"]
        );
        assert_eq!(
            mock.requests()
                .iter()
                .find(|r| r.body["title"] == "Test")
                .unwrap()
                .body["play"],
            true
        );
    }

    #[test]
    fn hwl_beside_the_media_wins_and_goes_out_base64() {
        let dir = std::env::temp_dir().join(format!("bp-howl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clip.hwl");
        std::fs::write(&path, b"HWL\x00\x01\x02").unwrap();
        let mock = Mock::start();
        let mut link = HowlLink::connect_to(mock.base.clone(), KEY).unwrap();
        link.set_source(
            &scripts(),
            &Media {
                title: "clip".into(),
                hwl: Some(path.clone()),
            },
        );
        run(&mut link, &mock, "load_hwl", 1, Some(0.0), true);
        let body = mock.last("load_hwl").body;
        assert_eq!(body["hwl"].as_str(), Some("SFdMAAEC"));
        assert_eq!(body["loop"], false);
        assert_eq!(mock.count("load_funscript"), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn scripts_become_one_multi_axis_funscript() {
        let json = howl_json(&scripts()).unwrap();
        assert_eq!(
            json,
            r#"{"actions":[{"at":0,"pos":0},{"at":500,"pos":100}],"axes":[{"id":"R0","actions":[{"at":0,"pos":20},{"at":250,"pos":80}]}]}"#
        );
        assert_eq!(howl_json(&scripts()[1..]), None);
        assert_eq!(
            howl_json(&scripts()[..1]).unwrap(),
            r#"{"actions":[{"at":0,"pos":0},{"at":500,"pos":100}]}"#
        );
        let test: Value = serde_json::from_str(&test_json()).unwrap();
        assert_eq!(test["actions"].as_array().unwrap().len(), 51);
    }

    #[test]
    fn replies_carry_howls_message() {
        assert_eq!(
            parse_reply("seek", 401, "").unwrap_err(),
            "Howl rejected the key"
        );
        assert_eq!(
            parse_reply("seek", 400, r#"{"error":{"message":"Invalid parameters"}}"#).unwrap_err(),
            "seek: Invalid parameters"
        );
        assert_eq!(
            parse_reply("seek", 500, "{}").unwrap_err(),
            "seek: Howl refused the request"
        );
        assert_eq!(
            parse_reply("seek", 200, r#"{"player":{}}"#).unwrap()["player"],
            json!({})
        );
    }
}
