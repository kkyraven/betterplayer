#![allow(dead_code)]

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::enhance::{DlssOptions, dlss_mode};

pub const DIR: &str = "dlss5";
pub const HOST_DIR: &str = "host";
pub const WORKER: &str = "nvngx.dll";
pub const RESHADE: &str = "dxgi.dll";
pub const ADDON: &str = "renodx-dlss5.addon64";
pub const NEURAL_RUNTIME: &str = "nvngx_dlssnr.dll";
pub const SUPER_RESOLUTION: &str = "dlss/nvngx_dlss.dll";

pub const REQUIRED: [&str; 5] = ["host/nvngx.dll", "host/dxgi.dll", "host/renodx-dlss5.addon64", "host/nvngx_dlssnr.dll", "dlss/nvngx_dlss.dll"];

pub const MAX_OUTPUT: (u32, u32) = (7680, 4320);

pub fn available() -> Result<PathBuf, String> {
    let dir = super::module_dir().ok_or("the engine's folder could not be found")?;
    check_layout(&dir.join(DIR))
}

fn check_layout(runtime: &Path) -> Result<PathBuf, String> {
    let name = runtime.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| DIR.into());
    if !runtime.is_dir() {
        return Err(format!("{name}\\ not found next to the engine"));
    }
    let missing: Vec<&str> = REQUIRED.iter().copied().filter(|rel| !runtime.join(rel).is_file()).collect();
    if missing.is_empty() {
        Ok(runtime.join(HOST_DIR))
    } else {
        Err(format!("{name}\\ is missing {}", missing.join(", ")))
    }
}

pub const VIDEO_MAGIC: u32 = 0x3456_3544;
pub const SETUP_MAGIC: u32 = 0x3450_5553;
pub const FRAME_MAGIC: u32 = 0x314D_5246;
pub const OUT_MAGIC: u32 = 0x3154_554F;
pub const END_MAGIC: u32 = 0x3144_4E45;

pub const LIVE_FRAME_COUNT: u32 = 0;

#[derive(Clone, Debug, PartialEq)]
pub struct VideoHeader {
    pub input: (u32, u32),
    pub output: (u32, u32),
    pub warmup_frames: u32,
    pub frame_count: u32,
    pub perf_quality: u32,
    pub model_preset: u32,
    pub profile: u32,
    pub preset: u32,
    pub style: u32,
    pub auto_mask: u32,
    pub ui_correction: u32,
    pub intensity: f32,
    pub local_tone: f32,
    pub local_structure: f32,
    pub skin_structure: f32,
}

impl VideoHeader {
    pub const SIZE: usize = 14 * 4 + 4 * 4;

    pub fn live(input: (u32, u32), options: &DlssOptions) -> Result<VideoHeader, String> {
        options.validate()?;
        let (_, perf_quality) = dlss_mode(options.factor).ok_or("not a DLSS mode")?;
        let output = output_size(input, options.factor)?;
        Ok(VideoHeader {
            input,
            output,
            warmup_frames: 0,
            frame_count: LIVE_FRAME_COUNT,
            perf_quality,
            model_preset: options.model_preset.code(),
            profile: 0,
            preset: options.nr_preset.code(),
            style: options.nr_style.code(),
            auto_mask: options.auto_mask as u32,
            ui_correction: 0,
            intensity: options.intensity,
            local_tone: options.local_tone,
            local_structure: options.local_structure,
            skin_structure: options.skin_structure,
        })
    }

    pub fn to_bytes(&self) -> [u8; Self::SIZE] {
        let mut out = [0u8; Self::SIZE];
        let words = [
            VIDEO_MAGIC,
            self.input.0,
            self.input.1,
            self.output.0,
            self.output.1,
            self.warmup_frames,
            self.frame_count,
            self.perf_quality,
            self.model_preset,
            self.profile,
            self.preset,
            self.style,
            self.auto_mask,
            self.ui_correction,
        ];
        for (i, w) in words.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
        }
        for (i, f) in [self.intensity, self.local_tone, self.local_structure, self.skin_structure].iter().enumerate() {
            let at = 56 + i * 4;
            out[at..at + 4].copy_from_slice(&f.to_le_bytes());
        }
        out
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetupResponse {
    pub ok: bool,
    pub result: u32,
    pub render: (u32, u32),
    pub output: (u32, u32),
    pub minimum: (u32, u32),
    pub maximum: (u32, u32),
    pub model_preset: u32,
}

impl SetupResponse {
    pub const SIZE: usize = 12 * 4;

    pub fn parse(bytes: &[u8; Self::SIZE]) -> Result<SetupResponse, String> {
        let w = |i: usize| u32::from_le_bytes([bytes[i * 4], bytes[i * 4 + 1], bytes[i * 4 + 2], bytes[i * 4 + 3]]);
        if w(0) != SETUP_MAGIC {
            return Err("the worker does not speak the version-4 protocol".into());
        }
        Ok(SetupResponse { ok: w(1) != 0, result: w(2), render: (w(3), w(4)), output: (w(5), w(6)), minimum: (w(7), w(8)), maximum: (w(9), w(10)), model_preset: w(11) })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameHeader {
    pub magic: u32,
    pub index: u32,
    pub reset: bool,
    pub pts: i64,
}

impl FrameHeader {
    pub const SIZE: usize = 4 * 4 + 8;

    pub fn to_bytes(&self) -> [u8; Self::SIZE] {
        let mut out = [0u8; Self::SIZE];
        out[0..4].copy_from_slice(&self.magic.to_le_bytes());
        out[4..8].copy_from_slice(&self.index.to_le_bytes());
        out[8..12].copy_from_slice(&(self.reset as u32).to_le_bytes());
        out[16..24].copy_from_slice(&self.pts.to_le_bytes());
        out
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameResult {
    pub magic: u32,
    pub index: u32,
    pub ok: bool,
    pub bytes: u32,
    pub result: u32,
    pub pts: i64,
}

impl FrameResult {
    pub const SIZE: usize = 5 * 4 + 8;

    pub fn parse(bytes: &[u8; Self::SIZE]) -> FrameResult {
        let w = |i: usize| u32::from_le_bytes([bytes[i * 4], bytes[i * 4 + 1], bytes[i * 4 + 2], bytes[i * 4 + 3]]);
        let mut pts = [0u8; 8];
        pts.copy_from_slice(&bytes[20..28]);
        FrameResult { magic: w(0), index: w(1), ok: w(2) != 0, bytes: w(3), result: w(4), pts: i64::from_le_bytes(pts) }
    }
}

fn nearest_even(v: f64) -> u32 {
    ((v / 2.0 + 0.5).floor() as u32 * 2).max(2)
}

pub fn fit_height((width, height): (u32, u32), max_rows: u32) -> (u32, u32) {
    if height <= max_rows || height == 0 {
        return (width, height);
    }
    let scale = max_rows as f64 / height as f64;
    (nearest_even(width as f64 * scale), nearest_even(height as f64 * scale))
}

pub fn output_size((width, height): (u32, u32), factor: f64) -> Result<(u32, u32), String> {
    let out = (nearest_even(width as f64 * factor), nearest_even(height as f64 * factor));
    let (long, short) = (out.0.max(out.1), out.0.min(out.1));
    if long > MAX_OUTPUT.0 || short > MAX_OUTPUT.1 {
        return Err(format!("{}×{} at {factor}× would be {}×{}, past the {}×{} DLSS boundary", width, height, out.0, out.1, MAX_OUTPUT.0, MAX_OUTPUT.1));
    }
    Ok(out)
}

#[derive(Clone, Default)]
pub struct SessionControl(Arc<(Mutex<ControlState>, Condvar)>);

#[derive(Default)]
struct ControlState {
    watching: bool,
    cancelled: bool,
    deadline: Option<Instant>,
    failure: Option<String>,
    exited: Option<bool>,
}

impl SessionControl {
    pub fn new() -> Self { Self::default() }

    pub fn cancel(&self) {
        let mut state = self.0.0.lock().unwrap();
        state.cancelled = true;
        self.0.1.notify_all();
    }

    pub fn wait_stopped(&self) {
        let mut state = self.0.0.lock().unwrap();
        while state.watching && state.exited.is_none() {
            state = self.0.1.wait(state).unwrap();
        }
    }

    fn arm(&self, timeout: Duration) -> Result<(), String> {
        let mut state = self.0.0.lock().unwrap();
        if state.cancelled { return Err(state.failure.clone().unwrap_or_else(|| "DLSS worker cancelled".into())); }
        if state.exited.is_some() { return Err("DLSS worker exited".into()); }
        state.deadline = Some(Instant::now() + timeout);
        self.0.1.notify_all();
        Ok(())
    }

    fn disarm(&self) { self.0.0.lock().unwrap().deadline = None; }

    fn error(&self, fallback: String) -> String {
        self.0.0.lock().unwrap().failure.clone().unwrap_or(fallback)
    }

    fn wait_exit(&self) -> Result<(), String> {
        let mut state = self.0.0.lock().unwrap();
        loop {
            if let Some(failure) = &state.failure { return Err(failure.clone()); }
            if let Some(ok) = state.exited { return if ok { Ok(()) } else { Err("DLSS worker exited unsuccessfully".into()) }; }
            state = self.0.1.wait(state).unwrap();
        }
    }
}

fn watch_child(mut child: Child, control: SessionControl) {
    loop {
        let mut state = control.0.0.lock().unwrap();
        let expired = state.deadline.is_some_and(|deadline| Instant::now() >= deadline);
        if state.cancelled || expired {
            state.cancelled = true;
            state.failure = Some(if expired { "DLSS worker operation timed out" } else { "DLSS worker cancelled" }.into());
            drop(state);
            let _ = child.kill();
            let status = child.wait();
            let mut state = control.0.0.lock().unwrap();
            state.exited = Some(status.is_ok_and(|status| status.success()));
            control.0.1.notify_all();
            return;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                state.exited = Some(status.success());
                control.0.1.notify_all();
                return;
            }
            Err(error) => {
                state.failure = Some(format!("waiting for DLSS worker: {error}"));
                drop(state);
                let _ = child.kill();
                let status = child.wait();
                control.0.0.lock().unwrap().exited = Some(status.is_ok_and(|status| status.success()));
                control.0.1.notify_all();
                return;
            }
            Ok(None) => {}
        }
        let _ = control.0.1.wait_timeout(state, Duration::from_millis(10)).unwrap();
    }
}

struct CancelOnDrop(Option<SessionControl>);
impl Drop for CancelOnDrop { fn drop(&mut self) { if let Some(control) = &self.0 { control.cancel(); } } }

pub struct Session {
    control: SessionControl,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    header: VideoHeader,
    setup: SetupResponse,
    sent: u32,
}

impl Session {
    pub fn start(host: &Path, header: VideoHeader) -> Result<Session, String> {
        Self::start_cancellable(host, header, SessionControl::new())
    }

    pub fn start_cancellable(host: &Path, header: VideoHeader, control: SessionControl) -> Result<Session, String> {
        let mut command = Command::new(host.join(WORKER));
        command.arg("--video").current_dir(host);
        Self::start_command(command, header, control, Duration::from_secs(15))
    }

    fn start_command(mut command: Command, header: VideoHeader, control: SessionControl, timeout: Duration) -> Result<Session, String> {
        control.arm(timeout)?;
        let mut cleanup = CancelOnDrop(Some(control.clone()));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().map_err(|e| format!("starting {}: {e}", WORKER))?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let mut stdout = child.stdout.take().expect("piped stdout");
        control.0.0.lock().unwrap().watching = true;
        let watcher_control = control.clone();
        let child_slot = Arc::new(Mutex::new(Some(child)));
        let watcher_slot = child_slot.clone();
        if let Err(error) = std::thread::Builder::new().name("dlss-worker-watch".into()).spawn(move || {
            watch_child(watcher_slot.lock().unwrap().take().unwrap(), watcher_control);
        }) {
            if let Some(mut child) = child_slot.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            control.0.0.lock().unwrap().watching = false;
            control.0.1.notify_all();
            return Err(format!("starting DLSS watchdog: {error}"));
        }
        let mut negotiate = || -> Result<SetupResponse, String> {
            stdin.write_all(&header.to_bytes()).map_err(|e| format!("writing the header: {e}"))?;
            stdin.flush().map_err(|e| e.to_string())?;
            let mut buf = [0u8; SetupResponse::SIZE];
            stdout.read_exact(&mut buf).map_err(|e| format!("the worker stopped during setup: {e}"))?;
            let setup = SetupResponse::parse(&buf)?;
            if !setup.ok {
                return Err(format!("DLSS is unavailable for {}×{} (NGX 0x{:08X}); pick a lower scaling mode or update the driver", header.output.0, header.output.1, setup.result));
            }
            if setup.output != header.output {
                return Err("the worker returned an output size other than the request".into());
            }
            if setup.model_preset != header.model_preset {
                return Err(format!("the worker applied model preset {} instead of {}", setup.model_preset, header.model_preset));
            }
            if setup.render.0 < 64 || setup.render.1 < 64 {
                return Err(format!("DLSS render size {}×{} is below 64 pixels", setup.render.0, setup.render.1));
            }
            Ok(setup)
        };
        let setup = negotiate().map_err(|error| control.error(error))?;
        control.disarm();
        cleanup.0 = None;
        Ok(Session { control, stdin: Some(stdin), stdout, header, setup, sent: 0 })
    }

    pub fn header(&self) -> &VideoHeader {
        &self.header
    }

    pub fn setup(&self) -> &SetupResponse {
        &self.setup
    }

    pub fn input_bytes(&self) -> (usize, usize) {
        let pixels = self.header.input.0 as usize * self.header.input.1 as usize;
        (pixels * 4, pixels * 4)
    }

    pub fn output_bytes(&self) -> usize {
        self.header.output.0 as usize * self.header.output.1 as usize * 4
    }

    pub fn process(&mut self, rgba: &[u8], motion: &[u8], pts: i64, reset: bool, out: &mut [u8]) -> Result<(), String> {
        let (rgba_len, motion_len) = self.input_bytes();
        if rgba.len() != rgba_len || motion.len() != motion_len || out.len() != self.output_bytes() {
            return Err("frame buffers do not match the session's sizes".into());
        }
        self.control.arm(Duration::from_secs(2))?;
        let result = self.process_inner(rgba, motion, pts, reset, out);
        self.control.disarm();
        if result.is_err() { self.control.cancel(); }
        result.map_err(|error| self.control.error(error))
    }

    fn process_inner(&mut self, rgba: &[u8], motion: &[u8], pts: i64, reset: bool, out: &mut [u8]) -> Result<(), String> {
        let index = self.sent;
        let head = FrameHeader { magic: FRAME_MAGIC, index, reset, pts };
        let stdin = self.stdin.as_mut().ok_or("the stream is closed")?;
        stdin.write_all(&head.to_bytes()).and_then(|_| stdin.write_all(rgba)).and_then(|_| stdin.write_all(motion)).and_then(|_| stdin.flush()).map_err(|e| format!("writing frame {index}: {e}"))?;
        self.sent = self.sent.checked_add(1).ok_or("frame index overflow")?;
        let mut buf = [0u8; FrameResult::SIZE];
        self.stdout.read_exact(&mut buf).map_err(|e| format!("the worker stopped before frame {index}: {e}"))?;
        let result = FrameResult::parse(&buf);
        if result.magic != OUT_MAGIC || !result.ok || result.index != index || result.bytes as usize != out.len() || result.pts != pts {
            return Err(format!("invalid worker response for frame {index}"));
        }
        if result.result != 1 {
            return Err(format!("feature 18 failed on frame {index}: 0x{:08X}", result.result));
        }
        self.stdout.read_exact(out).map_err(|e| format!("reading frame {index}: {e}"))
    }

    pub fn finish(mut self) -> Result<u32, String> {
        self.control.arm(Duration::from_secs(2))?;
        let mut stdin = self.stdin.take().ok_or("the stream is closed")?;
        if self.header.frame_count == LIVE_FRAME_COUNT {
            let end = FrameHeader { magic: END_MAGIC, index: self.sent, reset: false, pts: 0 };
            stdin.write_all(&end.to_bytes()).and_then(|_| stdin.flush()).map_err(|e| format!("closing the stream: {e}"))?;
        }
        drop(stdin);
        if self.header.frame_count == LIVE_FRAME_COUNT {
            let mut buf = [0u8; FrameResult::SIZE];
            self.stdout.read_exact(&mut buf).map_err(|e| format!("reading the completion: {e}"))?;
            let ack = FrameResult::parse(&buf);
            if ack != (FrameResult { magic: END_MAGIC, index: self.sent, ok: true, bytes: 0, result: 1, pts: 0 }) {
                return Err("the worker's completion count does not match".into());
            }
        }
        self.control.wait_exit()?;
        Ok(self.sent)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.control.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn fake_worker(script: &str) -> Command {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
        command
    }

    #[cfg(windows)]
    #[test]
    fn stalled_setup_is_killed_at_deadline() {
        let control = SessionControl::new();
        let header = VideoHeader::live((64, 64), &DlssOptions::default()).unwrap();
        let started = Instant::now();
        let result = Session::start_command(fake_worker("Start-Sleep -Seconds 60"), header, control.clone(), Duration::from_millis(100));
        assert!(result.err().unwrap().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(control.wait_exit().is_err());
    }

    #[cfg(windows)]
    #[test]
    fn setup_can_be_cancelled_before_or_during_start() {
        let header = VideoHeader::live((64, 64), &DlssOptions::default()).unwrap();
        let cancelled = SessionControl::new();
        cancelled.cancel();
        assert!(Session::start_command(fake_worker("Start-Sleep -Seconds 60"), header.clone(), cancelled, Duration::from_secs(15)).err().unwrap().contains("cancelled"));
        let control = SessionControl::new();
        let cancel = control.clone();
        let helper = std::thread::spawn(move || {
            Session::start_command(fake_worker("Start-Sleep -Seconds 60"), header, control, Duration::from_secs(15)).err().unwrap()
        });
        std::thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        cancel.cancel();
        assert!(helper.join().unwrap().contains("cancelled"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(windows)]
    #[test]
    fn exited_worker_fails_setup_without_waiting_for_deadline() {
        let header = VideoHeader::live((64, 64), &DlssOptions::default()).unwrap();
        let started = Instant::now();
        assert!(Session::start_command(fake_worker("exit 7"), header, SessionControl::new(), Duration::from_secs(15)).is_err());
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(windows)]
    fn ready_worker(header: &VideoHeader, tail: &str) -> Command {
        let words = [SETUP_MAGIC, 1, 1, 64, 64, header.output.0, header.output.1, 64, 64, 7680, 4320, header.model_preset];
        let bytes = words.iter().flat_map(|word| word.to_le_bytes()).map(|byte| byte.to_string()).collect::<Vec<_>>().join(",");
        fake_worker(&format!("$stream = [Console]::OpenStandardOutput(); $bytes = [byte[]]@({bytes}); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush(); {tail}"))
    }

    #[cfg(windows)]
    #[test]
    fn stalled_frame_reads_and_writes_are_killed_at_deadline() {
        for tail in [
            "Start-Sleep -Seconds 60",
            "$inputStream = [Console]::OpenStandardInput(); $buf = New-Object byte[] 32864; $left = $buf.Length; while ($left -gt 0) { $count = $inputStream.Read($buf, 0, $left); if ($count -eq 0) { exit 9 }; $left -= $count }; Start-Sleep -Seconds 60",
        ] {
            let header = VideoHeader::live((64, 64), &DlssOptions::default()).unwrap();
            let command = ready_worker(&header, tail);
            let mut session = Session::start_command(command, header, SessionControl::new(), Duration::from_secs(10)).unwrap();
            let (rgba, motion) = session.input_bytes();
            let mut output = vec![0; session.output_bytes()];
            let started = Instant::now();
            let error = session.process(&vec![0; rgba], &vec![0; motion], 0, false, &mut output).unwrap_err();
            assert!(error.contains("timed out"), "{error}");
            assert!(started.elapsed() < Duration::from_secs(5));
        }
    }

    #[cfg(windows)]
    #[test]
    fn dropping_ready_session_reaps_worker() {
        let header = VideoHeader::live((64, 64), &DlssOptions::default()).unwrap();
        let control = SessionControl::new();
        let session = Session::start_command(ready_worker(&header, "Start-Sleep -Seconds 60"), header, control.clone(), Duration::from_secs(10)).unwrap();
        drop(session);
        let started = Instant::now();
        control.wait_stopped();
        assert!(started.elapsed() < Duration::from_secs(5), "worker was not reaped");
        assert!(control.0.0.lock().unwrap().exited.is_some());
    }

    #[test]
    fn stop_barrier_without_a_worker_returns_immediately() {
        let control = SessionControl::new();
        control.cancel();
        control.wait_stopped();
        let header = VideoHeader::live((64, 64), &DlssOptions::default()).unwrap();
        let failed = SessionControl::new();
        let command = Command::new("bp-deliberately-nonexistent-worker.exe");
        assert!(Session::start_command(command, header, failed.clone(), Duration::from_secs(15)).is_err());
        failed.cancel();
        failed.wait_stopped();
    }

    #[test]
    fn records_have_the_reference_sizes() {
        assert_eq!(VideoHeader::SIZE, 72);
        assert_eq!(SetupResponse::SIZE, 48);
        assert_eq!(FrameHeader::SIZE, 24);
        assert_eq!(FrameResult::SIZE, 28);
    }

    #[test]
    fn header_packs_little_endian_in_protocol_order() {
        let options = DlssOptions { intensity: 1.25, skin_structure: -1.0, auto_mask: true, ..DlssOptions::default() };
        let h = VideoHeader::live((1280, 720), &options).unwrap();
        assert_eq!(h.output, (1920, 1080));
        assert_eq!(h.perf_quality, 2, "Quality mode");
        let b = h.to_bytes();
        assert_eq!(&b[0..4], &VIDEO_MAGIC.to_le_bytes());
        assert_eq!(&b[0..4], b"D5V4");
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 1280);
        assert_eq!(u32::from_le_bytes(b[16..20].try_into().unwrap()), 1080);
        assert_eq!(u32::from_le_bytes(b[48..52].try_into().unwrap()), 1, "auto_mask");
        assert_eq!(f32::from_le_bytes(b[56..60].try_into().unwrap()), 1.25);
        assert_eq!(f32::from_le_bytes(b[68..72].try_into().unwrap()), -1.0);
    }

    #[test]
    fn frame_records_round_trip() {
        let f = FrameHeader { magic: FRAME_MAGIC, index: 7, reset: true, pts: -90_000 };
        let b = f.to_bytes();
        assert_eq!(&b[0..4], b"FRM1");
        assert_eq!(u32::from_le_bytes(b[8..12].try_into().unwrap()), 1);
        assert_eq!(&b[12..16], &[0, 0, 0, 0], "reserved word");
        assert_eq!(i64::from_le_bytes(b[16..24].try_into().unwrap()), -90_000);

        let mut r = [0u8; FrameResult::SIZE];
        r[0..4].copy_from_slice(b"OUT1");
        r[4..8].copy_from_slice(&7u32.to_le_bytes());
        r[8..12].copy_from_slice(&1u32.to_le_bytes());
        r[12..16].copy_from_slice(&(1920u32 * 1080 * 4).to_le_bytes());
        r[16..20].copy_from_slice(&1u32.to_le_bytes());
        r[20..28].copy_from_slice(&(-90_000i64).to_le_bytes());
        assert_eq!(FrameResult::parse(&r), FrameResult { magic: OUT_MAGIC, index: 7, ok: true, bytes: 1920 * 1080 * 4, result: 1, pts: -90_000 });
    }

    #[test]
    fn setup_response_needs_the_magic() {
        let mut b = [0u8; SetupResponse::SIZE];
        assert!(SetupResponse::parse(&b).is_err());
        b[0..4].copy_from_slice(b"SUP4");
        b[4..8].copy_from_slice(&1u32.to_le_bytes());
        b[44..48].copy_from_slice(&11u32.to_le_bytes());
        let s = SetupResponse::parse(&b).unwrap();
        assert!(s.ok);
        assert_eq!(s.model_preset, 11);
    }

    #[test]
    fn sizes_follow_the_reference_rules() {
        assert_eq!(fit_height((1920, 1080), 720), (1280, 720));
        assert_eq!(fit_height((1280, 720), 1080), (1280, 720), "smaller pictures are left alone");
        assert_eq!(fit_height((3840, 2160), 1440), (2560, 1440));
        assert_eq!(output_size((1280, 720), 1.724), Ok((2206, 1242)));
        assert_eq!(output_size((1280, 720), 3.0), Ok((3840, 2160)));
        assert!(output_size((3840, 2160), 3.0).unwrap_err().contains("boundary"));
        assert!(VideoHeader::live((3840, 2160), &DlssOptions { factor: 3.0, ..DlssOptions::default() }).is_err());
    }

    #[test]
    fn layout_check_names_what_is_missing() {
        let dir = std::env::temp_dir().join(format!("bp-dlss5-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(check_layout(&dir).unwrap_err().contains("not found"));
        std::fs::create_dir_all(dir.join("host")).unwrap();
        std::fs::create_dir_all(dir.join("dlss")).unwrap();
        std::fs::write(dir.join("host/nvngx.dll"), b"").unwrap();
        let err = check_layout(&dir).unwrap_err();
        assert!(err.contains("host/dxgi.dll") && err.contains("dlss/nvngx_dlss.dll") && !err.contains("host/nvngx.dll"), "{err}");
        for rel in REQUIRED {
            std::fs::write(dir.join(rel), b"").unwrap();
        }
        assert_eq!(check_layout(&dir).unwrap(), dir.join("host"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
