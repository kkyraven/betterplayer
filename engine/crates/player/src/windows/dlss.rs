use std::ptr;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::enhance::{DlssRequest, DlssShared};
use crate::render::Msg;
use crate::windows::dlss5::{self, Session, SessionControl, VideoHeader};

const DEBOUNCE: Duration = Duration::from_millis(400);

#[derive(Clone, Copy, PartialEq)]
struct Built {
    input: (u32, u32),
    output: (u32, u32),
    request: DlssRequest,
}

struct Surfaces {
    in_fbo: u32,
    in_tex: u32,
    in_size: (u32, u32),
    out_fbo: u32,
    out_tex: u32,
    out_size: (u32, u32),
}

impl Surfaces {
    fn new() -> Surfaces {
        Surfaces { in_fbo: 0, in_tex: 0, in_size: (0, 0), out_fbo: 0, out_tex: 0, out_size: (0, 0) }
    }

    fn ensure(fbo: &mut u32, tex: &mut u32, current: &mut (u32, u32), size: (u32, u32)) {
        if *current == size && *fbo != 0 {
            return;
        }
        unsafe {
            if *tex == 0 {
                gl::GenTextures(1, tex);
                gl::GenFramebuffers(1, fbo);
            }
            gl::BindTexture(gl::TEXTURE_2D, *tex);
            gl::TexImage2D(gl::TEXTURE_2D, 0, gl::RGBA8 as i32, size.0 as i32, size.1 as i32, 0, gl::RGBA, gl::UNSIGNED_BYTE, ptr::null());
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::LINEAR as i32);
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::LINEAR as i32);
            gl::BindFramebuffer(gl::FRAMEBUFFER, *fbo);
            gl::FramebufferTexture2D(gl::FRAMEBUFFER, gl::COLOR_ATTACHMENT0, gl::TEXTURE_2D, *tex, 0);
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
        }
        *current = size;
    }

    fn input(&mut self, size: (u32, u32)) -> u32 {
        Surfaces::ensure(&mut self.in_fbo, &mut self.in_tex, &mut self.in_size, size);
        self.in_fbo
    }

    fn output(&mut self, size: (u32, u32)) -> u32 {
        Surfaces::ensure(&mut self.out_fbo, &mut self.out_tex, &mut self.out_size, size);
        self.out_fbo
    }
}

impl Drop for Surfaces {
    fn drop(&mut self) {
        unsafe {
            for fbo in [self.in_fbo, self.out_fbo] {
                if fbo != 0 {
                    gl::DeleteFramebuffers(1, &fbo);
                }
            }
            for tex in [self.in_tex, self.out_tex] {
                if tex != 0 {
                    gl::DeleteTextures(1, &tex);
                }
            }
        }
    }
}

struct Capture {
    pbo: u32,
    fence: gl::types::GLsync,
    serial: u64,
    len: usize,
    started: Instant,
}

impl Capture {
    fn start(fbo: u32, size: (u32, u32), serial: u64) -> Result<Self, String> {
        let mut pbo = 0;
        let len = size.0 as usize * size.1 as usize * 4;
        unsafe {
            gl::GenBuffers(1, &mut pbo);
            gl::BindBuffer(gl::PIXEL_PACK_BUFFER, pbo);
            gl::BufferData(gl::PIXEL_PACK_BUFFER, len as isize, ptr::null(), gl::STREAM_READ);
            gl::BindFramebuffer(gl::READ_FRAMEBUFFER, fbo);
            gl::PixelStorei(gl::PACK_ALIGNMENT, 4);
            gl::ReadPixels(0, 0, size.0 as i32, size.1 as i32, gl::RGBA, gl::UNSIGNED_BYTE, ptr::null_mut());
            let fence = gl::FenceSync(gl::SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl::BindBuffer(gl::PIXEL_PACK_BUFFER, 0);
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            gl::Flush();
            let capture = Self { pbo, fence, serial, len, started: Instant::now() };
            if fence.is_null() || gl::GetError() != gl::NO_ERROR {
                return Err("DLSS GPU readback could not be queued".into());
            }
            Ok(capture)
        }
    }

    fn poll(&self) -> Result<Option<Vec<u8>>, String> {
        if self.started.elapsed() >= Duration::from_secs(2) {
            return Err("DLSS GPU readback timed out".into());
        }
        unsafe {
            match gl::ClientWaitSync(self.fence, 0, 0) {
                gl::TIMEOUT_EXPIRED => return Ok(None),
                gl::ALREADY_SIGNALED | gl::CONDITION_SATISFIED => {},
                _ => return Err("DLSS GPU readback failed".into()),
            }
            gl::BindBuffer(gl::PIXEL_PACK_BUFFER, self.pbo);
            let data = gl::MapBufferRange(gl::PIXEL_PACK_BUFFER, 0, self.len as isize, gl::MAP_READ_BIT);
            if data.is_null() {
                gl::BindBuffer(gl::PIXEL_PACK_BUFFER, 0);
                return Err("DLSS GPU readback could not be mapped".into());
            }
            let bytes = std::slice::from_raw_parts(data as *const u8, self.len).to_vec();
            let ok = gl::UnmapBuffer(gl::PIXEL_PACK_BUFFER) == gl::TRUE;
            gl::BindBuffer(gl::PIXEL_PACK_BUFFER, 0);
            if !ok { return Err("DLSS GPU readback was invalidated".into()); }
            Ok(Some(bytes))
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            if !self.fence.is_null() { gl::DeleteSync(self.fence); }
            gl::DeleteBuffers(1, &self.pbo);
        }
    }
}

struct InputFrame { serial: u64, pixels: Vec<u8> }
enum WorkerEvent {
    Ready,
    Frame { serial: u64, pixels: Vec<u8> },
    Failed(String),
}

struct Worker {
    built: Built,
    input: Option<mpsc::SyncSender<InputFrame>>,
    events: mpsc::Receiver<WorkerEvent>,
    control: SessionControl,
    ready: bool,
    stopping: bool,
}

impl Worker {
    fn start(host: std::path::PathBuf, built: Built, wake: mpsc::Sender<Msg>) -> Result<Self, String> {
        let header = VideoHeader::live(built.input, &built.request.options)?;
        let control = SessionControl::new();
        let child_control = control.clone();
        let (tx, rx) = mpsc::sync_channel::<InputFrame>(1);
        let (events, result) = mpsc::channel();
        std::thread::Builder::new().name("bp-dlss-worker".into()).spawn(move || {
            let run = || -> Result<(), String> {
                let mut session = Session::start_cancellable(&host, header, child_control.clone())?;
                events.send(WorkerEvent::Ready).map_err(|_| "render thread closed")?;
                let _ = wake.send(Msg::Redraw);
                let motion = vec![0; session.input_bytes().1];
                while let Ok(frame) = rx.recv() {
                    let mut pixels = vec![0; session.output_bytes()];
                    session.process(&frame.pixels, &motion, frame.serial as i64, true, &mut pixels)?;
                    events.send(WorkerEvent::Frame { serial: frame.serial, pixels }).map_err(|_| "render thread closed")?;
                    let _ = wake.send(Msg::Redraw);
                }
                Ok(())
            };
            if let Err(error) = run() { let _ = events.send(WorkerEvent::Failed(error)); }
            child_control.cancel();
            child_control.wait_stopped();
            drop(events);
            let _ = wake.send(Msg::Redraw);
        }).map_err(|e| format!("starting DLSS thread: {e}"))?;
        Ok(Self { built, input: Some(tx), events: result, control, ready: false, stopping: false })
    }

    fn cancel(&mut self) {
        self.stopping = true;
        self.input = None;
        self.control.cancel();
    }
}

impl Drop for Worker {
    fn drop(&mut self) { self.cancel(); }
}

#[derive(Default)]
struct Flight {
    serial: u64,
    pending: Option<u64>,
    completed: Option<u64>,
}

impl Flight {
    fn advance(&mut self) -> bool {
        self.serial = self.serial.wrapping_add(1);
        self.completed = None;
        self.pending.take().is_some()
    }
    fn complete(&mut self, serial: u64) -> bool {
        if self.pending != Some(serial) || self.serial != serial { return false; }
        self.pending = None;
        self.completed = Some(serial);
        true
    }
}

pub(crate) struct DlssRender {
    shared: Arc<Mutex<DlssShared>>,
    wake: mpsc::Sender<Msg>,
    host: Result<std::path::PathBuf, String>,
    request: DlssRequest,
    changed_at: Instant,
    surfaces: Surfaces,
    worker: Option<Worker>,
    failure: Option<String>,
    capture: Option<Capture>,
    flight: Flight,
    completed: Option<Vec<u8>>,
    frame: Option<(u32, u32, u32)>,
}

impl DlssRender {
    pub fn new(shared: Arc<Mutex<DlssShared>>, wake: mpsc::Sender<Msg>) -> Self {
        Self {
            shared, wake, host: dlss5::available(), request: DlssRequest::default(),
            changed_at: Instant::now(), surfaces: Surfaces::new(), worker: None,
            failure: None, capture: None, flight: Flight::default(), completed: None, frame: None,
        }
    }

    fn report(&self, factor: f64, reason: Option<String>) {
        let mut shared = self.shared.lock().unwrap();
        if shared.request == self.request {
            shared.factor = factor;
            shared.reason = reason;
        }
    }

    fn cancel(&mut self) {
        if let Some(worker) = &mut self.worker { worker.cancel(); }
        self.capture = None;
        self.flight.pending = None;
        self.flight.completed = None;
        self.completed = None;
    }

    fn fail(&mut self, reason: String) {
        self.cancel();
        self.failure = Some(reason.clone());
        self.report(0.0, Some(reason));
    }

    pub fn new_frame(&mut self) {
        if self.flight.advance() {
            self.fail("DLSS cannot keep up with this video's frame rate; using Sharp. Turn DLSS off and on to retry".into());
        }
        self.completed = None;
    }

    pub fn suspend(&mut self) {
        self.cancel();
        self.request.enabled = false;
    }

    pub fn poll(&mut self) { self.poll_worker(); }

    pub fn has_worker(&self) -> bool { self.worker.is_some() }

    pub fn next_wake(&self) -> Option<Duration> {
        if self.capture.is_some() {
            return Some(Duration::from_millis(2));
        }
        if self.request.enabled && self.failure.is_none() && self.worker.is_none() {
            return Some(DEBOUNCE.saturating_sub(self.changed_at.elapsed()));
        }
        None
    }

    fn sizes(request: &DlssRequest) -> Result<((u32, u32), (u32, u32)), String> {
        request.options.validate()?;
        let (sw, sh) = request.source;
        let (tw, th) = request.output;
        if sw == 0 || sh == 0 || tw == 0 || th == 0 { return Err("waiting for the video and display size".into()); }
        let fit = (tw as f64 / sw as f64).min(th as f64 / sh as f64);
        let scale = (fit / request.options.factor).min(1.0);
        let scale = if request.options.input_height == 0 { scale } else {
            scale.min(request.options.input_height as f64 / sh as f64)
        };
        let even = |v: f64| ((v.floor() as u32) & !1).max(2);
        let input = (even(sw as f64 * scale), even(sh as f64 * scale));
        if input.0 < 64 || input.1 < 64 { return Err("display is too small for DLSS; using Sharp".into()); }
        let output = dlss5::output_size(input, request.options.factor)?;
        Ok((input, output))
    }

    fn poll_worker(&mut self) {
        loop {
            let Some(worker) = &mut self.worker else { break };
            match worker.events.try_recv() {
                Ok(_) if worker.stopping => {},
                Ok(WorkerEvent::Ready) => worker.ready = true,
                Ok(WorkerEvent::Frame { serial, pixels }) => {
                    if self.flight.complete(serial) { self.completed = Some(pixels); }
                }
                Ok(WorkerEvent::Failed(error)) => { self.fail(error); }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    let unexpected = !worker.stopping;
                    self.worker = None;
                    if unexpected { self.fail("DLSS worker stopped; using Sharp".into()); }
                    break;
                }
            }
        }
    }

    pub fn prepare(&mut self, target_w: u32, target_h: u32) -> Option<(u32, u32, u32)> {
        self.frame = None;
        let mut request = self.shared.lock().unwrap().request;
        request.output = (target_w, target_h);
        if request != self.request {
            self.cancel();
            self.request = request;
            self.changed_at = Instant::now();
            self.failure = None;
        }
        self.poll_worker();
        if !request.enabled { return None; }
        if let Some(error) = &self.failure { self.report(0.0, Some(error.clone())); return None; }
        let host = match &self.host {
            Ok(host) => host.clone(),
            Err(error) => { self.fail(error.clone()); return None; }
        };
        let (input, output) = match Self::sizes(&request) {
            Ok(sizes) => sizes,
            Err(error) => { self.fail(error); return None; }
        };
        if self.worker.is_none() && self.changed_at.elapsed() >= DEBOUNCE {
            let built = Built { input, output, request };
            match Worker::start(host, built, self.wake.clone()) {
                Ok(worker) => self.worker = Some(worker),
                Err(error) => { self.fail(error); return None; }
            }
        }
        if !self.worker.as_ref().is_some_and(|w| w.ready && !w.stopping) {
            self.report(0.0, Some("starting DLSS; using Sharp".into()));
            return None;
        }
        if let Some(capture) = &self.capture {
            match capture.poll() {
                Ok(Some(pixels)) => {
                    let serial = capture.serial;
                    self.capture = None;
                    let sent = self.worker.as_ref().and_then(|w| w.input.as_ref())
                        .is_some_and(|tx| tx.try_send(InputFrame { serial, pixels }).is_ok());
                    if !sent { self.fail("DLSS worker queue unavailable; using Sharp".into()); }
                }
                Ok(None) => {},
                Err(error) => self.fail(error),
            }
        }
        if self.failure.is_some() || self.flight.pending.is_some() || self.completed.is_some() { return None; }
        let fbo = self.surfaces.input(input);
        self.frame = Some((fbo, input.0, input.1));
        self.frame
    }

    pub fn process(&mut self, target: u32, target_w: u32, target_h: u32) -> bool {
        if let Some((fbo, w, h)) = self.frame.take() {
            match Capture::start(fbo, (w, h), self.flight.serial) {
                Ok(capture) => {
                    self.capture = Some(capture);
                    self.flight.pending = Some(self.flight.serial);
                    return false;
                }
                Err(error) => {
                    self.fail(error);
                    let _ = self.wake.send(Msg::Redraw);
                    return false;
                }
            }
        }
        if let Some(pixels) = &self.completed {
            let Some(worker) = &self.worker else { return true };
            let (w, h) = worker.built.output;
            let factor = worker.built.request.options.factor;
            let fbo = self.surfaces.output((w, h));
            unsafe {
                gl::BindBuffer(gl::PIXEL_UNPACK_BUFFER, 0);
                gl::BindTexture(gl::TEXTURE_2D, self.surfaces.out_tex);
                gl::PixelStorei(gl::UNPACK_ALIGNMENT, 4);
                gl::TexSubImage2D(gl::TEXTURE_2D, 0, 0, 0, w as i32, h as i32, gl::RGBA, gl::UNSIGNED_BYTE, pixels.as_ptr() as *const _);
                gl::BindTexture(gl::TEXTURE_2D, 0);
                gl::BindFramebuffer(gl::READ_FRAMEBUFFER, fbo);
                gl::BindFramebuffer(gl::DRAW_FRAMEBUFFER, target);
                gl::BlitFramebuffer(0, 0, w as i32, h as i32, 0, 0, target_w as i32, target_h as i32, gl::COLOR_BUFFER_BIT, gl::LINEAR);
                gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            }
            self.report(factor, None);
            return true;
        }
        self.flight.pending.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::enhance::DlssOptions;

    fn request(source: (u32, u32), output: (u32, u32)) -> DlssRequest {
        DlssRequest { enabled: true, source, output, options: DlssOptions::default() }
    }

    #[test]
    fn auto_sizes_fit_the_display_without_pre_upscaling() {
        assert_eq!(DlssRender::sizes(&request((2560, 1440), (3840, 2160))).unwrap(), ((2560, 1440), (3840, 2160)));
        assert_eq!(DlssRender::sizes(&request((1920, 1080), (960, 540))).unwrap(), ((640, 360), (960, 540)));
        assert_eq!(DlssRender::sizes(&request((1280, 720), (3840, 2160))).unwrap(), ((1280, 720), (1920, 1080)));
        assert!(DlssRender::sizes(&request((1920, 1080), (32, 32))).is_err());
    }

    #[test]
    fn explicit_budget_and_portrait_fit_are_respected() {
        let mut r = request((2560, 1440), (3840, 2160));
        r.options.input_height = 720;
        assert_eq!(DlssRender::sizes(&r).unwrap(), ((1280, 720), (1920, 1080)));
        assert_eq!(DlssRender::sizes(&request((1080, 1920), (1080, 1920))).unwrap(), ((720, 1280), (1080, 1920)));
        let (_, output) = DlssRender::sizes(&request((1920, 1080), (1000, 1000))).unwrap();
        assert!(output.0 <= 1000 && output.1 < 600);
    }

    #[test]
    fn newer_frames_reject_pending_and_completed_reconstructions() {
        let mut flight = Flight::default();
        flight.pending = Some(0);
        assert!(flight.advance(), "an over-budget frame requires fallback");
        assert!(!flight.complete(0), "late output must never be displayed");
        flight.pending = Some(1);
        assert!(flight.complete(1));
        assert_eq!(flight.completed, Some(1));
        assert!(!flight.advance(), "finished work does not stall the next frame");
        assert_eq!(flight.completed, None);
    }

    #[test]
    fn paused_debounce_has_a_deadline_and_failure_does_not_retry() {
        let (tx, _) = mpsc::channel();
        let shared = Arc::new(Mutex::new(DlssShared::default()));
        let mut render = DlssRender::new(shared, tx);
        render.request = request((1920, 1080), (1280, 720));
        assert!(render.next_wake().is_some_and(|d| d <= DEBOUNCE));
        render.changed_at = Instant::now() - DEBOUNCE;
        assert_eq!(render.next_wake(), Some(Duration::ZERO));
        render.fail("unsupported model".into());
        assert_eq!(render.next_wake(), None);
        render.request.enabled = false;
        render.failure = None;
        assert_eq!(render.next_wake(), None);
    }

    #[test]
    fn a_failed_start_stays_latched_until_the_request_changes() {
        let wanted = request((1920, 1080), (1280, 720));
        let shared = Arc::new(Mutex::new(DlssShared { request: wanted, ..Default::default() }));
        let (wake, _) = mpsc::channel();
        let mut render = DlssRender::new(shared.clone(), wake);
        render.host = Ok(std::path::PathBuf::from("unused-test-host"));
        render.request = wanted;
        render.changed_at = Instant::now() - DEBOUNCE;
        let (events, rx) = mpsc::channel();
        events.send(WorkerEvent::Failed("unsupported model".into())).unwrap();
        drop(events);
        render.worker = Some(Worker {
            built: Built { input: (852, 480), output: (1278, 720), request: wanted },
            input: None, events: rx, control: SessionControl::new(), ready: false, stopping: false,
        });
        for _ in 0..100 {
            assert!(render.prepare(1280, 720).is_none());
            assert!(render.worker.is_none(), "a failed request must not respawn");
            assert_eq!(render.next_wake(), None);
        }
        assert_eq!(shared.lock().unwrap().reason.as_deref(), Some("unsupported model"));
        shared.lock().unwrap().request.options.input_height = 480;
        assert!(render.prepare(1280, 720).is_none());
        assert!(render.failure.is_none());
        assert!(render.next_wake().is_some(), "changed settings must schedule paused startup");
    }

    #[test]
    fn changing_settings_waits_for_the_old_worker_to_exit() {
        let wanted = request((1920, 1080), (1280, 720));
        let shared = Arc::new(Mutex::new(DlssShared { request: wanted, ..Default::default() }));
        let (wake, _) = mpsc::channel();
        let mut render = DlssRender::new(shared, wake);
        render.host = Ok(std::path::PathBuf::from("unused-test-host"));
        let (events, rx) = mpsc::channel();
        let (input, _) = mpsc::sync_channel(1);
        render.worker = Some(Worker {
            built: Built { input: (1280, 720), output: (1920, 1080), request: wanted },
            input: Some(input), events: rx, control: SessionControl::new(), ready: false, stopping: false,
        });
        assert!(render.prepare(1280, 720).is_none());
        render.changed_at = Instant::now() - DEBOUNCE;
        events.send(WorkerEvent::Ready).unwrap();
        assert!(render.prepare(1280, 720).is_none());
        assert!(render.worker.as_ref().is_some_and(|worker| worker.stopping && !worker.ready));
        assert_eq!(render.next_wake(), None, "worker exit wakes cleanup without repeatedly redrawing fallback frames");
        drop(events);
        render.poll();
        assert!(render.worker.is_none(), "replacement is permitted only after the old thread exits");
    }
}
