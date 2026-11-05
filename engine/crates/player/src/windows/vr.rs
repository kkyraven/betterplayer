use std::ffi::{CStr, CString, c_char};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use bp_vr::{Aim, Buzz, Drag, Eye, Frame, Grab, Offset, Pose, Ray, Recentre, Scene, Shortcut, eye_view};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::core::Interface;

use super::controllers::Controllers;
use super::egl::{Context, D3dImage};
use super::share::{Handoff, Inbox, Outbox};
use crate::gl_context::{GlContext, Gpu};
use crate::mpv::{mpv_render_context, mpv_render_context_report_swap};
use crate::render::{Msg, draw_mpv, skip_one, take_gl_error};
use crate::vr::{ASKED, VrKind, VrLayout, VrStatus, VrView};
use crate::{Feather, KEYING, KeyMode, Matte, VrPassthrough, VrPick};

const SCREEN_RADIUS: f32 = 3.0;

const VERTEX: &str = "#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}";

const FRAGMENT: &str = "#version 300 es
precision highp float;
const float PI = 3.141592653589793;
// Alpha this near 0 or 1 draws as 0 or 1: under half a step of 8 bits.
const float NEAR = 0.5 / 255.0;
const vec3 ROOM = vec3(7.0, 8.0, 11.0) / 255.0;
const vec3 GLOW = vec3(183.0, 163.0, 255.0) / 255.0;
const float RADIUS = 3.0;
const float FLOOR = -1.3;
// Footprints are scaled by this before filtering: about 0.4 of a mip level sharper.
const float SHARPEN = 0.75;
// VR_PASSTHROUGH_KEY in app/shared/vr.ts.
const vec3 PASS = vec3(0.0, 1.0, 0.0);
// KEY_SOFT_FROM, KEY_SOFT_TO, KEY_GREY_FROM, KEY_GREY_TO, KEY_SPILL and KEY_FILL* in app/shared/passthrough.ts.
const float SOFT_FROM = 0.03;
const float SOFT_TO = 0.95;
const float GREY_FROM = 0.005;
const float GREY_TO = 0.06;
const float SPILL = 0.27;
const float FILL = 0.06;
const float FILL_NEAR_FROM = 0.008;
const float FILL_NEAR_TO = 0.02;
const float FILL_FAR_FROM = 0.025;
const float FILL_FAR_TO = 0.06;
// The Pick's reticle: a ring this many eye pixels round where the controller aims.
const float RETICLE = 14.0;
uniform sampler2D video;
// The share of the video texture right of and below the picture, which fills its top left: the
// texture is kept for later pictures (`video_size`). 0 when the picture fills it.
uniform vec2 spare;
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
// 1 keys `keyColour` out of the video, 2 keys by `mask`; 0 keys nothing.
uniform int keying;
uniform vec3 keyColour;
// 0 Edges, 1 Colour distance.
uniform int feather;
uniform float featherPx;
// The AI mask over the whole frame, each eye its own, 1 where the video shows (`matte::showing`).
uniform sampler2D mask;
// 1 shows the room (the pass colour) round the picture and wherever it is keyed.
uniform int passRoom;
// Beta Censoring: 0 off, 1 blur, 2 pixels, at `censorLevel` (0 to 1). `censor` is 1 where the
// picture is hidden, over the whole frame; with `censorWhole` 1 all of it is.
uniform int censorMode;
uniform float censorLevel;
uniform int censorWhole;
uniform sampler2D censor;
// The Pick's aim on the picture (u, v) when z is 1.
uniform vec3 reticle;
out vec4 o;
vec2 eyeOf(vec2 t) {
  if (stereo == 1) t.x = t.x * 0.5 + float(side) * 0.5;
  else if (stereo == 2) t.y = t.y * 0.5 + float(side) * 0.5;
  return t;
}
// The picture's size in texels.
vec2 picture() {
  return vec2(textureSize(video, 0)) * (1.0 - spare);
}
// `eyeOf(t)` in the video texture.
vec2 onVideo(vec2 t) {
  return eyeOf(t) * (1.0 - spare);
}
// One eye's share of the texture, which scales its footprint too.
vec2 share() {
  return stereo == 1 ? vec2(0.5, 1.0) : stereo == 2 ? vec2(1.0, 0.5) : vec2(1.0);
}
// The video at `t` (0 to 1 across this eye), filtered over the pixel's footprint `dx`, `dy`.
vec3 sampleAt(vec2 t, vec2 dx, vec2 dy) {
  vec2 s = share();
  // On the axis the eyes split, stay a footprint (at least half a texel) inside this eye, so
  // neither the filter nor a mip texel across the split reaches the other eye.
  vec2 texel = 1.0 / (picture() * s);
  vec2 inset = step(s, vec2(0.5)) * min(max(abs(dx) + abs(dy), 0.5 * texel), 0.5);
  vec2 at = onVideo(clamp(t, inset, 1.0 - inset));
  vec2 k = s * (1.0 - spare) * SHARPEN;
  return textureGrad(video, at, dx * k, dy * k).rgb;
}
// BT.601 full range, as `ycbcr` in passthrough.ts.
vec3 ycc(vec3 c) {
  return vec3(dot(c, vec3(0.299, 0.587, 0.114)), 0.5 + dot(c, vec3(-0.168736, -0.331264, 0.5)), 0.5 + dot(c, vec3(0.5, -0.418688, -0.081312)));
}
// BT.601 full range back to RGB.
vec3 rgb(vec3 y) {
  return y.x + vec3(1.402 * (y.z - 0.5), -0.344136 * (y.y - 0.5) - 0.714136 * (y.z - 0.5), 1.772 * (y.y - 0.5));
}
// How much of colour `c` shows over `key`, 0 to 1. A saturated key fades by chroma distance, whole
// at SOFT_TO of the key's own chroma; a black, white or grey key by the largest channel difference.
float shows(vec3 c, vec3 key) {
  vec2 k = ycc(key).yz;
  float sat = distance(k, vec2(0.5));
  float chroma = clamp((distance(ycc(c).yz, k) - SOFT_FROM) / max(SOFT_TO * sat - SOFT_FROM, 0.001), 0.0, 1.0);
  vec3 d = abs(c - key);
  float grey = clamp((max(d.r, max(d.g, d.b)) - GREY_FROM) / (GREY_TO - GREY_FROM), 0.0, 1.0);
  return mix(grey, chroma, smoothstep(0.05, 0.15, sat));
}
// Colour `c` as the picture's own where `a` of it shows: the key's share taken out, then the key's
// hue (spill) kept only past SPILL of the chroma across it. A grey key has no hue to take.
vec3 unkeyed(vec3 c, vec3 key, float a) {
  if (a <= 0.0) return c;
  vec3 y = ycc(clamp((c - (1.0 - a) * key) / a, 0.0, 1.0));
  vec2 k = ycc(key).yz - 0.5;
  float sat = length(k);
  vec2 along = k / max(sat, 0.001);
  vec2 v = y.yz - 0.5;
  float spill = max(dot(v, along) - abs(dot(v, vec2(along.y, -along.x))) * SPILL, 0.0);
  y.yz -= along * spill * smoothstep(0.05, 0.15, sat);
  return clamp(rgb(y), 0.0, 1.0);
}
// How much `c`, a mip level's mean, hits the picture over a black, white or grey key: its largest
// channel difference, from `from` to `to`.
float hits(vec3 c, float from, float to) {
  vec3 d = abs(c - keyColour);
  return smoothstep(from, to, max(d.r, max(d.g, d.b)));
}
// How much the picture encloses `t`, for a black, white or grey key: of 8 rays FILL of the eye's
// width long, the least by the more its 2 taps hit the picture, the near one by picture as dim as
// hair and the far one by brighter picture, so dim gaps stay open. Each tap is the mip level a quarter
// of the ray across, which with bilinear filtering sees 3/8 of the ray either side of it, so taps
// 3/8 and 7/8 along see the whole ray and nothing behind it. A hole the picture surrounds fills;
// the backdrop, open on a side, does not. Pure backdrop all round stops at once, and opposite rays
// go in turn to find an open side soon.
float enclosed(vec2 t) {
  vec2 eye = picture() * share();
  vec2 reach = FILL * eye.x / eye;
  float lod = log2(FILL * eye.x / 4.0);
  vec3 d = abs(textureLod(video, onVideo(t), lod + 3.0).rgb - keyColour);
  if (max(d.r, max(d.g, d.b)) < GREY_FROM) return 0.0;
  float least = 1.0;
  for (int i = 0; i < 8 && least > 0.0; i++) {
    float a = float(i / 2) * PI * 0.25 + float(i % 2) * PI;
    vec2 ray = reach * vec2(cos(a), sin(a));
    float most = hits(textureLod(video, onVideo(clamp(t + ray * 0.375, 0.0, 1.0)), lod).rgb, FILL_NEAR_FROM, FILL_NEAR_TO);
    if (most < 1.0) most = max(most, hits(textureLod(video, onVideo(clamp(t + ray * 0.875, 0.0, 1.0)), lod).rgb, FILL_FAR_FROM, FILL_FAR_TO));
    least = min(least, most);
  }
  return least;
}
// How much of the video shows at `t`, whose colour is `c`; `own` is how much `c` alone shows.
// Edges takes the lesser of that and the taps' mean, so it softens inward and never grows the
// picture. Colour distance shows whole where every tap shows (filling holes), hides where none do,
// and between them (an edge is near) follows the colour. A black, white or grey key then fills
// what the picture encloses, as such a backdrop was not made for keying.
float keyAlpha(vec2 t, vec2 dx, vec2 dy, vec3 c, out float own) {
  own = shows(c, keyColour);
  float k = own;
  // Taps that cannot change what draws (NEAR) are skipped, as in the Quest's keyAlpha: Edges needs none where the
  // colour does not show, and Colour distance none past the first where the colour shows all but whole or not at
  // all and that tap agrees.
  if (featherPx > 0.0 && (feather == 1 || own > NEAR)) {
    vec2 r = featherPx / (picture() * share());
    float s = shows(sampleAt(t + r * vec2(1.0, 0.0), dx, dy), keyColour);
    float sum = own + s;
    float least = s;
    float most = s;
    bool settled = feather == 1 && (s >= 0.5 ? own >= 1.0 - NEAR : own <= NEAR);
    if (!settled) {
      for (int i = 1; i < 8; i++) {
        float a = float(i) * PI * 0.25;
        s = shows(sampleAt(t + r * vec2(cos(a), sin(a)), dx, dy), keyColour);
        sum += s;
        least = min(least, s);
        most = max(most, s);
      }
    }
    k = feather == 0 ? min(own, sum / 9.0) : settled ? own : least > 0.5 ? 1.0 : most < 0.5 ? 0.0 : own;
  }
  float grey = 1.0 - smoothstep(0.05, 0.15, length(ycc(keyColour).yz - 0.5));
  if (grey > 0.0 && k < 1.0) k = max(k, grey * enclosed(t));
  return k;
}
// The AI mask at `t` in this eye, read at the frame point the video is (`eyeOf`). Half a cell inside
// this eye's cells, so the filter never blends in the other eye's.
float maskAt(vec2 t) {
  vec2 inset = 0.5 / (vec2(textureSize(mask, 0)) * share());
  return texture(mask, eyeOf(clamp(t, inset, 1.0 - inset))).r;
}
// AI: the mask (255 shows) at `t`, softened by the same taps as Edges, `featherPx` of the frame's
// pixels round it. As maskAlpha in the Quest's passthrough.frag.
float maskAlpha(vec2 t) {
  float sum = maskAt(t);
  if (featherPx > 0.0) {
    // In this eye's 0 to 1, that is featherPx / picture() of the frame.
    vec2 reach = featherPx / (picture() * share());
    for (int i = 0; i < 8; i++) {
      float a = float(i) * PI * 0.25;
      sum += maskAt(t + reach * vec2(cos(a), sin(a)));
    }
    sum /= 9.0;
  }
  return smoothstep(0.35, 0.65, sum);
}
// Beta Censoring's cover at `t` in this eye, as `hidden` in app/renderer/src/components/player/stage.ts.
vec3 hidden(vec2 t) {
  vec2 eye = picture() * share();
  if (censorMode == 2) {
    float across = mix(64.0, 14.0, censorLevel);
    vec2 grid = vec2(across, across * eye.y / eye.x);
    return textureLod(video, onVideo((floor(t * grid) + 0.5) / grid), log2(eye.x / across)).rgb;
  }
  float lod = log2(eye.x / mix(160.0, 24.0, censorLevel));
  vec2 px = exp2(lod) / eye;
  vec3 sum = textureLod(video, onVideo(t), lod).rgb * 2.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = i < 2 ? vec2(px.x * float(i * 2 - 1), 0.0) : vec2(0.0, px.y * float(i * 2 - 5));
    sum += textureLod(video, onVideo(clamp(t + o, 0.0, 1.0)), lod).rgb;
  }
  return sum / 6.0;
}
// How much of the picture at `t` is hidden. Half a cell inside this eye's cells, so the filter
// never blends in the other eye's.
float censored(vec2 t) {
  if (censorWhole == 1) return 1.0;
  vec2 inset = 0.5 / (vec2(textureSize(censor, 0)) * share());
  return smoothstep(0.35, 0.65, texture(censor, eyeOf(clamp(t, inset, 1.0 - inset))).r);
}
// What shows the room for the user's streamer: the picture's `a` over the pass colour, with
// straight alpha for a runtime that reads it. The one place SteamVR's room comes from.
vec4 overRoom(vec3 c, float a) {
  return vec4(mix(PASS, c, a), a);
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
// @portals:decls
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
  vec3 back = passRoom == 1 ? PASS : room(p, d);
  vec3 c = back;
  // How much of the picture shows here: its coverage at the border, then the key.
  float a = clamp(edge + 0.5, 0.0, 1.0);
  if (a > 0.0) {
    c = sampleAt(t, dx, dy);
    if (keying == 1) {
      float own;
      float k = keyAlpha(t, dx, dy, c, own);
      // Unmixed by the larger, so a filled hole keeps its own colour and an eroded edge loses none.
      c = unkeyed(c, keyColour, max(own, k));
      a *= k;
    } else if (keying == 2) a *= maskAlpha(t);
    if (censorMode != 0) {
      float m = censored(t);
      if (m > 0.0) c = mix(c, hidden(t), m);
    }
    if (reticle.z > 0.5) {
      // The aim in this pixel's own steps across the picture, so the ring keeps its size.
      vec2 r = t - reticle.xy;
      if (mode == 2 && hfov > 6.28) r.x -= round(r.x);
      mat2 j = mat2(dx, dy);
      if (determinant(j) != 0.0) {
        float off = abs(length(inverse(j) * r) - RETICLE);
        c = mix(c, vec3(0.05), 0.6 * (1.0 - smoothstep(2.0, 3.0, off)));
        c = mix(c, vec3(1.0), 1.0 - smoothstep(0.75, 1.5, off));
      }
    }
  }
  // @portals:main
  // One dither over everything, last, so neither the glow nor the video bands in the 8-bit eye.
  // Over the room it scales with how much video shows, so the pass colour stays exact for the
  // streamer's match and a keyed edge gets only its share.
  float n = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  if (passRoom == 1) {
    o = overRoom(c, a);
    o.rgb += n * a;
  } else {
    o = vec4(mix(back, c, a) + n, 1.0);
  }
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
    spare: i32,
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
    keying: i32,
    key_colour: i32,
    feather: i32,
    feather_px: i32,
    mask: i32,
    pass_room: i32,
    reticle: i32,
    censor: i32,
    censor_mode: i32,
    censor_level: i32,
    censor_whole: i32,
}

impl Program {
    fn new(gpu: Gpu) -> Result<Program, String> {
        unsafe {
            let vs = compile(gl::VERTEX_SHADER, VERTEX)?;
            let fs = match compile(gl::FRAGMENT_SHADER, &super::portals::fragment(FRAGMENT)) {
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
                spare: at("spare"),
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
                keying: at("keying"),
                key_colour: at("keyColour"),
                feather: at("feather"),
                feather_px: at("featherPx"),
                mask: at("mask"),
                pass_room: at("passRoom"),
                reticle: at("reticle"),
                censor: at("censor"),
                censor_mode: at("censorMode"),
                censor_level: at("censorLevel"),
                censor_whole: at("censorWhole"),
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

pub(super) unsafe fn compile(kind: u32, source: &str) -> Result<u32, String> {
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

pub(super) unsafe fn info_log(id: u32, get: unsafe fn(u32, i32, *mut i32, *mut gl::types::GLchar)) -> String {
    let mut buf = vec![0u8; 2048];
    let mut len = 0;
    unsafe { get(id, buf.len() as i32, &mut len, buf.as_mut_ptr() as *mut gl::types::GLchar) };
    String::from_utf8_lossy(&buf[..len.max(0) as usize]).into_owned()
}

struct MaskTexture {
    tex: u32,
    w: u32,
    h: u32,
    at: (u64, u64),
    gpu: Gpu,
}

impl MaskTexture {
    fn show(slot: &mut Option<MaskTexture>, gpu: Gpu, at: (u64, u64), m: &Matte) -> bool {
        if m.w == 0 || m.h == 0 || m.cover.len() != m.w as usize * m.h as usize {
            return false;
        }
        unsafe {
            if slot.as_ref().is_none_or(|t| (t.w, t.h) != (m.w, m.h)) {
                *slot = None;
                let mut tex = 0;
                gl::GenTextures(1, &mut tex);
                gl::BindTexture(gl::TEXTURE_2D, tex);
                gl::TexStorage2D(gl::TEXTURE_2D, 1, gl::R8, m.w as i32, m.h as i32);
                gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::LINEAR as i32);
                gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::LINEAR as i32);
                gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE as i32);
                gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE as i32);
                *slot = Some(MaskTexture { tex, w: m.w, h: m.h, at: (u64::MAX, u64::MAX), gpu });
            }
            let Some(t) = slot.as_mut() else { return false };
            if t.at != at {
                gl::BindTexture(gl::TEXTURE_2D, t.tex);
                gl::PixelStorei(gl::UNPACK_ALIGNMENT, 1);
                gl::TexSubImage2D(gl::TEXTURE_2D, 0, 0, 0, m.w as i32, m.h as i32, gl::RED, gl::UNSIGNED_BYTE, m.cover.as_ptr().cast());
                gl::PixelStorei(gl::UNPACK_ALIGNMENT, 4);
                t.at = at;
            }
            gl::BindTexture(gl::TEXTURE_2D, 0);
        }
        true
    }
}

impl Drop for MaskTexture {
    fn drop(&mut self) {
        let _gpu = self.gpu.section();
        unsafe { gl::DeleteTextures(1, &self.tex) };
    }
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

struct Renderer {
    gpu: Gpu,
    targets: [EyeTarget; 2],
    size: (u32, u32),
    eyes: [Eye; 2],
    program: Program,
    controllers: Option<Controllers>,
    legend: Option<usize>,
    models: [bool; 2],
    rays: [bool; 2],
    inbox: Inbox,
    video: Option<Video>,
    large: Option<Video>,
    picture: (u32, u32),
    largest: (u32, u32),
    anisotropy: f32,
    view: VrView,
    passthrough: VrPassthrough,
    mask: Option<MaskTexture>,
    censor: Option<MaskTexture>,
    pick: Option<usize>,
    held_back: [bool; 4],
    aim: [Option<Ray>; 2],
    head: Option<Pose>,
    recentre: Recentre,
    recentre_next: bool,
    keep_recline: bool,
    offset: Offset,
    grab: Option<Grab>,
    screen: f32,
    status: Arc<Mutex<Option<VrStatus>>>,
    second: (Instant, u32),
    failing: Option<(Instant, String)>,
    ended: bool,
    portals: super::portals::Stage,
    scene: Scene,
}

impl Renderer {
    fn start(gl: &GlContext, view: VrView, status: Arc<Mutex<Option<VrStatus>>>, handoff: Handoff) -> Result<Renderer, String> {
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
        let portals = super::portals::Stage::new(gpu, program.id);
        let controllers = Controllers::new(gpu, [targets[0].image.fbo, targets[1].image.fbo], size)
            .inspect_err(|e| eprintln!("bp-player: the controllers are not drawn: {e}"))
            .ok();
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
        let passthrough = {
            let mut keying = KEYING.lock().unwrap();
            keying.pick = None;
            keying.picks.clear();
            keying.passthrough
        };
        Ok(Renderer {
            gpu,
            targets,
            size,
            eyes,
            program,
            controllers,
            legend: None,
            models: [true; 2],
            rays: [false; 2],
            inbox: Inbox::new(handoff),
            video: None,
            large: None,
            picture: (0, 0),
            largest: (0, 0),
            anisotropy,
            view,
            passthrough,
            mask: None,
            censor: None,
            pick: None,
            held_back: [false; 4],
            aim: [None; 2],
            head,
            recentre: head.map(|h| Recentre::from_head(&h)).unwrap_or_default(),
            recentre_next: head.is_none(),
            keep_recline: false,
            offset: Offset::default(),
            grab: None,
            screen,
            status,
            second: (Instant::now(), 0),
            failing: None,
            ended: false,
            portals,
            scene,
        })
    }

    fn view(&mut self, view: VrView) {
        if self.portals.hold_view(view) {
            return;
        }
        self.view = view;
    }

    fn recentre(&mut self, keep_recline: bool) {
        self.keep_recline = keep_recline && (!self.recentre_next || self.keep_recline);
        self.recentre_next = true;
    }

    fn take_video(&mut self, angle: &Context) {
        let (video, large, picture, largest, gpu, anisotropy) = (&mut self.video, &mut self.large, &mut self.picture, &mut self.largest, self.gpu, self.anisotropy);
        let mut failed = None;
        let taken = self.inbox.take(angle, |(w, h), from| {
            let (tw, th) = video_size(video.as_ref().map(|v| (v.w, v.h)), *largest, (w, h));
            *largest = (largest.0.max(w), largest.1.max(h));
            if video.as_ref().is_none_or(|v| (v.w, v.h) != (tw, th)) {
                let old = video.take();
                if large.as_ref().is_some_and(|l| (l.w, l.h) == (tw, th)) {
                    *video = large.take();
                } else if large.as_ref().is_some_and(|l| l.w <= tw && l.h <= th) {
                    *large = None;
                }
                let old = old.filter(|o| o.w >= tw && o.h >= th && large.is_none());
                if video.is_none() {
                    match Video::new(tw, th, anisotropy, gpu) {
                        Ok(v) => *video = Some(v),
                        Err(e) => {
                            failed = Some(e);
                            return;
                        }
                    }
                }
                if old.is_some() {
                    *large = old;
                }
            }
            let Some(v) = video.as_ref() else { return };
            *picture = (w, h);
            unsafe {
                gl::Disable(gl::SCISSOR_TEST);
                gl::BindFramebuffer(gl::READ_FRAMEBUFFER, from);
                gl::BindFramebuffer(gl::DRAW_FRAMEBUFFER, v.fbo);
                gl::BlitFramebuffer(0, 0, w as i32, h as i32, 0, 0, w as i32, h as i32, gl::COLOR_BUFFER_BIT, gl::NEAREST);
                pad_edges((w, h), (v.w, v.h));
                gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            }
        });
        if let Some(e) = failed {
            self.fail(format!("failed: {e}"));
            return;
        }
        match taken {
            Ok(true) => {
                if let Some(v) = &self.video {
                    unsafe {
                        gl::BindTexture(gl::TEXTURE_2D, v.tex);
                        gl::GenerateMipmap(gl::TEXTURE_2D);
                        gl::BindTexture(gl::TEXTURE_2D, 0);
                    }
                }
            }
            Ok(false) => {}
            Err(e) => {
                static REPORTED: AtomicBool = AtomicBool::new(false);
                if !REPORTED.swap(true, Ordering::Relaxed) {
                    eprintln!("bp-player: {e}");
                }
            }
        }
        if let Some(e) = take_gl_error() {
            eprintln!("bp-player: GL error 0x{e:x} taking the headset video");
        }
    }

    fn frame(&mut self, angle: &Context) {
        let called = Instant::now();
        match self.wait() {
            Ok(()) => {
                let woke = Instant::now();
                self.take_asked();
                self.take_keying();
                let taken = self.portals.take();
                if let Some(seat) = taken.seat {
                    self.recentre = seat;
                    self.offset = Offset::default();
                    self.grab = None;
                }
                if let Some(view) = taken.view {
                    self.view = view;
                }
                if let Some(head) = self.head {
                    match self.draw(&head, angle) {
                        Ok(()) => self.failing = None,
                        Err(e) => self.trouble(e),
                    }
                    self.portals.log_frame(&mut self.scene, called, woke);
                }
            }
            Err(e) => {
                self.trouble(e);
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        self.events();
    }

    fn ended(&self) -> bool {
        self.ended
    }

    fn draw(&mut self, head: &Pose, angle: &Context) -> Result<(), String> {
        let asked = Instant::now();
        let _gpu = self.gpu.section();
        self.portals.locked(asked);
        self.take_video(angle);
        let p = &self.program;
        let (w, h) = self.size;
        let (mode, hfov) = self.mode();
        let stereo = match self.view.layout {
            VrLayout::Mono => 0,
            VrLayout::Sbs => 1,
            VrLayout::Ou => 2,
        };
        let screen = self.flat();
        let key = self.passthrough.video.filter(|_| self.pick.is_none());
        let matte = key.filter(|k| k.mode == KeyMode::Ai && mode != 0).and_then(|_| crate::matte::showing());
        let reticle = self.pick.and_then(|hand| self.aimed(hand));
        let models = self.scene.controllers();
        let masked = matte.is_some_and(|(at, m)| MaskTexture::show(&mut self.mask, self.gpu, at, &m));
        let censoring = crate::matte::censoring().map(|(look, grid)| (look, grid.is_some_and(|(at, m)| MaskTexture::show(&mut self.censor, self.gpu, at, &m))));
        let keying = match key {
            Some(k) if k.mode == KeyMode::Colour => 1,
            Some(_) if masked => 2,
            _ => 0,
        };
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
            let spare = self.video.as_ref().map_or((0.0, 0.0), |v| (1.0 - self.picture.0 as f32 / v.w as f32, 1.0 - self.picture.1 as f32 / v.h as f32));
            gl::Uniform2f(p.spare, spare.0, spare.1);
            gl::Uniform2f(p.size, w as f32, h as f32);
            gl::Uniform1i(p.mode, mode);
            gl::Uniform1f(p.hfov, hfov);
            gl::Uniform1i(p.stereo, stereo);
            gl::Uniform2f(p.screen, screen.0, screen.1);
            gl::Uniform1i(p.keying, keying);
            if keying == 2 {
                gl::ActiveTexture(gl::TEXTURE1);
                gl::BindTexture(gl::TEXTURE_2D, self.mask.as_ref().map_or(0, |t| t.tex));
                gl::BindSampler(1, 0);
                gl::ActiveTexture(gl::TEXTURE0);
            }
            gl::Uniform1i(p.mask, 1);
            gl::Uniform1i(p.censor_mode, censoring.map_or(0, |(look, _)| if look.blur { 1 } else { 2 }));
            gl::Uniform1f(p.censor_level, censoring.map_or(0.0, |(look, _)| look.strength));
            gl::Uniform1i(p.censor_whole, censoring.is_some_and(|(_, shown)| !shown) as i32);
            if censoring.is_some_and(|(_, shown)| shown) {
                gl::ActiveTexture(gl::TEXTURE2);
                gl::BindTexture(gl::TEXTURE_2D, self.censor.as_ref().map_or(0, |t| t.tex));
                gl::BindSampler(2, 0);
                gl::ActiveTexture(gl::TEXTURE0);
            }
            gl::Uniform1i(p.censor, 2);
            if let Some(k) = key {
                let [r, g, b] = [16, 8, 0].map(|shift| ((k.key >> shift) & 0xff) as f32 / 255.0);
                gl::Uniform3f(p.key_colour, r, g, b);
                gl::Uniform1i(p.feather, (k.feather == Feather::Distance) as i32);
                gl::Uniform1f(p.feather_px, k.feather_px);
            }
            gl::Uniform1i(p.pass_room, self.passthrough.room as i32);
            let [u, v] = reticle.unwrap_or_default();
            gl::Uniform3f(p.reticle, u, v, reticle.is_some() as i32 as f32);
            gl::Viewport(0, 0, w as i32, h as i32);
            self.portals.bind(head);
            for (i, eye) in self.eyes.iter().enumerate() {
                let half = self.view.ipd / 2.0;
                let v = eye_view(&self.recentre, &self.offset, head, &eye.to_head).turned(if i == 0 { half } else { -half });
                let [l, r, t, b] = eye.tangents;
                let pixel = (r - l) / w as f32;
                gl::Uniform4f(p.tangents, l, r, t, b);
                gl::UniformMatrix3fv(p.rot, 1, gl::FALSE, v.rotation.as_ptr());
                gl::Uniform3f(p.eye_pos, v.position[0], v.position[1], v.position[2]);
                gl::Uniform1i(p.side, (i == 1) as i32 ^ self.view.swap_eyes as i32);
                gl::Uniform1f(p.pixel, pixel);
                self.portals.eye(head, &eye.to_head);
                gl::BindFramebuffer(gl::FRAMEBUFFER, self.targets[i].image.fbo);
                gl::DrawArrays(gl::TRIANGLES, 0, 3);
            }
            self.portals.done();
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            gl::ActiveTexture(gl::TEXTURE2);
            gl::BindTexture(gl::TEXTURE_2D, 0);
            gl::ActiveTexture(gl::TEXTURE1);
            gl::BindTexture(gl::TEXTURE_2D, 0);
            gl::ActiveTexture(gl::TEXTURE0);
            gl::BindTexture(gl::TEXTURE_2D, 0);
            gl::BindVertexArray(0);
            gl::UseProgram(0);
            if let Some(c) = &mut self.controllers {
                c.draw(models, self.models, self.legend, self.rays, self.aim, &self.recentre, head, &self.eyes);
            }
            gl::Flush();
        }
        if let Some(e) = take_gl_error() {
            eprintln!("bp-player: headset draw: GL error 0x{e:x}");
        }
        let submitting = Instant::now();
        for (i, t) in self.targets.iter().enumerate() {
            self.scene.submit(i, t.tex.as_raw())?;
        }
        self.scene.handoff();
        self.portals.submitted(submitting);
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
        let buzzes = self.status.lock().unwrap().as_mut().map(|s| std::mem::take(&mut s.buzzes)).unwrap_or_default();
        for (hand, buzz) in buzzes {
            self.scene.buzz(hand, buzz);
        }
        let mut e = self.scene.events();
        if e.eyes_changed {
            self.eyes = [self.scene.eye(0), self.scene.eye(1)];
        }
        if e.space_changed {
            self.recentre_next = true;
            self.keep_recline = false;
            self.offset = Offset::default();
            self.grab = None;
        }
        self.aim = e.aim;
        self.pick_input(&mut e);
        self.drag(&e);
        if let Some(s) = self.status.lock().unwrap().as_mut() {
            if let Some(m) = e.mounted {
                s.mounted = m;
            }
            s.lost_tracking = e.lost_tracking;
            s.focused = e.focused;
            s.push_shortcuts(e.shortcuts);
            s.aim = e.aim;
            s.stick = e.stick;
            s.turn = self.offset.turn;
            s.dragging = self.grab.is_some();
            s.presses += e.presses;
            if e.quit {
                s.quit = true;
                s.active = false;
                s.error = Some("quit: SteamVR asked Better Player to quit".into());
            }
        }
        self.ended |= e.quit;
    }

    fn drag(&mut self, e: &bp_vr::Events) {
        let aim = |hand: usize| Aim::of(&self.recentre, self.head?.position(), e.hands[hand].as_ref()?);
        match e.drag {
            Some(Drag::Start(hand)) if self.video.is_some() => self.grab = aim(hand).map(|a| Grab::start(hand, a, &self.offset)),
            Some(Drag::End) => self.grab = None,
            _ => {}
        }
        let Some(g) = &mut self.grab else { return };
        let Some(a) = aim(g.hand) else { return };
        if g.drag(a, &mut self.offset) {
            self.scene.buzz(g.hand, Buzz::Detent);
        }
    }

    fn mode(&self) -> (i32, f32) {
        if self.passthrough.idle {
            return (0, 0.0);
        }
        match (&self.video, self.view.kind) {
            (None, _) => (0, 0.0),
            (Some(_), VrKind::Flat) => (1, self.screen.to_radians()),
            (Some(_), VrKind::Equirect180) => (2, self.view.arc.to_radians()),
            (Some(_), VrKind::Equirect360) => (2, std::f32::consts::TAU),
            (Some(_), VrKind::Fisheye) => (3, self.view.fov.to_radians()),
        }
    }

    fn flat(&self) -> (f32, f32) {
        let (w, h) = self.picture;
        let aspect = self.video.as_ref().map_or(1.0, |_| flat_aspect(self.view.layout, w as f32, h as f32));
        flat_screen(self.screen, aspect)
    }

    fn aimed(&self, hand: usize) -> Option<[f32; 2]> {
        let ray = self.aim[hand]?.to_video(&self.recentre, &self.offset);
        match self.mode() {
            (1, _) => {
                let (w, h) = self.flat();
                ray.on_screen(SCREEN_RADIUS, w, h)
            }
            (2, hfov) => ray.on_equirect(hfov),
            (3, fov) => ray.on_fisheye(fov),
            _ => None,
        }
    }

    fn take_keying(&mut self) {
        let mut keying = KEYING.lock().unwrap();
        self.passthrough = keying.passthrough;
        if let Some(pick) = keying.pick.take() {
            self.pick = pick;
            if pick.is_some() {
                self.grab = None;
            }
        }
    }

    fn pick_input(&mut self, e: &mut bp_vr::Events) {
        if self.pick.is_some() && matches!(e.drag, Some(Drag::Start(_))) {
            e.drag = None;
        }
        let mut picks = Vec::new();
        e.shortcuts.retain(|&s| {
            let (side, press) = match s {
                Shortcut::PointLeft => (0, true),
                Shortcut::PointRight => (1, true),
                Shortcut::ReleaseLeft => (0, false),
                Shortcut::ReleaseRight => (1, false),
                Shortcut::GripLeft => (2, true),
                Shortcut::GripRight => (3, true),
                Shortcut::GripReleaseLeft => (2, false),
                Shortcut::GripReleaseRight => (3, false),
                Shortcut::Back => {
                    let Some(hand) = self.pick.take() else { return true };
                    picks.push(VrPick::Cancel { hand });
                    return false;
                }
                _ => return true,
            };
            if !press {
                return !std::mem::take(&mut self.held_back[side]);
            }
            self.held_back[side] = self.pick.is_some();
            let Some(hand) = self.pick else { return true };
            if let Some([u, v]) = (side == hand).then(|| self.aimed(hand)).flatten() {
                picks.push(VrPick::Pick { hand, u, v });
                self.pick = None;
            }
            false
        });
        if !picks.is_empty() {
            KEYING.lock().unwrap().picks.extend(picks);
        }
    }

    fn take_asked(&mut self) {
        let mut asked = ASKED.lock().unwrap();
        if std::mem::take(&mut asked.recentred) {
            self.offset = Offset::default();
            self.grab = None;
        }
        self.offset.turn = (self.offset.turn + std::mem::take(&mut asked.turn) + 180.0).rem_euclid(360.0) - 180.0;
        self.screen = asked.screen;
        self.legend = asked.legend;
        (self.models, self.rays) = (asked.models, asked.rays);
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

enum Ask {
    View(VrView),
    Recentre(bool),
}

pub(crate) struct Headset {
    gpu: Gpu,
    angle: *const Context,
    out: Outbox,
    video: Option<Video>,
    mipmapped: bool,
    max_texture: u32,
    status: Arc<Mutex<Option<VrStatus>>>,
    asks: Option<Sender<Ask>>,
    thread: Option<JoinHandle<()>>,
    ended: Arc<AtomicBool>,
}

impl Headset {
    pub fn start(gl: &GlContext, view: VrView, status: Arc<Mutex<Option<VrStatus>>>, wake: Sender<Msg>) -> Result<Headset, String> {
        let out = Outbox::new();
        let handoff = out.handoff();
        let (asks, asked) = channel();
        let (started, answer) = channel();
        let ended = Arc::new(AtomicBool::new(false));
        let thread = {
            let (status, ended) = (status.clone(), ended.clone());
            std::thread::Builder::new()
                .name("bp-headset".into())
                .spawn(move || run(view, status, handoff, asked, started, ended, wake))
                .map_err(|e| format!("failed: the headset thread: {e}"))?
        };
        if let Err(e) = answer.recv().unwrap_or_else(|_| Err("failed: the headset thread ended".into())) {
            let _ = thread.join();
            return Err(e);
        }
        let gpu = gl.gpu();
        let mut max_texture = 0;
        {
            let _gpu = gpu.section();
            unsafe { gl::GetIntegerv(gl::MAX_TEXTURE_SIZE, &mut max_texture) };
        }
        Ok(Headset {
            gpu,
            angle: gl.angle(),
            out,
            video: None,
            mipmapped: false,
            max_texture: max_texture.max(1) as u32,
            status,
            asks: Some(asks),
            thread: Some(thread),
            ended,
        })
    }

    pub fn view(&mut self, view: VrView) {
        self.ask(Ask::View(view));
    }

    pub fn recentre(&mut self, keep_recline: bool) {
        self.ask(Ask::Recentre(keep_recline));
    }

    fn ask(&self, ask: Ask) {
        if let Some(asks) = &self.asks {
            let _ = asks.send(ask);
        }
    }

    pub fn draw_video(&mut self, ctx: *mut mpv_render_context, (w, h): (u32, u32), window: bool) -> bool {
        if w == 0 || h == 0 {
            return true;
        }
        let shrink = (self.max_texture as f32 / w.max(h) as f32).min(1.0);
        let (w, h) = (((w as f32 * shrink) as u32).max(1), ((h as f32 * shrink) as u32).max(1));
        let _gpu = self.gpu.section();
        if !window {
            self.video = None;
        } else if self.video.as_ref().is_none_or(|v| (v.w, v.h) != (w, h)) {
            self.video = None;
            match Video::new(w, h, 0.0, self.gpu) {
                Ok(v) => self.video = Some(v),
                Err(e) => {
                    skip_one(self.gpu, ctx);
                    self.fail(format!("failed: {e}"));
                    return false;
                }
            }
        }
        let angle = unsafe { &*self.angle };
        let video = self.video.as_ref();
        let sent = self.out.send(angle, (w, h), |to| match video {
            Some(v) => {
                let drawn = draw_mpv(ctx, v.fbo, w, h, VIDEO_DEPTH) >= 0;
                if drawn {
                    unsafe {
                        gl::Disable(gl::SCISSOR_TEST);
                        gl::BindFramebuffer(gl::READ_FRAMEBUFFER, v.fbo);
                        gl::BindFramebuffer(gl::DRAW_FRAMEBUFFER, to);
                        gl::BlitFramebuffer(0, 0, w as i32, h as i32, 0, 0, w as i32, h as i32, gl::COLOR_BUFFER_BIT, gl::NEAREST);
                        gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
                    }
                }
                drawn
            }
            None => draw_mpv(ctx, to, w, h, VIDEO_DEPTH) >= 0,
        });
        let drawn = match sent {
            Ok(drawn) => drawn,
            Err(e) => {
                skip_one(self.gpu, ctx);
                self.fail(format!("failed: {e}"));
                return false;
            }
        };
        self.mipmapped = false;
        unsafe { mpv_render_context_report_swap(ctx) };
        take_gl_error().is_none() && drawn
    }

    pub fn copy_video(&mut self, fbo: u32, w: u32, h: u32) -> bool {
        let Some(v) = &self.video else { return false };
        let mut level = 0;
        while v.w >> (level + 1) >= w && v.h >> (level + 1) >= h {
            level += 1;
        }
        let _gpu = self.gpu.section();
        unsafe {
            if !self.mipmapped {
                gl::BindTexture(gl::TEXTURE_2D, v.tex);
                gl::GenerateMipmap(gl::TEXTURE_2D);
                gl::BindTexture(gl::TEXTURE_2D, 0);
                self.mipmapped = true;
            }
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

    pub fn ended(&self) -> bool {
        self.ended.load(Ordering::Relaxed)
    }

    fn fail(&mut self, error: String) {
        if let Some(s) = self.status.lock().unwrap().as_mut() {
            s.active = false;
            s.error = Some(bp_vr::coded(error));
        }
        self.ended.store(true, Ordering::Relaxed);
    }
}

impl Drop for Headset {
    fn drop(&mut self) {
        self.asks = None;
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn run(
    view: VrView,
    status: Arc<Mutex<Option<VrStatus>>>,
    handoff: Handoff,
    asks: Receiver<Ask>,
    started: Sender<Result<(), String>>,
    ended: Arc<AtomicBool>,
    wake: Sender<Msg>,
) {
    let gl = match GlContext::new() {
        Ok(gl) => gl,
        Err(e) => {
            let _ = started.send(Err(format!("failed: the headset's GL context: {e}")));
            return;
        }
    };
    let mut r = match Renderer::start(&gl, view, status, handoff) {
        Ok(r) => r,
        Err(e) => {
            let _ = started.send(Err(e));
            return;
        }
    };
    let _ = started.send(Ok(()));
    'frames: loop {
        loop {
            match asks.try_recv() {
                Ok(Ask::View(v)) => r.view(v),
                Ok(Ask::Recentre(keep_recline)) => r.recentre(keep_recline),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break 'frames,
            }
        }
        r.frame(gl.angle());
        if r.ended() {
            ended.store(true, Ordering::Relaxed);
            let _ = wake.send(Msg::VrEnded);
            break;
        }
    }
    drop(r);
    drop(gl);
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

fn video_size(kept: Option<(u32, u32)>, largest: (u32, u32), (w, h): (u32, u32)) -> (u32, u32) {
    let fills = |(tw, th): (u32, u32)| w as u64 * h as u64 * 4 >= tw as u64 * th as u64 * 3;
    let big = (largest.0.max(w), largest.1.max(h));
    match kept {
        Some((tw, th)) if w <= tw && h <= th && fills((tw, th)) => (tw, th),
        _ if fills(big) => big,
        _ => (w, h),
    }
}

const PAD: u32 = 1024;

unsafe fn pad_edges((w, h): (u32, u32), texture: (u32, u32)) {
    let (r, b) = (texture.0.min(w + PAD) as i32, texture.1.min(h + PAD) as i32);
    let (w, h) = (w as i32, h as i32);
    let blit = |from: [i32; 4], to: [i32; 4]| unsafe {
        gl::BlitFramebuffer(from[0], from[1], from[2], from[3], to[0], to[1], to[2], to[3], gl::COLOR_BUFFER_BIT, gl::NEAREST);
    };
    if r > w {
        blit([w - 1, 0, w, h], [w, 0, r, h]);
    }
    if b > h {
        blit([0, h - 1, w, h], [0, h, w, b]);
    }
    if r > w && b > h {
        blit([w - 1, h - 1, w, h], [w, h, r, b]);
    }
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
pub(super) fn fragment_source() -> &'static str {
    FRAGMENT
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
    fn the_headset_keeps_its_video_texture_between_8k_files() {
        let (mut kept, mut largest, mut made) = (None, (0, 0), Vec::new());
        for (w, h) in [(8192, 4096), (7680, 4320), (7680, 3840), (8192, 4096), (5800, 2900), (7680, 3840), (6144, 3072), (8192, 4096)] {
            let size = video_size(kept, largest, (w, h));
            if kept != Some(size) {
                made.push(size);
            }
            (kept, largest) = (Some(size), (largest.0.max(w), largest.1.max(h)));
        }
        assert_eq!(made, [(8192, 4096), (8192, 4320), (5800, 2900), (8192, 4320), (6144, 3072), (8192, 4320)]);
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

    #[test]
    fn the_shader_keys_with_the_apps_numbers() {
        let shared = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../app/shared/");
        let read = |file: &str| std::fs::read_to_string(format!("{shared}{file}")).expect(file);
        let value = |ts: &str, name: &str| ts.split_once(&format!("export const {name} = ")).and_then(|(_, rest)| rest.split_whitespace().next()).expect(name).to_owned();
        let passthrough = read("passthrough.ts");
        let quest = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../quest/app/src/shaders/passthrough.frag")).expect("passthrough.frag");
        for (ts, glsl) in [("KEY_SOFT_FROM", "SOFT_FROM"), ("KEY_SOFT_TO", "SOFT_TO"), ("KEY_GREY_FROM", "GREY_FROM"), ("KEY_GREY_TO", "GREY_TO"), ("KEY_SPILL", "SPILL"), ("KEY_FILL", "FILL"), ("KEY_FILL_NEAR_FROM", "FILL_NEAR_FROM"), ("KEY_FILL_NEAR_TO", "FILL_NEAR_TO"), ("KEY_FILL_FAR_FROM", "FILL_FAR_FROM"), ("KEY_FILL_FAR_TO", "FILL_FAR_TO")] {
            let line = format!("const float {glsl} = {};", value(&passthrough, ts));
            assert!(FRAGMENT.contains(&line), "{glsl} differs from {ts}");
            assert!(quest.contains(&line), "the Quest's {glsl} differs from {ts}");
        }
        assert_eq!(value(&read("vr.ts"), "VR_PASSTHROUGH_KEY"), "0x00ff00");
        assert!(FRAGMENT.contains("const vec3 PASS = vec3(0.0, 1.0, 0.0);"));
    }

    #[test]
    #[ignore = "requires ANGLE: libEGL.dll and libGLESv2.dll on the path"]
    fn the_shader_compiles_and_links() {
        let gl_context = GlContext::new().unwrap();
        gl::load_with(|name| gl_context.get_proc_address(&CString::new(name).unwrap()) as *const _);
        let gpu = gl_context.gpu();
        let _gpu = gpu.section();
        let p = Program::new(gpu).unwrap();
        for (name, at) in [("keyColour", p.key_colour), ("featherPx", p.feather_px), ("mask", p.mask), ("passRoom", p.pass_room), ("reticle", p.reticle), ("censor", p.censor), ("censorMode", p.censor_mode), ("censorLevel", p.censor_level), ("censorWhole", p.censor_whole)] {
            assert!(at >= 0, "{name} is not a live uniform");
        }
        for (name, at) in super::super::portals::PortalUniforms::of(p.id).all() {
            assert!(at >= 0, "{name} is not a live uniform");
        }
    }

    #[test]
    #[ignore = "requires ANGLE: libEGL.dll and libGLESv2.dll on the path"]
    fn a_picture_in_a_larger_texture_draws_as_on_its_own() {
        const N: i32 = 64;
        let (w, h) = (256u32, 128u32);
        let gl_context = GlContext::new().unwrap();
        gl::load_with(|name| gl_context.get_proc_address(&CString::new(name).unwrap()) as *const _);
        let gpu = gl_context.gpu();
        let _gpu = gpu.section();
        let p = Program::new(gpu).unwrap();
        let mut stage = super::super::portals::Stage::new(gpu, p.id);
        let rgba = |w: u32, h: u32, px: &[u8]| unsafe {
            let (mut tex, mut fbo) = (0, 0);
            gl::GenTextures(1, &mut tex);
            gl::BindTexture(gl::TEXTURE_2D, tex);
            gl::TexStorage2D(gl::TEXTURE_2D, 1, gl::RGBA8, w as i32, h as i32);
            if !px.is_empty() {
                gl::TexSubImage2D(gl::TEXTURE_2D, 0, 0, 0, w as i32, h as i32, gl::RGBA, gl::UNSIGNED_BYTE, px.as_ptr().cast());
            }
            gl::GenFramebuffers(1, &mut fbo);
            gl::BindFramebuffer(gl::FRAMEBUFFER, fbo);
            gl::FramebufferTexture2D(gl::FRAMEBUFFER, gl::COLOR_ATTACHMENT0, gl::TEXTURE_2D, tex, 0);
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            (tex, fbo)
        };
        let noise: Vec<u8> = (0..w * h).flat_map(|i| [0u32, 1, 2].map(|c| ((i.wrapping_mul(2654435761) >> (8 * c + 3)) & 0xff) as u8).into_iter().chain([255])).collect();
        let (_, picture) = rgba(w, h, &noise);
        let (_, eye) = rgba(N as u32, N as u32, &[]);
        let anisotropy = unsafe { max_anisotropy() };
        let alone = Video::new(w, h, anisotropy, gpu).unwrap();
        let larger = Video::new(w + 128, h + 128, anisotropy, gpu).unwrap();
        unsafe {
            gl::BindFramebuffer(gl::FRAMEBUFFER, larger.fbo);
            gl::ClearColor(1.0, 0.0, 1.0, 1.0);
            gl::Clear(gl::COLOR_BUFFER_BIT);
            for v in [&alone, &larger] {
                gl::BindFramebuffer(gl::READ_FRAMEBUFFER, picture);
                gl::BindFramebuffer(gl::DRAW_FRAMEBUFFER, v.fbo);
                gl::BlitFramebuffer(0, 0, w as i32, h as i32, 0, 0, w as i32, h as i32, gl::COLOR_BUFFER_BIT, gl::NEAREST);
                pad_edges((w, h), (v.w, v.h));
                gl::BindTexture(gl::TEXTURE_2D, v.tex);
                gl::GenerateMipmap(gl::TEXTURE_2D);
            }
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
        }
        let draw = |v: &Video, stage: &mut super::super::portals::Stage, down: bool, censor: bool| -> Vec<u8> {
            let (s, c) = 80f32.to_radians().sin_cos();
            let rot = if down { [1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c] } else { [c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c] };
            let mut px = vec![0u8; (N * N * 4) as usize];
            unsafe {
                gl::UseProgram(p.id);
                gl::BindVertexArray(p.vao);
                gl::ActiveTexture(gl::TEXTURE0);
                gl::BindTexture(gl::TEXTURE_2D, v.tex);
                gl::Uniform1i(p.video, 0);
                gl::Uniform2f(p.spare, 1.0 - w as f32 / v.w as f32, 1.0 - h as f32 / v.h as f32);
                gl::Uniform2f(p.size, N as f32, N as f32);
                gl::Uniform4f(p.tangents, -1.0, 1.0, 1.0, -1.0);
                gl::UniformMatrix3fv(p.rot, 1, gl::FALSE, rot.as_ptr());
                gl::Uniform3f(p.eye_pos, 0.0, 0.0, 0.0);
                gl::Uniform1i(p.mode, 2);
                gl::Uniform1f(p.hfov, std::f32::consts::PI);
                gl::Uniform1i(p.stereo, 1);
                gl::Uniform1i(p.side, 1);
                gl::Uniform1f(p.pixel, 2.0 / N as f32);
                gl::Uniform1i(p.keying, 0);
                gl::Uniform1i(p.mask, 1);
                gl::Uniform1i(p.censor, 2);
                gl::Uniform1i(p.censor_mode, if censor { 2 } else { 0 });
                gl::Uniform1f(p.censor_level, 1.0);
                gl::Uniform1i(p.censor_whole, 1);
                gl::Uniform1i(p.pass_room, 0);
                gl::Uniform3f(p.reticle, 0.0, 0.0, 0.0);
                gl::Viewport(0, 0, N, N);
                stage.bind(&Pose::IDENTITY);
                stage.eye(&Pose::IDENTITY, &Pose::IDENTITY);
                gl::BindFramebuffer(gl::FRAMEBUFFER, eye);
                gl::DrawArrays(gl::TRIANGLES, 0, 3);
                stage.done();
                gl::ReadPixels(0, 0, N, N, gl::RGBA, gl::UNSIGNED_BYTE, px.as_mut_ptr().cast());
                gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            }
            assert_eq!(take_gl_error(), None);
            px
        };
        for (down, censor) in [(false, false), (true, false), (false, true), (true, true)] {
            let (a, b) = (draw(&alone, &mut stage, down, censor), draw(&larger, &mut stage, down, censor));
            let worst = a.iter().zip(&b).map(|(x, y)| x.abs_diff(*y)).max().unwrap();
            assert!(worst <= 2, "down {down}, censored {censor}: a texel differs by {worst}");
            assert!(a.chunks(4).any(|p| p[0] > 40 || p[1] > 40 || p[2] > 40), "down {down}, censored {censor}: no picture");
        }
    }
}