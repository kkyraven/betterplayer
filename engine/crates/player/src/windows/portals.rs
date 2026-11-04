use std::ffi::CString;
use std::io::Write as _;
use std::time::{Duration, Instant};

use bp_vr::{Offset, Pose, Scene, eye_view};

use crate::frame_log;
use crate::gl_context::Gpu;
use crate::portals::{self as p, DIVE_SLOT, DIVE_TEXELS, DiveKind, FrameState, ItemKind, MAX_PORTALS, SHELF_TEXELS, StillInfo};
use crate::render::take_gl_error;
use crate::vr::VrView;

const DECLS: &str = "// The VR library's portals (windows/portals.rs). Seat frame: -z forward.
const vec3 P_ACCENT = vec3(183.0, 163.0, 255.0) / 255.0;
const vec3 P_BLANK = vec3(0.012, 0.014, 0.02);
const vec3 P_DARK = vec3(3.0, 4.0, 5.0) / 255.0;
const float P_RING_GAP = 0.005;
const float P_RING_W = 0.0045;
const float P_RING_FLASH = 0.002;
const float P_AP_RING_GAP = 0.0036;
const float P_AP_RING_W = 0.0047;
uniform int pOn;
uniform int pCount;
// Per portal: (az, el, d, hr), (half w, half h, corner, s), (half field (radians), bowl depth (half
// widths), layer, kind 0 blank 1 still 2 poster), (half h, half v of its still, op, shade), (ring, flash,
// rim, 0), (u max, v max, texel u, texel v: its picture within its layer).
uniform vec4 pA[16];
uniform vec4 pB[16];
uniform vec4 pC[16];
uniform vec4 pD[16];
uniform vec4 pE[16];
uniform vec4 pF[16];
uniform mat3 portalRot;
uniform vec3 portalEye;
uniform float pCull;
uniform float pDim;
uniform int pDebug;
uniform highp sampler2DArray pStills;
uniform sampler2D pDive;
// The dive: 0 none, 1 the window (vr, back), 2 the flat tile.
uniform int dKind;
uniform vec4 dAp;
uniform vec4 dAp2;
uniform vec4 dMix;
// The window's picture (portals.ts diveAngles): scale, bowl, k, the window's aspect; its half field and
// bowl depth as a portal's, live outside the window.
uniform vec4 dFit;
uniform vec4 dFit2;
uniform vec2 dOld;
uniform int dStill;
uniform vec4 dStillA;
uniform vec4 dStillB;
uniform mat3 dTileRot;
uniform vec3 dTilePos;
uniform vec4 dTileA;
uniform vec4 dTileB;
float pWrap(float x) {
  return atan(sin(x), cos(x));
}
float pBox(vec2 q, vec2 b, float r) {
  vec2 d = abs(q) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
// `pc` at `pa` over the colour `c` showing `a` of the way over the room, straight alpha.
void pOver(inout vec3 c, inout float a, vec3 pc, float pa) {
  float na = pa + a * (1.0 - pa);
  if (na > 0.0) c = (pc * pa + c * a * (1.0 - pa)) / na;
  a = na;
}
// A seat-frame vector in the frame of a window at (yaw, pitch): right, up, into it (portals.ts windowRay).
vec3 pWindowRay(vec3 v, float yaw, float pitch) {
  float f1 = v.x * sin(yaw) - v.z * cos(yaw);
  return vec3(v.x * cos(yaw) + v.z * sin(yaw), v.y * cos(pitch) - f1 * sin(pitch), v.y * sin(pitch) + f1 * cos(pitch));
}
vec3 pFromWindow(vec3 w, float yaw, float pitch) {
  float f1 = w.z * cos(pitch) - w.y * sin(pitch);
  return vec3(w.x * cos(yaw) + f1 * sin(yaw), w.y * cos(pitch) + w.z * sin(pitch), w.x * sin(yaw) - f1 * cos(yaw));
}
vec2 pWindowAngles(vec3 w) {
  return vec2(atan(w.x, w.z), asin(clamp(w.y, -1.0, 1.0)));
}
// The fitted picture in its bowl (portals.ts bowlAngles): the video's (az, el) and the shade where the eye's ray `lv`
// through the window at `p` half widths meets an ellipsoid through the corners of a window `aspect` tall, `depth` deep.
vec3 pBowl(vec2 p, vec3 lv, float aspect, float fh, float depth) {
  vec3 ax = vec3(1.42, 1.42 * aspect, max(depth, 1e-3));
  vec3 q0 = vec3(p, 0.0) / ax;
  vec3 d = lv / ax;
  float qa = dot(d, d), qb = dot(q0, d), qc = dot(q0, q0) - 1.0;
  float t = (-qb + sqrt(max(qb * qb - qa * qc, 0.0))) / qa;
  vec3 q = vec3(p, 0.0) + lv * t;
  return vec3(q.xy * fh, mix(0.5, 1.0, smoothstep(0.15, 0.9, normalize(q / (ax * ax)).z)));
}
// A shelf layer at `st` (0 to 1 across its picture), half a texel inside the picture.
vec3 pShelf(vec2 st, float layer, vec4 f, float lod) {
  vec2 t = clamp(st * f.xy, 0.5 * f.zw, f.xy - 0.5 * f.zw);
  return textureLod(pStills, vec3(t, layer), lod).rgb;
}
void portalStage(vec2 uv, inout vec3 c, inout float a, vec3 back) {
  if (pOn == 0) return;
  vec3 rd = normalize(portalRot * vec3(mix(tangents.x, tangents.y, uv.x), mix(tangents.w, tangents.z, uv.y), 1.0));
  vec3 o = vec3(portalEye.xy, -portalEye.z);
  vec3 v = vec3(rd.xy, -rd.z);
  vec3 c0 = c;
  float a0 = a;
  // The video behind dims while the library shows (never the room: it is the streamer's key), and an
  // old file fades to the room while a dive into another opens.
  c *= pDim;
  a *= dOld.x;
  if (dKind == 1) {
    float b = dot(o, v);
    float cc = dot(o, o) - dAp2.w * dAp2.w;
    vec3 dd = normalize(o + v * (-b + sqrt(max(b * b - cc, 0.0))));
    float ca = cos(dAp.x), sa = sin(dAp.x), ce = cos(dAp.y), se = sin(dAp.y);
    float x1 = dd.x * ca + dd.z * sa;
    float f1 = dd.x * sa - dd.z * ca;
    float y2 = dd.y * ce - f1 * se;
    float f2 = dd.y * se + f1 * ce;
    vec2 q = vec2(atan(x1, f2), atan(y2, length(vec2(x1, f2))));
    float e = pBox(q, dAp.zw, dAp2.x);
    float aa = fwidth(e);
    float fe = max(dAp2.y, aa);
    float inside = 1.0 - smoothstep(-fe, fe, e);
    // The world: the still from its fitted picture in the bowl to the video at its real place as the window grows
    // (diveAngles), into live.
    vec3 w = pWindowRay(v, dAp.x, dAp.y);
    vec2 fa = pWindowAngles(w) * dFit.x;
    vec3 u = pFromWindow(vec3(cos(fa.y) * sin(fa.x), sin(fa.y), cos(fa.y) * cos(fa.x)), dAp.x, dAp.y);
    vec2 ang = pWindowAngles(pWindowRay(u, dAp.x * (1.0 - dFit.z), dAp.y * (1.0 - dFit.z)));
    float shade = 1.0;
    if (dFit.y > 0.0) {
      vec3 b = pBowl(vec2(q.x / dAp.z, q.y / dAp.w * dFit.w), w, dFit.w, dFit2.x, dFit2.y);
      ang = mix(ang, b.xy, dFit.y);
      shade = mix(1.0, b.z, dFit.y);
    }
    vec2 st = vec2(0.5 + ang.x / (2.0 * dStillA.x), 0.5 - ang.y / (2.0 * dStillA.y));
    vec2 sdx = dFdx(st) * dStillB.xy, sdy = dFdy(st) * dStillB.xy;
    vec3 still = P_DARK;
    if (dStill != 0 && abs(ang.x) <= dStillA.x && abs(ang.y) <= dStillA.y) {
      vec2 t = clamp(st * dStillB.xy, 0.5 * dStillB.zw, dStillB.xy - 0.5 * dStillB.zw);
      still = (dStill == 1 ? textureGrad(pDive, t, sdx, sdy).rgb : textureGrad(pStills, vec3(t, dStillA.z), sdx, sdy).rgb) * shade;
    }
    // Outside the window a same dive and B show the video behind.
    float live = mix(dFit2.z, dMix.w, inside);
    float wa = (1.0 - live) + a0 * live;
    vec3 wc = wa > 0.0 ? (still * (1.0 - live) + c0 * a0 * live) / wa : still;
    wc *= mix(dMix.y, dMix.x, inside);
    wc += smoothstep(-0.003, 0.0, e) * (1.0 - smoothstep(-aa, aa, e)) * dAp2.z;
    float ring = smoothstep(P_AP_RING_GAP - aa, P_AP_RING_GAP + aa, e) * (1.0 - smoothstep(P_AP_RING_GAP + P_AP_RING_W - aa, P_AP_RING_GAP + P_AP_RING_W + aa, e)) * dOld.y;
    wc = mix(wc, mix(P_ACCENT, vec3(1.0), 0.6), ring);
    float wA = max(mix(dMix.z, 1.0, inside) * wa, ring);
    if (pDebug == 1) {
      float line = 1.0 - smoothstep(aa, 3.0 * aa, abs(e));
      wc = mix(wc, vec3(1.0, 0.0, 1.0), line);
      wA = max(wA, line);
    }
    pOver(c, a, wc, wA);
  } else if (dKind == 2) {
    // The flat tile: a cylinder bent round its own axis (`dTileA.z` across), tipped to face the eye.
    vec3 lo = dTileRot * (o - dTilePos);
    vec3 lv = dTileRot * v;
    float rb = dTileA.z;
    vec2 p0 = vec2(lo.x, lo.z - rb);
    float qa = max(dot(lv.xz, lv.xz), 1e-6);
    float qb = dot(p0, lv.xz);
    float qc = dot(p0, p0) - rb * rb;
    float s = (-qb + sqrt(max(qb * qb - qa * qc, 0.0))) / qa;
    vec3 h = lo + lv * s;
    vec2 q = vec2(rb * atan(h.x, rb - h.z), h.y);
    float e = pBox(q, dTileA.xy * 0.5, dTileA.w);
    float aa = fwidth(e);
    float inside = 1.0 - smoothstep(-aa, aa, e);
    vec2 tuv = vec2(0.5 + q.x / dTileA.x, 0.5 - q.y / dTileA.y);
    vec2 tdx = dFdx(tuv), tdy = dFdy(tuv);
    float aspect = dTileA.x / dTileA.y;
    // The poster is 16:9 and the picture its own aspect, each cropped to the tile.
    vec2 pk = vec2(aspect / (16.0 / 9.0), 1.0);
    vec2 vk = vec2(aspect / dTileB.w, 1.0);
    vec3 col = P_BLANK;
    if (dStill == 2) {
      vec2 t = clamp((0.5 + (tuv - 0.5) * pk) * dStillB.xy, 0.5 * dStillB.zw, dStillB.xy - 0.5 * dStillB.zw);
      col = textureGrad(pStills, vec3(t, dStillA.z), tdx * pk * dStillB.xy, tdy * pk * dStillB.xy).rgb;
    }
    if (dTileB.z > 0.0) {
      // The raw video, so covered here as main() covers it (`c0` already is).
      vec2 tt = 0.5 + (tuv - 0.5) * vk;
      vec3 lv = sampleAt(tt, tdx * vk, tdy * vk);
      if (censorMode != 0) {
        float m = censored(tt);
        if (m > 0.0) lv = mix(lv, hidden(tt), m);
      }
      col = mix(col, lv, dTileB.z);
    }
    col += smoothstep(-0.004, 0.0, e) * inside * dTileB.x;
    float th = P_RING_W + dTileB.y * P_RING_FLASH;
    float ring = smoothstep(P_RING_GAP - aa, P_RING_GAP + aa, e) * (1.0 - smoothstep(P_RING_GAP + th - aa, P_RING_GAP + th + aa, e)) * dTileB.y;
    col = mix(col, mix(P_ACCENT, vec3(1.0), dTileB.y * 0.6), ring);
    if (pDebug == 1) col = vec3(0.0, 1.0, 0.0);
    pOver(c, a, col, max(inside, ring));
  }
  // Portals, farthest first. Non-uniform flow: explicit LODs and analytic edges, no derivatives.
  float rayAz = atan(v.x, -v.z);
  float rayEl = atan(v.y, length(v.xz));
  for (int i = 0; i < 16; i++) {
    if (i >= pCount) break;
    vec4 A = pA[i];
    vec4 B = pB[i];
    if (abs(pWrap(rayAz - A.x)) > B.x * B.w / A.w + pCull || abs(rayEl - A.y) > B.y * B.w / A.z + pCull) continue;
    float b = dot(o, v);
    float disc = b * b - (dot(o, o) - A.z * A.z);
    if (disc < 0.0) continue;
    float t = -b + sqrt(disc);
    vec3 P = o + v * t;
    float x = pWrap(atan(P.x, -P.z) - A.x) * A.w / B.w;
    float y = (atan(P.y, length(P.xz)) - A.y) * A.z / B.w;
    vec4 E = pE[i];
    // One eye pixel at the hit, in the portal's unscaled metres.
    float aa = pixel * t / B.w;
    float th = P_RING_W + E.y * P_RING_FLASH;
    float e = pBox(vec2(x, y), B.xy, B.z);
    if (e > P_RING_GAP + th + aa) continue;
    float inside = 1.0 - smoothstep(-aa, aa, e);
    vec4 C = pC[i];
    vec4 D = pD[i];
    vec4 F = pF[i];
    int kind = int(C.w + 0.5);
    vec3 col = P_BLANK;
    if (kind == 1) {
      // The fitted picture in its bowl, mipmapped by its scale: C.x radians across half the window.
      vec3 pic = pBowl(vec2(x, y) / B.x, pWindowRay(v, A.x, A.y), B.y / B.x, C.x, C.y);
      col = P_DARK;
      if (abs(pic.x) <= D.x && abs(pic.y) <= D.y) {
        vec2 st = vec2(0.5 + pic.x / (2.0 * D.x), 0.5 - pic.y / (2.0 * D.y));
        col = pShelf(st, C.z, F, log2(max(aa * C.x / B.x * F.x / (2.0 * D.x * F.z), 1e-6))) * pic.z;
      }
    } else if (kind == 2) {
      float crop = (B.x / B.y) / (16.0 / 9.0);
      vec2 st = vec2(0.5 + x / (2.0 * B.x) * crop, 0.5 - y / (2.0 * B.y));
      col = pShelf(st, C.z, F, log2(max(aa * crop * F.x / (2.0 * B.x * F.z), 1e-6)));
    }
    col += smoothstep(-0.004, 0.0, e) * inside * E.z;
    col *= D.w;
    float ring = smoothstep(P_RING_GAP - aa, P_RING_GAP + aa, e) * (1.0 - smoothstep(P_RING_GAP + th - aa, P_RING_GAP + th + aa, e)) * max(E.x, E.y);
    col = mix(col, mix(P_ACCENT, vec3(1.0), E.y * 0.6), ring);
    float alpha = max(inside, ring) * D.z;
    if (pDebug == 1) {
      col = vec3(0.0, 1.0, 0.0);
      alpha = inside * D.z;
    }
    pOver(c, a, col, alpha);
  }
}
";

const MAIN: &str = "portalStage(uv, c, a, back);";

pub(super) fn fragment(base: &str) -> String {
    base.replacen("// @portals:decls", DECLS, 1).replacen("// @portals:main", MAIN, 1)
}

const UNIT_STILLS: u32 = 3;
const UNIT_DIVE: u32 = 4;
const SHELF_LEVELS: i32 = 11;
const DIVE_LEVELS: i32 = 12;

struct Stills {
    array: u32,
    dive: u32,
    gpu: Gpu,
}

impl Stills {
    fn new(gpu: Gpu) -> Result<Stills, String> {
        if let Some(e) = take_gl_error() {
            eprintln!("bp-player: GL error 0x{e:x} before the portal stills");
        }
        let mut s = Stills { array: 0, dive: 0, gpu };
        unsafe {
            gl::GenTextures(1, &mut s.array);
            gl::BindTexture(gl::TEXTURE_2D_ARRAY, s.array);
            gl::TexStorage3D(gl::TEXTURE_2D_ARRAY, SHELF_LEVELS, gl::RGBA8, SHELF_TEXELS as i32, SHELF_TEXELS as i32, (MAX_PORTALS) as i32);
            filters(gl::TEXTURE_2D_ARRAY);
            gl::BindTexture(gl::TEXTURE_2D_ARRAY, 0);
            gl::GenTextures(1, &mut s.dive);
            gl::BindTexture(gl::TEXTURE_2D, s.dive);
            gl::TexStorage2D(gl::TEXTURE_2D, DIVE_LEVELS, gl::RGBA8, DIVE_TEXELS as i32, DIVE_TEXELS as i32);
            filters(gl::TEXTURE_2D);
            gl::BindTexture(gl::TEXTURE_2D, 0);
        }
        s.touch();
        match take_gl_error() {
            Some(e) => Err(format!("portal stills: GL error 0x{e:x}")),
            None => Ok(s),
        }
    }

    fn touch(&self) {
        let texel = [0u8; 4];
        unsafe {
            gl::BindBuffer(gl::PIXEL_UNPACK_BUFFER, 0);
            gl::PixelStorei(gl::UNPACK_ALIGNMENT, 4);
            gl::BindTexture(gl::TEXTURE_2D_ARRAY, self.array);
            gl::TexSubImage3D(gl::TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 1, gl::RGBA, gl::UNSIGNED_BYTE, texel.as_ptr().cast());
            gl::GenerateMipmap(gl::TEXTURE_2D_ARRAY);
            gl::BindTexture(gl::TEXTURE_2D_ARRAY, 0);
            gl::BindTexture(gl::TEXTURE_2D, self.dive);
            gl::TexSubImage2D(gl::TEXTURE_2D, 0, 0, 0, 1, 1, gl::RGBA, gl::UNSIGNED_BYTE, texel.as_ptr().cast());
            gl::GenerateMipmap(gl::TEXTURE_2D);
            gl::BindTexture(gl::TEXTURE_2D, 0);
            gl::Finish();
        }
    }

    fn upload(&self, u: &p::Upload) -> Result<(), String> {
        unsafe {
            gl::BindBuffer(gl::PIXEL_UNPACK_BUFFER, 0);
            for (name, value) in [(gl::UNPACK_ALIGNMENT, 4), (gl::UNPACK_ROW_LENGTH, 0), (gl::UNPACK_SKIP_ROWS, 0), (gl::UNPACK_SKIP_PIXELS, 0), (gl::UNPACK_IMAGE_HEIGHT, 0), (gl::UNPACK_SKIP_IMAGES, 0)] {
                gl::PixelStorei(name, value);
            }
            let (w, h, px) = (u.info.width as i32, u.info.height as i32, u.rgba.as_ptr().cast());
            if u.slot == DIVE_SLOT {
                gl::ActiveTexture(gl::TEXTURE0 + UNIT_DIVE);
                gl::BindTexture(gl::TEXTURE_2D, self.dive);
                gl::TexSubImage2D(gl::TEXTURE_2D, 0, 0, 0, w, h, gl::RGBA, gl::UNSIGNED_BYTE, px);
                gl::GenerateMipmap(gl::TEXTURE_2D);
            } else {
                gl::ActiveTexture(gl::TEXTURE0 + UNIT_STILLS);
                gl::BindTexture(gl::TEXTURE_2D_ARRAY, self.array);
                gl::TexSubImage3D(gl::TEXTURE_2D_ARRAY, 0, 0, 0, u.slot as i32, w, h, 1, gl::RGBA, gl::UNSIGNED_BYTE, px);
                let timed = p::measuring().then(|| {
                    gl::Finish();
                    std::time::Instant::now()
                });
                gl::GenerateMipmap(gl::TEXTURE_2D_ARRAY);
                if let Some(t0) = timed {
                    gl::Finish();
                    p::mipped_in(t0.elapsed().as_secs_f64() * 1000.0);
                }
            }
            gl::ActiveTexture(gl::TEXTURE0);
        }
        match take_gl_error() {
            Some(e) => Err(format!("portal still in slot {}: GL error 0x{e:x}", u.slot)),
            None => Ok(()),
        }
    }
}

impl Drop for Stills {
    fn drop(&mut self) {
        let _gpu = self.gpu.section();
        unsafe {
            gl::DeleteTextures(1, &self.array);
            gl::DeleteTextures(1, &self.dive);
        }
    }
}

unsafe fn filters(target: u32) {
    unsafe {
        gl::TexParameteri(target, gl::TEXTURE_MIN_FILTER, gl::LINEAR_MIPMAP_LINEAR as i32);
        gl::TexParameteri(target, gl::TEXTURE_MAG_FILTER, gl::LINEAR as i32);
        gl::TexParameteri(target, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE as i32);
        gl::TexParameteri(target, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE as i32);
    }
}

pub(super) struct PortalUniforms {
    pub on: i32,
    pub count: i32,
    pub a: i32,
    pub b: i32,
    pub c: i32,
    pub d: i32,
    pub e: i32,
    pub f: i32,
    pub rot: i32,
    pub eye: i32,
    pub cull: i32,
    pub dim: i32,
    pub debug: i32,
    pub stills: i32,
    pub dive: i32,
    pub d_kind: i32,
    pub d_ap: i32,
    pub d_ap2: i32,
    pub d_mix: i32,
    pub d_fit: i32,
    pub d_fit2: i32,
    pub d_old: i32,
    pub d_still: i32,
    pub d_still_a: i32,
    pub d_still_b: i32,
    pub d_tile_rot: i32,
    pub d_tile_pos: i32,
    pub d_tile_a: i32,
    pub d_tile_b: i32,
}

impl PortalUniforms {
    pub fn of(program: u32) -> PortalUniforms {
        let at = |name: &str| {
            let n = CString::new(name).unwrap();
            unsafe { gl::GetUniformLocation(program, n.as_ptr()) }
        };
        PortalUniforms {
            on: at("pOn"),
            count: at("pCount"),
            a: at("pA"),
            b: at("pB"),
            c: at("pC"),
            d: at("pD"),
            e: at("pE"),
            f: at("pF"),
            rot: at("portalRot"),
            eye: at("portalEye"),
            cull: at("pCull"),
            dim: at("pDim"),
            debug: at("pDebug"),
            stills: at("pStills"),
            dive: at("pDive"),
            d_kind: at("dKind"),
            d_ap: at("dAp"),
            d_ap2: at("dAp2"),
            d_mix: at("dMix"),
            d_fit: at("dFit"),
            d_fit2: at("dFit2"),
            d_old: at("dOld"),
            d_still: at("dStill"),
            d_still_a: at("dStillA"),
            d_still_b: at("dStillB"),
            d_tile_rot: at("dTileRot"),
            d_tile_pos: at("dTilePos"),
            d_tile_a: at("dTileA"),
            d_tile_b: at("dTileB"),
        }
    }

    #[cfg(test)]
    pub fn all(&self) -> [(&'static str, i32); 29] {
        [
            ("pOn", self.on),
            ("pCount", self.count),
            ("pA", self.a),
            ("pB", self.b),
            ("pC", self.c),
            ("pD", self.d),
            ("pE", self.e),
            ("pF", self.f),
            ("portalRot", self.rot),
            ("portalEye", self.eye),
            ("pCull", self.cull),
            ("pDim", self.dim),
            ("pDebug", self.debug),
            ("pStills", self.stills),
            ("pDive", self.dive),
            ("dKind", self.d_kind),
            ("dAp", self.d_ap),
            ("dAp2", self.d_ap2),
            ("dMix", self.d_mix),
            ("dFit", self.d_fit),
            ("dFit2", self.d_fit2),
            ("dOld", self.d_old),
            ("dStill", self.d_still),
            ("dStillA", self.d_still_a),
            ("dStillB", self.d_still_b),
            ("dTileRot", self.d_tile_rot),
            ("dTilePos", self.d_tile_pos),
            ("dTileA", self.d_tile_a),
            ("dTileB", self.d_tile_b),
        ]
    }
}

pub(crate) struct Stage {
    stills: Option<Stills>,
    u: PortalUniforms,
    slots: [Option<StillInfo>; 17],
    pending: Vec<p::Upload>,
    frame: FrameState,
    mirror: Option<MirrorWorker>,
    lock_ms: f64,
    submit_ms: f64,
    upload: (f64, u32),
    last_woke: Option<Instant>,
}

impl Stage {
    pub fn new(gpu: Gpu, program: u32) -> Stage {
        let stills = Stills::new(gpu).inspect_err(|e| eprintln!("bp-player: the portals are not drawn: {e}")).ok();
        frame_log::session();
        Stage { stills, u: PortalUniforms::of(program), slots: Default::default(), pending: Vec::new(), frame: FrameState::default(), mirror: None, lock_ms: 0.0, submit_ms: 0.0, upload: (0.0, 0), last_woke: None }
    }

    pub fn locked(&mut self, asked: Instant) {
        self.lock_ms = asked.elapsed().as_secs_f64() * 1000.0;
    }

    pub fn submitted(&mut self, began: Instant) {
        self.submit_ms = began.elapsed().as_secs_f64() * 1000.0;
    }

    pub fn log_frame(&mut self, scene: &mut Scene, called: Instant, woke: Instant) {
        let gap = self.last_woke.replace(woke).map_or(0.0, |w| woke.duration_since(w).as_secs_f64() * 1000.0);
        let (lock_ms, submit_ms, (upload_ms, upload_kib)) = (std::mem::take(&mut self.lock_ms), std::mem::take(&mut self.submit_ms), std::mem::take(&mut self.upload));
        if !frame_log::on() {
            return;
        }
        let now = p::now_ms();
        let cpu_ms = woke.elapsed().as_secs_f64() * 1000.0;
        let wait_ms = woke.duration_since(called).as_secs_f64() * 1000.0;
        frame_log::drawn(frame_log::Drawn { at_ms: now - cpu_ms, cpu_ms, lock_ms, upload_ms, upload_kib, gap_ms: gap, wait_ms, submit_ms });
        let timings = scene.frame_timings(12);
        let shown: Vec<frame_log::Shown> = timings
            .iter()
            .map(|t| frame_log::Shown {
                index: t.index,
                at_ms: t.system_s * 1000.0,
                presents: t.presents,
                mispresented: t.mispresented,
                dropped: t.dropped,
                reprojection: t.reprojection,
                gpu_ms: t.gpu_ms,
                post_gpu_ms: t.post_gpu_ms,
                interval_ms: t.interval_ms,
                ready_ms: t.ready_ms,
                compositor_ms: t.compositor_gpu_ms,
            })
            .collect();
        let t = scene.frame_totals();
        frame_log::shown(&shown, p::now_ms(), frame_log::Totals { presents: t.presents, dropped: t.dropped, reprojected: t.reprojected, timed_out: t.timed_out, submits: t.submits });
    }

    pub fn take(&mut self) -> p::Taken {
        p::take()
    }

    pub fn hold_view(&mut self, view: VrView) -> bool {
        p::hold_view(view)
    }

    pub fn bind(&mut self, head: &Pose) {
        p::set_head(head);
        let (drops, uploads) = p::take_uploads();
        for slot in drops {
            self.slots[slot as usize] = None;
            self.pending.retain(|u| u.slot != slot);
        }
        for u in uploads {
            self.pending.retain(|q| q.slot != u.slot);
            self.pending.push(u);
        }
        if let Some(prefix) = p::take_mirror() {
            mirror_later(&mut self.mirror, prefix);
        }
        let u = &self.u;
        unsafe {
            gl::Uniform1i(u.stills, UNIT_STILLS as i32);
            gl::Uniform1i(u.dive, UNIT_DIVE as i32);
        }
        let Some(stills) = &self.stills else {
            unsafe { gl::Uniform1i(u.on, 0) };
            return;
        };
        if let Some(i) = self.pending.iter().position(|q| q.slot == DIVE_SLOT).or((!self.pending.is_empty()).then_some(0)) {
            let up = self.pending.remove(i);
            let timed = p::measuring().then(|| {
                unsafe { gl::Finish() };
                std::time::Instant::now()
            });
            let began = Instant::now();
            let done = stills.upload(&up);
            self.upload = (began.elapsed().as_secs_f64() * 1000.0, (up.rgba.len() / 1024) as u32);
            if let Some(t0) = timed {
                unsafe { gl::Finish() };
                p::uploaded_in(t0.elapsed().as_secs_f64() * 1000.0);
            }
            match done {
                Ok(()) => self.slots[up.slot as usize] = Some(up.info),
                Err(e) => eprintln!("bp-player: {e}"),
            }
        }
        self.frame = p::frame(p::now_ms());
        let f = &self.frame;
        unsafe {
            gl::Uniform1i(u.on, f.on as i32);
            if !f.on {
                return;
            }
            gl::ActiveTexture(gl::TEXTURE0 + UNIT_STILLS);
            gl::BindTexture(gl::TEXTURE_2D_ARRAY, stills.array);
            gl::BindSampler(UNIT_STILLS, 0);
            gl::ActiveTexture(gl::TEXTURE0 + UNIT_DIVE);
            gl::BindTexture(gl::TEXTURE_2D, stills.dive);
            gl::BindSampler(UNIT_DIVE, 0);
            gl::ActiveTexture(gl::TEXTURE0);
            gl::Uniform1f(u.dim, f.dim as f32);
            gl::Uniform1i(u.debug, f.debug as i32);
        }
        self.items();
        self.dive();
    }

    fn items(&self) {
        let mut arrays = [[[0f32; 4]; MAX_PORTALS]; 6];
        let n = self.frame.items.len().min(MAX_PORTALS);
        for (i, it) in self.frame.items.iter().take(n).enumerate() {
            let (kind, info) = self.shows(it.kind, it.slot);
            let (half_h, half_v) = info.map_or((0.0, 0.0), |s| (s.half_h_deg.to_radians(), s.half_v_deg.to_radians()));
            let rim = if it.kind == ItemKind::Still { p::aperture::RIM_VR } else { p::aperture::RIM_FLAT };
            let q = &it.pose;
            let hover = p::window_hover(q.s, &it.size);
            arrays[0][i] = [q.az, q.el, q.d, q.hr].map(|v| v as f32);
            arrays[1][i] = [it.size.w / 2.0, it.size.h / 2.0, it.size.corner, q.s].map(|v| v as f32);
            arrays[2][i] = [p::half_field(hover), p::bowl_depth(hover), it.slot.unwrap_or(0) as f64, kind as f64].map(|v| v as f32);
            arrays[3][i] = [half_h, half_v, it.op, it.shade].map(|v| v as f32);
            arrays[4][i] = [it.ring, it.flash, rim, 0.0].map(|v| v as f32);
            arrays[5][i] = picture(info, SHELF_TEXELS);
        }
        let u = &self.u;
        unsafe {
            gl::Uniform1i(u.count, n as i32);
            for (loc, a) in [u.a, u.b, u.c, u.d, u.e, u.f].into_iter().zip(&arrays) {
                gl::Uniform4fv(loc, MAX_PORTALS as i32, a.as_ptr().cast());
            }
        }
    }

    fn shows(&self, kind: ItemKind, slot: Option<u32>) -> (u32, Option<&StillInfo>) {
        let info = slot.and_then(|s| self.slots.get(s as usize)?.as_ref());
        match (kind, info) {
            (ItemKind::Still | ItemKind::Poster, Some(i)) => (if i.equirect { 1 } else { 2 }, Some(i)),
            _ => (0, None),
        }
    }

    fn dive(&self) {
        let u = &self.u;
        let Some(d) = &self.frame.dive else {
            unsafe {
                gl::Uniform1i(u.d_kind, 0);
                gl::Uniform2f(u.d_old, 1.0, 0.0);
            }
            return;
        };
        let f = &d.frame;
        let dive_still = self.slots[DIVE_SLOT as usize].as_ref().filter(|s| s.equirect && s.key.as_deref().is_none_or(|k| k == d.key));
        let shelf = d.slot.and_then(|s| self.slots.get(s as usize)?.as_ref().map(|i| (s, i)));
        let (still, layer, info, texels) = match (d.kind, dive_still, shelf) {
            (DiveKind::Flat | DiveKind::FlatBack, _, Some((s, i))) => (2, s, Some(i), SHELF_TEXELS),
            (DiveKind::Flat | DiveKind::FlatBack, _, None) => (0, 0, None, SHELF_TEXELS),
            (_, Some(i), _) => (1, 0, Some(i), DIVE_TEXELS),
            (_, None, Some((s, i))) if i.equirect => (2, s, Some(i), SHELF_TEXELS),
            _ => (0, 0, None, SHELF_TEXELS),
        };
        let half = info.map_or([1.0, 1.0], |i| [i.half_h_deg.to_radians().max(1e-3), i.half_v_deg.to_radians().max(1e-3)]);
        unsafe {
            gl::Uniform2f(u.d_old, d.old as f32, d.ring_flash as f32);
            gl::Uniform1i(u.d_still, still);
            gl::Uniform4f(u.d_still_a, half[0] as f32, half[1] as f32, layer as f32, 0.0);
            let [a, b, c, e] = picture(info, texels);
            gl::Uniform4f(u.d_still_b, a, b, c, e);
            if let Some(ap) = f.aperture {
                gl::Uniform1i(u.d_kind, 1);
                gl::Uniform4f(u.d_ap, ap.az as f32, ap.el as f32, ap.hw as f32, ap.hh as f32);
                gl::Uniform4f(u.d_ap2, ap.rr as f32, ap.feather as f32, ap.rim as f32, ap.rp as f32);
                gl::Uniform4f(u.d_mix, f.in_b as f32, f.out_b as f32, f.out_a as f32, f.live as f32);
                gl::Uniform4f(u.d_fit, ap.scale as f32, ap.bowl as f32, ap.k as f32, (d.size.h / d.size.w) as f32);
                gl::Uniform4f(u.d_fit2, p::half_field(ap.hover) as f32, p::bowl_depth(ap.hover) as f32, f.out_live as f32, 0.0);
            } else if let Some(t) = f.tile {
                let (rot, pos) = tile_frame(t.a, t.y, t.r, t.tilt);
                gl::Uniform1i(u.d_kind, 2);
                gl::UniformMatrix3fv(u.d_tile_rot, 1, gl::FALSE, rot.as_ptr());
                gl::Uniform3f(u.d_tile_pos, pos[0], pos[1], pos[2]);
                gl::Uniform4f(u.d_tile_a, t.w as f32, t.h as f32, (1.0 / t.bend.max(1e-3)) as f32, t.rad as f32);
                gl::Uniform4f(u.d_tile_b, d.tile_rim as f32, f.flash as f32, f.live as f32, d.aspect as f32);
            } else {
                gl::Uniform1i(u.d_kind, 0);
            }
        }
    }

    pub fn eye(&self, head: &Pose, eye_to_head: &Pose) {
        if !self.frame.on || self.stills.is_none() {
            return;
        }
        let v = eye_view(&self.frame.seat, &Offset::default(), head, eye_to_head);
        let e = self.frame.eye.map(|c| c as f32);
        let at = [v.position[0] + e[0], v.position[1] + e[1], v.position[2] - e[2]];
        let off = (at[0] * at[0] + at[1] * at[1] + at[2] * at[2]).sqrt();
        unsafe {
            gl::UniformMatrix3fv(self.u.rot, 1, gl::FALSE, v.rotation.as_ptr());
            gl::Uniform3f(self.u.eye, at[0], at[1], at[2]);
            gl::Uniform1f(self.u.cull, (off / 1.2).min(1.0).asin() + 0.03);
        }
    }

    pub fn done(&self) {
        if !self.frame.on {
            return;
        }
        unsafe {
            gl::ActiveTexture(gl::TEXTURE0 + UNIT_DIVE);
            gl::BindTexture(gl::TEXTURE_2D, 0);
            gl::ActiveTexture(gl::TEXTURE0 + UNIT_STILLS);
            gl::BindTexture(gl::TEXTURE_2D_ARRAY, 0);
            gl::ActiveTexture(gl::TEXTURE0);
        }
    }
}

fn picture(info: Option<&StillInfo>, texels: u32) -> [f32; 4] {
    let n = texels as f32;
    info.map_or([1.0, 1.0, 1.0 / n, 1.0 / n], |i| [i.width as f32 / n, i.height as f32 / n, 1.0 / n, 1.0 / n])
}

fn tile_frame(a: f64, y: f64, r: f64, tilt: f64) -> ([f32; 9], [f32; 3]) {
    let az = a.to_radians();
    let to_world = Pose::yaw(-az as f32).then(&Pose::pitch(tilt as f32)).0;
    let mut m = [0f32; 9];
    for c in 0..3 {
        for r in 0..3 {
            m[c * 3 + r] = to_world[c][r];
        }
    }
    ([m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]], [(r * az.sin()) as f32, y as f32, (-r * az.cos()) as f32])
}

struct MirrorWorker {
    tx: Option<std::sync::mpsc::Sender<String>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for MirrorWorker {
    fn drop(&mut self) {
        self.tx = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn mirror_later(worker: &mut Option<MirrorWorker>, prefix: String) {
    if let Some(tx) = worker.as_ref().and_then(|w| w.tx.as_ref())
        && tx.send(prefix.clone()).is_ok()
    {
        return;
    }
    *worker = None;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let spawned = std::thread::Builder::new().name("bp-vr-mirror".into()).spawn(move || {
        let mirror = match Mirror::open() {
            Ok(m) => m,
            Err(e) => return eprintln!("bp-player: mirror: {e}"),
        };
        std::thread::sleep(Duration::from_millis(250));
        for prefix in rx {
            std::thread::sleep(Duration::from_millis(40));
            for (eye, side) in [(0, "left"), (1, "right")] {
                let path = format!("{prefix}-{side}.bmp");
                let read = mirror.read(eye);
                if let (0, Ok((.., at))) = (eye, &read) {
                    let s = p::status(*at);
                    let _ = std::fs::write(format!("{prefix}-at.txt"), format!("{at:.1} {} {:.1}
", s.phase, s.elapsed_ms));
                }
                match read.and_then(|(w, h, bgra, _)| write_bmp(&path, w, h, &bgra)) {
                    Ok(()) => eprintln!("bp-player: wrote {path}"),
                    Err(e) => eprintln!("bp-player: mirror {path}: {e}"),
                }
            }
        }
    });
    match spawned {
        Ok(thread) => {
            let _ = tx.send(prefix);
            *worker = Some(MirrorWorker { tx: Some(tx), thread: Some(thread) });
        }
        Err(e) => eprintln!("bp-player: mirror: {e}"),
    }
}

struct Mirror {
    device: windows::Win32::Graphics::Direct3D11::ID3D11Device,
    context: windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
    views: [*mut std::ffi::c_void; 2],
}

impl Mirror {
    fn open() -> Result<Mirror, String> {
        use windows::Win32::Foundation::HMODULE;
        use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
        use windows::Win32::Graphics::Direct3D11::{D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11CreateDevice};
        use windows::core::Interface;
        let (mut device, mut context) = (None, None);
        unsafe { D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context)) }
            .map_err(|e| e.to_string())?;
        let (device, context) = (device.ok_or("no device")?, context.ok_or("no context")?);
        let left = unsafe { bp_vr::mirror(0, device.as_raw())? };
        let right = match unsafe { bp_vr::mirror(1, device.as_raw()) } {
            Ok(v) => v,
            Err(e) => {
                unsafe { bp_vr::release_mirror(left) };
                return Err(e);
            }
        };
        Ok(Mirror { device, context, views: [left, right] })
    }

    fn read(&self, eye: usize) -> Result<(u32, u32, Vec<u8>, f64), String> {
        use windows::Win32::Graphics::Direct3D11::{D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, ID3D11ShaderResourceView, ID3D11Texture2D};
        use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_TYPELESS, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_B8G8R8A8_UNORM_SRGB};
        use windows::core::Interface;
        let (device, context) = (&self.device, &self.context);
        unsafe {
            let srv = ID3D11ShaderResourceView::from_raw_borrowed(&self.views[eye]).ok_or("no mirror view")?;
            let texture: ID3D11Texture2D = srv.GetResource().and_then(|r| r.cast()).map_err(|e| e.to_string())?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut desc);
            let bgra = matches!(desc.Format, DXGI_FORMAT_B8G8R8A8_TYPELESS | DXGI_FORMAT_B8G8R8A8_UNORM | DXGI_FORMAT_B8G8R8A8_UNORM_SRGB);
            let staging_desc = D3D11_TEXTURE2D_DESC { MipLevels: 1, ArraySize: 1, Usage: D3D11_USAGE_STAGING, BindFlags: 0, CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32, MiscFlags: 0, ..desc };
            let staging = || -> Result<ID3D11Texture2D, String> {
                let mut t = None;
                device.CreateTexture2D(&staging_desc, None, Some(&mut t)).map_err(|e| e.to_string())?;
                t.ok_or_else(|| "no staging texture".to_string())
            };
            let (a, b) = (staging()?, staging()?);
            let (w, h) = (desc.Width, desc.Height);
            let rows = |t: &ID3D11Texture2D| -> Result<Vec<u8>, String> {
                let mut mapped = Default::default();
                context.Map(t, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(|e| e.to_string())?;
                let mut out = Vec::with_capacity((w * h * 4) as usize);
                for y in 0..h as usize {
                    out.extend_from_slice(std::slice::from_raw_parts((mapped.pData as *const u8).add(y * mapped.RowPitch as usize), w as usize * 4));
                }
                context.Unmap(t, 0);
                Ok(out)
            };
            let mut px = Vec::new();
            let mut at = p::now_ms();
            for attempt in 0..10 {
                at = p::now_ms();
                context.CopySubresourceRegion(&a, 0, 0, 0, 0, &texture, 0, None);
                context.CopySubresourceRegion(&b, 0, 0, 0, 0, &texture, 0, None);
                px = rows(&a)?;
                if px == rows(&b)? {
                    break;
                }
                if attempt == 9 {
                    eprintln!("bp-player: mirror eye {eye} may be torn (no two matching copies)");
                }
                std::thread::sleep(Duration::from_millis(3));
            }
            for p in px.chunks_exact_mut(4) {
                let [x, y, z, _] = [p[0], p[1], p[2], p[3]];
                p.copy_from_slice(&if bgra { [x, y, z, 255] } else { [z, y, x, 255] });
            }
            Ok((w, h, px, at))
        }
    }
}

impl Drop for Mirror {
    fn drop(&mut self) {
        for view in self.views {
            unsafe { bp_vr::release_mirror(view) };
        }
    }
}

fn write_bmp(path: &str, w: u32, h: u32, bgra: &[u8]) -> Result<(), String> {
    let stride = (w * 3).div_ceil(4) * 4;
    let size = 54 + stride * h;
    let mut out = Vec::with_capacity(size as usize);
    out.extend_from_slice(b"BM");
    for v in [size, 0, 54, 40] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&(w as i32).to_le_bytes());
    out.extend_from_slice(&(h as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    for v in [0u32, stride * h, 2835, 2835, 0, 0] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for y in (0..h as usize).rev() {
        let row = &bgra[y * w as usize * 4..(y + 1) * w as usize * 4];
        for px in row.chunks_exact(4) {
            out.extend_from_slice(&px[..3]);
        }
        out.resize(out.len() + (stride - w * 3) as usize, 0);
    }
    std::fs::File::create(path).and_then(|mut f| f.write_all(&out)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portals_fragment_replaces_each_marker_once_and_nothing_else() {
        let base = "a\n// @portals:decls\nvoid main() {\n  b;\n  // @portals:main\n  // dither\n}\n";
        let out = fragment(base);
        assert_eq!(out.matches("void portalStage(").count(), 1);
        assert_eq!(out.matches(MAIN).count(), 1);
        assert!(!out.contains("@portals"));
        assert_eq!(out.replacen(DECLS, "// @portals:decls", 1).replacen(MAIN, "// @portals:main", 1), base);
        let frag = super::super::vr::fragment_source();
        assert_eq!(frag.matches("// @portals:decls").count(), 1);
        assert_eq!(frag.matches("// @portals:main").count(), 1);
        assert!(frag.find("// @portals:decls").unwrap() < frag.find("void main()").unwrap());
        assert!(frag.find("// @portals:main").unwrap() > frag.find("reticle.z > 0.5").unwrap());
    }

    #[test]
    fn portals_the_tile_frame_brings_its_centre_to_the_origin_facing_the_seat() {
        let (m, pos) = tile_frame(20.0, 0.3, 1.4, 0.3f64.atan2(1.4));
        let apply = |v: [f32; 3]| [0, 1, 2].map(|r| m[r] * v[0] + m[3 + r] * v[1] + m[6 + r] * v[2]);
        let back = [-pos[0], -pos[1], -pos[2]];
        let n = (back.iter().map(|c| c * c).sum::<f32>()).sqrt();
        let local = apply(back.map(|c| c / n));
        assert!(local[0].abs() < 1e-5 && local[1].abs() < 1e-5 && (local[2] - 1.0).abs() < 1e-5, "{local:?}");
    }

    #[test]
    #[ignore = "requires ANGLE: libEGL.dll and libGLESv2.dll on the path"]
    fn portals_the_stage_draws_where_the_maths_puts_it() {
        use crate::gl_context::GlContext;
        use crate::portals::{Dive, Keyframe, PORTAL, PortalItem, PortalScene, ROWS_BAND, Upload, band_layout, band_texel, set_for_test};
        const N: i32 = 256;
        let gl_context = GlContext::new().unwrap();
        gl::load_with(|name| gl_context.get_proc_address(&CString::new(name).unwrap()) as *const _);
        let gpu = gl_context.gpu();
        let _gpu = gpu.section();
        let vertex = "#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}";
        let (program, vao, fbo, tex) = unsafe {
            let vs = super::super::vr::compile(gl::VERTEX_SHADER, vertex).unwrap();
            let fs = super::super::vr::compile(gl::FRAGMENT_SHADER, &fragment(super::super::vr::fragment_source())).unwrap();
            let id = gl::CreateProgram();
            gl::AttachShader(id, vs);
            gl::AttachShader(id, fs);
            gl::LinkProgram(id);
            let mut ok = 0;
            gl::GetProgramiv(id, gl::LINK_STATUS, &mut ok);
            assert_ne!(ok, 0, "link");
            let (mut vao, mut fbo, mut tex) = (0, 0, 0);
            gl::GenVertexArrays(1, &mut vao);
            gl::GenTextures(1, &mut tex);
            gl::BindTexture(gl::TEXTURE_2D, tex);
            gl::TexStorage2D(gl::TEXTURE_2D, 1, gl::RGBA8, N, N);
            gl::GenFramebuffers(1, &mut fbo);
            gl::BindFramebuffer(gl::FRAMEBUFFER, fbo);
            gl::FramebufferTexture2D(gl::FRAMEBUFFER, gl::COLOR_ATTACHMENT0, gl::TEXTURE_2D, tex, 0);
            (id, vao, fbo, tex)
        };
        let at = |name: &str| unsafe { gl::GetUniformLocation(program, CString::new(name).unwrap().as_ptr()) };
        let mut stage = Stage::new(gpu, program);
        let draw = |stage: &mut Stage| -> Vec<u8> {
            unsafe {
                gl::UseProgram(program);
                gl::BindVertexArray(vao);
                gl::Uniform2f(at("size"), N as f32, N as f32);
                gl::Uniform4f(at("tangents"), -1.0, 1.0, 1.0, -1.0);
                gl::UniformMatrix3fv(at("rot"), 1, gl::FALSE, [1.0f32, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0].as_ptr());
                gl::Uniform1f(at("pixel"), 2.0 / N as f32);
                gl::Uniform1i(at("video"), 0);
                gl::Uniform1i(at("mask"), 1);
                gl::Uniform1i(at("censor"), 2);
                gl::Viewport(0, 0, N, N);
                stage.bind(&Pose::IDENTITY);
                stage.eye(&Pose::IDENTITY, &Pose::IDENTITY);
                gl::BindFramebuffer(gl::FRAMEBUFFER, fbo);
                gl::DrawArrays(gl::TRIANGLES, 0, 3);
                stage.done();
                let mut px = vec![0u8; (N * N * 4) as usize];
                gl::ReadPixels(0, 0, N, N, gl::RGBA, gl::UNSIGNED_BYTE, px.as_mut_ptr().cast());
                assert_eq!(take_gl_error(), None);
                px
            }
        };
        let pixel = |px: &[u8], az: f64, el: f64| -> [u8; 3] {
            let col = ((az.to_radians().tan() + 1.0) / 2.0 * N as f64) as usize;
            let row = ((el.to_radians().tan() / az.to_radians().cos() + 1.0) / 2.0 * N as f64) as usize;
            let i = (row * N as usize + col) * 4;
            [px[i], px[i + 1], px[i + 2]]
        };
        let l = band_layout(&ROWS_BAND);
        let (x, y) = band_texel(&ROWS_BAND, 0.0, 2.5);
        assert!((x - l.width as f64 / 2.0).abs() < 1e-9);
        let item = PortalItem {
            key: "top-1".into(),
            x,
            y,
            size: PORTAL,
            row: 0,
            kind: ItemKind::Still,
            slot: Some(0),
            lift: Keyframe::still(0.0),
            shade: Keyframe::still(1.0),
            enter: Keyframe::still(1.0),
            dz: 0.0,
            op: 1.0,
        };
        let scene_item = item.clone();
        let scene = PortalScene {
            rev: 1,
            seat: Default::default(),
            bands: Vec::new(),
            items: vec![item],
            scroll: vec![Keyframe::still(0.0); 3],
            shown: Keyframe::still(1.0),
            fade: Keyframe::still(1.0),
            dim: 0.32,
        };
        let scene_copy = scene.clone();
        let red = |w: u32, h: u32| [230u8, 20, 20, 255].repeat((w * h) as usize);
        let still = |key: Option<&str>| StillInfo { equirect: true, half_h_deg: 36.0, half_v_deg: 27.0, width: 64, height: 48, key: key.map(Into::into) };
        set_for_test(Some(scene.clone()), None, true, vec![Upload { slot: 0, rgba: red(64, 48), info: still(None) }], None);
        let px = draw(&mut stage);
        let green = |c: [u8; 3]| c[1] > 200 && c[0] < 40 && c[2] < 40;
        assert!(green(pixel(&px, 0.0, 2.5)), "centre {:?}", pixel(&px, 0.0, 2.5));
        assert!(green(pixel(&px, 6.0, 2.5)), "inside the right edge {:?}", pixel(&px, 6.0, 2.5));
        assert!(!green(pixel(&px, 8.0, 2.5)), "past the right edge {:?}", pixel(&px, 8.0, 2.5));
        assert!(green(pixel(&px, 0.0, -1.5)), "inside the bottom edge {:?}", pixel(&px, 0.0, -1.5));
        assert!(!green(pixel(&px, 0.0, -3.0)), "past the bottom edge {:?}", pixel(&px, 0.0, -3.0));
        set_for_test(Some(scene.clone()), None, true, Vec::new(), Some([0.2, 0.0, 0.0]));
        let px = draw(&mut stage);
        assert!(green(pixel(&px, -7.6, 2.5)), "moved left {:?}", pixel(&px, -7.6, 2.5));
        assert!(!green(pixel(&px, 2.0, 2.5)), "no longer straight ahead {:?}", pixel(&px, 2.0, 2.5));
        let quadrants: Vec<u8> = (0..48u32)
            .flat_map(|r| (0..64u32).map(move |c| match (r < 24, c < 32) {
                (true, true) => [230u8, 20, 20, 255],
                (true, false) => [20, 20, 230, 255],
                (false, true) => [20, 230, 20, 255],
                (false, false) => [230, 230, 230, 255],
            }))
            .flatten()
            .collect();
        let whole = StillInfo { half_h_deg: 90.0, half_v_deg: 90.0, ..still(None) };
        set_for_test(Some(scene.clone()), None, false, vec![Upload { slot: 0, rgba: quadrants, info: whole }], None);
        let px = draw(&mut stage);
        let reddish = |c: [u8; 3]| c[0] > 180 && c[1] < 60 && c[2] < 60;
        assert!(reddish(pixel(&px, -3.0, 6.0)), "top-left {:?}", pixel(&px, -3.0, 6.0));
        let blue = pixel(&px, 3.0, 6.0);
        assert!(blue[2] > 180 && blue[0] < 60, "top-right {blue:?}");
        let low = pixel(&px, -3.0, -1.0);
        assert!(low[1] > 180 && low[0] < 60, "bottom-left {low:?}");
        assert!(pixel(&px, 20.0, 2.5).iter().all(|&v| v < 20), "the room {:?}", pixel(&px, 20.0, 2.5));
        let dive = Dive { kind: DiveKind::Vr, key: "top-1".into(), start_ms: p::now_ms() - 900.0, slide_ms: 0.0, same: false, full: 180, screen_deg: 50.0, aspect: 16.0 / 9.0 };
        let mut wide = still(Some("top-1"));
        (wide.half_h_deg, wide.half_v_deg) = (30.0, 20.0);
        set_for_test(Some(scene), Some((dive, None)), false, vec![Upload { slot: DIVE_SLOT, rgba: red(64, 48), info: wide }], None);
        let px = draw(&mut stage);
        assert!(reddish(pixel(&px, 20.0, -10.0)), "the dive still {:?}", pixel(&px, 20.0, -10.0));
        assert!(!reddish(pixel(&px, 40.0, 0.0)), "past the dive still {:?}", pixel(&px, 40.0, 0.0));
        let (fx, fy) = band_texel(&ROWS_BAND, 20.0, -13.7);
        let flat_scene = PortalScene { items: vec![PortalItem { key: "bottom-1".into(), x: fx, y: fy, kind: ItemKind::Poster, ..scene_item.clone() }], ..scene_copy.clone() };
        let flat = Dive { kind: DiveKind::Flat, key: "bottom-1".into(), start_ms: p::now_ms() - 293.0, slide_ms: 0.0, same: false, full: 180, screen_deg: 50.0, aspect: 16.0 / 9.0 };
        set_for_test(Some(flat_scene.clone()), Some((flat, None)), true, Vec::new(), None);
        let px = draw(&mut stage);
        eprintln!("flat tile: ahead {:?} left30 {:?} left40 {:?} right20 {:?}", pixel(&px, 0.0, 0.0), pixel(&px, -30.0, 0.0), pixel(&px, -40.0, 0.0), pixel(&px, 20.0, 0.0));
        assert!(green(pixel(&px, 0.0, 0.0)), "the tile ahead {:?}", pixel(&px, 0.0, 0.0));
        assert!(!green(pixel(&px, -40.0, 0.0)), "nothing far left {:?}", pixel(&px, -40.0, 0.0));
        let video = unsafe {
            let stripes: Vec<u8> = (0..64u32).flat_map(|_| (0..64u32).flat_map(|x| if (x + 1) / 2 % 2 == 0 { [230u8, 20, 20, 255] } else { [20, 20, 230, 255] })).collect();
            let mut v = 0;
            gl::GenTextures(1, &mut v);
            gl::ActiveTexture(gl::TEXTURE0);
            gl::BindTexture(gl::TEXTURE_2D, v);
            gl::TexStorage2D(gl::TEXTURE_2D, 7, gl::RGBA8, 64, 64);
            gl::TexSubImage2D(gl::TEXTURE_2D, 0, 0, 0, 64, 64, gl::RGBA, gl::UNSIGNED_BYTE, stripes.as_ptr().cast());
            gl::GenerateMipmap(gl::TEXTURE_2D);
            filters(gl::TEXTURE_2D);
            v
        };
        let crossfading = |stage: &mut Stage, censor: i32| -> [u8; 3] {
            unsafe {
                gl::UseProgram(program);
                gl::Uniform1i(at("censorMode"), censor);
                gl::Uniform1f(at("censorLevel"), 1.0);
                gl::Uniform1i(at("censorWhole"), 1);
            }
            let start = p::now_ms() - 800.0;
            let flat = Dive { kind: DiveKind::Flat, key: "bottom-1".into(), start_ms: start, slide_ms: 0.0, same: false, full: 180, screen_deg: 50.0, aspect: 1.0 };
            set_for_test(Some(flat_scene.clone()), Some((flat, Some(start + 100.0))), false, Vec::new(), None);
            pixel(&draw(stage), 0.0, 0.0)
        };
        let raw = crossfading(&mut stage, 0);
        assert!(reddish(raw), "the live tile {raw:?}");
        let covered = crossfading(&mut stage, 2);
        assert!(covered[0] > 60 && covered[2] > 60, "the live tile under Beta Censoring {covered:?}");
        unsafe { gl::DeleteTextures(1, &video) };
        set_for_test(None, None, false, Vec::new(), None);
        unsafe {
            gl::DeleteFramebuffers(1, &fbo);
            gl::DeleteTextures(1, &tex);
            gl::DeleteVertexArrays(1, &vao);
            gl::DeleteProgram(program);
        }
    }

    #[test]
    fn portals_a_bmp_has_its_size_and_padded_rows() {
        let path = std::env::temp_dir().join("bp-portals-test.bmp");
        let path = path.to_str().unwrap();
        write_bmp(path, 3, 2, &[10u8; 3 * 2 * 4]).unwrap();
        let bytes = std::fs::read(path).unwrap();
        let _ = std::fs::remove_file(path);
        assert_eq!(&bytes[..2], b"BM");
        assert_eq!(bytes.len(), 54 + 12 * 2);
        assert_eq!(u32::from_le_bytes(bytes[18..22].try_into().unwrap()), 3);
    }
}
