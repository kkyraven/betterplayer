use std::ffi::{CStr, CString, c_char};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bp_vr::{Eye, Frame, Pose, Recentre, Scene, eye_view};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::core::Interface;

use super::egl::{Context, D3dImage};
use crate::gl_context::{GlContext, Gpu};
use crate::mpv::{mpv_render_context, mpv_render_context_report_swap};
use crate::render::{draw_mpv, skip_one, take_gl_error};
use crate::vr::{ASKED, VrKind, VrLayout, VrStatus, VrView};

const SCREEN_RADIUS: f32 = 3.0;

const VERTEX: &str = "#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}";

const FRAGMENT: &str = "#version 300 es
precision highp float;
const float PI = 3.141592653589793;
const vec3 ROOM = vec3(7.0, 8.0, 11.0) / 255.0;
const vec3 GLOW = vec3(183.0, 163.0, 255.0) / 255.0;
const float RADIUS = 3.0;
const float FLOOR = -1.3;
// Footprints are scaled by this before filtering: about 0.4 of a mip level sharper.
const float SHARPEN = 0.75;
uniform sampler2D video;
uniform vec2 size;
uniform vec4 tangents;
uniform mat3 rot;
uniform vec3 eyePos;
uniform int mode;
uniform float hfov;
uniform int stereo;
uniform int side;
uniform vec2 screen;
uniform float pixel;
out vec4 o;
vec2 eyeOf(vec2 t) {
  if (stereo == 1) t.x = t.x * 0.5 + float(side) * 0.5;
  else if (stereo == 2) t.y = t.y * 0.5 + float(side) * 0.5;
  return t;
}
vec3 room(vec3 p, vec3 d) {
  vec3 c = ROOM;
  if (mode == 1 && d.y < -0.001) {
    vec3 f = p + d * ((FLOOR - p.y) / d.y);
    vec2 q = vec2(f.x / 2.2, (f.z - 2.4) / 1.3);
    c += GLOW * 0.07 * exp(-dot(q, q));
  }
  return c;
}
// Where the ray meets the picture, 0 to 1 across one eye, and how many pixels inside the
// picture's border that is (negative outside), for a smooth edge. Misses without a video.
vec2 hit(vec3 p, vec3 d, out float edge) {
  if (mode == 2) {
    float lon = atan(d.x, d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    edge = hfov > 6.28 ? 1e6 : (hfov * 0.5 - abs(lon)) / pixel;
    return vec2(0.5 + lon / hfov, 0.5 - lat / PI);
  }
  if (mode == 3) {
    float theta = acos(clamp(d.z, -1.0, 1.0));
    float r = theta / (hfov * 0.5) * 0.5;
    float phi = atan(d.y, d.x);
    edge = (hfov * 0.5 - theta) / pixel;
    return vec2(0.5 + r * cos(phi), 0.5 - r * sin(phi));
  }
  if (mode == 1) {
    // The far hit on a cylinder round the viewer, since the eye is inside it.
    float a = max(dot(d.xz, d.xz), 1e-6);
    float b = dot(p.xz, d.xz);
    float c = dot(p.xz, p.xz) - RADIUS * RADIUS;
    float s = (-b + sqrt(max(b * b - a * c, 0.0))) / a;
    vec3 h = p + d * s;
    vec2 t = vec2(0.5 + atan(h.x, h.z) * RADIUS / screen.x, 0.5 - h.y / screen.y);
    vec2 inside = min(t, 1.0 - t) * screen;
    edge = min(inside.x, inside.y) / (s * pixel);
    return t;
  }
  edge = -1.0;
  return vec2(0.0);
}
void main() {
  // ANGLE puts GL row 0 in the D3D texture's top row, so uv.y runs down the eye's image.
  vec2 uv = gl_FragCoord.xy / size;
  vec3 d = normalize(rot * vec3(mix(tangents.x, tangents.y, uv.x), mix(tangents.w, tangents.z, uv.y), 1.0));
  vec3 p = eyePos;
  float edge;
  vec2 t = hit(p, d, edge);
  // Before any branch: a derivative is only defined where the whole 2x2 quad runs it.
  vec2 dx = dFdx(t), dy = dFdy(t);
  // The 360's longitude wraps behind the viewer. Take the short way round, or the seam reads the
  // smallest mip.
  if (mode == 2 && hfov > 6.28) {
    dx.x -= round(dx.x);
    dy.x -= round(dy.x);
  }
  vec3 c = room(p, d);
  float cover = clamp(edge + 0.5, 0.0, 1.0);
  if (cover > 0.0) {
    // One eye's share of the texture, which scales its footprint too.
    vec2 share = stereo == 1 ? vec2(0.5, 1.0) : stereo == 2 ? vec2(1.0, 0.5) : vec2(1.0);
    // On the axis the eyes split, stay a footprint (at least half a texel) inside this eye, so
    // neither the filter nor a mip texel across the split reaches the other eye.
    vec2 texel = 1.0 / (vec2(textureSize(video, 0)) * share);
    vec2 inset = step(share, vec2(0.5)) * min(max(abs(dx) + abs(dy), 0.5 * texel), 0.5);
    vec2 at = eyeOf(clamp(t, inset, 1.0 - inset));
    c = mix(c, textureGrad(video, at, dx * share * SHARPEN, dy * share * SHARPEN).rgb, cover);
  }
  // One dither over everything, last, so neither the glow nor the video bands in the 8-bit eye.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  o = vec4(c + (n - 0.5) / 255.0, 1.0);
}";

const VIDEO_DEPTH: i32 = 10;

const TEXTURE_MAX_ANISOTROPY: u32 = 0x84FE;
const MAX_TEXTURE_MAX_ANISOTROPY: u32 = 0x84FF;

struct Video {
    tex: u32,
    fbo: u32,
    read: u32,
    w: u32,
    h: u32,
    gpu: Gpu,
}

impl Video {
    fn new(w: u32, h: u32, anisotropy: f32, gpu: Gpu) -> Result<Video, String> {
        if let Some(e) = take_gl_error() {
            eprintln!("bp-player: GL error 0x{e:x} before the headset video texture");
        }
        let levels = 32 - w.max(h).leading_zeros();
        let mut v = Video { tex: 0, fbo: 0, read: 0, w, h, gpu };
        unsafe {
            gl::GenTextures(1, &mut v.tex);
            gl::BindTexture(gl::TEXTURE_2D, v.tex);
            gl::TexStorage2D(gl::TEXTURE_2D, levels as i32, gl::RGB10_A2, w as i32, h as i32);
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::LINEAR_MIPMAP_LINEAR as i32);
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::LINEAR as i32);
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE as i32);
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE as i32);
            if anisotropy > 1.0 {
                gl::TexParameterf(gl::TEXTURE_2D, TEXTURE_MAX_ANISOTROPY, anisotropy.min(16.0));
            }
            gl::GenFramebuffers(1, &mut v.fbo);
            gl::GenFramebuffers(1, &mut v.read);
            gl::BindFramebuffer(gl::FRAMEBUFFER, v.fbo);
            gl::FramebufferTexture2D(gl::FRAMEBUFFER, gl::COLOR_ATTACHMENT0, gl::TEXTURE_2D, v.tex, 0);
            let status = gl::CheckFramebufferStatus(gl::FRAMEBUFFER);
            if status == gl::FRAMEBUFFER_COMPLETE {
                gl::Disable(gl::SCISSOR_TEST);
                gl::ColorMask(gl::TRUE, gl::TRUE, gl::TRUE, gl::TRUE);
                gl::ClearColor(0.0, 0.0, 0.0, 1.0);
                gl::Clear(gl::COLOR_BUFFER_BIT);
            }
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            gl::BindTexture(gl::TEXTURE_2D, 0);
            if status != gl::FRAMEBUFFER_COMPLETE {
                return Err(format!("headset video framebuffer incomplete: 0x{status:x}"));
            }
        }
        match take_gl_error() {
            Some(e) => Err(format!("headset video texture {w}x{h}: GL error 0x{e:x}")),
            None => Ok(v),
        }
    }
}

impl Drop for Video {
    fn drop(&mut self) {
        let _gpu = self.gpu.section();
        unsafe {
            gl::DeleteFramebuffers(1, &self.fbo);
            gl::DeleteFramebuffers(1, &self.read);
            gl::DeleteTextures(1, &self.tex);
        }
    }
}

struct Program {
    id: u32,
    vao: u32,
    gpu: Gpu,
    video: i32,
    size: i32,
    tangents: i32,
    rot: i32,
    eye_pos: i32,
    mode: i32,
    hfov: i32,
    stereo: i32,
    side: i32,
    screen: i32,
    pixel: i32,
}

impl Program {
    fn new(gpu: Gpu) -> Result<Program, String> {
        unsafe {
            let vs = compile(gl::VERTEX_SHADER, VERTEX)?;
            let fs = match compile(gl::FRAGMENT_SHADER, FRAGMENT) {
                Ok(fs) => fs,
                Err(e) => {
                    gl::DeleteShader(vs);
                    return Err(e);
                }
            };
            let id = gl::CreateProgram();
            gl::AttachShader(id, vs);
            gl::AttachShader(id, fs);
            gl::LinkProgram(id);
            gl::DeleteShader(vs);
            gl::DeleteShader(fs);
            let mut ok = 0;
            gl::GetProgramiv(id, gl::LINK_STATUS, &mut ok);
            if ok == 0 {
                let log = info_log(id, gl::GetProgramInfoLog);
                gl::DeleteProgram(id);
                return Err(format!("headset shader link: {log}"));
            }
            let at = |name: &str| {
                let n = CString::new(name).unwrap();
                gl::GetUniformLocation(id, n.as_ptr())
            };
            let mut vao = 0;
            gl::GenVertexArrays(1, &mut vao);
            Ok(Program {
                id,
                vao,
                gpu,
                video: at("video"),
                size: at("size"),
                tangents: at("tangents"),
                rot: at("rot"),
                eye_pos: at("eyePos"),
                mode: at("mode"),
                hfov: at("hfov"),
                stereo: at("stereo"),
                side: at("side"),
                screen: at("screen"),
                pixel: at("pixel"),
            })
        }
    }
}

impl Drop for Program {
    fn drop(&mut self) {
        let _gpu = self.gpu.section();
        unsafe {
            gl::DeleteVertexArrays(1, &self.vao);
            gl::DeleteProgram(self.id);
        }
    }
}

unsafe fn compile(kind: u32, source: &str) -> Result<u32, String> {
    unsafe {
        let s = gl::CreateShader(kind);
        let src = CString::new(source).unwrap();
        gl::ShaderSource(s, 1, &src.as_ptr(), std::ptr::null());
        gl::CompileShader(s);
        let mut ok = 0;
        gl::GetShaderiv(s, gl::COMPILE_STATUS, &mut ok);
        if ok == 0 {
            let log = info_log(s, gl::GetShaderInfoLog);
            gl::DeleteShader(s);
            return Err(format!("headset shader: {log}"));
        }
        Ok(s)
    }
}

unsafe fn info_log(id: u32, get: unsafe fn(u32, i32, *mut i32, *mut gl::types::GLchar)) -> String {
    let mut buf = vec![0u8; 2048];
    let mut len = 0;
    unsafe { get(id, buf.len() as i32, &mut len, buf.as_mut_ptr() as *mut gl::types::GLchar) };
    String::from_utf8_lossy(&buf[..len.max(0) as usize]).into_owned()
}

struct EyeTarget {
    image: D3dImage,
    tex: ID3D11Texture2D,
}

impl EyeTarget {
    fn new(angle: &Context, (w, h): (u32, u32)) -> Result<EyeTarget, String> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut tex = None;
        unsafe { angle.d3d11().CreateTexture2D(&desc, None, Some(&mut tex)) }.map_err(|e| format!("headset eye texture: {e}"))?;
        let tex = tex.ok_or("headset eye texture: none returned")?;
        Ok(EyeTarget { image: angle.wrap_d3d11(&tex)?, tex })
    }
}

pub(crate) struct Headset {
    gpu: Gpu,
    targets: [EyeTarget; 2],
    size: (u32, u32),
    eyes: [Eye; 2],
    program: Program,
    video: Option<Video>,
    max_texture: u32,
    anisotropy: f32,
    view: VrView,
    head: Option<Pose>,
    recentre: Recentre,
    recentre_next: bool,
    keep_recline: bool,
    turn: f32,
    screen: f32,
    status: Arc<Mutex<Option<VrStatus>>>,
    period: Duration,
    last_frame: Instant,
    second: (Instant, u32),
    failing: Option<(Instant, String)>,
    ended: bool,
    scene: Scene,
}

impl Headset {
    pub fn start(gl: &GlContext, view: VrView, status: Arc<Mutex<Option<VrStatus>>>) -> Result<Headset, String> {
        let angle = gl.angle();
        if !angle.has_extension("EGL_ANGLE_image_d3d11_texture") {
            return Err("no-interop: This build's ANGLE cannot share D3D11 textures (EGL_ANGLE_image_d3d11_texture), which the headset needs".into());
        }
        let scene = Scene::start()?;
        let theirs = scene.adapter();
        if theirs != 0 && theirs != adapter(angle.d3d11())? {
            return Err("other-gpu: The headset is on another graphics card than Better Player".into());
        }
        let size = scene.render_size();
        let gpu = gl.gpu();
        let _gpu = gpu.section();
        let targets = [EyeTarget::new(angle, size)?, EyeTarget::new(angle, size)?];
        let program = Program::new(gpu)?;
        let mut max_texture = 0;
        unsafe { gl::GetIntegerv(gl::MAX_TEXTURE_SIZE, &mut max_texture) };
        let anisotropy = unsafe { max_anisotropy() };
        let refresh_hz = scene.refresh_hz();
        *status.lock().unwrap() = Some(VrStatus {
            active: true,
            hmd_name: scene.hmd_name(),
            mounted: true,
            focused: true,
            refresh_hz,
            width: size.0,
            height: size.1,
            ..VrStatus::default()
        });
        let eyes = [scene.eye(0), scene.eye(1)];
        let head = scene.head();
        let screen = {
            let mut asked = ASKED.lock().unwrap();
            asked.turn = 0.0;
            asked.recentred = false;
            asked.screen
        };
        Ok(Headset {
            gpu,
            targets,
            size,
            eyes,
            program,
            video: None,
            max_texture: max_texture.max(1) as u32,
            anisotropy,
            view,
            head,
            recentre: head.map(|h| Recentre::from_head(&h)).unwrap_or_default(),
            recentre_next: head.is_none(),
            keep_recline: false,
            turn: 0.0,
            screen,
            status,
            period: Duration::from_secs_f32(1.0 / if refresh_hz.is_finite() && refresh_hz >= 1.0 { refresh_hz } else { 90.0 }),
            last_frame: Instant::now(),
            second: (Instant::now(), 0),
            failing: None,
            ended: false,
            scene,
        })
    }

    pub fn view(&mut self, view: VrView) {
        self.view = view;
    }

    pub fn recentre(&mut self, keep_recline: bool) {
        self.keep_recline = keep_recline && (!self.recentre_next || self.keep_recline);
        self.recentre_next = true;
    }

    pub fn draw_video(&mut self, ctx: *mut mpv_render_context, (w, h): (u32, u32)) -> bool {
        if w == 0 || h == 0 {
            return true;
        }
        let shrink = (self.max_texture as f32 / w.max(h) as f32).min(1.0);
        let (w, h) = (((w as f32 * shrink) as u32).max(1), ((h as f32 * shrink) as u32).max(1));
        let _gpu = self.gpu.section();
        if self.video.as_ref().is_none_or(|v| (v.w, v.h) != (w, h)) {
            self.video = None;
            match Video::new(w, h, self.anisotropy, self.gpu) {
                Ok(v) => self.video = Some(v),
                Err(e) => {
                    skip_one(self.gpu, ctx);
                    self.fail(format!("failed: {e}"));
                    return false;
                }
            }
        }
        let Some(v) = &self.video else { return false };
        let drawn = draw_mpv(ctx, v.fbo, w, h, VIDEO_DEPTH) >= 0;
        if drawn {
            unsafe {
                gl::BindTexture(gl::TEXTURE_2D, v.tex);
                gl::GenerateMipmap(gl::TEXTURE_2D);
                gl::BindTexture(gl::TEXTURE_2D, 0);
            }
        }
        unsafe { mpv_render_context_report_swap(ctx) };
        take_gl_error().is_none() && drawn
    }

    pub fn copy_video(&self, fbo: u32, w: u32, h: u32) -> bool {
        let Some(v) = &self.video else { return false };
        let mut level = 0;
        while v.w >> (level + 1) >= w && v.h >> (level + 1) >= h {
            level += 1;
        }
        let _gpu = self.gpu.section();
        unsafe {
            gl::Disable(gl::SCISSOR_TEST);
            gl::BindFramebuffer(gl::READ_FRAMEBUFFER, v.read);
            gl::FramebufferTexture2D(gl::READ_FRAMEBUFFER, gl::COLOR_ATTACHMENT0, gl::TEXTURE_2D, v.tex, level);
            gl::BindFramebuffer(gl::DRAW_FRAMEBUFFER, fbo);
            let (sw, sh) = ((v.w >> level) as i32, (v.h >> level) as i32);
            gl::BlitFramebuffer(0, 0, sw, sh, 0, 0, w as i32, h as i32, gl::COLOR_BUFFER_BIT, gl::LINEAR);
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
        }
        take_gl_error().is_none()
    }

    pub fn overdue(&self) -> bool {
        self.last_frame.elapsed() > self.period / 2
    }

    pub fn frame(&mut self) {
        match self.wait() {
            Ok(()) => {
                self.take_asked();
                if let Some(head) = self.head {
                    match self.draw(&head) {
                        Ok(()) => self.failing = None,
                        Err(e) => self.trouble(e),
                    }
                }
            }
            Err(e) => {
                self.trouble(e);
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        self.events();
        self.last_frame = Instant::now();
    }

    pub fn ended(&self) -> bool {
        self.ended
    }

    fn draw(&mut self, head: &Pose) -> Result<(), String> {
        let p = &self.program;
        let (w, h) = self.size;
        let (mode, hfov) = match (&self.video, self.view.kind) {
            (None, _) => (0, 0.0),
            (Some(_), VrKind::Flat) => (1, self.screen.to_radians()),
            (Some(_), VrKind::Equirect180) => (2, std::f32::consts::PI),
            (Some(_), VrKind::Equirect360) => (2, std::f32::consts::TAU),
            (Some(_), VrKind::Fisheye) => (3, self.view.fov.to_radians()),
        };
        let stereo = match self.view.layout {
            VrLayout::Mono => 0,
            VrLayout::Sbs => 1,
            VrLayout::Ou => 2,
        };
        let aspect = self.video.as_ref().map_or(1.0, |v| flat_aspect(self.view.layout, v.w as f32, v.h as f32));
        let screen = flat_screen(self.screen, aspect);
        let content = self.recentre.turned(self.turn);
        let _gpu = self.gpu.section();
        unsafe {
            for cap in [gl::BLEND, gl::SCISSOR_TEST, gl::DEPTH_TEST, gl::STENCIL_TEST, gl::CULL_FACE] {
                gl::Disable(cap);
            }
            gl::ColorMask(gl::TRUE, gl::TRUE, gl::TRUE, gl::TRUE);
            gl::UseProgram(p.id);
            gl::BindVertexArray(p.vao);
            gl::ActiveTexture(gl::TEXTURE0);
            gl::BindTexture(gl::TEXTURE_2D, self.video.as_ref().map_or(0, |v| v.tex));
            gl::BindSampler(0, 0);
            gl::Uniform1i(p.video, 0);
            gl::Uniform2f(p.size, w as f32, h as f32);
            gl::Uniform1i(p.mode, mode);
            gl::Uniform1f(p.hfov, hfov);
            gl::Uniform1i(p.stereo, stereo);
            gl::Uniform2f(p.screen, screen.0, screen.1);
            gl::Viewport(0, 0, w as i32, h as i32);
            for (i, eye) in self.eyes.iter().enumerate() {
                let v = eye_view(&content, head, &eye.to_head);
                let [l, r, t, b] = eye.tangents;
                let pixel = (r - l) / w as f32;
                gl::Uniform4f(p.tangents, l, r, t, b);
                gl::UniformMatrix3fv(p.rot, 1, gl::FALSE, v.rotation.as_ptr());
                gl::Uniform3f(p.eye_pos, v.position[0], v.position[1], v.position[2]);
                gl::Uniform1i(p.side, (i == 1) as i32 ^ self.view.swap_eyes as i32);
                gl::Uniform1f(p.pixel, pixel);
                gl::BindFramebuffer(gl::FRAMEBUFFER, self.targets[i].image.fbo);
                gl::DrawArrays(gl::TRIANGLES, 0, 3);
            }
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            gl::BindTexture(gl::TEXTURE_2D, 0);
            gl::BindVertexArray(0);
            gl::UseProgram(0);
            gl::Flush();
        }
        if let Some(e) = take_gl_error() {
            eprintln!("bp-player: headset draw: GL error 0x{e:x}");
        }
        for (i, t) in self.targets.iter().enumerate() {
            self.scene.submit(i, t.tex.as_raw())?;
        }
        self.scene.handoff();
        self.second.1 += 1;
        let elapsed = self.second.0.elapsed();
        if let Some(s) = self.status.lock().unwrap().as_mut() {
            s.frames += 1;
            if elapsed >= Duration::from_secs(1) {
                s.fps = self.second.1 as f32 / elapsed.as_secs_f32();
                self.second = (Instant::now(), 0);
            }
        }
        Ok(())
    }

    fn events(&mut self) {
        let e = self.scene.events();
        if e.eyes_changed {
            self.eyes = [self.scene.eye(0), self.scene.eye(1)];
        }
        if e.space_changed {
            self.recentre_next = true;
            self.keep_recline = false;
            self.turn = 0.0;
        }
        if let Some(s) = self.status.lock().unwrap().as_mut() {
            if let Some(m) = e.mounted {
                s.mounted = m;
            }
            s.lost_tracking = e.lost_tracking;
            s.focused = e.focused;
            s.push_shortcuts(e.shortcuts);
            s.presses += e.presses;
            if e.quit {
                s.quit = true;
                s.active = false;
                s.error = Some("quit: SteamVR asked Better Player to quit".into());
            }
        }
        self.ended |= e.quit;
    }

    fn take_asked(&mut self) {
        let mut asked = ASKED.lock().unwrap();
        if std::mem::take(&mut asked.recentred) {
            self.turn = 0.0;
        }
        self.turn = (self.turn + std::mem::take(&mut asked.turn) + 180.0).rem_euclid(360.0) - 180.0;
        self.screen = asked.screen;
    }

    fn wait(&mut self) -> Result<(), String> {
        if let Frame::Head(head) = self.scene.wait()? {
            if self.recentre_next {
                self.recentre = if self.keep_recline { self.recentre.keeping_recline(&head) } else { Recentre::from_head(&head) };
                self.recentre_next = false;
            }
            self.head = Some(head);
        }
        Ok(())
    }

    fn trouble(&mut self, error: String) {
        let since = self.failing.as_ref().map_or_else(Instant::now, |f| f.0);
        if since.elapsed() > Duration::from_secs(3) {
            self.fail(error);
        } else {
            self.failing = Some((since, error));
        }
    }

    fn fail(&mut self, error: String) {
        if let Some(s) = self.status.lock().unwrap().as_mut() {
            s.active = false;
            s.error = Some(bp_vr::coded(error));
        }
        self.ended = true;
    }
}

fn flat_aspect(layout: VrLayout, w: f32, h: f32) -> f32 {
    let frame = w / h;
    match layout {
        VrLayout::Sbs if frame / 2.0 >= 1.2 => frame / 2.0,
        VrLayout::Ou if frame * 2.0 <= 2.5 => frame * 2.0,
        _ => frame,
    }
}

fn flat_screen(arc_deg: f32, aspect: f32) -> (f32, f32) {
    let width = SCREEN_RADIUS * arc_deg.to_radians();
    let height = width * 9.0 / 16.0;
    if aspect < 16.0 / 9.0 { (height * aspect, height) } else { (width, width / aspect) }
}

unsafe fn max_anisotropy() -> f32 {
    let mut count = 0;
    unsafe { gl::GetIntegerv(gl::NUM_EXTENSIONS, &mut count) };
    let listed = (0..count.max(0) as u32).any(|i| {
        let name = unsafe { gl::GetStringi(gl::EXTENSIONS, i) };
        !name.is_null() && unsafe { CStr::from_ptr(name as *const c_char) }.to_bytes() == b"GL_EXT_texture_filter_anisotropic"
    });
    if !listed {
        return 0.0;
    }
    let mut max = 0.0;
    unsafe { gl::GetFloatv(MAX_TEXTURE_MAX_ANISOTROPY, &mut max) };
    match take_gl_error() {
        Some(e) => {
            eprintln!("bp-player: GL error 0x{e:x} asking the anisotropic filter's limit; the headset filters without it");
            0.0
        }
        None => max,
    }
}

fn adapter(device: &ID3D11Device) -> Result<u64, String> {
    let desc = unsafe { device.cast::<IDXGIDevice>().and_then(|d| d.GetAdapter()).and_then(|a| a.GetDesc()) }.map_err(|e| format!("the player's graphics card: {e}"))?;
    let luid = desc.AdapterLuid;
    Ok((luid.HighPart as u32 as u64) << 32 | luid.LowPart as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_size_3d_shows_at_double_the_eye() {
        let near = |a: f32, b: f32| (a - b).abs() < 1e-4;
        assert!(near(flat_aspect(VrLayout::Sbs, 1920.0, 1080.0), 16.0 / 9.0));
        assert!(near(flat_aspect(VrLayout::Ou, 1920.0, 1080.0), 16.0 / 9.0));
        assert!(near(flat_aspect(VrLayout::Sbs, 3840.0, 1080.0), 16.0 / 9.0));
        assert!(near(flat_aspect(VrLayout::Ou, 1920.0, 2160.0), 16.0 / 9.0));
        assert!(near(flat_aspect(VrLayout::Sbs, 2400.0, 1000.0), 1.2));
        assert!(near(flat_aspect(VrLayout::Ou, 1250.0, 1000.0), 2.5));
        assert!(near(flat_aspect(VrLayout::Mono, 1920.0, 1080.0), 16.0 / 9.0));
    }

    #[test]
    fn the_screen_spans_its_arc_and_a_narrow_picture_fits_its_height() {
        let near = |(a, b): (f32, f32), (c, d): (f32, f32)| (a - c).abs() < 1e-4 && (b - d).abs() < 1e-4;
        let arc = |deg: f32| 3.0 * deg.to_radians();
        assert!(near(flat_screen(50.0, 16.0 / 9.0), (arc(50.0), arc(50.0) * 9.0 / 16.0)));
        assert!(near(flat_screen(75.0, 2.39), (arc(75.0), arc(75.0) / 2.39)));
        assert!(near(flat_screen(40.0, 4.0 / 3.0), (arc(40.0) * 9.0 / 16.0 * 4.0 / 3.0, arc(40.0) * 9.0 / 16.0)));
        assert!(near(flat_screen(3.2f32.to_degrees() / 3.0, 16.0 / 9.0), (3.2, 1.8)));
    }
}
