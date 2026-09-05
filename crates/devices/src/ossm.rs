use std::fmt::Write as _;
use std::io;
use std::time::{Duration, Instant};

use crate::ble::{BleConn, OSSM_COMMAND, OSSM_SERVICE, OSSM_STATE};
use crate::output::CONNECT_GLIDE_MS;



pub const LINE_MS: u32 = 50;



const SESSION_SETTINGS: [&str; 4] = ["set:speed:100", "set:stroke:100", "set:depth:100", "set:sensation:100"];


#[derive(Clone, Debug, Default, PartialEq)]
pub struct OssmStatus {


    pub state: String,

    pub speed: u8,

    pub position_mm: f64,
}

impl OssmStatus {

    pub fn streaming(&self) -> bool {
        self.state == "streaming.idle"
    }
}

pub struct OssmLink {
    conn: BleConn,
    pub status: OssmStatus,

    configured: Option<String>,




    armed: bool,

    last: Option<u8>,
    last_line_at: Option<Instant>,


    last_attempt_at: Option<Instant>,


    glide: bool,
    hold_until: Option<Instant>,
    line: String,
}

impl OssmLink {


    pub fn open(target: &str) -> io::Result<OssmLink> {
        let conn = BleConn::open(target, OSSM_SERVICE, OSSM_COMMAND, OSSM_STATE)?;

        conn.watch(OSSM_STATE);
        Ok(OssmLink {
            conn,
            status: OssmStatus::default(),
            configured: None,
            armed: false,
            last: None,
            last_line_at: None,
            last_attempt_at: None,
            glide: false,
            hold_until: None,
            line: String::with_capacity(24),
        })
    }


    pub fn name(&self) -> &str {
        &self.conn.name
    }




    pub fn poll(&mut self) -> io::Result<Vec<String>> {
        self.conn.check()?;
        let mut lines = Vec::new();
        for (uuid, payload) in self.conn.take_notifications() {
            if uuid != OSSM_STATE {
                continue;
            }
            let text = String::from_utf8_lossy(&payload).trim().to_string();
            if let Some((status, session)) = parse_state(&text) {
                self.apply(status, session)?;
            }
            lines.push(text);
        }
        if self.status.state == "menu.idle" && !self.armed {
            self.conn.write(b"go:streaming")?;
            self.armed = true;
        }
        Ok(lines)
    }


    fn apply(&mut self, status: OssmStatus, session: Option<String>) -> io::Result<()> {
        let was = self.status.streaming();
        self.status = status;
        if !self.status.streaming() {
            return Ok(());
        }
        if !was {
            self.last = None;
            self.glide = true;
            self.hold_until = None;
        }
        if let Some(session) = session.filter(|s| self.configured.as_deref() != Some(s.as_str())) {
            for cmd in SESSION_SETTINGS {
                self.conn.write(cmd.as_bytes())?;
            }
            self.configured = Some(session);
        }
        Ok(())
    }



    pub fn send(&mut self, stroke: f64) -> io::Result<bool> {
        if !self.status.streaming() {
            return Ok(false);
        }
        let now = Instant::now();
        if self.hold_until.is_some_and(|t| now < t) || self.last_line_at.is_some_and(|t| now.duration_since(t) < Duration::from_millis(LINE_MS as u64)) {
            return Ok(false);
        }
        let since_attempt = self.last_attempt_at.map_or(LINE_MS, |t| (now.duration_since(t).as_millis() as u32).clamp(LINE_MS, 4 * LINE_MS));
        self.last_attempt_at = Some(now);
        let pos = (stroke.clamp(0.0, 1.0) * 100.0).round() as u8;
        if self.last == Some(pos) {
            return Ok(false);
        }
        let ms = if self.glide {
            self.glide = false;
            self.hold_until = Some(now + Duration::from_millis(CONNECT_GLIDE_MS as u64));
            CONNECT_GLIDE_MS
        } else {
            since_attempt
        };
        stream_line(&mut self.line, pos, ms);
        self.conn.write_latest(self.line.as_bytes())?;
        self.last = Some(pos);
        self.last_line_at = Some(now);
        Ok(true)
    }
}


pub fn stream_line(line: &mut String, pos: u8, ms: u32) {
    line.clear();
    let _ = write!(line, "stream:{}:{ms}", pos.min(100));
}




pub fn parse_state(json: &str) -> Option<(OssmStatus, Option<String>)> {
    let state = string_field(json, "state")?.to_string();
    let speed = number_field(json, "speed").map_or(0, |v| v.clamp(0.0, 100.0) as u8);
    let position_mm = number_field(json, "position").unwrap_or(0.0);
    let session = string_field(json, "sessionId").map(str::to_string);
    Some((OssmStatus { state, speed, position_mm }, session))
}

fn string_field<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let at = json.find(&format!("\"{key}\":\""))? + key.len() + 4;
    let rest = &json[at..];
    Some(&rest[..rest.find('"')?])
}

fn number_field(json: &str, key: &str) -> Option<f64> {
    let at = json.find(&format!("\"{key}\":"))? + key.len() + 3;
    let rest = json[at..].trim_start();
    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-')).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_lines_are_percent_and_milliseconds() {
        let mut line = String::new();
        stream_line(&mut line, 42, 50);
        assert_eq!(line, "stream:42:50");
        stream_line(&mut line, 250, 1500);
        assert_eq!(line, "stream:100:1500");
    }

    #[test]
    fn state_json_reads_by_key_even_when_cut_short() {
        let json = r#"{"timestamp":1234,"state":"streaming.idle","speed":63,"stroke":100,"sensation":100,"depth":100,"buffer":100,"pattern":0,"position":12.50,"sessionId":"abc-123","firmwareProvenanceId":"x"}"#;
        let (s, session) = parse_state(json).unwrap();
        assert!(s.streaming());
        assert_eq!((s.speed, s.position_mm, session.as_deref()), (63, 12.5, Some("abc-123")));
        let (s, session) = parse_state(r#"{"timestamp":1,"state":"streaming.preflight","speed":0,"str"#).unwrap();
        assert!(!s.streaming());
        assert_eq!((s.state.as_str(), s.speed, session), ("streaming.preflight", 0, None));
        assert!(parse_state("ok:boot").is_none());
    }
}
