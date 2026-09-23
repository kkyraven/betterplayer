import type { Projection } from '@shared/projection'
import * as client from '@/engine/client'
import { side } from '@/engine/side'
import { on } from '@/ipc'
import { toRgb } from '@/lib/rgb'
import { MAX_BOXES, goonerMask } from '@/state/gooner'
import * as live from '@/state/live'
import { useCompare } from '@/state/compare'
import { usePlayer } from '@/state/player'
import { useTracking } from '@/state/tracking'

const TRACK_MIN_INTERVAL_MS = 1000 / 30
const RESIZE_SETTLE_MS = 120

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
uniform int split;
uniform int bgra;
uniform int mode;
uniform float hfov;
uniform int eyes;
uniform int eye;
uniform vec2 outSize;
uniform vec2 videoSize;
uniform vec3 look;
uniform int maskMode;
uniform float maskLevel;
uniform int boxCount;
uniform vec4 boxes[MAX_BOXES];
in vec2 uv;
out vec4 o;
float masked(vec2 t) {
  float feather = maskMode == 1 ? 0.015 : 0.0;
  float m = 0.0;
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
vec4 pickFrom(sampler2D s, vec2 t) {
  vec4 c = texture(s, t);
  if (maskMode != 0 && boxCount > 0) {
    float m = masked(t);
    if (m > 0.0) c = mix(c, hidden(s, t), m);
  }
  return bgra == 1 ? c.bgra : c;
}
vec4 pick(vec2 t) {
  return split == 1 && uv.x >= 0.5 ? pickFrom(tex2, t) : pickFrom(tex, t);
}
vec2 eyeOf(vec2 t) {
  if (eyes == 1) t.x = t.x * 0.5 + float(eye) * 0.5;
  else if (eyes == 2) t.y = t.y * 0.5 + float(eye) * 0.5;
  return t;
}
void main() {
  float outA = outSize.x / outSize.y;
  if (mode == 0) {
    float vidA = videoSize.x / videoSize.y;
    if (eyes == 1) vidA *= 0.5; else if (eyes == 2) vidA *= 2.0;
    vec2 t = vec2(uv.x, 1.0 - uv.y) - 0.5;
    float s = vidA / outA;
    if (s > 1.005) t.y *= s; else if (s < 0.995) t.x /= s;
    t += 0.5;
    if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
    o = pick(eyeOf(t));
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
  o = pick(eyeOf(t));
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
  private uniforms!: Record<'mode' | 'hfov' | 'eyes' | 'eye' | 'outSize' | 'videoSize' | 'look' | 'maskMode' | 'maskLevel' | 'boxCount' | 'boxes' | 'split', WebGLUniformLocation | null>
  private lost = false
  private tex: WebGLTexture | null = null
  private tex2: WebGLTexture | null = null
  private split = false
  private texW = 0
  private texH = 0
  private look: Look = { ...DEFAULT_LOOK }
  private drag: { x: number; y: number } | null = null
  private dirty = true
  private hasFrame = false
  private slot: HTMLElement | null = null
  private shown = true
  private presenting = true
  private projection: Projection
  private fitted = { w: 0, h: 0 }
  private resizeTimer = 0
  private resizeRetryAt = 0
  private lastTrack = 0
  private maskOn = false
  private maskVersion = -1
  private mips = false
  private mips2 = false

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
      this.initGl()
      this.tex = null
      this.tex2 = null
      this.texW = 0
      this.texH = 0
      this.hasFrame = false
      this.maskVersion = -1
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
    gl.uniform1i(u('bgra'), client.engine.bgra() ? 1 : 0)
    gl.uniform1i(u('split'), this.split ? 1 : 0)
    this.uniforms = { mode: u('mode'), hfov: u('hfov'), eyes: u('eyes'), eye: u('eye'), outSize: u('outSize'), videoSize: u('videoSize'), look: u('look'), maskMode: u('maskMode'), maskLevel: u('maskLevel'), boxCount: u('boxCount'), boxes: u('boxes'), split: u('split') }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
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

  private setProjection(p: Projection) {
    const shape = p.kind !== this.projection.kind || p.layout !== this.projection.layout
    this.projection = p
    if (shape) {
      this.look = { ...DEFAULT_LOOK }
      this.applyProjection(p)
      this.layout()
    }
    this.dirty = true
  }

  private applyProjection(p: Projection) {
    this.canvas.toggleAttribute('data-vr', p.kind !== 'flat')
  }

  private updatePresenting() {
    const want = this.shown && this.slot !== null
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
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.maskOn ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
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
    try {
      client.resize(this.canvas.clientWidth, this.canvas.clientHeight, this.projection, vw, vh)
      this.ensureTexture()
      side?.resize(client.width, client.height)
      this.fitted = { w: vw, h: vh }
      this.resizeRetryAt = 0
    } catch (error) {
      this.resizeRetryAt = performance.now() + 1000
      console.warn('Video resize failed', error)
    }
  }

  private ensureTexture() {
    const { gl, canvas } = this
    if (this.tex && this.texW === client.width && this.texH === client.height) return
    const old = this.hasFrame ? this.tex : null
    if (this.tex && !old) gl.deleteTexture(this.tex)
    this.texW = client.width
    this.texH = client.height
    canvas.width = this.texW
    canvas.height = this.texH
    gl.viewport(0, 0, this.texW, this.texH)
    if (old) {
      gl.bindTexture(gl.TEXTURE_2D, old)
      this.draw()
    }
    this.tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(this.texW, this.texH))) + 1, gl.RGBA8, this.texW, this.texH)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.maskOn ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (old) gl.deleteTexture(old)
    this.hasFrame = false
    this.mips = false
    this.dirty = false
    if (this.split) this.ensureSideTexture()
  }

  private applyMask(now: number): boolean {
    const { gl, uniforms: u } = this
    const mask = goonerMask(now)
    let changed = false
    if ((mask !== null) !== this.maskOn) {
      this.maskOn = mask !== null
      this.maskVersion = -1
      gl.uniform1i(u.maskMode, 0)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.maskOn ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
      if (this.tex2) {
        gl.activeTexture(gl.TEXTURE1)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.maskOn ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
        gl.activeTexture(gl.TEXTURE0)
      }
      changed = true
    }
    if (mask && mask.version !== this.maskVersion) {
      this.maskVersion = mask.version
      gl.uniform1i(u.maskMode, mask.style === 'blur' ? 1 : 2)
      gl.uniform1f(u.maskLevel, mask.strength)
      gl.uniform1i(u.boxCount, mask.count)
      gl.uniform4fv(u.boxes, mask.boxes)
      changed = true
    }
    if (mask && !this.mips && this.hasFrame) {
      gl.generateMipmap(gl.TEXTURE_2D)
      this.mips = true
    }
    if (mask && !this.mips2 && this.tex2) {
      gl.activeTexture(gl.TEXTURE1)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.activeTexture(gl.TEXTURE0)
      this.mips2 = true
    }
    return changed
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
    gl.uniform1f(u.hfov, p.kind === 'equirect360' ? Math.PI * 2 : p.kind === 'fisheye' ? (p.fov * Math.PI) / 180 : Math.PI)
    gl.uniform1i(u.eyes, p.layout === 'sbs' ? 1 : p.layout === 'ou' ? 2 : 0)
    gl.uniform1i(u.eye, p.swapEyes ? 1 : 0)
    gl.uniform2f(u.outSize, this.texW, this.texH)
    gl.uniform2f(u.videoSize, client.engine.videoWidth() || 16, client.engine.videoHeight() || 9)
    gl.uniform3f(u.look, l.yaw, l.pitch, l.fov)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private readonly frame = () => {
    requestAnimationFrame(this.frame)
    if (this.slot && this.presenting && !this.lost) {
      const vw = client.engine.videoWidth()
      const vh = client.engine.videoHeight()
      if (this.resizeRetryAt || (vw > 0 && vh > 0 && (vw !== this.fitted.w || vh !== this.fitted.h))) this.layout()
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
      if (buffer && buffer.length === bytes) {
        const { gl } = this
        gl.bindTexture(gl.TEXTURE_2D, this.tex)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.texW, this.texH, gl.RGBA, gl.UNSIGNED_BYTE, buffer)
        this.hasFrame = true
        this.mips = false
        this.applyMask(now)
        this.draw()
        const trackingSource = useTracking.getState().source
        if (trackingSource !== 'browser' && (trackingSource === 'player' || client.engine.wantsFrames())) {
          if (now - this.lastTrack >= TRACK_MIN_INTERVAL_MS) {
            this.lastTrack = now
            const f = toRgb(buffer, this.texW, this.texH, client.engine.bgra())
            client.engine.trackFrame(f.rgb, f.width, f.height, live.get().timeMs, 3)
          }
        }
      } else if (this.hasFrame && (this.applyMask(now) || this.dirty)) {
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

export function videoStage(): Stage {
  stage ??= new Stage()
  return stage
}
