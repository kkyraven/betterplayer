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

    pub bgra: bool,


    pub async_readback: bool,


    pub stamp: bool,
}

pub enum Msg {
    Update,


    #[cfg(any(target_os = "macos", windows))]
    Redraw,


    Resize(u32, u32, Option<External>, Sender<()>),

    Presenting(bool),
    Stop,
}


const POLL: Duration = Duration::from_micros(500);

const WAIT_NS: u64 = 200_000_000;


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


#[derive(Clone, Copy)]
struct Inflight {
    pbo: usize,
    fence: gl::types::GLsync,
    issued: Instant,
    render_ms: f32,
    pts: Option<f64>,
}


struct Target {
    fbo: u32,
    tex: u32,
    w: u32,
    h: u32,
    len: usize,
    cfg: RenderConfig,
    pbos: [u32; 2],

    cur: usize,

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






pub fn spawn(
    mpv: Arc<Mpv>,
    frames: Arc<Frames>,
    stats: Arc<RenderStats>,
    cfg: RenderConfig,
    has_video: Arc<AtomicBool>,
    #[cfg(target_os = "macos")] apple: Arc<std::sync::Mutex<crate::enhance::AppleUpscaling>>,
    #[cfg(windows)] dlss: Arc<std::sync::Mutex<crate::enhance::DlssShared>>,
) -> Result<(Box<Sender<Msg>>, JoinHandle<()>, String), String> {
    let (tx, rx) = channel::<Msg>();
    let tx = Box::new(tx);
    let cb_ctx = SendPtr(&*tx as *const Sender<Msg> as *mut c_void);
    let (ready_tx, ready_rx) = channel::<Result<String, String>>();
    #[cfg(any(target_os = "macos", windows))]
    let wake = (*tx).clone();

    let handle = thread::Builder::new()
        .name("bp-render".into())
        .spawn(move || {
            run(
                mpv,
                rx,
                cb_ctx,
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
    gl::load_with(|s| {
        let name = CString::new(s).unwrap();
        gl.get_proc_address(&name) as *const c_void
    });

    let mut init = mpv_opengl_init_params { get_proc_address: Some(get_proc), get_proc_address_ctx: &*gl as *const GlContext as *mut c_void };
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
    let _ = ready.send(Ok(gl.describe()));

    let mut presenting = true;


    let wanted = |presenting: bool| presenting && has_video.load(Ordering::Relaxed);
    loop {

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


                        let pts = if cfg.stamp {
                            let mut info = mpv_render_frame_info::default();
                            unsafe {
                                mpv_render_context_get_info(
                                    ctx,
                                    mpv_render_param { type_: MPV_RENDER_PARAM_NEXT_FRAME_INFO, data: &mut info as *mut _ as *mut c_void },
                                );
                            }
                            if info.flags & MPV_RENDER_FRAME_INFO_PRESENT != 0
                                && info.flags & (MPV_RENDER_FRAME_INFO_REDRAW | MPV_RENDER_FRAME_INFO_REPEAT) == 0
                            {
                                Some(f64::from_bits(mpv.observed_time.load(Ordering::Relaxed)))
                            } else {
                                None
                            }
                        } else {
                            None
                        };
                        if cfg.stamp && pts.is_none() {


                            skip_one(ctx);
                        } else {
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
                        skip_one(ctx);
                    }
                }
            }
            Some(Msg::Presenting(on)) => {
                let resumed = on && !presenting;
                presenting = on;

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
                match Target::new(w, h, cfg) {
                    Ok(t) => {
                        target = t;
                        frames.reset(w, h, external);
                    }
                    Err(e) => eprintln!("bp-player: resize failed: {e}"),
                }
                let _ = done.send(());


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


    #[cfg(target_os = "macos")]
    let redirect = apple.prepare();
    #[cfg(windows)]
    let redirect = dlss.prepare();
    #[cfg(not(any(target_os = "macos", windows)))]
    let redirect: Option<(u32, u32, u32)> = None;
    let (draw_fbo, draw_w, draw_h) = redirect.unwrap_or((target.fbo, target.w, target.h));
    let mut fbo = mpv_opengl_fbo { fbo: draw_fbo as c_int, w: draw_w as c_int, h: draw_h as c_int, internal_format: 0 };


    let mut flip: c_int = 0;

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
    if redirect.is_some() {
        dlss.process(target.fbo, target.w, target.h);
    }
    target.readback(ctx, frames, stats, ms(t0.elapsed()), pts);
    let gl_err = unsafe { gl::GetError() };
    if gl_err != gl::NO_ERROR {
        stats.gl_error(gl_err);
    }
}



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
