use std::collections::HashMap;
use std::ffi::CString;
use std::time::Instant;

use bp_vr::{ControllerModels, Eye, EyeView, Mesh, Offset, Pose, Ray, Recentre, Vertex, eye_view};

use super::vr::{compile, info_log};
use crate::gl_context::Gpu;
use crate::render::take_gl_error;

const NEAR: f32 = 0.02;
const FAR: f32 = 20.0;
const EASE_SECS: f32 = 0.15;
const GHOST: f32 = 0.2;
const RAY_METRES: f32 = 1.5;
const RAY_WIDTH: f32 = 0.002;
const RAY_RGBA: [f32; 4] = [238.0 / 255.0, 240.0 / 255.0, 244.0 / 255.0, 0.4];
const KEY_LIGHT: [f32; 3] = [0.3, 0.6, -0.5];

const VERTEX: &str = "#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
uniform mat4 mvp;
// The part's turn into the frame `light` is in.
uniform mat3 model;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vNormal = model * normal;
  vUv = uv;
  gl_Position = mvp * vec4(position, 1.0);
}";

const FRAGMENT: &str = "#version 300 es
precision highp float;
const vec3 ACCENT = vec3(183.0, 163.0, 255.0) / 255.0;
const vec3 SKY = vec3(220.0, 214.0, 255.0) / 255.0;
const vec3 GROUND = vec3(26.0, 22.0, 38.0) / 255.0;
const vec3 PLAIN = vec3(42.0, 42.0, 48.0) / 255.0;
const float AMBIENT = 0.45;
const float KEY = 0.7;
const float EMISSIVE = 0.55;
// sRGB, decoded as it is sampled.
uniform sampler2D diffuse;
uniform int textured;
// Toward the key light, unit length.
uniform vec3 light;
// How lit the part is, 0 to 1.
uniform float glow;
// Over 0: the see-through copy, the accent at this opacity.
uniform float ghost;
// Alpha over 0: a ray in this colour, fading out along its far third (uv.y, 0 at the hand).
uniform vec4 plain;
in vec3 vNormal;
in vec2 vUv;
out vec4 o;
vec3 decode(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 encode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  if (plain.a > 0.0) {
    o = vec4(plain.rgb, plain.a * smoothstep(1.0, 0.67, vUv.y));
    return;
  }
  if (ghost > 0.0) {
    o = vec4(ACCENT, ghost);
    return;
  }
  vec3 n = normalize(vNormal);
  vec3 albedo = textured == 1 ? texture(diffuse, vUv).rgb : decode(PLAIN);
  vec3 irradiance = mix(decode(GROUND), decode(SKY), 0.5 + 0.5 * n.y) * AMBIENT + KEY * max(dot(n, light), 0.0);
  vec3 accent = decode(ACCENT);
  o = vec4(encode(mix(albedo * irradiance, accent * (irradiance + EMISSIVE), glow)), 1.0);
}";

struct Program {
    id: u32,
    mvp: i32,
    model: i32,
    diffuse: i32,
    textured: i32,
    light: i32,
    glow: i32,
    ghost: i32,
    plain: i32,
}

impl Program {
    fn new() -> Result<Program, String> {
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
                return Err(format!("controller shader link: {log}"));
            }
            let at = |name: &str| {
                let n = CString::new(name).unwrap();
                gl::GetUniformLocation(id, n.as_ptr())
            };
            Ok(Program {
                id,
                mvp: at("mvp"),
                model: at("model"),
                diffuse: at("diffuse"),
                textured: at("textured"),
                light: at("light"),
                glow: at("glow"),
                ghost: at("ghost"),
                plain: at("plain"),
            })
        }
    }
}

struct GlMesh {
    vao: u32,
    buffers: [u32; 2],
    count: i32,
    texture: Option<i32>,
}

pub(crate) struct Controllers {
    gpu: Gpu,
    program: Program,
    meshes: Vec<Option<GlMesh>>,
    textures: HashMap<i32, u32>,
    depth: u32,
    fbos: [u32; 2],
    size: (u32, u32),
    glow: [f32; 2],
    ray: [(f32, Option<Ray>); 2],
    strip: Option<GlMesh>,
    last: Option<Instant>,
}

impl Controllers {
    pub fn new(gpu: Gpu, fbos: [u32; 2], (w, h): (u32, u32)) -> Result<Controllers, String> {
        let program = Program::new()?;
        let mut c = Controllers {
            gpu,
            program,
            meshes: Vec::new(),
            textures: HashMap::new(),
            depth: 0,
            fbos,
            size: (w, h),
            glow: [0.0; 2],
            ray: [(0.0, None); 2],
            strip: None,
            last: None,
        };
        c.strip = Some(gl_mesh(&strip()));
        unsafe {
            gl::GenRenderbuffers(1, &mut c.depth);
            gl::BindRenderbuffer(gl::RENDERBUFFER, c.depth);
            gl::RenderbufferStorage(gl::RENDERBUFFER, gl::DEPTH_COMPONENT24, w as i32, h as i32);
            gl::BindRenderbuffer(gl::RENDERBUFFER, 0);
            let mut status = gl::FRAMEBUFFER_COMPLETE;
            for fbo in fbos {
                gl::BindFramebuffer(gl::FRAMEBUFFER, fbo);
                gl::FramebufferRenderbuffer(gl::FRAMEBUFFER, gl::DEPTH_ATTACHMENT, gl::RENDERBUFFER, c.depth);
                if status == gl::FRAMEBUFFER_COMPLETE {
                    status = gl::CheckFramebufferStatus(gl::FRAMEBUFFER);
                }
            }
            let error = take_gl_error();
            if status != gl::FRAMEBUFFER_COMPLETE || error.is_some() {
                for fbo in fbos {
                    gl::BindFramebuffer(gl::FRAMEBUFFER, fbo);
                    gl::FramebufferRenderbuffer(gl::FRAMEBUFFER, gl::DEPTH_ATTACHMENT, gl::RENDERBUFFER, 0);
                }
                gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
                take_gl_error();
                return Err(format!("controller depth buffer: framebuffer 0x{status:x}, GL error 0x{:x}", error.unwrap_or(0)));
            }
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
        }
        Ok(c)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn draw(
        &mut self,
        mut models: ControllerModels,
        shown: [bool; 2],
        legend: Option<usize>,
        rays: [bool; 2],
        aim: [Option<Ray>; 2],
        recentre: &Recentre,
        head: &Pose,
        eyes: &[Eye; 2],
    ) {
        self.upload(&mut models);
        let now = Instant::now();
        let dt = self.last.map_or(0.0, |t| (now - t).as_secs_f32());
        self.last = Some(now);
        for (hand, g) in self.glow.iter_mut().enumerate() {
            *g = ease(*g, legend == Some(hand), dt);
        }
        for ((r, on), aim) in self.ray.iter_mut().zip(rays).zip(aim) {
            *r = step_ray(*r, on, aim, dt);
        }
        let to_content = recentre.to_content();
        let parts: Vec<(usize, &GlMesh, [[f32; 4]; 3], f32)> = models
            .hands
            .iter()
            .enumerate()
            .filter_map(|(hand, h)| Some((hand, h.as_ref().filter(|_| shown[hand])?)))
            .flat_map(|(hand, h)| h.parts.iter().map(move |p| (hand, h, p)))
            .filter_map(|(hand, h, p)| {
                let mesh = self.meshes.get(p.mesh)?.as_ref()?;
                let glow = if p.lit { smooth(self.glow[hand]) } else { 0.0 };
                Some((hand, mesh, shader_frame(&to_content.then(&h.pose).then(&p.pose)), glow))
            })
            .collect();
        let beams: Vec<([[f32; 4]; 3], f32)> = self
            .ray
            .iter()
            .filter_map(|&(fade, aim)| Some((shader_frame(&to_content.then(&ray_pose(&aim?, RAY_METRES))), RAY_RGBA[3] * smooth(fade))).filter(|b| b.1 > 0.0))
            .collect();
        if parts.is_empty() && beams.is_empty() {
            return;
        }
        let p = &self.program;
        let (w, h) = self.size;
        unsafe {
            gl::UseProgram(p.id);
            gl::Viewport(0, 0, w as i32, h as i32);
            gl::Enable(gl::CULL_FACE);
            gl::CullFace(gl::BACK);
            gl::FrontFace(front_face(eyes[0].tangents));
            gl::DepthFunc(gl::LESS);
            gl::ActiveTexture(gl::TEXTURE0);
            gl::BindSampler(0, 0);
            gl::Uniform1i(p.diffuse, 0);
            for (i, eye) in eyes.iter().enumerate() {
                let view = eye_view(recentre, &Offset::default(), head, &eye.to_head);
                let lights = [0, 1].map(|hand| key_light(&view, hand));
                gl::BindFramebuffer(gl::FRAMEBUFFER, self.fbos[i]);
                gl::Disable(gl::BLEND);
                gl::Enable(gl::DEPTH_TEST);
                gl::DepthMask(gl::TRUE);
                gl::Clear(gl::DEPTH_BUFFER_BIT);
                gl::Uniform1f(p.ghost, 0.0);
                gl::Uniform4f(p.plain, 0.0, 0.0, 0.0, 0.0);
                for (hand, mesh, model, glow) in &parts {
                    let [x, y, z] = lights[*hand];
                    gl::Uniform3f(p.light, x, y, z);
                    gl::Uniform1f(p.glow, *glow);
                    self.draw_mesh(mesh, model, &view, eye.tangents);
                }
                if parts.iter().any(|part| part.3 > 0.0) {
                    gl::Disable(gl::DEPTH_TEST);
                    gl::DepthMask(gl::FALSE);
                    gl::Enable(gl::BLEND);
                    gl::BlendFuncSeparate(gl::SRC_ALPHA, gl::ONE_MINUS_SRC_ALPHA, gl::ONE, gl::ONE_MINUS_SRC_ALPHA);
                    for (_, mesh, model, glow) in parts.iter().filter(|part| part.3 > 0.0) {
                        gl::Uniform1f(p.ghost, GHOST * glow);
                        self.draw_mesh(mesh, model, &view, eye.tangents);
                    }
                }
                if let Some(strip) = self.strip.as_ref().filter(|_| !beams.is_empty()) {
                    gl::Disable(gl::CULL_FACE);
                    gl::Enable(gl::DEPTH_TEST);
                    gl::DepthMask(gl::FALSE);
                    gl::Enable(gl::BLEND);
                    gl::BlendFuncSeparate(gl::SRC_ALPHA, gl::ONE_MINUS_SRC_ALPHA, gl::ONE, gl::ONE_MINUS_SRC_ALPHA);
                    let [r, g, b, _] = RAY_RGBA;
                    for (model, alpha) in &beams {
                        gl::Uniform4f(p.plain, r, g, b, *alpha);
                        self.draw_mesh(strip, model, &view, eye.tangents);
                    }
                    gl::Uniform4f(p.plain, 0.0, 0.0, 0.0, 0.0);
                    gl::Enable(gl::CULL_FACE);
                }
            }
            gl::Disable(gl::BLEND);
            gl::Disable(gl::DEPTH_TEST);
            gl::Disable(gl::CULL_FACE);
            gl::DepthMask(gl::TRUE);
            gl::FrontFace(gl::CCW);
            gl::BindTexture(gl::TEXTURE_2D, 0);
            gl::BindVertexArray(0);
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            gl::UseProgram(0);
        }
    }

    unsafe fn draw_mesh(&self, mesh: &GlMesh, model: &[[f32; 4]; 3], view: &EyeView, tangents: [f32; 4]) {
        let p = &self.program;
        let texture = mesh.texture.and_then(|t| self.textures.get(&t)).copied();
        let turn: [f32; 9] = std::array::from_fn(|i| model[i % 3][i / 3]);
        unsafe {
            gl::UniformMatrix4fv(p.mvp, 1, gl::FALSE, clip(tangents, view, model).as_ptr());
            gl::UniformMatrix3fv(p.model, 1, gl::FALSE, turn.as_ptr());
            gl::Uniform1i(p.textured, texture.is_some() as i32);
            gl::BindTexture(gl::TEXTURE_2D, texture.unwrap_or(0));
            gl::BindVertexArray(mesh.vao);
            gl::DrawElements(gl::TRIANGLES, mesh.count, gl::UNSIGNED_SHORT, std::ptr::null());
        }
    }

    fn upload(&mut self, models: &mut ControllerModels) {
        for t in std::mem::take(&mut models.textures) {
            let levels = 32 - t.width.max(t.height).leading_zeros();
            let mut tex = 0;
            unsafe {
                gl::GenTextures(1, &mut tex);
                gl::BindTexture(gl::TEXTURE_2D, tex);
                gl::TexStorage2D(gl::TEXTURE_2D, levels as i32, gl::SRGB8_ALPHA8, t.width as i32, t.height as i32);
                gl::PixelStorei(gl::UNPACK_ALIGNMENT, 4);
                gl::TexSubImage2D(gl::TEXTURE_2D, 0, 0, 0, t.width as i32, t.height as i32, gl::RGBA, gl::UNSIGNED_BYTE, t.rgba.as_ptr().cast());
                gl::GenerateMipmap(gl::TEXTURE_2D);
                gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::LINEAR_MIPMAP_LINEAR as i32);
                gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::LINEAR as i32);
                gl::BindTexture(gl::TEXTURE_2D, 0);
            }
            if let Some(old) = self.textures.insert(t.id, tex) {
                unsafe { gl::DeleteTextures(1, &old) };
            }
        }
        for m in std::mem::take(&mut models.meshes) {
            let mesh = gl_mesh(&m);
            if self.meshes.len() <= m.id {
                self.meshes.resize_with(m.id + 1, || None);
            }
            if let Some(old) = self.meshes[m.id].replace(mesh) {
                delete_mesh(&old);
            }
        }
        if let Some(e) = take_gl_error() {
            eprintln!("bp-player: GL error 0x{e:x} uploading the controllers");
        }
    }
}

impl Drop for Controllers {
    fn drop(&mut self) {
        let _gpu = self.gpu.section();
        unsafe {
            for m in self.meshes.iter().flatten() {
                delete_mesh(m);
            }
            for t in self.textures.values() {
                gl::DeleteTextures(1, t);
            }
            if let Some(strip) = &self.strip {
                delete_mesh(strip);
            }
            gl::DeleteRenderbuffers(1, &self.depth);
            gl::DeleteProgram(self.program.id);
        }
    }
}

fn gl_mesh(m: &Mesh) -> GlMesh {
    let mut mesh = GlMesh { vao: 0, buffers: [0; 2], count: m.indices.len() as i32, texture: m.texture };
    let stride = size_of::<Vertex>() as i32;
    unsafe {
        gl::GenVertexArrays(1, &mut mesh.vao);
        gl::GenBuffers(2, mesh.buffers.as_mut_ptr());
        gl::BindVertexArray(mesh.vao);
        gl::BindBuffer(gl::ARRAY_BUFFER, mesh.buffers[0]);
        gl::BufferData(gl::ARRAY_BUFFER, size_of_val(m.vertices.as_slice()) as isize, m.vertices.as_ptr().cast(), gl::STATIC_DRAW);
        gl::BindBuffer(gl::ELEMENT_ARRAY_BUFFER, mesh.buffers[1]);
        gl::BufferData(gl::ELEMENT_ARRAY_BUFFER, size_of_val(m.indices.as_slice()) as isize, m.indices.as_ptr().cast(), gl::STATIC_DRAW);
        for (location, floats, offset) in [(0, 3, 0), (1, 3, 12), (2, 2, 24)] {
            gl::EnableVertexAttribArray(location);
            gl::VertexAttribPointer(location, floats, gl::FLOAT, gl::FALSE, stride, offset as *const _);
        }
        gl::BindVertexArray(0);
        gl::BindBuffer(gl::ARRAY_BUFFER, 0);
    }
    mesh
}

fn step_ray((fade, last): (f32, Option<Ray>), on: bool, aim: Option<Ray>, dt: f32) -> (f32, Option<Ray>) {
    (ease(fade, on && aim.is_some(), dt), aim.or(last))
}

fn strip() -> Mesh {
    let h = RAY_WIDTH / 2.0;
    let vertex = |x: f32, y: f32, z: f32| Vertex { position: [x, y, z], normal: [0.0, 0.0, 1.0], uv: [0.0, -z] };
    let vertices = vec![vertex(-h, 0.0, 0.0), vertex(h, 0.0, 0.0), vertex(h, 0.0, -1.0), vertex(-h, 0.0, -1.0), vertex(0.0, -h, 0.0), vertex(0.0, h, 0.0), vertex(0.0, h, -1.0), vertex(0.0, -h, -1.0)];
    Mesh { id: usize::MAX, vertices, indices: vec![0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7], texture: None }
}

fn ray_pose(ray: &Ray, length: f32) -> Pose {
    let z = ray.direction.map(|v| -v);
    let up = if z[1].abs() > 0.99 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let x = unit([up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]]);
    let y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    let [ox, oy, oz] = ray.origin;
    Pose([[x[0], y[0], z[0] * length, ox], [x[1], y[1], z[1] * length, oy], [x[2], y[2], z[2] * length, oz]])
}

fn unit(v: [f32; 3]) -> [f32; 3] {
    let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    v.map(|c| c / n)
}

fn delete_mesh(m: &GlMesh) {
    unsafe {
        gl::DeleteVertexArrays(1, &m.vao);
        gl::DeleteBuffers(2, m.buffers.as_ptr());
    }
}

fn ease(glow: f32, lit: bool, dt: f32) -> f32 {
    let step = dt / EASE_SECS;
    if lit { (glow + step).min(1.0) } else { (glow - step).max(0.0) }
}

fn smooth(glow: f32) -> f32 {
    glow * glow * (3.0 - 2.0 * glow)
}

fn shader_frame(content: &Pose) -> [[f32; 4]; 3] {
    let [a, b, c] = content.0;
    [a, b, c.map(|v| -v)]
}

fn clip(tangents: [f32; 4], view: &EyeView, model: &[[f32; 4]; 3]) -> [f32; 16] {
    let [l, r, t, b] = tangents;
    let rot = &view.rotation;
    let e = view.position;
    let row = |i: usize| {
        let turn = [rot[i * 3], rot[i * 3 + 1], rot[i * 3 + 2]];
        [turn[0], turn[1], turn[2], -(turn[0] * e[0] + turn[1] * e[1] + turn[2] * e[2])]
    };
    let a = Pose([row(0), row(1), row(2)]).then(&Pose(*model)).0;
    let rows = [
        std::array::from_fn::<f32, 4, _>(|c| (2.0 * a[0][c] - (r + l) * a[2][c]) / (r - l)),
        std::array::from_fn(|c| (2.0 * a[1][c] - (t + b) * a[2][c]) / (t - b)),
        std::array::from_fn(|c| (FAR + NEAR) / (FAR - NEAR) * a[2][c] - if c == 3 { 2.0 * FAR * NEAR / (FAR - NEAR) } else { 0.0 }),
        a[2],
    ];
    std::array::from_fn(|i| rows[i % 4][i / 4])
}

fn front_face([l, r, t, b]: [f32; 4]) -> u32 {
    if (r - l) * (t - b) < 0.0 { gl::CW } else { gl::CCW }
}

fn key_light(view: &EyeView, hand: usize) -> [f32; 3] {
    let [x, y, z] = KEY_LIGHT;
    let l = [if hand == 0 { -x } else { x }, y, z];
    let n = (l[0] * l[0] + l[1] * l[1] + l[2] * l[2]).sqrt();
    let r = &view.rotation;
    std::array::from_fn(|i| (r[i] * l[0] + r[3 + i] * l[1] + r[6 + i] * l[2]) / n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gl_context::GlContext;

    fn ndc(tangents: [f32; 4], point: [f32; 3]) -> [f32; 3] {
        let view = eye_view(&Recentre::default(), &Offset::default(), &Pose::IDENTITY, &Pose::IDENTITY);
        let [x, y, z] = point;
        let m = clip(tangents, &view, &shader_frame(&Pose::translation(x, y, z)));
        let w = m[15];
        [m[12] / w, m[13] / w, m[14] / w]
    }

    #[test]
    fn the_projection_follows_the_eyes_tangents_as_the_video_does() {
        let tangents = [-1.2, 1.0, -1.1, 0.9];
        assert!((ndc(tangents, [1.0, 0.0, -1.0])[0] - 1.0).abs() < 1e-4);
        assert!((ndc(tangents, [-1.2, 0.0, -1.0])[0] + 1.0).abs() < 1e-4);
        assert!((ndc(tangents, [0.0, 0.9, -1.0])[1] + 1.0).abs() < 1e-4);
        assert!((ndc(tangents, [0.0, -1.1, -1.0])[1] - 1.0).abs() < 1e-4);
        assert!((ndc(tangents, [0.0, 0.0, -NEAR])[2] + 1.0).abs() < 1e-4);
        assert!((ndc(tangents, [0.0, 0.0, -FAR])[2] - 1.0).abs() < 1e-3);
    }

    #[test]
    fn a_face_toward_the_viewer_keeps_the_winding_gl_takes_for_front() {
        for tangents in [[-1.0, 1.0, -1.0, 1.0], [-1.0, 1.0, 1.0, -1.0]] {
            let [a, b, c] = [[0.0, 0.0, -1.0], [0.1, 0.0, -1.0], [0.0, 0.1, -1.0]].map(|p| ndc(tangents, p));
            let area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
            let ccw = area > 0.0;
            assert_eq!(front_face(tangents), if ccw { gl::CCW } else { gl::CW }, "{tangents:?}");
        }
    }

    #[test]
    fn the_recentre_moves_the_eyes_and_the_hands_alike() {
        let recentre = Recentre { origin: [0.5, 1.6, -0.2], heading: 0.7, pitch: 0.4, roll: 0.6 };
        let head = recentre.to_tracking();
        let hand = Pose::translation(0.6, 1.3, -0.6);
        let view = eye_view(&recentre, &Offset::default(), &head, &Pose::IDENTITY);
        let unmoved = eye_view(&Recentre::default(), &Offset::default(), &head, &Pose::IDENTITY);
        let a = clip([-1.0, 1.0, -1.0, 1.0], &view, &shader_frame(&recentre.to_content().then(&hand)));
        let b = clip([-1.0, 1.0, -1.0, 1.0], &unmoved, &shader_frame(&hand));
        assert!(a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-4));
    }

    #[test]
    fn a_ray_runs_from_the_hand_down_its_aim() {
        let ray = Ray { origin: [0.2, 1.1, -0.3], direction: unit([0.3, -0.2, -1.0]) };
        let pose = ray_pose(&ray, RAY_METRES);
        let far = pose.then(&Pose::translation(0.0, 0.0, -1.0)).position();
        let end = ray.at(RAY_METRES);
        assert!((0..3).all(|i| (far[i] - end[i]).abs() < 1e-5), "{far:?} for {end:?}");
        assert_eq!(pose.position(), ray.origin);
        let down = ray_pose(&Ray { origin: [0.0; 3], direction: [0.0, -1.0, 0.0] }, 1.0);
        assert!(down.0.iter().flatten().all(|v| v.is_finite()));
        assert_eq!(strip().indices.len(), 12);
    }

    #[test]
    fn a_fading_ray_keeps_following_its_aim() {
        let at = |x: f32| Some(Ray { origin: [x, 1.0, 0.0], direction: [0.0, 0.0, -1.0] });
        let shown = step_ray((1.0, at(0.0)), true, at(0.0), 0.016);
        let fading = step_ray(shown, false, at(0.2), 0.016);
        assert!(fading.0 < 1.0 && fading.0 > 0.0);
        assert_eq!(fading.1, at(0.2));
        assert_eq!(step_ray(fading, false, None, 0.016).1, at(0.2));
    }

    #[test]
    fn the_accent_eases_over_150_ms() {
        let mut g = 0.0;
        for _ in 0..3 {
            g = ease(g, true, 0.05);
        }
        assert!((g - 1.0).abs() < 1e-5);
        assert_eq!(ease(g, true, 1.0), 1.0);
        g = ease(g, false, 0.075);
        assert!((g - 0.5).abs() < 1e-5 && (smooth(g) - 0.5).abs() < 1e-5);
        assert_eq!(ease(g, false, 1.0), 0.0);
        assert_eq!((smooth(0.0), smooth(1.0)), (0.0, 1.0));
    }

    #[test]
    #[ignore = "requires ANGLE: libEGL.dll and libGLESv2.dll on the path"]
    fn the_shader_compiles_and_links() {
        let gl_context = GlContext::new().unwrap();
        gl::load_with(|name| gl_context.get_proc_address(&CString::new(name).unwrap()) as *const _);
        let gpu = gl_context.gpu();
        let _gpu = gpu.section();
        let p = Program::new().unwrap();
        for (name, at) in [("mvp", p.mvp), ("model", p.model), ("diffuse", p.diffuse), ("textured", p.textured), ("light", p.light), ("glow", p.glow), ("ghost", p.ghost), ("plain", p.plain)] {
            assert!(at >= 0, "{name} is not a live uniform");
        }
        unsafe { gl::DeleteProgram(p.id) };
    }

    #[test]
    #[ignore = "requires ANGLE: libEGL.dll and libGLESv2.dll on the path"]
    fn a_lit_part_shows_in_the_accent_and_faintly_through_what_hides_it() {
        use bp_vr::{HandModel, Mesh, Part};
        let gl_context = GlContext::new().unwrap();
        gl::load_with(|name| gl_context.get_proc_address(&CString::new(name).unwrap()) as *const _);
        let gpu = gl_context.gpu();
        let _gpu = gpu.section();
        const SIZE: i32 = 64;
        let (mut tex, mut fbos) = ([0; 2], [0; 2]);
        unsafe {
            gl::GenTextures(2, tex.as_mut_ptr());
            gl::GenFramebuffers(2, fbos.as_mut_ptr());
            for i in 0..2 {
                gl::BindTexture(gl::TEXTURE_2D, tex[i]);
                gl::TexStorage2D(gl::TEXTURE_2D, 1, gl::RGBA8, SIZE, SIZE);
                gl::BindFramebuffer(gl::FRAMEBUFFER, fbos[i]);
                gl::FramebufferTexture2D(gl::FRAMEBUFFER, gl::COLOR_ATTACHMENT0, gl::TEXTURE_2D, tex[i], 0);
                gl::ClearColor(0.0, 0.0, 0.0, 1.0);
                gl::Clear(gl::COLOR_BUFFER_BIT);
            }
        }
        let mut c = Controllers::new(gpu, fbos, (SIZE as u32, SIZE as u32)).unwrap();
        let square = |id: usize, half: f32| Mesh {
            id,
            vertices: [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]]
                .map(|[x, y]| Vertex { position: [x * half, y * half, 0.0], normal: [0.0, 0.0, 1.0], uv: [0.0; 2] })
                .to_vec(),
            indices: vec![0, 1, 2, 0, 2, 3],
            texture: None,
        };
        let hand = HandModel {
            device: 1,
            pose: Pose::IDENTITY,
            parts: vec![
                Part { mesh: 0, pose: Pose::translation(0.0, 0.0, -0.5), lit: false },
                Part { mesh: 1, pose: Pose::translation(0.0, 0.0, -1.0), lit: true },
            ],
        };
        let eye = Eye { tangents: [-1.0, 1.0, -1.0, 1.0], to_head: Pose::IDENTITY };
        let frame = |c: &mut Controllers, meshes: Vec<Mesh>| {
            let models = ControllerModels { hands: [None, Some(hand.clone())], meshes, ..Default::default() };
            c.draw(models, [true; 2], Some(1), [false; 2], [None; 2], &Recentre::default(), &Pose::IDENTITY, &[eye, eye]);
        };
        frame(&mut c, vec![square(0, 0.05), square(1, 0.5)]);
        std::thread::sleep(std::time::Duration::from_millis(200));
        frame(&mut c, Vec::new());
        let pixel = |x: i32, y: i32| {
            let mut p = [0u8; 4];
            unsafe {
                gl::BindFramebuffer(gl::FRAMEBUFFER, fbos[0]);
                gl::ReadPixels(x, y, 1, 1, gl::RGBA, gl::UNSIGNED_BYTE, p.as_mut_ptr().cast());
                gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            }
            p
        };
        let (lit, hidden, outside) = (pixel(SIZE / 2 + 12, SIZE / 2), pixel(SIZE / 2, SIZE / 2), pixel(1, 1));
        assert_eq!(take_gl_error(), None);
        assert!(lit[2] > 230 && lit[0] > 170 && lit[1] > 150 && lit[3] == 255, "lit {lit:?}");
        assert!(hidden[2] > 60 && hidden[2] < 120 && hidden[2] > hidden[1], "hidden {hidden:?}");
        assert_eq!(outside[..3], [0, 0, 0]);
        drop(c);
        unsafe {
            gl::DeleteFramebuffers(2, fbos.as_ptr());
            gl::DeleteTextures(2, tex.as_ptr());
        }
    }
}
