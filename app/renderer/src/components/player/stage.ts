import {
  KEY_FILL,
  KEY_FILL_FAR_FROM,
  KEY_FILL_FAR_TO,
  KEY_FILL_NEAR_FROM,
  KEY_FILL_NEAR_TO,
  KEY_GREY_FROM,
  KEY_GREY_TO,
  KEY_SOFT_FROM,
  KEY_SOFT_TO,
  KEY_SPILL,
  eyeRect,
  type FeatherKind,
} from '@shared/passthrough'
import { flatEye, lensDegrees, type Projection } from '@shared/projection'
import * as client from '@/engine/client'
import { side } from '@/engine/side'
import { on } from '@/ipc'
import { toRgb } from '@/lib/rgb'
import { MAX_BOXES, censorMask, type CensorMask } from '@/state/censor'
import * as live from '@/state/live'
import { useCompare } from '@/state/compare'
import { usePlayer } from '@/state/player'
import { needsFrames, useTracking } from '@/state/tracking'
import { useVr } from '@/state/vr'

const TRACK_MIN_INTERVAL_MS = 1000 / 30
const CENSOR_WAIT_MS = 100
const CENSOR_CATCH_UP_MS = 34
const RESIZE_SETTLE_MS = 120
const MATTE_POLL_MS = 250

export type StageKeying =
  | { kind: 'colour'; key: number; feather: FeatherKind; featherPx: number }
  | { kind: 'mask'; featherPx: number }

function sameKeying(a: StageKeying | null, b: StageKeying | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'mask' || b.kind === 'mask') return a.kind === b.kind && a.featherPx === b.featherPx
  return a.key === b.key && a.feather === b.feather && a.featherPx === b.featherPx
}

const glf = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n))

function tracksFrames(): boolean {
  const tracking = useTracking.getState()
  return tracking.source !== 'browser' && ((tracking.source === 'player' && needsFrames(tracking)) || client.engine.wantsFrames())
}

const VS = `#version 300 es
out vec2 uv;
void main() {
  uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`

const FS = `#version 300 es
precision highp float;
const float PI = 3.141592653589793;
const int MAX_BOXES = ${MAX_BOXES};
uniform sampler2D tex;
uniform sampler2D tex2;
uniform sampler2D skin;
uniform int skinOn;
uniform int split;
uniform int bgra;
uniform int mode;
uniform float hfov;
uniform int eyes;
uniform int eye;
uniform vec2 outSize;
uniform vec2 eyeSize;
uniform vec3 look;
uniform int maskMode;
uniform float maskLevel;
uniform int boxCount;
uniform vec4 boxes[MAX_BOXES];
// 1 keys keyColour out, 2 keys by the AI mask (matte); 0 keys nothing.
uniform int keying;
uniform vec3 keyColour;
// 0 Edges, 1 Colour distance.
uniform int feather;
uniform float featherPx;
// Source pixels across the eye shown, and that eye's rectangle in 0 to 1 of the whole frame.
uniform vec2 eyeSrc;
uniform vec4 eyeRect;
uniform sampler2D matte;
in vec2 uv;
out vec4 o;
// Alpha this near 0 or 1 draws as 0 or 1: under half a step of 8 bits.
const float NEAR = 0.5 / 255.0;
// KEY_* in app/shared/passthrough.ts.
const float SOFT_FROM = ${glf(KEY_SOFT_FROM)};
const float SOFT_TO = ${glf(KEY_SOFT_TO)};
const float GREY_FROM = ${glf(KEY_GREY_FROM)};
const float GREY_TO = ${glf(KEY_GREY_TO)};
const float SPILL = ${glf(KEY_SPILL)};
const float FILL = ${glf(KEY_FILL)};
const float FILL_NEAR_FROM = ${glf(KEY_FILL_NEAR_FROM)};
const float FILL_NEAR_TO = ${glf(KEY_FILL_NEAR_TO)};
const float FILL_FAR_FROM = ${glf(KEY_FILL_FAR_FROM)};
const float FILL_FAR_TO = ${glf(KEY_FILL_FAR_TO)};
float masked(vec2 t) {
  float feather = maskMode == 1 ? 0.015 : 0.0;
  float m = skinOn == 1 ? smoothstep(0.35, 0.65, texture(skin, t).r) : 0.0;
  for (int i = 0; i < MAX_BOXES; i++) {
    if (i >= boxCount) break;
    vec4 b = boxes[i];
    vec2 d = min(t - b.xy, b.xy + b.zw - t);
    float inside = min(d.x, d.y);
    m = max(m, feather > 0.0 ? smoothstep(-feather, feather, inside) : step(0.0, inside));
  }
  return m;
}
vec4 hidden(sampler2D s, vec2 t) {
  if (maskMode == 2) {
    float across = mix(64.0, 14.0, maskLevel);
    vec2 grid = vec2(across, across * outSize.y / outSize.x);
    return textureLod(s, (floor(t * grid) + 0.5) / grid, log2(outSize.x / across));
  }
  float lod = log2(outSize.x / mix(160.0, 24.0, maskLevel));
  vec2 px = exp2(lod) / outSize;
  vec4 sum = textureLod(s, t, lod) * 2.0
    + textureLod(s, t + vec2(px.x, 0.0), lod) + textureLod(s, t - vec2(px.x, 0.0), lod)
    + textureLod(s, t + vec2(0.0, px.y), lod) + textureLod(s, t - vec2(0.0, px.y), lod);
  return sum / 6.0;
}
vec4 rgba(vec4 c) {
  return bgra == 1 ? c.bgra : c;
}
vec2 eyeOf(vec2 t) {
  if (eyes == 1) t.x = t.x * 0.5 + float(eye) * 0.5;
  else if (eyes == 2) t.y = t.y * 0.5 + float(eye) * 0.5;
  return t;
}
// The eye's share of the texture: all of it when frames hold only the eye shown.
vec2 share() {
  return eyes == 1 ? vec2(0.5, 1.0) : eyes == 2 ? vec2(1.0, 0.5) : vec2(1.0);
}
// The picture at t in the eye, kept inside it, at mip level lod.
vec3 at(sampler2D s, vec2 t, float lod) {
  return rgba(textureLod(s, eyeOf(clamp(t, 0.0, 1.0)), lod)).rgb;
}
// BT.601 full range, as ycbcr in passthrough.ts.
vec3 ycc(vec3 c) {
  return vec3(dot(c, vec3(0.299, 0.587, 0.114)), 0.5 + dot(c, vec3(-0.168736, -0.331264, 0.5)), 0.5 + dot(c, vec3(0.5, -0.418688, -0.081312)));
}
// BT.601 full range back to RGB.
vec3 rgb(vec3 y) {
  return y.x + vec3(1.402 * (y.z - 0.5), -0.344136 * (y.y - 0.5) - 0.714136 * (y.z - 0.5), 1.772 * (y.y - 0.5));
}
// How much of colour c shows over key, 0 to 1. A saturated key fades by chroma distance, whole
// at SOFT_TO of the key's own chroma; a black, white or grey key by the largest channel difference.
float shows(vec3 c, vec3 key) {
  vec2 k = ycc(key).yz;
  float sat = distance(k, vec2(0.5));
  float chroma = clamp((distance(ycc(c).yz, k) - SOFT_FROM) / max(SOFT_TO * sat - SOFT_FROM, 0.001), 0.0, 1.0);
  vec3 d = abs(c - key);
  float grey = clamp((max(d.r, max(d.g, d.b)) - GREY_FROM) / (GREY_TO - GREY_FROM), 0.0, 1.0);
  return mix(grey, chroma, smoothstep(0.05, 0.15, sat));
}
// Colour c as the picture's own where a of it shows: the key's share taken out, then the key's
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
// How much c, a mip level's mean, hits the picture over a black, white or grey key.
float hits(vec3 c, float from, float to) {
  vec3 d = abs(c - keyColour);
  return smoothstep(from, to, max(d.r, max(d.g, d.b)));
}
// How much the picture encloses t, for a black, white or grey key: of 8 rays FILL of the eye's
// width long, the least by the more its 2 taps hit the picture. As enclosed in vr.rs.
float enclosed(sampler2D s, vec2 t) {
  vec2 eyePx = vec2(textureSize(s, 0)) * share();
  vec2 reach = FILL * eyePx.x / eyePx;
  float lod = log2(FILL * eyePx.x / 4.0);
  vec3 d = abs(at(s, t, lod + 3.0) - keyColour);
  if (max(d.r, max(d.g, d.b)) < GREY_FROM) return 0.0;
  float least = 1.0;
  for (int i = 0; i < 8 && least > 0.0; i++) {
    float a = float(i / 2) * PI * 0.25 + float(i % 2) * PI;
    vec2 ray = reach * vec2(cos(a), sin(a));
    float most = hits(at(s, t + ray * 0.375, lod), FILL_NEAR_FROM, FILL_NEAR_TO);
    if (most < 1.0) most = max(most, hits(at(s, t + ray * 0.875, lod), FILL_FAR_FROM, FILL_FAR_TO));
    least = min(least, most);
  }
  return least;
}
// How much of the picture shows at t, whose colour is c; own is how much c alone shows. Edges
// takes the lesser of that and its taps' mean; Colour distance shows whole where every tap shows,
// hides where none do, and follows the colour between. As keyAlpha in vr.rs.
float keyAlpha(sampler2D s, vec2 t, vec3 c, out float own) {
  own = shows(c, keyColour);
  float k = own;
  if (featherPx > 0.0 && (feather == 1 || own > NEAR)) {
    vec2 r = featherPx / eyeSrc;
    float v = shows(at(s, t + r * vec2(1.0, 0.0), 0.0), keyColour);
    float sum = own + v;
    float least = v;
    float most = v;
    bool settled = feather == 1 && (v >= 0.5 ? own >= 1.0 - NEAR : own <= NEAR);
    if (!settled) {
      for (int i = 1; i < 8; i++) {
        float a = float(i) * PI * 0.25;
        v = shows(at(s, t + r * vec2(cos(a), sin(a)), 0.0), keyColour);
        sum += v;
        least = min(least, v);
        most = max(most, v);
      }
    }
    k = feather == 0 ? min(own, sum / 9.0) : settled ? own : least > 0.5 ? 1.0 : most < 0.5 ? 0.0 : own;
  }
  float grey = 1.0 - smoothstep(0.05, 0.15, length(ycc(keyColour).yz - 0.5));
  if (grey > 0.0 && k < 1.0) k = max(k, grey * enclosed(s, t));
  return k;
}
// The AI mask at t in the eye, half a cell inside the eye's cells so the other eye's never blend in.
float matteAt(vec2 t) {
  vec2 inset = 0.5 / vec2(textureSize(matte, 0));
  vec2 f = eyeRect.xy + clamp(t, 0.0, 1.0) * eyeRect.zw;
  return texture(matte, clamp(f, eyeRect.xy + inset, eyeRect.xy + eyeRect.zw - inset)).r;
}
// The AI mask softened by the same taps as Edges, as maskAlpha in vr.rs.
float matteAlpha(vec2 t) {
  float sum = matteAt(t);
  if (featherPx > 0.0) {
    vec2 r = featherPx / eyeSrc;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * PI * 0.25;
      sum += matteAt(t + r * vec2(cos(a), sin(a)));
    }
    sum /= 9.0;
  }
  return smoothstep(0.35, 0.65, sum);
}
// The picture at t in the eye: keyed, censored, then over black by how much of it shows.
vec3 pickFrom(sampler2D s, vec2 t) {
  vec2 tt = eyeOf(t);
  vec3 c = rgba(texture(s, tt)).rgb;
  float a = 1.0;
  if (keying == 1) {
    float own;
    a = keyAlpha(s, t, c, own);
    // Unmixed by the larger, so a filled hole keeps its own colour and an eroded edge loses none.
    c = unkeyed(c, keyColour, max(own, a));
  } else if (keying == 2) {
    a = matteAlpha(t);
  }
  if (maskMode != 0 && (boxCount > 0 || skinOn == 1)) {
    float m = masked(tt);
    if (m > 0.0) c = mix(c, rgba(hidden(s, tt)).rgb, m);
  }
  return c * a;
}
vec4 pick(vec2 t) {
  return vec4(split == 1 && uv.x >= 0.5 ? pickFrom(tex2, t) : pickFrom(tex, t), 1.0);
}
void main() {
  float outA = outSize.x / outSize.y;
  if (mode == 0) {
    float vidA = eyeSize.x / eyeSize.y;
    vec2 t = vec2(uv.x, 1.0 - uv.y) - 0.5;
    float s = vidA / outA;
    if (s > 1.005) t.y *= s; else if (s < 0.995) t.x /= s;
    t += 0.5;
    if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
    o = pick(t);
    return;
  }
  float tanV = tan(look.z * 0.5);
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 d = normalize(vec3(ndc.x * tanV * outA, ndc.y * tanV, 1.0));
  float cp = cos(look.y), sp = sin(look.y);
  d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
  float cy = cos(look.x), sy = sin(look.x);
  d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
  vec2 t;
  if (mode == 1) {
    float lon = atan(d.x, d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    if (abs(lon) > hfov * 0.5) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
    t = vec2(0.5 + lon / hfov, 0.5 - lat / PI);
  } else {
    float theta = acos(clamp(d.z, -1.0, 1.0));
    if (theta > hfov * 0.5) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float r = theta / (hfov * 0.5) * 0.5;
    float phi = atan(d.y, d.x);
    t = vec2(0.5 + r * cos(phi), 0.5 - r * sin(phi));
  }
  o = pick(t);
}`

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)
  if (!s) throw new Error('createShader failed')
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error')
  return s
}

interface Look {
  yaw: number
  pitch: number
  fov: number
}

const DEFAULT_LOOK: Look = { yaw: 0, pitch: 0, fov: (90 * Math.PI) / 180 }

class Stage {
  readonly canvas = document.createElement('canvas')
  private readonly gl: WebGL2RenderingContext
  private uniforms!: Record<'mode' | 'hfov' | 'eyes' | 'eye' | 'outSize' | 'eyeSize' | 'look' | 'maskMode' | 'maskLevel' | 'boxCount' | 'boxes' | 'split' | 'skinOn' | 'keying' | 'keyColour' | 'feather' | 'featherPx' | 'eyeSrc' | 'eyeRect', WebGLUniformLocation | null>
  private lost = false
  private tex: WebGLTexture | null = null
  private tex2: WebGLTexture | null = null
  private split = false
  private texW = 0
  private texH = 0
  private texHalf: client.Half | null = null
  private whole = false
  private look: Look = { ...DEFAULT_LOOK }
  private drag: { x: number; y: number } | null = null
  private dirty = true
  private hasFrame = false
  private frameSource: { path: string | null; seekGeneration: number; timeMs: number } | null = null
  private slot: HTMLElement | null = null
  private shown = true
  private headset = useVr.getState().active
  private presenting = true
  private projection: Projection
  private fitted = { w: 0, h: 0 }
  private resizeTimer = 0
  private resizeRetryAt = 0
  private lastTrack = 0
  private maskOn = false
  private maskVersion = -1
  private skinTex: WebGLTexture | null = null
  private skinData: CensorMask['skin'] = null
  private pending: { serial: number; first: number; since: number } | null = null
  private mips = false
  private mips2 = false
  private keying: StageKeying | null = stageKeying
  private matteTex: WebGLTexture | null = null
  private matteIndex = -1
  private matteAskedAt = 0

  constructor() {
    const { canvas } = this
    canvas.className = 'video-canvas'
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' })
    if (!gl) throw new Error('WebGL2 unavailable')
    this.gl = gl
    this.initGl()
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lost = true
    })
    canvas.addEventListener('webglcontextrestored', () => {
      this.matteTex = null
      this.matteIndex = -1
      this.initGl()
      this.tex = null
      this.tex2 = null
      this.texW = 0
      this.texH = 0
      this.hasFrame = false
      this.maskVersion = -1
      this.skinTex = null
      this.skinData = null
      this.lost = false
      this.ensureTexture()
      this.dirty = true
    })

    this.projection = usePlayer.getState().projection
    this.applyProjection(this.projection)
    usePlayer.subscribe((s) => {
      if (s.projection !== this.projection) this.setProjection(s.projection)
      if ((s.path === null || s.audio !== null) && this.hasFrame) this.clear()
    })
    useCompare.subscribe((s) => {
      if (s.on !== this.split) this.setSplit(s.on)
    })

    new ResizeObserver(() => {
      window.clearTimeout(this.resizeTimer)
      this.resizeTimer = window.setTimeout(() => this.layout(), RESIZE_SETTLE_MS)
    }).observe(canvas)

    on('window:shown', (shown) => {
      this.shown = shown
      this.updatePresenting()
    })
    useVr.subscribe((s) => {
      if (s.active === this.headset) return
      this.headset = s.active
      this.updatePresenting()
    })

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: true })

    this.ensureTexture()
    requestAnimationFrame(this.frame)
  }

  private initGl() {
    const { gl } = this
    const prog = gl.createProgram()
    if (!prog) throw new Error('createProgram failed')
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS))
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(prog)
    gl.useProgram(prog)
    const u = (name: string) => gl.getUniformLocation(prog, name)
    gl.uniform1i(u('tex'), 0)
    gl.uniform1i(u('tex2'), 1)
    gl.uniform1i(u('skin'), 2)
    gl.uniform1i(u('matte'), 3)
    gl.uniform1i(u('bgra'), client.engine.bgra() ? 1 : 0)
    gl.uniform1i(u('split'), this.split ? 1 : 0)
    this.uniforms = { mode: u('mode'), hfov: u('hfov'), eyes: u('eyes'), eye: u('eye'), outSize: u('outSize'), eyeSize: u('eyeSize'), look: u('look'), maskMode: u('maskMode'), maskLevel: u('maskLevel'), boxCount: u('boxCount'), boxes: u('boxes'), split: u('split'), skinOn: u('skinOn'), keying: u('keying'), keyColour: u('keyColour'), feather: u('feather'), featherPx: u('featherPx'), eyeSrc: u('eyeSrc'), eyeRect: u('eyeRect') }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    this.applyKeying()
  }

  setKeying(k: StageKeying | null) {
    if (sameKeying(k, this.keying)) return
    const mipped = this.mipped
    this.keying = k
    if (k?.kind !== 'mask') this.matteIndex = -1
    if (this.mipped !== mipped) {
      this.setFilters()
      this.mips = false
      this.mips2 = false
    }
    this.applyKeying()
    this.dirty = true
  }

  private applyKeying() {
    const { gl, uniforms: u, keying: k } = this
    gl.uniform1i(u.keying, k?.kind === 'colour' ? 1 : k?.kind === 'mask' && this.matteIndex >= 0 ? 2 : 0)
    gl.uniform1f(u.featherPx, k?.featherPx ?? 0)
    if (k?.kind !== 'colour') return
    gl.uniform3f(u.keyColour, ((k.key >> 16) & 0xff) / 255, ((k.key >> 8) & 0xff) / 255, (k.key & 0xff) / 255)
    gl.uniform1i(u.feather, k.feather === 'distance' ? 1 : 0)
  }

  private readMatte(now: number): boolean {
    this.matteAskedAt = now
    const grid = typeof client.engine.matteGrid === 'function' ? client.engine.matteGrid() : null
    if (!grid || grid.cover.length < grid.w * grid.h) {
      if (this.matteIndex < 0) return false
      this.matteIndex = -1
      this.applyKeying()
      return true
    }
    if (grid.index === this.matteIndex) return false
    const { gl } = this
    gl.activeTexture(gl.TEXTURE3)
    if (!this.matteTex) {
      this.matteTex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this.matteTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.matteTex)
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, grid.w, grid.h, 0, gl.RED, gl.UNSIGNED_BYTE, grid.cover)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.activeTexture(gl.TEXTURE0)
    const first = this.matteIndex < 0
    this.matteIndex = grid.index
    if (first) this.applyKeying()
    return true
  }

  private get mipped() {
    return this.maskOn || this.keying?.kind === 'colour'
  }

  private setFilters() {
    const { gl } = this
    const filter = this.mipped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    if (this.tex2) {
      gl.activeTexture(gl.TEXTURE1)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
      gl.activeTexture(gl.TEXTURE0)
    }
  }

  attach(slot: HTMLElement) {
    slot.appendChild(this.canvas)
    this.slot = slot
    this.layout()
    this.updatePresenting()
  }

  detach(slot: HTMLElement) {
    if (this.slot !== slot) return
    this.canvas.remove()
    this.slot = null
    this.updatePresenting()
  }

  capture() {
    const p = usePlayer.getState()
    const source = this.frameSource
    if (!this.hasFrame || this.lost || !this.presenting || (this.pending && this.maskOn) || !source || !p.path || p.audio || !p.snapshot.loaded || source.path !== p.path || source.seekGeneration !== live.get().seekGeneration) return null
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 960 / Math.max(this.canvas.width, this.canvas.height))
    canvas.width = Math.max(1, Math.round(this.canvas.width * scale))
    canvas.height = Math.max(1, Math.round(this.canvas.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    this.applyMask(censorMask())
    this.draw()
    ctx.drawImage(this.canvas, 0, 0, canvas.width, canvas.height)
    const url = canvas.toDataURL('image/jpeg', 0.8)
    return { url, timeMs: source.timeMs, path: source.path }
  }

  private setProjection(p: Projection) {
    const shape = p.kind !== this.projection.kind || p.layout !== this.projection.layout
    const eye = p.swapEyes !== this.projection.swapEyes
    this.projection = p
    if (shape) {
      this.look = { ...DEFAULT_LOOK }
      this.applyProjection(p)
      this.layout()
    } else if (eye) {
      this.layout()
    }
    this.dirty = true
  }

  private applyProjection(p: Projection) {
    this.canvas.toggleAttribute('data-vr', p.kind !== 'flat')
  }

  private updatePresenting() {
    const want = this.shown && (this.headset ? tracksFrames() : this.slot !== null)
    if (want === this.presenting) return
    this.presenting = want
    client.engine.setPresenting(want)
    side?.setPresenting(want)
  }

  private setSplit(on: boolean) {
    const { gl } = this
    this.split = on
    gl.uniform1i(this.uniforms.split, on ? 1 : 0)
    if (on) {
      side?.setPresenting(this.presenting)
      this.ensureSideTexture()
    } else if (this.tex2) {
      gl.deleteTexture(this.tex2)
      this.tex2 = null
    }
    this.dirty = true
  }

  private ensureSideTexture() {
    const { gl } = this
    gl.activeTexture(gl.TEXTURE1)
    if (this.tex2) gl.deleteTexture(this.tex2)
    this.tex2 = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.tex2)
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(this.texW, this.texH))) + 1, gl.RGBA8, this.texW, this.texH)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.mipped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.activeTexture(gl.TEXTURE0)
    this.mips2 = false
  }

  private layout() {
    if (!this.slot || performance.now() < this.resizeRetryAt) return
    const vw = client.engine.videoWidth() || this.fitted.w
    const vh = client.engine.videoHeight() || this.fitted.h
    const whole = tracksFrames()
    try {
      client.resize(this.canvas.clientWidth, this.canvas.clientHeight, this.projection, vw, vh, whole)
      this.whole = whole
      this.ensureTexture()
      side?.resize(client.width, client.height, client.half)
      this.fitted = { w: vw, h: vh }
      this.resizeRetryAt = 0
    } catch (error) {
      this.resizeRetryAt = performance.now() + 1000
      console.warn('Video resize failed', error)
    }
  }

  private ensureTexture() {
    const { gl, canvas } = this
    if (this.tex && this.texW === client.width && this.texH === client.height && this.texHalf === client.half) return
    const old = this.hasFrame && !(this.pending && this.maskOn) ? this.tex : null
    if (this.tex && !old) gl.deleteTexture(this.tex)
    this.texW = client.width
    this.texH = client.height
    canvas.width = client.drawnWidth
    canvas.height = client.drawnHeight
    gl.viewport(0, 0, canvas.width, canvas.height)
    if (old) {
      gl.bindTexture(gl.TEXTURE_2D, old)
      this.draw()
    }
    this.texHalf = client.half
    this.tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(this.texW, this.texH))) + 1, gl.RGBA8, this.texW, this.texH)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.mipped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (old) gl.deleteTexture(old)
    this.hasFrame = false
    this.pending = null
    this.mips = false
    this.dirty = false
    if (this.split) this.ensureSideTexture()
  }

  private applyMask(mask: CensorMask | null): boolean {
    const { gl, uniforms: u } = this
    let changed = false
    if ((mask !== null) !== this.maskOn) {
      this.maskOn = mask !== null
      this.maskVersion = -1
      gl.uniform1i(u.maskMode, 0)
      if (!mask) this.uploadSkin(null)
      this.setFilters()
      changed = true
    }
    if (mask && mask.version !== this.maskVersion) {
      this.maskVersion = mask.version
      gl.uniform1i(u.maskMode, mask.style === 'blur' ? 1 : 2)
      gl.uniform1f(u.maskLevel, mask.strength)
      gl.uniform1i(u.boxCount, mask.count)
      gl.uniform4fv(u.boxes, mask.boxes)
      if (mask.skin !== this.skinData) this.uploadSkin(mask.skin)
      changed = true
    }
    if (this.mipped && !this.mips && this.hasFrame) {
      gl.generateMipmap(gl.TEXTURE_2D)
      this.mips = true
    }
    if (this.mipped && !this.mips2 && this.tex2) {
      gl.activeTexture(gl.TEXTURE1)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.activeTexture(gl.TEXTURE0)
      this.mips2 = true
    }
    return changed
  }

  private uploadSkin(skin: CensorMask['skin']) {
    const { gl, uniforms: u } = this
    this.skinData = skin
    gl.uniform1i(u.skinOn, skin ? 1 : 0)
    if (!skin) return
    gl.activeTexture(gl.TEXTURE2)
    if (!this.skinTex) {
      this.skinTex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this.skinTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.skinTex)
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, skin.width, skin.height, 0, gl.RED, gl.UNSIGNED_BYTE, skin.data)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.activeTexture(gl.TEXTURE0)
  }

  private clear() {
    const { gl } = this
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.hasFrame = false
  }

  private draw() {
    const { gl, uniforms: u, projection: p, look: l } = this
    gl.uniform1i(u.mode, p.kind === 'flat' ? 0 : p.kind === 'fisheye' ? 2 : 1)
    gl.uniform1f(u.hfov, p.kind === 'equirect360' ? Math.PI * 2 : ((lensDegrees(p) ?? 180) * Math.PI) / 180)
    gl.uniform1i(u.eyes, this.texHalf ? 0 : p.layout === 'sbs' ? 1 : p.layout === 'ou' ? 2 : 0)
    gl.uniform1i(u.eye, p.swapEyes ? 1 : 0)
    gl.uniform2f(u.outSize, this.canvas.width, this.canvas.height)
    const shown = flatEye(p, client.engine.videoWidth() || 16, client.engine.videoHeight() || 9)
    gl.uniform2f(u.eyeSize, shown.width, shown.height)
    const r = eyeRect(p)
    gl.uniform2f(u.eyeSrc, (client.engine.videoWidth() || this.fitted.w || this.texW) * r.w, (client.engine.videoHeight() || this.fitted.h || this.texH) * r.h)
    gl.uniform4f(u.eyeRect, r.x, r.y, r.w, r.h)
    gl.uniform3f(u.look, l.yaw, l.pitch, l.fov)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private readonly frame = () => {
    requestAnimationFrame(this.frame)
    if (this.headset) this.updatePresenting()
    if ((this.slot || this.headset) && this.presenting && !this.lost) {
      const vw = client.engine.videoWidth()
      const vh = client.engine.videoHeight()
      if (this.resizeRetryAt || (vw > 0 && vh > 0 && (vw !== this.fitted.w || vh !== this.fitted.h)) || tracksFrames() !== this.whole) this.layout()
      const buffer = client.acquireFrame()
      const now = performance.now()
      const bytes = this.texW * this.texH * 4
      const sideBuffer = this.split ? side?.acquireFrame() : null
      if (sideBuffer && sideBuffer.length === bytes && this.tex2) {
        const { gl } = this
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, this.tex2)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.texW, this.texH, gl.RGBA, gl.UNSIGNED_BYTE, sideBuffer)
        gl.activeTexture(gl.TEXTURE0)
        this.mips2 = false
        this.dirty = true
      }
      const mask = censorMask()
      if (this.keying?.kind === 'mask' && ((buffer && buffer.length === bytes) || now - this.matteAskedAt >= MATTE_POLL_MS) && this.readMatte(now)) this.dirty = true
      if (buffer && buffer.length === bytes) {
        const { gl } = this
        gl.bindTexture(gl.TEXTURE_2D, this.tex)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.texW, this.texH, gl.RGBA, gl.UNSIGNED_BYTE, buffer)
        this.hasFrame = true
        this.frameSource = { path: usePlayer.getState().path, seekGeneration: live.get().seekGeneration, timeMs: live.get().timeMs }
        this.mips = false
        const serial = client.engine.frameSerial()
        this.pending = { serial, first: this.pending?.first ?? serial, since: this.pending?.since ?? now }
        if (tracksFrames()) {
          if (now - this.lastTrack >= TRACK_MIN_INTERVAL_MS) {
            this.lastTrack = now
            const f = toRgb(buffer, this.texW, this.texH, client.engine.bgra())
            client.engine.trackFrame(f.rgb, f.width, f.height, live.get().timeMs, 3)
          }
        }
      }
      const p = this.pending
      if (p) {
        const waited = now - p.since
        if (!mask?.ready || mask.serial >= p.serial || (mask.serial >= p.first && waited >= CENSOR_CATCH_UP_MS) || waited >= CENSOR_WAIT_MS) {
          this.pending = null
          this.applyMask(mask)
          this.draw()
        }
      } else if (this.hasFrame && (this.applyMask(mask) || this.dirty)) {
        this.draw()
      }
    }
    this.dirty = false
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    if (this.projection.kind === 'flat' || e.button !== 0) return
    this.canvas.setPointerCapture(e.pointerId)
    this.drag = { x: e.clientX, y: e.clientY }
  }
  private readonly onPointerMove = (e: PointerEvent) => {
    const d = this.drag
    if (!d) return
    const l = this.look
    const perPixel = l.fov / this.canvas.clientHeight
    l.yaw -= (e.clientX - d.x) * perPixel
    l.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, l.pitch + (e.clientY - d.y) * perPixel))
    this.drag = { x: e.clientX, y: e.clientY }
    this.dirty = true
  }
  private readonly onPointerUp = () => {
    this.drag = null
  }
  private readonly onWheel = (e: WheelEvent) => {
    if (this.projection.kind === 'flat') return
    const l = this.look
    l.fov = Math.max((30 * Math.PI) / 180, Math.min((120 * Math.PI) / 180, l.fov * (1 + e.deltaY * 0.002)))
    this.dirty = true
  }
}

let stage: Stage | null = null
let stageKeying: StageKeying | null = null

export function setStageKeying(k: StageKeying | null): void {
  stageKeying = k
  stage?.setKeying(k)
}

export function videoStage(): Stage {
  stage ??= new Stage()
  return stage
}

export function captureVideo() {
  return stage?.capture() ?? null
}
