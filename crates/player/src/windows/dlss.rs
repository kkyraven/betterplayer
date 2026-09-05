use std::ptr;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::enhance::{DlssRequest, DlssShared};
use crate::render::Msg;
use crate::windows::dlss5::{self, Session, VideoHeader};


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


struct Pending {
    built: Built,
    result: mpsc::Receiver<Result<Session, String>>,
}

pub(crate) struct DlssRender {
    shared: Arc<Mutex<DlssShared>>,
    wake: mpsc::Sender<Msg>,

    host: Result<std::path::PathBuf, String>,

    request: DlssRequest,
    changed_at: Instant,
    surfaces: Surfaces,
    session: Option<(Session, Built)>,
    pending: Option<Pending>,

    frame: Option<(u32, u32, u32, u32)>,
    in_buf: Vec<u8>,
    out_buf: Vec<u8>,
    motion: Vec<u8>,
    first_frame: bool,
}

impl DlssRender {
    pub fn new(shared: Arc<Mutex<DlssShared>>, wake: mpsc::Sender<Msg>) -> DlssRender {
        DlssRender {
            shared,
            wake,
            host: dlss5::available(),
            request: DlssRequest::default(),
            changed_at: Instant::now(),
            surfaces: Surfaces::new(),
            session: None,
            pending: None,
            frame: None,
            in_buf: Vec::new(),
            out_buf: Vec::new(),
            motion: Vec::new(),
            first_frame: true,
        }
    }



    fn report(&self, factor: f64, reason: Option<String>) {
        let mut shared = self.shared.lock().unwrap();
        if shared.request == self.request {
            shared.factor = factor;
            shared.reason = reason;
        }
    }


    fn sizes(request: &DlssRequest) -> Result<((u32, u32), (u32, u32)), String> {
        if request.source.0 == 0 || request.source.1 == 0 {
            return Err("waiting for the video size".into());
        }
        let input = dlss5::fit_height(request.source, request.options.input_height);
        let output = dlss5::output_size(input, request.options.factor)?;
        Ok((input, output))
    }




    pub fn prepare(&mut self) -> Option<(u32, u32, u32)> {
        let request = self.shared.lock().unwrap().request;
        if request != self.request {
            self.request = request;
            self.changed_at = Instant::now();
        }
        self.frame = None;

        if !request.enabled {
            self.session = None;
            self.pending = None;
            return None;
        }
        let host = match &self.host {
            Ok(h) => h.clone(),
            Err(e) => {
                self.report(0.0, Some(e.clone()));
                return None;
            }
        };

        let (input, output) = match DlssRender::sizes(&request) {
            Ok(sizes) => sizes,
            Err(e) => {
                self.session = None;
                self.report(0.0, Some(e));
                return None;
            }
        };
        let want = Built { input, output, request };


        if let Some(pending) = &self.pending {
            match pending.result.try_recv() {
                Ok(result) => {
                    let built = pending.built;
                    self.pending = None;
                    match result {
                        Ok(session) if built == want => {
                            self.session = Some((session, built));
                            self.first_frame = true;
                        }
                        Ok(_) => {}
                        Err(e) => self.report(0.0, Some(e)),
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => self.pending = None,
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }


        let have = self.session.as_ref().map(|(_, b)| *b) == Some(want);
        let building = self.pending.as_ref().map(|p| p.built) == Some(want);
        if !have && !building && self.changed_at.elapsed() >= DEBOUNCE {
            match VideoHeader::live(input, &request.options) {
                Ok(header) => {
                    let (tx, rx) = mpsc::channel();
                    let wake = self.wake.clone();
                    let host = host.clone();
                    if std::thread::Builder::new()
                        .name("bp-dlss-start".into())
                        .spawn(move || {
                            let _ = tx.send(Session::start(&host, header));
                            let _ = wake.send(Msg::Redraw);
                        })
                        .is_ok()
                    {
                        self.pending = Some(Pending { built: want, result: rx });
                        if self.session.is_none() {
                            self.report(0.0, Some("starting DLSS 5".into()));
                        }
                    }
                }
                Err(e) => {
                    self.report(0.0, Some(e));
                    return None;
                }
            }
        }



        match &self.session {
            Some((_, built)) if *built == want => {
                self.frame = Some((self.surfaces.input(input), input.0, input.1, 0));
                Some((self.surfaces.input(input), input.0, input.1))
            }
            _ => None,
        }
    }




    pub fn process(&mut self, target: u32, target_w: u32, target_h: u32) {
        let Some((in_fbo, in_w, in_h, _)) = self.frame else { return };
        let Some((session, built)) = &mut self.session else { return };
        let (out_w, out_h) = built.output;
        let in_len = in_w as usize * in_h as usize * 4;
        let out_len = out_w as usize * out_h as usize * 4;
        self.in_buf.resize(in_len, 0);
        self.out_buf.resize(out_len, 0);
        self.motion.resize(in_len, 0);

        unsafe {
            gl::BindFramebuffer(gl::READ_FRAMEBUFFER, in_fbo);
            gl::PixelStorei(gl::PACK_ALIGNMENT, 4);
            gl::ReadPixels(0, 0, in_w as i32, in_h as i32, gl::RGBA, gl::UNSIGNED_BYTE, self.in_buf.as_mut_ptr() as *mut _);
        }


        let result = session.process(&self.in_buf, &self.motion, 0, true, &mut self.out_buf);
        self.first_frame = false;
        let (src_fbo, src_w, src_h, factor) = match result {
            Ok(()) => {
                let out_fbo = self.surfaces.output((out_w, out_h));
                unsafe {
                    gl::BindTexture(gl::TEXTURE_2D, self.surfaces.out_tex);
                    gl::PixelStorei(gl::UNPACK_ALIGNMENT, 4);
                    gl::TexSubImage2D(gl::TEXTURE_2D, 0, 0, 0, out_w as i32, out_h as i32, gl::RGBA, gl::UNSIGNED_BYTE, self.out_buf.as_ptr() as *const _);
                    gl::BindTexture(gl::TEXTURE_2D, 0);
                }
                (out_fbo, out_w, out_h, built.request.options.factor)
            }
            Err(e) => {
                self.report(0.0, Some(e));
                self.session = None;
                (in_fbo, in_w, in_h, 0.0)
            }
        };

        unsafe {
            gl::BindFramebuffer(gl::READ_FRAMEBUFFER, src_fbo);
            gl::BindFramebuffer(gl::DRAW_FRAMEBUFFER, target);
            gl::BlitFramebuffer(0, 0, src_w as i32, src_h as i32, 0, 0, target_w as i32, target_h as i32, gl::COLOR_BUFFER_BIT, gl::LINEAR);
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
        }
        if factor > 0.0 {
            self.report(factor, None);
        }
    }
}
