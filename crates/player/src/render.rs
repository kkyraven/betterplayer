//! The render thread: owns the GL context and the mpv render context, renders each new
//! video frame into an FBO and reads it back into the shared frame slots. Apple AI renders
//! at source size first, processes through VideoToolbox, then fits the result to the output.

use std::collections::VecDeque;
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::ptr;
use std::sync::{Arc, Condvar, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::frames::{External, Frames, frame_len};
use crate::gl_context::{GlContext, Gpu};
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
    /// media time. The observed clock is approximate during an untimed decode.
    pub stamp: bool,
}

pub enum Msg {
    Update,
    /// Redraw the current frame after a setting changed the enhancement path (macOS Apple AI,
    /// Windows DLSS), so a paused picture updates without waiting for the next decoded frame.
    #[cfg(any(target_os = "macos", windows))]
    Redraw,
    /// New output size and optionally host memory; the sender is signalled once the new
    /// slots are in place.
    Resize(u32, u32, Option<External>, Arc<ResizeReply>),
    /// Whether frames are wanted. While not, mpv skips drawing and nothing is read back.
    Presenting(bool),
    /// The picture came back (a load, or a seek that reconfigured it). A frame update skipped
    /// while it was gone is drawn now, else a paused player keeps showing the frame before it.
    PictureBack,
    Stop,
}

/// A resize either attaches its borrowed buffers or cancels before touching them.
/// The same lock covers commitment and timeout, so a late render thread cannot attach
/// memory the caller has already released.
#[derive(Default)]
pub struct ResizeReply {
    result: Mutex<Option<Result<(), String>>>,
    ready: Condvar,
}

impl ResizeReply {
    pub fn wait(&self, timeout: Duration) -> Result<(), String> {
        let result = self.result.lock().unwrap();
        let (mut result, _) = self.ready.wait_timeout_while(result, timeout, |r| r.is_none()).unwrap();
        result.get_or_insert_with(|| Err("resize timed out".into())).clone()
    }

    fn finish(&self, apply: impl FnOnce() -> Result<(), String>) -> bool {
        let mut result = self.result.lock().unwrap();
        if result.is_some() { return false; }
        let applied = apply();
        let ok = applied.is_ok();
        *result = Some(applied);
        self.ready.notify_one();
        ok
    }
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
    /// For the GPU sections around this target's own GL work.
    gpu: Gpu,
}

/// A synchronous readback the GPU has finished. Published by the caller once its GPU section
/// is released: a held publish can wait on the reader, which must not stall the other players.
struct Done {
    t0: Instant,
    render_ms: f32,
    pts: Option<f64>,
}

impl Target {
    fn new(w: u32, h: u32, cfg: RenderConfig, gpu: Gpu) -> Result<Target, String> {
        let _gpu = gpu.section();
        let len = frame_len(w, h)?;
        let mut limit = 0;
        unsafe { gl::GetIntegerv(gl::MAX_TEXTURE_SIZE, &mut limit) };
        if w > limit as u32 || h > limit as u32 || limit <= 0 {
            return Err(format!("frame size {w}x{h} exceeds GL texture limit {limit}"));
        }
        let mut tex = 0;
        let mut fbo = 0;
        unsafe {
            gl::ActiveTexture(gl::TEXTURE0);
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
            gl::BindTexture(gl::TEXTURE_2D, 0);
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
        let target = Target { fbo, tex, w, h, len, cfg, pbos, cur: 0, inflight: VecDeque::with_capacity(2), gpu };
        if let Some(e) = take_gl_error() {
            return Err(format!("framebuffer allocation: GL error 0x{e:x}"));
        }
        Ok(target)
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

    /// Copies the FBO into a frame slot. A synchronous readback is returned for the caller to
    /// publish; the queued kind fences the copy and `poll` publishes it once the GPU is done.
    fn readback(&mut self, ctx: *mut mpv_render_context, frames: &Frames, stats: &RenderStats, render_ms: f32, pts: Option<f64>) -> Option<Done> {
        let _gpu = self.gpu.section();
        let (fmt, ty) = self.format();
        unsafe {
            gl::BindFramebuffer(gl::READ_FRAMEBUFFER, self.fbo);
            gl::PixelStorei(gl::PACK_ALIGNMENT, 4);
            gl::PixelStorei(gl::PACK_ROW_LENGTH, 0);
            gl::PixelStorei(gl::PACK_SKIP_ROWS, 0);
            gl::PixelStorei(gl::PACK_SKIP_PIXELS, 0);
        }
        if !self.cfg.async_readback {
            let t0 = Instant::now();
            let slot = frames.writing();
            unsafe {
                gl::BindBuffer(gl::PIXEL_PACK_BUFFER, 0);
                gl::ReadPixels(0, 0, self.w as i32, self.h as i32, fmt, ty, slot.as_ptr() as *mut c_void);
                gl::BindFramebuffer(gl::READ_FRAMEBUFFER, 0);
            }
            if let Some(e) = take_gl_error() {
                stats.gl_error(e);
                return None;
            }
            return Some(Done { t0, render_ms, pts });
        }
        // Both buffers queued: the older copy into this one has to be out before it is reused.
        if self.inflight.iter().any(|f| f.pbo == self.cur) {
            self.poll(ctx, frames, stats, true);
        }
        unsafe {
            gl::BindBuffer(gl::PIXEL_PACK_BUFFER, self.pbos[self.cur]);
            gl::ReadPixels(0, 0, self.w as i32, self.h as i32, fmt, ty, ptr::null_mut());
            gl::BindFramebuffer(gl::READ_FRAMEBUFFER, 0);
            gl::BindBuffer(gl::PIXEL_PACK_BUFFER, 0);
            if let Some(e) = take_gl_error() {
                stats.gl_error(e);
                return None;
            }
            let fence = gl::FenceSync(gl::SYNC_GPU_COMMANDS_COMPLETE, 0);
            if fence.is_null() {
                stats.gl_error(take_gl_error().unwrap_or(gl::INVALID_OPERATION));
                return None;
            }
            gl::Flush();
            self.inflight.push_back(Inflight { pbo: self.cur, fence, issued: Instant::now(), render_ms, pts });
        }
        self.cur = 1 - self.cur;
        None
    }

    /// Publishes every queued readback the GPU has finished, oldest first. With `wait` the
    /// oldest is waited for (and dropped if the GPU does not answer in time). Publishing
    /// inside the section is fine here: queued readback is never paired with held frames.
    fn poll(&mut self, ctx: *mut mpv_render_context, frames: &Frames, stats: &RenderStats, wait: bool) {
        if self.inflight.is_empty() {
            return;
        }
        let _gpu = self.gpu.section();
        let mut waited = false;
        while let Some(&f) = self.inflight.front() {
            let block = wait && !waited;
            waited = true;
            let (flags, timeout) = if block { (gl::SYNC_FLUSH_COMMANDS_BIT, WAIT_NS) } else { (0, 0) };
            let r = unsafe { gl::ClientWaitSync(f.fence, flags, timeout) };
            let done = r == gl::ALREADY_SIGNALED || r == gl::CONDITION_SATISFIED;
            if r == gl::TIMEOUT_EXPIRED && !block && f.issued.elapsed() < Duration::from_nanos(WAIT_NS) {
                break;
            }
            unsafe {
                if done {
                    gl::BindBuffer(gl::PIXEL_PACK_BUFFER, self.pbos[f.pbo]);
                    let p = gl::MapBufferRange(gl::PIXEL_PACK_BUFFER, 0, self.len as isize, gl::MAP_READ_BIT) as *const u8;
                    if !p.is_null() {
                        let slot = frames.writing();
                        ptr::copy_nonoverlapping(p, slot.as_ptr(), self.len);
                        // GL_FALSE means the mapping's contents became corrupt. The copy
                        // stays in the writing slot, never visible to the host.
                        if gl::UnmapBuffer(gl::PIXEL_PACK_BUFFER) == gl::TRUE {
                            let dropped = frames.publish(f.pts);
                            mpv_render_context_report_swap(ctx);
                            stats.record(f.render_ms, ms(f.issued.elapsed()), dropped);
                        } else {
                            stats.gl_error(take_gl_error().unwrap_or(gl::INVALID_OPERATION));
                        }
                    } else {
                        stats.gl_error(take_gl_error().unwrap_or(gl::INVALID_OPERATION));
                    }
                    gl::BindBuffer(gl::PIXEL_PACK_BUFFER, 0);
                } else {
                    // The GPU did not finish in time: drop the frame. GL orders the next copy
                    // into this buffer after the stuck one, so reusing it is safe.
                    stats.gl_error(take_gl_error().unwrap_or(r));
                }
                gl::DeleteSync(f.fence);
            }
            self.inflight.pop_front();
        }
    }
}

impl Drop for Target {
    fn drop(&mut self) {
        let _gpu = self.gpu.section();
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

/// Starts the render thread and blocks until its GL and mpv render contexts exist; the string
/// names the GL context that came up, for the log.
/// The render thread owns the callback sender until the mpv context is freed.
/// `has_video` is the events thread's word on whether a picture is configured: while it is
/// not (between files), mpv's blank redraws are skipped so the host keeps the last frame.
pub fn spawn(
    mpv: Arc<Mpv>,
    frames: Arc<Frames>,
    stats: Arc<RenderStats>,
    cfg: RenderConfig,
    has_video: Arc<AtomicBool>,
    #[cfg(target_os = "macos")] apple: Arc<std::sync::Mutex<crate::enhance::AppleUpscaling>>,
    #[cfg(windows)] dlss: Arc<std::sync::Mutex<crate::enhance::DlssShared>>,
) -> Result<(Sender<Msg>, JoinHandle<()>, String), String> {
    let (tx, rx) = channel::<Msg>();
    let callback = Box::new(tx.clone());
    let (ready_tx, ready_rx) = channel::<Result<String, String>>();
    #[cfg(any(target_os = "macos", windows))]
    let wake = tx.clone();

    let handle = thread::Builder::new()
        .name("bp-render".into())
        .spawn(move || {
            run(
                mpv,
                rx,
                callback,
                frames,
                stats,
                cfg,
                has_video,
                ready_tx,
                #[cfg(target_os = "macos")]
                crate::macos::Upscaler::new(apple, wake),
                #[cfg(windows)]
                crate::windows::dlss::DlssRender::new(dlss, wake),
            )
        })
        .map_err(|e| e.to_string())?;

    match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(context)) => Ok((tx, handle, context)),
        Ok(Err(e)) => {
            let _ = handle.join();
            Err(e)
        }
        Err(_) => {
            // Startup may still finish after the timeout. Its callback belongs to that
            // thread, and Stop makes it release the contexts as soon as it can.
            let _ = tx.send(Msg::Stop);
            Err("render thread did not start in time".into())
        }
    }
}

fn run(
    mpv: Arc<Mpv>,
    rx: Receiver<Msg>,
    callback: Box<Sender<Msg>>,
    frames: Arc<Frames>,
    stats: Arc<RenderStats>,
    cfg: RenderConfig,
    has_video: Arc<AtomicBool>,
    ready: Sender<Result<String, String>>,
    #[cfg(target_os = "macos")] mut apple: crate::macos::Upscaler,
    #[cfg(windows)] mut dlss: crate::windows::dlss::DlssRender,
) {
    let gl = match GlContext::new() {
        Ok(g) => Box::new(g),
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let load_gl = || gl::load_with(|s| {
        let name = CString::new(s).unwrap();
        gl.get_proc_address(&name) as *const c_void
    });
    // ANGLE, CGL and Linux's loader dispatch through the current thread's context.
    // Reloading gl's mutable globals while another player renders is a data race.
    static LOAD_GL: std::sync::Once = std::sync::Once::new();
    LOAD_GL.call_once(load_gl);

    let mut init = mpv_opengl_init_params { get_proc_address: Some(get_proc), get_proc_address_ctx: &*gl as *const GlContext as *mut c_void };
    #[cfg(target_os = "linux")]
    let mut drm = mpv_opengl_drm_params_v2 {
        fd: -1, crtc_id: 0, connector_id: 0, atomic_request_ptr: ptr::null_mut(), render_fd: gl.render_fd(),
    };
    let mut advanced: c_int = 1;
    let mut params = [
        mpv_render_param { type_: MPV_RENDER_PARAM_API_TYPE, data: c"opengl".as_ptr() as *mut c_void },
        mpv_render_param { type_: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, data: &mut init as *mut _ as *mut c_void },
        #[cfg(target_os = "linux")]
        mpv_render_param { type_: MPV_RENDER_PARAM_DRM_DISPLAY_V2, data: &mut drm as *mut _ as *mut c_void },
        mpv_render_param { type_: MPV_RENDER_PARAM_ADVANCED_CONTROL, data: &mut advanced as *mut _ as *mut c_void },
        mpv_render_param { type_: MPV_RENDER_PARAM_INVALID, data: ptr::null_mut() },
    ];
    let gpu = gl.gpu();
    let mut ctx: *mut mpv_render_context = ptr::null_mut();
    let r = {
        let _gpu = gpu.section();
        unsafe { mpv_render_context_create(&mut ctx, mpv.handle, params.as_mut_ptr()) }
    };
    if r < 0 {
        let _ = ready.send(Err(format!("mpv_render_context_create: {}", error_string(r))));
        // The context's destruction touches ANGLE's shared renderer too.
        let _gpu = gpu.section();
        drop(gl);
        return;
    }

    let (w, h) = frames.size();
    let mut target = match Target::new(w, h, cfg, gpu) {
        Ok(t) => t,
        Err(e) => {
            let _gpu = gpu.section();
            unsafe { mpv_render_context_free(ctx) };
            drop(gl);
            let _ = ready.send(Err(e));
            return;
        }
    };

    unsafe { mpv_render_context_set_update_callback(ctx, Some(on_update), &*callback as *const Sender<Msg> as *mut c_void) };
    let _ = ready.send(Ok(gl.describe()));

    let mut presenting = true;
    // A frame update went undrawn while the picture was gone; `PictureBack` draws it.
    let mut skipped_frame = false;
    // Frames are wanted, and there is a picture to draw. Between files mpv would redraw its
    // background, which the host must not see over the last frame.
    let wanted = |presenting: bool| presenting && has_video.load(Ordering::Relaxed) && mpv.picture_ready.load(Ordering::Relaxed);
    loop {
        // Worker events may release a capture's GL objects, so this is a section; skipped
        // without a worker, since the loop wakes every 500 us while a readback is queued.
        #[cfg(windows)]
        if dlss.has_worker() {
            let _gpu = gpu.section();
            dlss.poll();
        }
        // While a readback is queued, wake regularly to publish it the moment the GPU is done.
        #[cfg(windows)]
        let enhancement_wake = if wanted(presenting) && !cfg.stamp { dlss.next_wake() } else { None };
        #[cfg(not(windows))]
        let enhancement_wake: Option<Duration> = None;
        let timeout = match (target.busy(), enhancement_wake) {
            (true, Some(delay)) => Some(POLL.min(delay)),
            (true, None) => Some(POLL),
            (false, delay) => delay,
        };
        let msg = if let Some(timeout) = timeout {
            match rx.recv_timeout(timeout) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => {
                    #[cfg(windows)]
                    if enhancement_wake.is_some_and(|delay| delay <= timeout) && wanted(presenting) {
                        Some(Msg::Redraw)
                    } else { None }
                    #[cfg(not(windows))]
                    { None }
                },
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
                let flags = {
                    let _gpu = gpu.section();
                    unsafe { mpv_render_context_update(ctx) }
                };
                if flags & MPV_RENDER_UPDATE_FRAME != 0 {
                    let mut info = mpv_render_frame_info::default();
                    unsafe {
                        mpv_render_context_get_info(
                            ctx,
                            mpv_render_param { type_: MPV_RENDER_PARAM_NEXT_FRAME_INFO, data: &mut info as *mut _ as *mut c_void },
                        );
                    }
                    let decoded = info.flags & MPV_RENDER_FRAME_INFO_PRESENT != 0
                        && info.flags & (MPV_RENDER_FRAME_INFO_REDRAW | MPV_RENDER_FRAME_INFO_REPEAT) == 0;
                    if decoded {
                        mpv.picture_ready.store(true, Ordering::Relaxed);
                        #[cfg(windows)]
                        {
                            // May release a capture (GL objects) when DLSS falls behind.
                            let _gpu = gpu.section();
                            dlss.new_frame();
                        }
                    }
                    if wanted(presenting) {
                        // A synchronous property query here can block on the VO thread, which
                        // is waiting for us to render. Read the observed clock instead.
                        let pts = if cfg.stamp && decoded {
                            Some(f64::from_bits(mpv.observed_time.load(Ordering::Relaxed)))
                        } else {
                            None
                        };
                        if cfg.stamp && pts.is_none() {
                            // An analysis reader never needs redraws, and a redraw must not
                            // replace the opening decoded frame while its model is loading.
                            skip_one(gpu, ctx);
                        } else {
                            skipped_frame = false;
                            render_one(
                                ctx,
                                &mut target,
                                &frames,
                                &stats,
                                pts,
                                #[cfg(target_os = "macos")]
                                &mut apple,
                                #[cfg(windows)]
                                &mut dlss,
                            );
                        }
                    } else {
                        // Wanted but no picture: mpv reports the size as unavailable for a
                        // moment while a seek reconfigures the decoder.
                        if presenting && decoded {
                            skipped_frame = true;
                            stats.skipped();
                        }
                        skip_one(gpu, ctx);
                    }
                }
            }
            Some(Msg::PictureBack) => {
                if skipped_frame && wanted(presenting) {
                    skipped_frame = false;
                    while target.busy() {
                        target.poll(ctx, &frames, &stats, true);
                    }
                    render_one(
                        ctx,
                        &mut target,
                        &frames,
                        &stats,
                        None,
                        #[cfg(target_os = "macos")]
                        &mut apple,
                        #[cfg(windows)]
                        &mut dlss,
                    );
                }
            }
            Some(Msg::Presenting(on)) => {
                #[cfg(windows)]
                if !on {
                    let _gpu = gpu.section();
                    dlss.suspend();
                }
                let resumed = on && !presenting;
                presenting = on;
                // Back on screen: redraw the current frame, else a paused video stays blank.
                if resumed && wanted(on) {
                    render_one(
                        ctx,
                        &mut target,
                        &frames,
                        &stats,
                        None,
                        #[cfg(target_os = "macos")]
                        &mut apple,
                        #[cfg(windows)]
                        &mut dlss,
                    );
                }
            }
            Some(Msg::Resize(w, h, external, done)) => {
                // GPU allocation and disposal can stall. Neither holds the commitment
                // lock, so the caller can cancel while the driver is busy.
                let next = Target::new(w, h, cfg, gpu);
                let mut old = None;
                let applied = done.finish(|| {
                    let next = next?;
                    frames.reset(w, h, external);
                    old = Some(std::mem::replace(&mut target, next));
                    Ok(())
                });
                drop(old);
                if !applied { continue; }
                // mpv redraws the current frame when none is pending, so a paused video is
                // not blank at the new size.
                if wanted(presenting) {
                    render_one(
                        ctx,
                        &mut target,
                        &frames,
                        &stats,
                        None,
                        #[cfg(target_os = "macos")]
                        &mut apple,
                        #[cfg(windows)]
                        &mut dlss,
                    );
                }
            }
            #[cfg(any(target_os = "macos", windows))]
            Some(Msg::Redraw) => {
                if wanted(presenting) && !cfg.stamp {
                    // Finish queued pre-change readbacks before publishing this redraw.
                    while target.busy() {
                        target.poll(ctx, &frames, &stats, true);
                    }
                    render_one(
                        ctx,
                        &mut target,
                        &frames,
                        &stats,
                        None,
                        #[cfg(target_os = "macos")]
                        &mut apple,
                        #[cfg(windows)]
                        &mut dlss,
                    );
                }
            }
            Some(Msg::Stop) => break,
            None => {}
        }
        target.poll(ctx, &frames, &stats, false);
    }

    let _gpu = gpu.section();
    unsafe {
        mpv_render_context_set_update_callback(ctx, None, ptr::null_mut());
        mpv_render_context_free(ctx);
    }
    drop(target);
    #[cfg(target_os = "macos")]
    drop(apple);
    #[cfg(windows)]
    drop(dlss);
    drop(gl);
}

fn render_one(
    ctx: *mut mpv_render_context,
    target: &mut Target,
    frames: &Frames,
    stats: &RenderStats,
    pts: Option<f64>,
    #[cfg(target_os = "macos")] apple: &mut crate::macos::Upscaler,
    #[cfg(windows)] dlss: &mut crate::windows::dlss::DlssRender,
) {
    let t0 = Instant::now();
    // The GPU is held for the draw and the copy, then released before a synchronous readback
    // is published: a held publish waits on the reader.
    let gpu = target.gpu.section();
    // An enhancement path may want mpv to draw into its own framebuffer first (macOS Apple AI
    // at source size, Windows DLSS at the processing size), then fit its result to the target.
    #[cfg(target_os = "macos")]
    let redirect = apple.prepare();
    #[cfg(windows)]
    let redirect = if target.cfg.stamp { None } else { dlss.prepare(target.w, target.h) };
    #[cfg(not(any(target_os = "macos", windows)))]
    let redirect: Option<(u32, u32, u32)> = None;
    let (draw_fbo, draw_w, draw_h) = redirect.unwrap_or((target.fbo, target.w, target.h));
    let mut fbo = mpv_opengl_fbo { fbo: draw_fbo as c_int, w: draw_w as c_int, h: draw_h as c_int, internal_format: 0 };
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
    #[cfg(target_os = "macos")]
    if redirect.is_some() {
        apple.process(target.fbo, target.w, target.h);
    }
    #[cfg(windows)]
    if !target.cfg.stamp && !dlss.process(target.fbo, target.w, target.h) {
        // Processing is asynchronous. Acknowledge consumption so mpv can decode the next
        // frame; only a matching completed reconstruction will be published on a redraw.
        unsafe { mpv_render_context_report_swap(ctx); }
        return;
    }
    if let Some(e) = take_gl_error() {
        stats.gl_error(e);
        return;
    }
    let done = target.readback(ctx, frames, stats, ms(t0.elapsed()), pts);
    drop(gpu);
    if let Some(d) = done {
        let dropped = frames.publish(d.pts);
        unsafe { mpv_render_context_report_swap(ctx) };
        stats.record(d.render_ms, ms(d.t0.elapsed()), dropped);
    }
}

/// Drain errors at operation boundaries so a failed draw or copy is never published.
fn take_gl_error() -> Option<u32> {
    let first = unsafe { gl::GetError() };
    if first == gl::NO_ERROR { return None; }
    // A lost context must not keep error handling on the render thread indefinitely.
    for _ in 0..16 {
        if unsafe { gl::GetError() } == gl::NO_ERROR { break; }
    }
    Some(first)
}

/// Lets mpv drop the pending frame without drawing it, so its timing and audio carry on
/// while nobody is looking.
fn skip_one(gpu: Gpu, ctx: *mut mpv_render_context) {
    let _gpu = gpu.section();
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn timed_out_resize_never_attaches_released_buffers() {
        let reply = ResizeReply::default();
        assert!(reply.wait(Duration::ZERO).is_err());
        let touched = Cell::new(false);
        assert!(!reply.finish(|| { touched.set(true); Ok(()) }));
        assert!(!touched.get());
    }

    #[test]
    fn committed_resize_wins_over_timeout_and_errors_are_returned() {
        let reply = ResizeReply::default();
        assert!(reply.finish(|| Ok(())));
        assert_eq!(reply.wait(Duration::ZERO), Ok(()));
        let reply = ResizeReply::default();
        assert!(!reply.finish(|| Err("allocation failed".into())));
        assert_eq!(reply.wait(Duration::ZERO), Err("allocation failed".into()));
    }

    thread_local! {
        static ERROR: Cell<u32> = const { Cell::new(gl::NO_ERROR) };
        static FAULT: Cell<u8> = const { Cell::new(0) };
    }

    extern "system" fn bind(_: u32, _: u32) {}
    extern "system" fn store(_: u32, _: i32) {}
    extern "system" fn flush() {}
    extern "system" fn delete(_: i32, _: *const u32) {}
    extern "system" fn delete_sync(_: gl::types::GLsync) {}
    extern "system" fn error() -> u32 { ERROR.with(|e| e.replace(gl::NO_ERROR)) }
    extern "system" fn read(_: i32, _: i32, _: i32, _: i32, _: u32, _: u32, _: *mut c_void) {
        if FAULT.get() == 1 { ERROR.set(gl::INVALID_OPERATION); }
    }
    extern "system" fn fence(_: u32, _: u32) -> gl::types::GLsync { ptr::null_mut() }
    extern "system" fn wait(_: gl::types::GLsync, _: u32, _: u64) -> u32 {
        match FAULT.get() {
            4 => gl::WAIT_FAILED,
            5 => gl::TIMEOUT_EXPIRED,
            _ => gl::ALREADY_SIGNALED,
        }
    }
    extern "system" fn map(_: u32, _: isize, _: isize, _: u32) -> *mut c_void {
        static PIXELS: [u8; 16] = [0x7f; 16];
        if FAULT.get() == 2 { ptr::null_mut() } else { PIXELS.as_ptr() as *mut c_void }
    }
    extern "system" fn unmap(_: u32) -> u8 { gl::FALSE }

    // This is the only unit test using GL. Integration tests use the real driver in a
    // separate process. Faults exercise the actual readback code without a broken GPU.
    #[test]
    fn failed_gpu_copies_are_discarded() {
        gl::load_with(|name| match name {
            "glBindFramebuffer" | "glBindBuffer" => bind as *const (),
            "glPixelStorei" => store as *const (),
            "glReadPixels" => read as *const (),
            "glGetError" => error as *const (),
            "glFenceSync" => fence as *const (),
            "glFlush" => flush as *const (),
            "glClientWaitSync" => wait as *const (),
            "glMapBufferRange" => map as *const (),
            "glUnmapBuffer" => unmap as *const (),
            "glDeleteSync" => delete_sync as *const (),
            "glDeleteBuffers" | "glDeleteFramebuffers" | "glDeleteTextures" => delete as *const (),
            _ => ptr::null(),
        } as *const c_void);
        for fault in 0..=5 {
            for async_readback in [false, true] {
                if !async_readback && fault != 1 { continue; }
                FAULT.set(fault);
                let frames = Frames::new(2, 2, false);
                let stats = RenderStats::new();
                let mut target = Target {
                    fbo: 1, tex: 2, w: 2, h: 2, len: 16,
                    cfg: RenderConfig { bgra: false, async_readback, stamp: false },
                    pbos: [3, 4], cur: 0, inflight: VecDeque::new(), gpu: Gpu::none(),
                };
                if fault <= 1 {
                    // Failed ReadPixels or a null fence must not queue or publish anything.
                    target.readback(ptr::null_mut(), &frames, &stats, 0.0, None);
                } else {
                    target.inflight.push_back(Inflight {
                        pbo: 0, fence: ptr::null_mut(),
                        issued: Instant::now() - Duration::from_secs(1), render_ms: 0.0, pts: None,
                    });
                    // Failed map, corrupt unmap, failed wait, and a stalled fence while
                    // paused must all leave the queue without exposing their bytes.
                    target.poll(ptr::null_mut(), &frames, &stats, false);
                }
                assert!(!target.busy(), "fault {fault} left a readback stuck");
                assert!(frames.acquire().is_none(), "fault {fault} published invalid pixels");
                assert_eq!(stats.snapshot().gl_errors, 1);
            }
        }
    }
}
