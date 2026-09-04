//! Transports behind an output. Line transports send newline-terminated TCode and hand
//! back whatever lines the device sent, line-buffered, without blocking the tick. Buttplug
//! is a message protocol and gets its own link.

use std::io::{self, ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tungstenite::protocol::WebSocketConfig;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::buttplug::Buttplug;
use crate::coyote::CoyoteLink;
use crate::handy::{HandyHosting, HandyLink};

#[derive(Clone, Debug, PartialEq)]
pub enum Transport {
    Serial { path: String, baud: u32 },
    Udp { host: String, port: u16 },
    Tcp { host: String, port: u16 },
    WebSocket { url: String },
    /// Intiface Central or any Buttplug v3 server.
    Buttplug { url: String },
    /// A TCodeESP32 board over BLE, matched by advertised name or address prefix.
    Ble { name: String },
    /// A DG-Lab Coyote v3 over BLE. Strengths are the user's per-channel cap, 0..200,
    /// and 0 means silence until the user raises it.
    Coyote { name: String, strength_a: u8, strength_b: u8 },
    /// The Handy over its cloud API. An app key picks API v3, without one it is v2.
    Handy { key: String, app_key: Option<String>, hosting: HandyHosting },
}

impl Transport {
    pub fn kind(&self) -> &'static str {
        match self {
            Transport::Serial { .. } => "serial",
            Transport::Udp { .. } => "udp",
            Transport::Tcp { .. } => "tcp",
            Transport::WebSocket { .. } => "websocket",
            Transport::Buttplug { .. } => "buttplug",
            Transport::Ble { .. } => "ble",
            Transport::Coyote { .. } => "coyote",
            Transport::Handy { .. } => "handy",
        }
    }

    /// The address a user would recognise: port path, host and port, URL, or the connection
    /// key with its middle masked.
    pub fn address(&self) -> String {
        match self {
            Transport::Serial { path, .. } => path.clone(),
            Transport::Udp { host, port } | Transport::Tcp { host, port } => format!("{host}:{port}"),
            Transport::WebSocket { url } | Transport::Buttplug { url } => url.clone(),
            Transport::Ble { name } | Transport::Coyote { name, .. } => name.clone(),
            Transport::Handy { key, .. } => mask(key),
        }
    }
}

/// Keeps the first and last two characters of a connection key, enough to recognise it
/// without putting the whole key on screen or in a log.
fn mask(key: &str) -> String {
    let n = key.chars().count();
    if n <= 4 {
        return "*".repeat(n);
    }
    let head: String = key.chars().take(2).collect();
    let tail: String = key.chars().skip(n - 2).collect();
    format!("{head}{}{tail}", "*".repeat(n - 4))
}

/// What an output talks through once connected.
pub enum Link {
    Lines(Box<dyn Conn>),
    Buttplug(Buttplug),
    Coyote(CoyoteLink),
    Handy(HandyLink),
}

/// A blocking write (serial, TCP) gives up after this rather than holding the tick.
const WRITE_TIMEOUT: Duration = Duration::from_millis(100);
/// Unsent WebSocket bytes past this fail the send, so a stalled peer errors into the reconnect
/// instead of buffering at 100 Hz.
const WS_WRITE_CAP: usize = 16 * 1024;

pub trait Conn: Send {
    /// Hands a line to the transport. Must not block the tick: line transports queue it.
    fn send(&mut self, line: &str) -> io::Result<()>;
    /// Complete lines received since the last call.
    fn recv_lines(&mut self) -> Vec<String>;
    /// How long the last completed write took, once, when the transport writes on its own thread.
    fn last_write_us(&mut self) -> Option<u32> {
        None
    }
    /// The shortest spacing between lines the link carries; 0 for whatever the tick sends.
    fn min_interval_ms(&self) -> u32 {
        0
    }
}

/// Blocks while connecting; call it off the tick thread.
pub fn open(t: &Transport) -> io::Result<Link> {
    match t {
        Transport::Buttplug { url } => return Buttplug::connect(url).map(Link::Buttplug),
        Transport::Coyote { name, strength_a, strength_b } => return CoyoteLink::open(name, *strength_a, *strength_b).map(Link::Coyote),
        Transport::Handy { key, app_key, hosting } => return HandyLink::connect(key, app_key.as_deref(), *hosting).map(Link::Handy),
        _ => {}
    }
    Ok(Link::Lines(match t {
        Transport::Buttplug { .. } | Transport::Coyote { .. } | Transport::Handy { .. } => unreachable!(),
        Transport::Ble { name } => Box::new(crate::ble::tcode(name)?),
        Transport::Serial { path, baud } => {
            let port = serialport::new(path, *baud)
                .timeout(Duration::from_millis(100))
                .open()
                .map_err(|e| io::Error::new(ErrorKind::NotFound, e.to_string()))?;
            let reader = port.try_clone().map_err(|e| io::Error::other(e.to_string()))?;
            Box::new(StreamConn { writer: MailboxWriter::spawn(Box::new(port)), reader: LineReader::spawn(Box::new(reader)) })
        }
        Transport::Tcp { host, port } => {
            let addr = (host.as_str(), *port).to_socket_addrs()?.next().ok_or_else(|| io::Error::new(ErrorKind::NotFound, "no address"))?;
            let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))?;
            stream.set_nodelay(true)?;
            stream.set_read_timeout(Some(Duration::from_millis(100)))?;
            stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
            let reader = stream.try_clone()?;
            Box::new(StreamConn { writer: MailboxWriter::spawn(Box::new(stream)), reader: LineReader::spawn(Box::new(reader)) })
        }
        Transport::Udp { host, port } => {
            let socket = UdpSocket::bind("0.0.0.0:0")?;
            socket.connect((host.as_str(), *port))?;
            socket.set_nonblocking(true)?;
            Box::new(UdpConn { socket, partial: Vec::new() })
        }
        Transport::WebSocket { url } => Box::new(WsConn { ws: websocket(url)? }),
    }))
}

/// A `ws://` socket in non-blocking mode, shared by the TCode and Buttplug links. Every message
/// is flushed as it is sent; what the socket will not take yet waits in a capped buffer.
pub(crate) fn websocket(url: &str) -> io::Result<WebSocket<MaybeTlsStream<TcpStream>>> {
    let config = WebSocketConfig::default().write_buffer_size(0).max_write_buffer_size(WS_WRITE_CAP);
    let (ws, _) = tungstenite::client::connect_with_config(url, Some(config), 3).map_err(|e| io::Error::new(ErrorKind::ConnectionRefused, e.to_string()))?;
    if let MaybeTlsStream::Plain(s) = ws.get_ref() {
        s.set_nonblocking(true)?;
    }
    Ok(ws)
}

/// Sends one text frame, treating a would-block as sent (the socket flushes next write). A full
/// write buffer is an error: the peer has stopped reading.
pub(crate) fn ws_send(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>, text: &str) -> io::Result<()> {
    match ws.send(Message::Text(text.into())) {
        Ok(()) => Ok(()),
        Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => Ok(()),
        Err(e) => Err(io::Error::new(ErrorKind::BrokenPipe, e.to_string())),
    }
}

/// A writer thread with a one-slot mailbox plus a thread that line-buffers a blocking reader.
struct StreamConn {
    writer: MailboxWriter,
    reader: LineReader,
}

impl Conn for StreamConn {
    fn send(&mut self, line: &str) -> io::Result<()> {
        self.writer.send(line)
    }

    fn recv_lines(&mut self) -> Vec<String> {
        self.reader.take()
    }

    fn last_write_us(&mut self) -> Option<u32> {
        self.writer.last_write_us()
    }
}

struct Mailbox {
    line: String,
    pending: bool,
    stop: bool,
    /// The write that failed; every send after it fails too, until the output reconnects.
    error: Option<String>,
    write_us: Option<u32>,
}

/// Writes lines on its own thread so a device that stops draining (a pulled cable, a full
/// buffer) never holds the tick. The mailbox keeps one line: positions are absolute, so a line
/// not yet written is replaced by the newer one.
struct MailboxWriter {
    shared: Arc<(Mutex<Mailbox>, Condvar)>,
    thread: Option<JoinHandle<()>>,
}

impl MailboxWriter {
    fn spawn(mut writer: Box<dyn Write + Send>) -> MailboxWriter {
        let shared = Arc::new((Mutex::new(Mailbox { line: String::new(), pending: false, stop: false, error: None, write_us: None }), Condvar::new()));
        let thread = {
            let shared = shared.clone();
            thread::spawn(move || {
                let (mailbox, wake) = &*shared;
                let mut line = String::new();
                loop {
                    {
                        let mut m = mailbox.lock().unwrap();
                        while !m.pending && !m.stop {
                            m = wake.wait(m).unwrap();
                        }
                        // A line handed in before the stop still goes out.
                        if m.stop && !m.pending {
                            break;
                        }
                        std::mem::swap(&mut line, &mut m.line);
                        m.pending = false;
                    }
                    let t0 = Instant::now();
                    let result = writer.write_all(line.as_bytes());
                    let mut m = mailbox.lock().unwrap();
                    match result {
                        Ok(()) => m.write_us = Some(t0.elapsed().as_micros() as u32),
                        Err(e) => {
                            m.error = Some(e.to_string());
                            break;
                        }
                    }
                }
            })
        };
        MailboxWriter { shared, thread: Some(thread) }
    }

    fn send(&self, line: &str) -> io::Result<()> {
        let mut m = self.shared.0.lock().unwrap();
        if let Some(e) = &m.error {
            return Err(io::Error::new(ErrorKind::BrokenPipe, e.clone()));
        }
        m.line.clear();
        m.line.push_str(line);
        m.pending = true;
        self.shared.1.notify_one();
        Ok(())
    }

    fn last_write_us(&self) -> Option<u32> {
        self.shared.0.lock().unwrap().write_us.take()
    }
}

impl Drop for MailboxWriter {
    fn drop(&mut self) {
        self.shared.0.lock().unwrap().stop = true;
        self.shared.1.notify_one();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct LineReader {
    lines: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl LineReader {
    fn spawn(mut reader: Box<dyn Read + Send>) -> LineReader {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let lines = lines.clone();
            let stop = stop.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 1024];
                let mut partial = Vec::new();
                while !stop.load(Ordering::Relaxed) {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => split_lines(&mut partial, &buf[..n], &mut lines.lock().unwrap()),
                        Err(e) if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                        Err(_) => break,
                    }
                }
            })
        };
        LineReader { lines, stop, thread: Some(thread) }
    }

    fn take(&mut self) -> Vec<String> {
        std::mem::take(&mut *self.lines.lock().unwrap())
    }
}

impl Drop for LineReader {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Appends complete lines from `bytes` to `out`, keeping the unterminated tail in `partial`.
pub(crate) fn split_lines(partial: &mut Vec<u8>, bytes: &[u8], out: &mut Vec<String>) {
    for &b in bytes {
        if b == b'\n' {
            let line = String::from_utf8_lossy(partial).trim_end_matches('\r').to_string();
            partial.clear();
            if out.len() < 200 {
                out.push(line);
            }
        } else if partial.len() < 512 {
            partial.push(b);
        }
    }
}

struct UdpConn {
    socket: UdpSocket,
    partial: Vec<u8>,
}

impl Conn for UdpConn {
    fn send(&mut self, line: &str) -> io::Result<()> {
        self.socket.send(line.as_bytes()).map(|_| ())
    }

    fn recv_lines(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        let mut buf = [0u8; 1024];
        while let Ok(n) = self.socket.recv(&mut buf) {
            split_lines(&mut self.partial, &buf[..n], &mut out);
        }
        out
    }
}

struct WsConn {
    ws: WebSocket<MaybeTlsStream<TcpStream>>,
}

impl Conn for WsConn {
    fn send(&mut self, line: &str) -> io::Result<()> {
        ws_send(&mut self.ws, line)
    }

    fn recv_lines(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        loop {
            match self.ws.read() {
                Ok(Message::Text(t)) => out.extend(t.as_str().lines().map(String::from)),
                Ok(_) => {}
                Err(_) => break,
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_handy_shows_a_masked_key() {
        let t = Transport::Handy { key: "AbCdEfGh".into(), app_key: None, hosting: crate::handy::HandyHosting::Cloud };
        assert_eq!((t.kind(), t.address()), ("handy", "Ab****Gh".to_string()));
        assert_eq!(mask("abc"), "***");
    }

    /// A writer that records what it got, and can be told to fail.
    struct Sink(Arc<Mutex<Vec<u8>>>, bool);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if self.1 {
                return Err(io::Error::new(ErrorKind::BrokenPipe, "gone"));
            }
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn the_mailbox_writes_the_newest_line_and_reports_a_failed_write() {
        let got = Arc::new(Mutex::new(Vec::new()));
        let writer = MailboxWriter::spawn(Box::new(Sink(got.clone(), false)));
        writer.send("L0500\n").unwrap();
        writer.send("L0600\n").unwrap();
        drop(writer);
        let text = String::from_utf8(got.lock().unwrap().clone()).unwrap();
        assert!(text.ends_with("L0600\n"), "wrote {text:?}");

        let failing = MailboxWriter::spawn(Box::new(Sink(got, true)));
        failing.send("L0500\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while failing.send("L0500\n").is_ok() {
            assert!(Instant::now() < deadline, "the failed write never surfaced");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn lines_split_across_reads() {
        let mut partial = Vec::new();
        let mut out = Vec::new();
        split_lines(&mut partial, b"TCode v0.3\r\nSR6", &mut out);
        split_lines(&mut partial, b" v2\n", &mut out);
        assert_eq!(out, vec!["TCode v0.3", "SR6 v2"]);
        assert!(partial.is_empty());
    }
}
