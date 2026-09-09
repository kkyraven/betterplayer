//! The OSSM (KinkyMakers) over its firmware's BLE service. `go:streaming` puts the machine
//! in streaming mode, then `stream:<pos>:<ms>` lines carry the stroke as a percent of the
//! calibrated travel and the time to get there; the firmware plans each move within its
//! speed and acceleration limits. It reports its state machine as JSON on a notify
//! characteristic. The physical speed knob stays the master speed limit: it must be at zero
//! to enter streaming (the firmware's preflight) and turned up after, which the status
//! shown in the app says.
//!
//! The firmware queues stream lines and caps each move's distance by its acceleration over
//! the square of half the move's time, so a 50 ms sample barely moves the carriage. While a
//! script drives the stroke each keyframe goes out once as one move over the time until it;
//! samples only fill in for a live stroke or a paused one.

use std::fmt::Write as _;
use std::io;
use std::time::{Duration, Instant};

use crate::ble::{BleConn, OSSM_COMMAND, OSSM_SERVICE, OSSM_STATE};
use crate::output::{CONNECT_GLIDE_MS, Keyframe};

/// Stream lines are spaced at least this far apart. Longer moves suit the firmware's
/// planner: the distance it allows per move grows with the square of the move's time.
pub const LINE_MS: u32 = 50;
/// A keyframe already sent goes again when its arrival moved by more than this (a seek
/// within its segment, a rate change), not for tick jitter.
const KEYFRAME_SLIP: Duration = Duration::from_millis(40);
/// Settings sent whenever a streaming session starts: our stream positions span the whole
/// calibrated travel (the output's range clamps it), the machine's own speed limit is the
/// knob alone, and acceleration is unrestricted so moves track their timing.
const SESSION_SETTINGS: [&str; 4] = ["set:speed:100", "set:stroke:100", "set:depth:100", "set:sensation:100"];

/// What the firmware last reported, for the UI.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OssmStatus {
    /// The firmware's state: `streaming.idle`, `streaming.preflight`, `homing.forward`,
    /// `menu.idle` and so on.
    pub state: String,
    /// Effective speed 0..100: the knob, scaled by the `set:speed` we send.
    pub speed: u8,
    /// Where the carriage is, in mm from home.
    pub position_mm: f64,
}

impl OssmStatus {
    /// Whether stream lines move the machine now.
    pub fn streaming(&self) -> bool {
        self.state == "streaming.idle"
    }
}

pub struct OssmLink {
    conn: BleConn,
    pub status: OssmStatus,
    /// The streaming session the settings went to; the firmware resets them on every new one.
    configured: Option<String>,
    /// Whether `go:streaming` has gone out on this connection. Once only: a long press on the
    /// machine is an emergency stop back to its menu, and the app must not start it again
    /// (streaming begins with homing, which moves the carriage). A new connection (the app
    /// starting, the output added, a BLE drop) arms again: connecting is the user's choice.
    armed: bool,
    /// Last position sent this session, so an unchanged stroke sends nothing. Never repeat
    /// a position: the firmware divides by the distance to find the move's direction.
    last: Option<u8>,
    /// The keyframe last sent (its video time) and when the machine was told to arrive.
    keyframe: Option<(f64, Instant)>,
    last_line_at: Option<Instant>,
    /// When `send` last had a chance to write, so a line's time is the spacing of lines, not
    /// how long the stroke held still before it.
    last_attempt_at: Option<Instant>,
    /// The first line of a session eases the carriage over the connect glide, and nothing
    /// follows until that has played out.
    glide: bool,
    hold_until: Option<Instant>,
    line: String,
}

impl OssmLink {
    /// Connects to the OSSM whose name or address starts with `target` (empty takes the first
    /// one advertising the service) and subscribes to its state. Blocks; call it off the tick.
    pub fn open(target: &str) -> io::Result<OssmLink> {
        let conn = BleConn::open(target, OSSM_SERVICE, OSSM_COMMAND, OSSM_STATE)?;
        // A read alongside the subscription, so the state is known before it next changes.
        conn.watch(OSSM_STATE);
        Ok(OssmLink {
            conn,
            status: OssmStatus::default(),
            configured: None,
            armed: false,
            last: None,
            keyframe: None,
            last_line_at: None,
            last_attempt_at: None,
            glide: false,
            hold_until: None,
            line: String::with_capacity(24),
        })
    }

    /// The advertised name.
    pub fn name(&self) -> &str {
        &self.conn.name
    }

    /// Reads state notifications, starts streaming the first time the machine reports its
    /// menu, and sends the session settings when a session starts. Returns the state lines
    /// for the diagnostics log.
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

    /// A notification cut short by the MTU has no session id; the settings are left as they are.
    fn apply(&mut self, status: OssmStatus, session: Option<String>) -> io::Result<()> {
        let was = self.status.streaming();
        self.status = status;
        if !self.status.streaming() {
            return Ok(());
        }
        if !was {
            self.last = None;
            self.keyframe = None;
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

    /// Sends the stroke (0..1, already clamped to the output's range) when it changed and the
    /// machine is streaming: a `keyframe` (its position clamped the same way) as one move the
    /// moment it starts, else the sampled stroke at the line spacing. Returns whether a line
    /// went out.
    pub fn send(&mut self, stroke: f64, keyframe: Option<Keyframe>) -> io::Result<bool> {
        if !self.status.streaming() {
            return Ok(false);
        }
        let now = Instant::now();
        if self.hold_until.is_some_and(|t| now < t) {
            return Ok(false);
        }
        let (target, ms) = match keyframe.filter(|_| !self.glide) {
            Some(k) => {
                let arrival = now + Duration::from_secs_f64(k.in_ms.max(0.0) / 1000.0);
                if self.keyframe.is_some_and(|(at, was)| at == k.at_ms && arrival.saturating_duration_since(was).max(was.saturating_duration_since(arrival)) <= KEYFRAME_SLIP) {
                    return Ok(false);
                }
                self.keyframe = Some((k.at_ms, arrival));
                (k.pos, (k.in_ms.round() as u32).max(1))
            }
            None => {
                self.keyframe = None;
                if self.last_line_at.is_some_and(|t| now.duration_since(t) < Duration::from_millis(LINE_MS as u64)) {
                    return Ok(false);
                }
                let since_attempt = self.last_attempt_at.map_or(LINE_MS, |t| (now.duration_since(t).as_millis() as u32).clamp(LINE_MS, 4 * LINE_MS));
                self.last_attempt_at = Some(now);
                (stroke, since_attempt)
            }
        };
        let mut pos = (target.clamp(0.0, 1.0) * 100.0).round() as u8;
        // The firmware's last position starts at zero, so the session's first line is never zero.
        if self.last.is_none() && pos == 0 {
            pos = 1;
        }
        if self.last == Some(pos) {
            return Ok(false);
        }
        let ms = if self.glide {
            self.glide = false;
            self.hold_until = Some(now + Duration::from_millis(CONNECT_GLIDE_MS as u64));
            CONNECT_GLIDE_MS
        } else {
            ms
        };
        stream_line(&mut self.line, pos, ms);
        self.conn.write_latest(self.line.as_bytes())?;
        self.last = Some(pos);
        self.last_line_at = Some(now);
        Ok(true)
    }
}

/// `stream:<pos>:<ms>`: the position as a whole percent and the time to reach it.
pub fn stream_line(line: &mut String, pos: u8, ms: u32) {
    line.clear();
    let _ = write!(line, "stream:{}:{ms}", pos.min(100));
}

/// The state and session id from the firmware's JSON, read by key so a notification cut
/// short by the MTU still yields what arrived (the session id is last, so it is what goes
/// missing). None for anything without a state.
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
