//! The render thread: owns the GL context and the mpv render context, renders each new
//! video frame into an FBO at output size and reads it back into the shared frame slots.

use std::collections::VecDeque;
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::frames::{External, Frames};
use crate::gl_context::GlContext;
use crate::mpv::*;
use crate::stats::RenderStats;

#[derive(Clone, Copy, Debug)]
pub struct RenderConfig {
    /// Read back as BGRA (the native order on most GPUs) instead of RGBA.
    pub bgra: bool,
    /// Queue the readback through pixel buffers behind a fence and publish as soon as the GPU
    /// has finished (a few ms) instead of waiting for it on the render thread.
    pub async_readback: bool,
    /// Publish each frame with mpv's position at the time, for a reader that keys frames by
    /// media time. Costs a property read per frame, so off for the on-screen player.
    pub stamp: bool,
}

pub enum Msg {
    Update,
    /// New output size and optionally host memory; the sender is signalled once the new
    /// slots are in place.
    Resize(u32, u32, Option<External>, Sender<()>),
    /// Whether frames are wanted. While not, mpv skips drawing and nothing is read back.
    Presenting(bool),
    Stop,
}

/// How often the loop checks the GPU for a finished readback while one is queued.
const POLL: Duration = Duration::from_micros(500);
/// How long a forced wait on a queued readback may take before the frame is dropped.
const WAIT_NS: u64 = 200_000_000;

/// mpv calls this from its own threads whenever a new frame (or other work) is pending.
unsafe extern "C" fn on_update(ctx: *mut c_void) {
    let tx = unsafe { &*(ctx as *const Sender<Msg>) };
    let _ = tx.send(Msg::Update);
}

unsafe extern "C" fn get_proc(ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    let gl = unsafe { &*(ctx as *const GlContext) };
    gl.get_proc_address(unsafe { CStr::from_ptr(name) })
}

struct SendPtr(*mut c_void);
unsafe impl Send for SendPtr {}

/// A readback the GPU is still copying into a pixel buffer.
#[derive(Clone, Copy)]
struct Inflight {
    pbo: usize,
    fence: gl::types::GLsync,
    issued: Instant,
    render_ms: f32,
    pts: Option<f64>,
}

/// Colour texture plus framebuffer at output size, and the readback buffers.
struct Target {
    fbo: u32,
    tex: u32,
    w: u32,
    h: u32,
    len: usize,
    cfg: RenderConfig,
    pbos: [u32; 2],
    /// The pixel buffer the next readback goes into.
    cur: usize,
    /// Queued readbacks, oldest first; at most one per pixel buffer.
    inflight: VecDeque<Inflight>,
}

impl Target {
    fn new(w: u32, h: u32, cfg: RenderConfig) -> Result<Target, String> {
        let mut tex = 0;
        let mut fbo = 0;
        let len = w as usize * h as usize * 4;
        unsafe {
            gl::GenTextures(1, &mut tex);
            gl::BindTexture(gl::TEXTURE_2D, tex);
            gl::TexImage2D(gl::TEXTURE_2D, 0, gl::RGBA8 as i32, w as i32, h as i32, 0, gl::RGBA, gl::UNSIGNED_BYTE, ptr::null());
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::NEAREST as i32);
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::NEAREST as i32);
            gl::GenFramebuffers(1, &mut fbo);
            gl::BindFramebuffer(gl::FRAMEBUFFER, fbo);
            gl::FramebufferTexture2D(gl::FRAMEBUFFER, gl::COLOR_ATTACHMENT0, gl::TEXTURE_2D, tex, 0);
            let status = gl::CheckFramebufferStatus(gl::FRAMEBUFFER);
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            if status != gl::FRAMEBUFFER_COMPLETE {
                gl::DeleteFramebuffers(1, &fbo);
                gl::DeleteTextures(1, &tex);
                return Err(format!("framebuffer incomplete: 0x{status:x}"));
            }
        }
        let mut pbos = [0u32; 2];
        if cfg.async_readback {
            unsafe {
                gl::GenBuffers(2, pbos.as_mut_ptr());
                for p in pbos {
                    gl::BindBuffer(gl::PIXEL_PACK_BUFFER, p);
                    gl::BufferData(gl::PIXEL_PACK_BUFFER, len as isize, ptr::null(), gl::STREAM_READ);
                }
                gl::BindBuffer(gl::PIXEL_PACK_BUFFER, 0);
            }
        }
        Ok(Target { fbo, tex, w, h, len, cfg, pbos, cur: 0, inflight: VecDeque::with_capacity(2) })
    }

    /// GLES (ANGLE on Windows) has no packed `8_8_8_8_REV` type; `BGRA` with plain bytes is the
    /// same memory order on a little-endian machine, through `GL_EXT_read_format_bgra`.
    fn format(&self) -> (u32, u32) {
        if !self.cfg.bgra {
            (gl::RGBA, gl::UNSIGNED_BYTE)
        } else if cfg!(windows) {
            (gl::BGRA, gl::UNSIGNED_BYTE)
        } else {
            (gl::BGRA, gl::UNSIGNED_INT_8_8_8_8_REV)
        }
    }

    fn busy(&self) -> bool {
        !self.inflight.is_empty()
    }

    /// Copies the FBO into a frame slot. Synchronous readback publishes here; the queued kind
    /// fences the copy and `poll` publishes it once the GPU is done.
    fn readback(&mut self, ctx: *mut mpv_render_context, frames: &Frames, stats: &RenderStats, render_ms: f32, pts: Option<f64>) {
        let (fmt, ty) = self.format();
        unsafe {
            gl::BindFramebuffer(gl::READ_FRAMEBUFFER, self.fbo);
            gl::PixelStorei(gl::PACK_ALIGNMENT, 4);
        }
        if !self.cfg.async_readback {
            let t0 = Instant::now();
            let slot = frames.writing();
            unsafe { gl::ReadPixels(0, 0, self.w as i32, self.h as i32, fmt, ty, slot.as_ptr() as *mut c_void) };
            let dropped = frames.publish(pts);
            unsafe { mpv_render_context_report_swap(ctx) };
            stats.record(render_ms, ms(t0.elapsed()), dropped);
            return;
        }
        // Both buffers queued: the older copy into this one has to be out before it is reused.
        if self.inflight.iter().any(|f| f.pbo == self.cur) {
            self.poll(ctx, frames, stats, true);
        }
        unsafe {
            gl::BindBuffer(gl::PIXEL_PACK_BUFFER, self.pbos[self.cur]);
            gl::ReadPixels(0, 0, self.w as i32, self.h as i32, fmt, ty, ptr::null_mut());
            let fence = gl::FenceSync(gl::SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl::Flush();
            gl::BindBuffer(gl::PIXEL_PACK_BUFFER, 0);
            self.inflight.push_back(Inflight { pbo: self.cur, fence, issued: Instant::now(), render_ms, pts });
        }
        self.cur = 1 - self.cur;
    }

    /// Publishes every queued readback the GPU has finished, oldest first. With `wait` the
    /// oldest is waited for (and dropped if the GPU does not answer in time).
    fn poll(&mut self, ctx: *mut mpv_render_context, frames: &Frames, stats: &RenderStats, wait: bool) {
        let mut waited = false;
        while let Some(&f) = self.inflight.front() {
            let block = wait && !waited;
            waited = true;
            let (flags, timeout) = if block { (gl::SYNC_FLUSH_COMMANDS_BIT, WAIT_NS) } else { (0, 0) };
            let r = unsafe { gl::ClientWaitSync(f.fence, flags, timeout) };
            let done = r == gl::ALREADY_SIGNALED || r == gl::CONDITION_SATISFIED;
            if !done && !block {
                break;
            }
            unsafe {
                if done {
                    gl::BindBuffer(gl::PIXEL_PACK_BUFFER, self.pbos[f.pbo]);
                    let p = gl::MapBufferRange(gl::PIXEL_PACK_BUFFER, 0, self.len as isize, gl::MAP_READ_BIT) as *const u8;
                    if !p.is_null() {
                        let slot = frames.writing();
                        ptr::copy_nonoverlapping(p, slot.as_ptr(), self.len);
                        gl::UnmapBuffer(gl::PIXEL_PACK_BUFFER);
                        let dropped = frames.publish(f.pts);
                        mpv_render_context_report_swap(ctx);
                        stats.record(f.render_ms, ms(f.issued.elapsed()), dropped);
                    }
                    gl::BindBuffer(gl::PIXEL_PACK_BUFFER, 0);
                } else {
                    // The GPU did not finish in time: drop the frame. GL orders the next copy
                    // into this buffer after the stuck one, so reusing it is safe.
                    stats.gl_error(r);
                }
                gl::DeleteSync(f.fence);
            }
            self.inflight.pop_front();
        }
    }
}

impl Drop for Target {
    fn drop(&mut self) {
        unsafe {
            for f in &self.inflight {
                gl::DeleteSync(f.fence);
            }
            if self.cfg.async_readback {
                gl::DeleteBuffers(2, self.pbos.as_ptr());
            }
            gl::DeleteFramebuffers(1, &self.fbo);
            gl::DeleteTextures(1, &self.tex);
        }
    }
}

/// Starts the render thread and blocks until its GL and mpv render contexts exist.
/// The returned Sender is boxed because mpv holds a raw pointer to it until the thread exits.
/// `has_video` is the events thread's word on whether a picture is configured: while it is
/// not (between files), mpv's blank redraws are skipped so the host keeps the last frame.
pub fn spawn(
    mpv: Arc<Mpv>,
    frames: Arc<Frames>,
    stats: Arc<RenderStats>,
    cfg: RenderConfig,
    has_video: Arc<AtomicBool>,
) -> Result<(Box<Sender<Msg>>, JoinHandle<()>), String> {
    let (tx, rx) = channel::<Msg>();
    let tx = Box::new(tx);
    let cb_ctx = SendPtr(&*tx as *const Sender<Msg> as *mut c_void);
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();

    let handle = thread::Builder::new()
        .name("bp-render".into())
        .spawn(move || run(mpv, rx, cb_ctx, frames, stats, cfg, has_video, ready_tx))
        .map_err(|e| e.to_string())?;

    match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(())) => Ok((tx, handle)),
        Ok(Err(e)) => {
            let _ = handle.join();
            Err(e)
        }
        Err(_) => Err("render thread did not start in time".into()),
    }
}

fn run(
    mpv: Arc<Mpv>,
    rx: Receiver<Msg>,
    cb_ctx: SendPtr,
    frames: Arc<Frames>,
    stats: Arc<RenderStats>,
    cfg: RenderConfig,
    has_video: Arc<AtomicBool>,
    ready: Sender<Result<(), String>>,
) {
    let gl = match GlContext::new() {
        Ok(g) => Box::new(g),
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    gl::load_with(|s| {
        let name = CString::new(s).unwrap();
        gl.get_proc_address(&name) as *const c_void
    });

    let mut init = mpv_opengl_init_params {
        get_proc_address: Some(get_proc),
        get_proc_address_ctx: &*gl as *const GlContext as *mut c_void,
    };
    let mut advanced: c_int = 1;
    let mut params = [
        mpv_render_param { type_: MPV_RENDER_PARAM_API_TYPE, data: c"opengl".as_ptr() as *mut c_void },
        mpv_render_param { type_: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, data: &mut init as *mut _ as *mut c_void },
        mpv_render_param { type_: MPV_RENDER_PARAM_ADVANCED_CONTROL, data: &mut advanced as *mut _ as *mut c_void },
        mpv_render_param { type_: MPV_RENDER_PARAM_INVALID, data: ptr::null_mut() },
    ];
    let mut ctx: *mut mpv_render_context = ptr::null_mut();
    let r = unsafe { mpv_render_context_create(&mut ctx, mpv.handle, params.as_mut_ptr()) };
    if r < 0 {
        let _ = ready.send(Err(format!("mpv_render_context_create: {}", error_string(r))));
        return;
    }

    let (w, h) = frames.size();
    let mut target = match Target::new(w, h, cfg) {
        Ok(t) => t,
        Err(e) => {
            unsafe { mpv_render_context_free(ctx) };
            let _ = ready.send(Err(e));
            return;
        }
    };

    unsafe { mpv_render_context_set_update_callback(ctx, Some(on_update), cb_ctx.0) };
    let _ = ready.send(Ok(()));

    let mut presenting = true;
    // Frames are wanted, and there is a picture to draw. Between files mpv would redraw its
    // background, which the host must not see over the last frame.
    let wanted = |presenting: bool| presenting && has_video.load(Ordering::Relaxed);
    loop {
        // While a readback is queued, wake regularly to publish it the moment the GPU is done.
        let msg = if target.busy() {
            match rx.recv_timeout(POLL) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => break,
            }
        };
        match msg {
            Some(Msg::Update) => {
                let flags = unsafe { mpv_render_context_update(ctx) };
                if flags & MPV_RENDER_UPDATE_FRAME != 0 {
                    if wanted(presenting) {
                        // Read before drawing: the pending frame's position is already
                        // reported, the one after cannot be until this one is drawn.
                        let pts = if cfg.stamp { mpv.get_double("time-pos") } else { None };
                        render_one(ctx, &mut target, &frames, &stats, pts);
                    } else {
                        skip_one(ctx);
                    }
                }
            }
            Some(Msg::Presenting(on)) => {
                let resumed = on && !presenting;
                presenting = on;
                // Back on screen: redraw the current frame, else a paused video stays blank.
                if resumed && wanted(on) {
                    render_one(ctx, &mut target, &frames, &stats, None);
                }
            }
            Some(Msg::Resize(w, h, external, done)) => {
                match Target::new(w, h, cfg) {
                    Ok(t) => {
                        target = t;
                        frames.reset(w, h, external);
                    }
                    Err(e) => eprintln!("bp-player: resize failed: {e}"),
                }
                let _ = done.send(());
                // mpv redraws the current frame when none is pending, so a paused video is
                // not blank at the new size.
                if wanted(presenting) {
                    render_one(ctx, &mut target, &frames, &stats, None);
                }
            }
            Some(Msg::Stop) => break,
            None => {}
        }
        target.poll(ctx, &frames, &stats, false);
    }

    unsafe {
        mpv_render_context_set_update_callback(ctx, None, ptr::null_mut());
        mpv_render_context_free(ctx);
    }
    drop(target);
    drop(gl);
}

fn render_one(ctx: *mut mpv_render_context, target: &mut Target, frames: &Frames, stats: &RenderStats, pts: Option<f64>) {
    let t0 = Instant::now();
    let mut fbo = mpv_opengl_fbo {
        fbo: target.fbo as c_int,
        w: target.w as c_int,
        h: target.h as c_int,
        internal_format: 0,
    };
    // glReadPixels starts at the bottom GL row, which is the top of an unflipped picture,
    // so the buffer comes out top-down with flip off.
    let mut flip: c_int = 0;
    // The host presents on its own schedule, so do not sleep until the frame's target time.
    let mut block: c_int = 0;
    let mut params = [
        mpv_render_param { type_: MPV_RENDER_PARAM_OPENGL_FBO, data: &mut fbo as *mut _ as *mut c_void },
        mpv_render_param { type_: MPV_RENDER_PARAM_FLIP_Y, data: &mut flip as *mut _ as *mut c_void },
        mpv_render_param { type_: MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, data: &mut block as *mut _ as *mut c_void },
        mpv_render_param { type_: MPV_RENDER_PARAM_INVALID, data: ptr::null_mut() },
    ];
    let r = unsafe { mpv_render_context_render(ctx, params.as_mut_ptr()) };
    if r < 0 {
        stats.render_error();
        return;
    }
    target.readback(ctx, frames, stats, ms(t0.elapsed()), pts);
    let gl_err = unsafe { gl::GetError() };
    if gl_err != gl::NO_ERROR {
        stats.gl_error(gl_err);
    }
}

/// Lets mpv drop the pending frame without drawing it, so its timing and audio carry on
/// while nobody is looking.
fn skip_one(ctx: *mut mpv_render_context) {
    let mut skip: c_int = 1;
    let mut params = [
        mpv_render_param { type_: MPV_RENDER_PARAM_SKIP_RENDERING, data: &mut skip as *mut _ as *mut c_void },
        mpv_render_param { type_: MPV_RENDER_PARAM_INVALID, data: ptr::null_mut() },
    ];
    unsafe {
        mpv_render_context_render(ctx, params.as_mut_ptr());
        mpv_render_context_report_swap(ctx);
    }
}

fn ms(d: Duration) -> f32 {
    d.as_secs_f32() * 1000.0
}
