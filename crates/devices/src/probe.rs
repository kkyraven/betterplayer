use std::io::{ErrorKind, Read, Write};
use std::thread;
use std::time::{Duration, Instant};

use crate::transport::split_lines;

#[derive(Clone, Debug, PartialEq)]
pub struct ProbedPort {
    pub path: String,

    pub device: Option<String>,

    pub tcode: Option<String>,
    pub error: Option<String>,
}


pub fn probe_ports(paths: &[String], wait: Duration) -> Vec<ProbedPort> {
    let handles: Vec<_> = paths
        .iter()
        .cloned()
        .map(|path| thread::spawn(move || probe_port(&path, wait)))
        .collect();
    handles
        .into_iter()
        .map(|h| {
            h.join().unwrap_or_else(|_| ProbedPort {
                path: String::new(),
                device: None,
                tcode: None,
                error: Some("probe thread died".into()),
            })
        })
        .collect()
}



pub(crate) fn is_identity(line: &str) -> bool {
    let l = line.trim();
    l.chars().count() >= 3
        && !l.starts_with(['[', '#', '@', '$', '{'])
        && l.chars().any(char::is_alphabetic)
        && l.chars().all(|c| {
            !c.is_control() && (c.is_alphanumeric() || c.is_ascii_punctuation() || c == ' ')
        })
}

fn probe_port(path: &str, wait: Duration) -> ProbedPort {
    let mut out = ProbedPort {
        path: path.to_string(),
        device: None,
        tcode: None,
        error: None,
    };
    let mut port = match serialport::new(path, 115_200)
        .timeout(Duration::from_millis(50))
        .open()
    {
        Ok(p) => p,
        Err(e) => {
            out.error = Some(e.to_string());
            return out;
        }
    };


    let start = Instant::now();
    let deadline = start + wait;
    let mut next_ask = start + Duration::from_millis(200);
    let mut buf = [0u8; 256];
    let mut partial = Vec::new();
    let mut lines = Vec::new();
    while Instant::now() < deadline && (out.device.is_none() || out.tcode.is_none()) {
        if Instant::now() >= next_ask {
            if let Err(e) = port.write_all(b"D0\nD1\n") {
                out.error = Some(e.to_string());
                return out;
            }
            next_ask += Duration::from_millis(400);
        }
        match port.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                split_lines(&mut partial, &buf[..n], &mut lines);
                for line in lines.drain(..) {
                    let l = line.trim();
                    if l.is_empty() {
                        continue;
                    }
                    if l.starts_with("TCode v") {
                        out.tcode = Some(l.to_string());
                    } else if out.device.is_none() && is_identity(l) {
                        out.device = Some(l.to_string());
                    }
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                ) => {}
            Err(e) => {
                out.error = Some(e.to_string());
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_lines() {
        assert!(is_identity(
            "SR6-OSR2-CraftyHandy-NTC v2.0 温控开启 (NTC34/LED32)"
        ));
        assert!(!is_identity("`"));
        assert!(!is_identity("#ok"));
        assert!(!is_identity("\u{1b}[0m"));
        assert!(!is_identity("1234"));
    }
}
