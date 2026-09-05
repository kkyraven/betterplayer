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
use crate::howl::{self, HowlLink};
use crate::openshock::{OpenShockLink, OpenShockTrigger};
use crate::ossm::OssmLink;
use crate::toys::{BIND_TIMEOUT, ToyLink};

#[derive(Clone, Debug, PartialEq)]
pub enum Transport {
    Serial {
        path: String,
        baud: u32,
    },
    Udp {
        host: String,
        port: u16,
    },
    Tcp {
        host: String,
        port: u16,
    },
    WebSocket {
        url: String,
    },

    Buttplug {
        url: String,
    },

    Ble {
        name: String,
    },


    Ossm {
        name: String,
    },


    Coyote {
        name: String,
        strength_a: u8,
        strength_b: u8,
    },

    Handy {
        key: String,
        app_key: Option<String>,
        hosting: HandyHosting,
    },

    Howl {
        host: String,
        key: String,
    },


    Toy {
        name: String,
        address: String,
    },


    OpenShock {
        url: String,
        token: String,
        shocker: String,
        trigger: OpenShockTrigger,
    },
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
            Transport::Ossm { .. } => "ossm",
            Transport::Coyote { .. } => "coyote",
            Transport::Handy { .. } => "handy",
            Transport::Howl { .. } => "howl",
            Transport::Toy { .. } => "toy",
            Transport::OpenShock { .. } => "openshock",
        }
    }



    pub fn address(&self) -> String {
        match self {
            Transport::Serial { path, .. } => path.clone(),
            Transport::Udp { host, port } | Transport::Tcp { host, port } => {
                format!("{host}:{port}")
            }
            Transport::WebSocket { url } | Transport::Buttplug { url } => url.clone(),
            Transport::Ble { name } | Transport::Coyote { name, .. } => name.clone(),
            Transport::Ossm { name } => {
                if name.is_empty() {
                    "OSSM".into()
                } else {
                    name.clone()
                }
            }
            Transport::Handy { key, .. } => mask(key),
            Transport::Howl { host, .. } => format!("{host}:{}", howl::PORT),
            Transport::Toy { name, address } => {
                if name.is_empty() {
                    address.clone()
                } else {
                    name.clone()
                }
            }
            Transport::OpenShock { url, .. } => host_of(url),
        }
    }
}


fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.split('/').next().unwrap_or_default().to_string()
}



fn mask(key: &str) -> String {
    let n = key.chars().count();
    if n <= 4 {
        return "*".repeat(n);
    }
    let head: String = key.chars().take(2).collect();
    let tail: String = key.chars().skip(n - 2).collect();
    format!("{head}{}{tail}", "*".repeat(n - 4))
}


pub enum Link {
    Lines(Box<dyn Conn>),
    Buttplug(Buttplug),
    Coyote(CoyoteLink),
    Ossm(OssmLink),
    Handy(HandyLink),
    Howl(HowlLink),
    Toy(ToyLink),
    OpenShock(OpenShockLink),
}


const WRITE_TIMEOUT: Duration = Duration::from_millis(100);


const WS_WRITE_CAP: usize = 16 * 1024;

pub trait Conn: Send {

    fn send(&mut self, line: &str) -> io::Result<()>;

    fn recv_lines(&mut self) -> Vec<String>;

    fn last_write_us(&mut self) -> Option<u32> {
        None
    }

    fn min_interval_ms(&self) -> u32 {
        0
    }
}





pub fn open_serial(path: &str, baud: u32, timeout: Duration) -> serialport::Result<Box<dyn serialport::SerialPort>> {
    let mut port = serialport::new(path, baud).timeout(timeout).flow_control(serialport::FlowControl::None).open()?;
    #[cfg(windows)]
    {
        port.write_data_terminal_ready(false)?;
        port.write_request_to_send(false)?;
    }
    Ok(port)
}





pub fn serial_reader(port: Box<dyn serialport::SerialPort>, wait: Duration) -> Box<dyn Read + Send> {
    #[cfg(windows)]
    {
        Box::new(PolledSerial { port, wait })
    }
    #[cfg(not(windows))]
    {
        let _ = wait;
        Box::new(port)
    }
}

#[cfg(windows)]
struct PolledSerial {
    port: Box<dyn serialport::SerialPort>,
    wait: Duration,
}

#[cfg(windows)]
impl Read for PolledSerial {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let deadline = Instant::now() + self.wait;
        loop {
            match self.port.bytes_to_read() {
                Ok(0) => {
                    if Instant::now() >= deadline {
                        return Err(io::Error::new(ErrorKind::TimedOut, "no input"));
                    }
                    thread::sleep(Duration::from_millis(1));
                }
                Ok(_) => return self.port.read(buf),
                Err(e) => return Err(io::Error::other(e.to_string())),
            }
        }
    }
}


pub fn open(t: &Transport) -> io::Result<Link> {
    match t {
        Transport::Buttplug { url } => return Buttplug::connect(url).map(Link::Buttplug),
        Transport::Coyote {
            name,
            strength_a,
            strength_b,
        } => return CoyoteLink::open(name, *strength_a, *strength_b).map(Link::Coyote),
        Transport::Ossm { name } => return OssmLink::open(name).map(Link::Ossm),
        Transport::Handy {
            key,
            app_key,
            hosting,
        } => return HandyLink::connect(key, app_key.as_deref(), *hosting).map(Link::Handy),
        Transport::Howl { host, key } => return HowlLink::connect(host, key).map(Link::Howl),
        Transport::Toy { name, address } => {
            return crate::toys::hub()
                .bind(address, name, BIND_TIMEOUT)
                .map(Link::Toy);
        }
        Transport::OpenShock {
            url,
            token,
            shocker,
            trigger,
        } => return OpenShockLink::connect(url, token, shocker, *trigger).map(Link::OpenShock),
        _ => {}
    }
    Ok(Link::Lines(match t {
        Transport::Buttplug { .. }
        | Transport::Coyote { .. }
        | Transport::Ossm { .. }
        | Transport::Handy { .. }
        | Transport::Howl { .. }
        | Transport::Toy { .. }
        | Transport::OpenShock { .. } => unreachable!(),
        Transport::Ble { name } => Box::new(crate::ble::tcode(name)?),
        Transport::Serial { path, baud } => {
            let port = open_serial(path, *baud, Duration::from_millis(100)).map_err(|e| io::Error::new(ErrorKind::NotFound, e.to_string()))?;
            let reader = port.try_clone().map_err(|e| io::Error::other(e.to_string()))?;
            Box::new(StreamConn { writer: MailboxWriter::spawn(Box::new(port)), reader: LineReader::spawn(serial_reader(reader, Duration::from_millis(100))) })
        }
        Transport::Tcp { host, port } => {
            let addr = (host.as_str(), *port)
                .to_socket_addrs()?
                .next()
                .ok_or_else(|| io::Error::new(ErrorKind::NotFound, "no address"))?;
            let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))?;
            stream.set_nodelay(true)?;
            stream.set_read_timeout(Some(Duration::from_millis(100)))?;
            stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
            let reader = stream.try_clone()?;
            Box::new(StreamConn {
                writer: MailboxWriter::spawn(Box::new(stream)),
                reader: LineReader::spawn(Box::new(reader)),
            })
        }
        Transport::Udp { host, port } => {
            let socket = UdpSocket::bind("0.0.0.0:0")?;
            socket.connect((host.as_str(), *port))?;
            socket.set_nonblocking(true)?;
            Box::new(UdpConn {
                socket,
                partial: Vec::new(),
            })
        }
        Transport::WebSocket { url } => Box::new(WsConn {
            ws: websocket(url)?,
        }),
    }))
}



pub(crate) fn websocket(url: &str) -> io::Result<WebSocket<MaybeTlsStream<TcpStream>>> {
    let config = WebSocketConfig::default()
        .write_buffer_size(0)
        .max_write_buffer_size(WS_WRITE_CAP);
    let (ws, _) = tungstenite::client::connect_with_config(url, Some(config), 3)
        .map_err(|e| io::Error::new(ErrorKind::ConnectionRefused, e.to_string()))?;
    if let MaybeTlsStream::Plain(s) = ws.get_ref() {
        s.set_nonblocking(true)?;
    }
    Ok(ws)
}



pub(crate) fn ws_send(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>, text: &str) -> io::Result<()> {
    match ws.send(Message::Text(text.into())) {
        Ok(()) => Ok(()),
        Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => Ok(()),
        Err(e) => Err(io::Error::new(ErrorKind::BrokenPipe, e.to_string())),
    }
}


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

    error: Option<String>,
    write_us: Option<u32>,
}




struct MailboxWriter {
    shared: Arc<(Mutex<Mailbox>, Condvar)>,
    thread: Option<JoinHandle<()>>,
}

impl MailboxWriter {
    fn spawn(mut writer: Box<dyn Write + Send>) -> MailboxWriter {
        let shared = Arc::new((
            Mutex::new(Mailbox {
                line: String::new(),
                pending: false,
                stop: false,
                error: None,
                write_us: None,
            }),
            Condvar::new(),
        ));
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
        MailboxWriter {
            shared,
            thread: Some(thread),
        }
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
                        Err(e)
                            if matches!(
                                e.kind(),
                                ErrorKind::TimedOut
                                    | ErrorKind::WouldBlock
                                    | ErrorKind::Interrupted
                            ) => {}
                        Err(_) => break,
                    }
                }
            })
        };
        LineReader {
            lines,
            stop,
            thread: Some(thread),
        }
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


pub(crate) fn split_lines(partial: &mut Vec<u8>, bytes: &[u8], out: &mut Vec<String>) {
    for &b in bytes {
        if b == b'\n' {
            let line = String::from_utf8_lossy(partial)
                .trim_end_matches('\r')
                .to_string();
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
        let t = Transport::Handy {
            key: "AbCdEfGh".into(),
            app_key: None,
            hosting: crate::handy::HandyHosting::Cloud,
        };
        assert_eq!((t.kind(), t.address()), ("handy", "Ab****Gh".to_string()));
        assert_eq!(mask("abc"), "***");
        assert_eq!(host_of("https://api.openshock.app/"), "api.openshock.app");
        assert_eq!(host_of("shock.local:8080"), "shock.local:8080");
    }


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
