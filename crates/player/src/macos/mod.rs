use std::ffi::{CStr, c_char, c_void};
use std::ptr::NonNull;
use std::sync::{Arc, Mutex, OnceLock, mpsc};

use crate::enhance::{AppleRequest, AppleUpscaling, EnhanceCapabilities};
use crate::render::Msg;

unsafe extern "C" {
    fn bp_apple_scaler_supported() -> i32;
    fn bp_apple_scaler_factor(width: u32, height: u32, requested: f32) -> f32;
    fn bp_apple_scaler_create(width: u32, height: u32, factor: f32, error: *mut c_char, capacity: usize) -> *mut c_void;
    fn bp_apple_scaler_bind(handle: *mut c_void, destination: bool, error: *mut c_char, capacity: usize) -> bool;
    fn bp_apple_scaler_process(handle: *mut c_void, error: *mut c_char, capacity: usize) -> bool;
    fn bp_apple_scaler_destroy(handle: *mut c_void);
}

pub fn capabilities() -> EnhanceCapabilities {
    static SUPPORT: OnceLock<i32> = OnceLock::new();
    let support = *SUPPORT.get_or_init(|| unsafe { bp_apple_scaler_supported() });
    EnhanceCapabilities {
        apple_vsr: support > 0,
        apple_vsr_reason: match support {
            -1 => Some("Requires macOS 26".into()),
            0 => Some("Unsupported Mac".into()),
            _ => None,
        },
        ..EnhanceCapabilities::none("Windows with an NVIDIA RTX card")
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Key {
    source: (u32, u32),
    factor: f32,
}

struct Session(NonNull<c_void>);

unsafe impl Send for Session {}

fn error_text(error: &[c_char]) -> String {
    unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy().into_owned()
}

impl Session {
    fn new(key: Key) -> Result<Self, String> {
        let mut error = [0; 512];
        let raw = unsafe { bp_apple_scaler_create(key.source.0, key.source.1, key.factor, error.as_mut_ptr(), error.len()) };
        NonNull::new(raw).map(Session).ok_or_else(|| error_text(&error))
    }

    fn process(&self) -> Result<(), String> {
        let mut error = [0; 512];
        if unsafe { bp_apple_scaler_process(self.0.as_ptr(), error.as_mut_ptr(), error.len()) } { Ok(()) } else { Err(error_text(&error)) }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe { bp_apple_scaler_destroy(self.0.as_ptr()) };
    }
}

struct Surface {
    fbo: u32,
    texture: u32,
}

impl Surface {
    fn new(session: &Session, destination: bool) -> Result<Self, String> {
        let mut surface = Self { fbo: 0, texture: 0 };
        let mut error = [0; 512];
        unsafe {
            gl::GenTextures(1, &mut surface.texture);
            gl::BindTexture(gl::TEXTURE_RECTANGLE, surface.texture);
            gl::TexParameteri(gl::TEXTURE_RECTANGLE, gl::TEXTURE_MIN_FILTER, gl::LINEAR as i32);
            gl::TexParameteri(gl::TEXTURE_RECTANGLE, gl::TEXTURE_MAG_FILTER, gl::LINEAR as i32);
            gl::TexParameteri(gl::TEXTURE_RECTANGLE, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE as i32);
            gl::TexParameteri(gl::TEXTURE_RECTANGLE, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE as i32);
            if !bp_apple_scaler_bind(session.0.as_ptr(), destination, error.as_mut_ptr(), error.len()) {
                gl::BindTexture(gl::TEXTURE_RECTANGLE, 0);
                return Err(error_text(&error));
            }
            gl::GenFramebuffers(1, &mut surface.fbo);
            gl::BindFramebuffer(gl::FRAMEBUFFER, surface.fbo);
            gl::FramebufferTexture2D(gl::FRAMEBUFFER, gl::COLOR_ATTACHMENT0, gl::TEXTURE_RECTANGLE, surface.texture, 0);
            let status = gl::CheckFramebufferStatus(gl::FRAMEBUFFER);
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            gl::BindTexture(gl::TEXTURE_RECTANGLE, 0);
            if status != gl::FRAMEBUFFER_COMPLETE {
                return Err(format!("Apple AI framebuffer: 0x{status:x}"));
            }
        }
        Ok(surface)
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            gl::DeleteFramebuffers(1, &self.fbo);
            gl::DeleteTextures(1, &self.texture);
        }
    }
}

struct Ready {

    input: Surface,
    output: Surface,
    session: Session,
    key: Key,
}

impl Ready {
    fn new(session: Session, key: Key) -> Result<Self, String> {
        let input = Surface::new(&session, false)?;
        let output = Surface::new(&session, true)?;
        Ok(Self { input, output, session, key })
    }
}

struct Pending {
    key: Key,
    result: mpsc::Receiver<Result<Session, String>>,
}

pub(crate) struct Upscaler {
    shared: Arc<Mutex<AppleUpscaling>>,
    wake: mpsc::Sender<Msg>,
    request: AppleRequest,
    key: Option<Key>,
    ready: Option<Ready>,
    pending: Option<Pending>,
    failure: Option<String>,
}

impl Upscaler {
    pub fn new(shared: Arc<Mutex<AppleUpscaling>>, wake: mpsc::Sender<Msg>) -> Self {
        Self { shared, wake, request: AppleRequest::default(), key: None, ready: None, pending: None, failure: None }
    }

    fn status(&self, factor: f64, reason: Option<String>) {
        let mut shared = self.shared.lock().unwrap();
        if shared.request == self.request {
            shared.factor = factor;
            shared.reason = reason;
        }
    }


    pub fn prepare(&mut self) -> Option<(u32, u32, u32)> {
        let request = self.shared.lock().unwrap().request;
        if request != self.request {
            self.request = request;
            let key = if request.enabled && request.source.0 > 0 && request.source.1 > 0 {
                let ratio = (request.output.0 as f32 / request.source.0 as f32).max(request.output.1 as f32 / request.source.1 as f32);
                if ratio > 1.0 {
                    let factor = unsafe { bp_apple_scaler_factor(request.source.0, request.source.1, ratio) };
                    if factor > 1.0 {
                        Some(Key { source: request.source, factor })
                    } else {
                        self.status(0.0, Some("Unsupported video size".into()));
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };
            if key != self.key {
                self.ready = None;
                self.failure = None;
                self.key = key;
            }
        }

        if let Some(pending) = &self.pending {
            let result = match pending.result.try_recv() {
                Ok(result) => Some(result),
                Err(mpsc::TryRecvError::Disconnected) => Some(Err("Apple AI unavailable".into())),
                Err(mpsc::TryRecvError::Empty) => None,
            };
            if let Some(result) = result {
                let completed = pending.key;
                self.pending = None;
                if self.key == Some(completed) {
                    match result.and_then(|session| Ready::new(session, completed)) {
                        Ok(ready) => self.ready = Some(ready),
                        Err(error) => {
                            self.failure = Some(error);
                        }
                    }
                }
            }
        }

        let key = self.key?;
        if let Some(error) = &self.failure {
            self.status(0.0, Some(error.clone()));
            return None;
        }
        if self.ready.is_none() && self.pending.is_none() {
            let (tx, rx) = mpsc::channel();
            let wake = self.wake.clone();
            match std::thread::Builder::new().name("bp-apple-upscale".into()).spawn(move || {
                let _ = tx.send(Session::new(key));
                let _ = wake.send(Msg::Redraw);
            }) {
                Ok(_) => {
                    self.pending = Some(Pending { key, result: rx });
                    self.status(0.0, Some("Preparing Apple AI".into()));
                }
                Err(error) => {
                    self.failure = Some(error.to_string());
                    self.status(0.0, Some(error.to_string()));
                }
            }
        }
        self.ready.as_ref().map(|ready| (ready.input.fbo, key.source.0, key.source.1))
    }



    pub fn process(&mut self, target: u32, width: u32, height: u32) {
        let Some(ready) = &self.ready else { return };

        unsafe { gl::Finish() };
        let result = ready.session.process();
        let (fbo, factor) = if result.is_ok() { (ready.output.fbo, ready.key.factor) } else { (ready.input.fbo, 1.0) };
        unsafe {
            gl::Disable(gl::SCISSOR_TEST);
            gl::BindFramebuffer(gl::READ_FRAMEBUFFER, fbo);
            gl::BindFramebuffer(gl::DRAW_FRAMEBUFFER, target);
            gl::BlitFramebuffer(
                0,
                0,
                (ready.key.source.0 as f32 * factor).round() as i32,
                (ready.key.source.1 as f32 * factor).round() as i32,
                0,
                0,
                width as i32,
                height as i32,
                gl::COLOR_BUFFER_BIT,
                gl::LINEAR,
            );
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
        }
        match result {
            Ok(()) => self.status(f64::from(ready.key.factor), None),
            Err(error) => {
                self.status(0.0, Some(error.clone()));
                self.failure = Some(error);
                self.ready = None;
            }
        }
    }
}
