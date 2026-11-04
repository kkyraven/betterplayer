import type { MediaQuery } from './library'
import type { ProjectionKind } from './projection'

const DEG = Math.PI / 180

export const VR_PORTAL = {
  radius: 1.5,
  ppm: 1200,
  portal: { w: 0.36, h: 0.225, corner: 0.0135, lift: 0.1, grow: 0.21, gap: 0.065, field: 0.7, hoverField: 0.8, bowl: 0.18 },
  returnPicture: { w: 0.104, h: 0.065, corner: 0.008, lift: 0.04, grow: 0.03 },
  returnButton: { padLeft: 0.012, gap: 0.014, padRight: 0.022, padHeight: 0.022, radius: 0.02, rightMargin: 0.035 },
  el: { label1: 9.35, ret: 10.4, row1: 2.5, label2: -6.85, row2: -13.7, strip: -24.1, hint: -26.6 },
  diveDrop: 0.05,
  bands: {
    rows: { centreDeg: -4.25, fromDeg: -21.0, toDeg: 12.5, halfArcDeg: 33 },
    strip: { centreDeg: -25.55, fromDeg: -29.5, toDeg: -21.6, halfArcDeg: 33 },
  },
  strip: { barLeft: -0.565, barWidth: 0.86, barHeight: 0.085, keyboardX: 0.365, keyDisc: 0.065, micDisc: 0.08, chipHeight: 0.064, chipGap: 0.018, tagsText: 0.025, tagsHeight: 0.064 },
  text: { title: 0.024, meta: 0.0192, label: 0.024, status: 0.019, hint: 0.022, badge: 0.0165 },
  tagList: { pitch: 0.068, gap: 0.016, topDrop: 0.075 },
  keyboard: { key: 0.0744, gap: 0.012, rowsDeg: [-9.3, -12.5, -15.7, -18.6], fieldDeg: -5.25 },
  ms: {
    lift: 200, scroll: 240, tagStep: 160, morph: 320, enter: 260, leave: 200, resultsDelay: 260, resultsIn: 420,
    fade: 200, grow: 500, live: 300, liveAfterEnd: 60, grace: 250, loadingFade: 150, flat: 500, flash: 180, textFade: 120,
    slideBase: 160, slidePerDeg: 4, backLibDelay: 100, backLib: 320, dwell: 150, leaveHold: 80, preload: 2000, keyframeGapMax: 5000,
    fadeNoSlide: 120,
  },
  pill: { w: 0.2, h: 0.0533, texels: [240, 64], windowY: 1332 },
  slideMinDeg: 3,
  resultsDz: 0.15,
  aperture: { full180: [105, 105], full360: [200, 105], growPow: 1.6, corner: 0.55, cornerK: 0.7, feather: 0.22, featherK: 0.8, rimVr: 0.14, rimFlat: 0.05, rimK: 0.35, bowlK: 0.4 },
  ring: { gap: 0.005, width: 0.0045, flash: 0.002 },
  dim: { video: 0.32, room: 0.5, keyboard: 0.1, fix: 0.3, words: 0.28, offline: 0.35, locked: 0.4 },
  loading: { drop: 0.3, distance: 1.4 },
  screen: { radius: 3, corner: 0.03 },
  stills: { shelfWidth: 1024, diveWidth: 2048 },
  rows: { limit: 24, results: 40, visible: 4 },
  maxPortals: 16,
} as const

export const portalStepDeg = (VR_PORTAL.portal.w + VR_PORTAL.portal.gap) / VR_PORTAL.radius / DEG
export const edgeDeg = 1.5 * portalStepDeg + VR_PORTAL.portal.w / 2 / VR_PORTAL.radius / DEG
export const fadeInDeg = 1.5 * portalStepDeg + 1
export const fadeOutDeg = 2.5 * portalStepDeg - 2
export const diveElDeg = Math.atan2(-VR_PORTAL.diveDrop, VR_PORTAL.radius) / DEG

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export type Ease = 'linear' | 'out' | 'inOut'
export interface Keyframe { from: number; to: number; startMs: number; durationMs: number; ease: Ease }
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
export const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t) }

export function ease(e: Ease, t: number): number {
  const x = clamp01(t)
  if (e === 'out') return 1 - (1 - x) ** 3
  if (e === 'inOut') return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2
  return x
}

export function keyframeAt(k: Keyframe, nowMs: number): number {
  if (k.durationMs <= 0) return k.to
  return k.from + (k.to - k.from) * ease(k.ease, (nowMs - k.startMs) / k.durationMs)
}

export const still = (value: number): Keyframe => ({ from: value, to: value, startMs: 0, durationMs: 0, ease: 'linear' })

export function retarget(k: Keyframe, to: number, nowMs: number, durationMs: number, e: Ease = 'out'): Keyframe {
  return { from: keyframeAt(k, nowMs), to, startMs: nowMs, durationMs, ease: e }
}

export interface PortalSize { w: number; h: number; corner: number; lift: number; grow: number }
export const PORTAL_SIZE: PortalSize = { ...VR_PORTAL.portal }
export const RETURN_SIZE: PortalSize = { ...VR_PORTAL.returnPicture }

export const columnAz = (i: number) => (i - 1.5) * portalStepDeg

export function resultCell(i: number, count: number): { column: number; row: 'row1' | 'row2' } {
  const two = count > VR_PORTAL.rows.visible
  return { column: two ? Math.floor(i / 2) : i, row: two && i % 2 === 1 ? 'row2' : 'row1' }
}

export const scrollMax = (columns: number) => Math.max(0, (columns - VR_PORTAL.rows.visible) * portalStepDeg)

export function edgeFade(azDeg: number): number {
  return smooth((fadeOutDeg - Math.abs(azDeg)) / (fadeOutDeg - fadeInDeg))
}

export function returnAz(labelW: number): number {
  const b = VR_PORTAL.returnButton
  return edgeDeg - (VR_PORTAL.returnPicture.w / 2 + b.gap + labelW + b.padRight) / VR_PORTAL.radius / DEG
}

export const rowEl = (row: 'row1' | 'row2') => VR_PORTAL.el[row]

export interface BandSpec { centreDeg: number; fromDeg: number; toDeg: number; halfArcDeg: number }
export interface BandLayout {
  width: number; height: number
  metres: number
  curvature: number
  distance: number; drop: number; pitch: number
}

export function bandLayout(b: BandSpec): BandLayout {
  const { radius: R, ppm } = VR_PORTAL
  const width = Math.round(2 * b.halfArcDeg * DEG * R * ppm)
  const height = Math.round(R * (Math.tan((b.toDeg - b.centreDeg) * DEG) - Math.tan((b.fromDeg - b.centreDeg) * DEG)) * ppm)
  const metres = width / ppm
  const c = b.centreDeg * DEG
  return { width, height, metres, curvature: metres / (2 * Math.PI * R), distance: R * Math.cos(c), drop: -R * Math.sin(c), pitch: -b.centreDeg }
}

function aboutX(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a)
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]
}

const direction = (azRad: number, elRad: number): Vec3 =>
  [Math.cos(elRad) * Math.sin(azRad), Math.sin(elRad), -Math.cos(elRad) * Math.cos(azRad)]

export function bandTexel(b: BandSpec, azDeg: number, elDeg: number): [x: number, y: number] {
  const { radius: R, ppm } = VR_PORTAL
  const { width, height } = bandLayout(b)
  const v = aboutX(direction(azDeg * DEG, elDeg * DEG), -b.centreDeg * DEG)
  const az = Math.atan2(v[0], -v[2])
  const el = Math.atan2(v[1], Math.hypot(v[0], v[2]))
  return [width / 2 + az * R * ppm, height / 2 - R * Math.tan(el) * ppm]
}

export function bandDirection(b: BandSpec, x: number, y: number): [azDeg: number, elDeg: number] {
  const { radius: R, ppm } = VR_PORTAL
  const { width, height } = bandLayout(b)
  const az = (x - width / 2) / ppm / R
  const el = Math.atan((height / 2 - y) / ppm / R)
  const v = aboutX(direction(az, el), b.centreDeg * DEG)
  return [Math.atan2(v[0], -v[2]) / DEG, Math.atan2(v[1], Math.hypot(v[0], v[2])) / DEG]
}

export interface PortalPose { az: number; el: number; d: number; hr: number; s: number }

export function portalPose(azDeg: number, elDeg: number, h: number, size: PortalSize, dz = 0): PortalPose {
  const r = VR_PORTAL.radius - size.lift * h + dz
  const el = elDeg * DEG
  return { az: azDeg * DEG, el, d: r / Math.cos(el), hr: r, s: 1 + size.grow * h }
}

export type Vec3 = [number, number, number]

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

export function portalHit(o: Vec3, v: Vec3, p: PortalPose, size: PortalSize): { t: number; x: number; y: number } | null {
  const b = o[0] * v[0] + o[1] * v[1] + o[2] * v[2]
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - p.d * p.d
  const disc = b * b - c
  if (disc < 0) return null
  const t = -b + Math.sqrt(disc)
  if (t <= 0) return null
  const P: Vec3 = [o[0] + v[0] * t, o[1] + v[1] * t, o[2] + v[2] * t]
  const az = Math.atan2(P[0], -P[2])
  const el = Math.atan2(P[1], Math.hypot(P[0], P[2]))
  const x = (wrap(az - p.az) * p.hr) / p.s
  const y = ((el - p.el) * p.d) / p.s
  return rbox(x, y, size.w / 2, size.h / 2, size.corner) <= 0 ? { t, x, y } : null
}

export function rbox(x: number, y: number, bx: number, by: number, r: number): number {
  const qx = Math.abs(x) - bx + r, qy = Math.abs(y) - by + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

export const windowHover = (s: number, size: PortalSize) => (size.grow > 0 ? clamp01((s - 1) / size.grow) : 0)

export const halfField = (hover: number) => (lerp(VR_PORTAL.portal.field, VR_PORTAL.portal.hoverField, hover) * Math.PI) / 2

export const bowlDepth = (hover: number) => (VR_PORTAL.portal.bowl / (VR_PORTAL.portal.w / 2)) * (1 - 0.5 * hover)

export function windowRay(v: Vec3, yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch)
  const f1 = v[0] * sy - v[2] * cy
  return [v[0] * cy + v[2] * sy, v[1] * cp - f1 * sp, v[1] * sp + f1 * cp]
}

export function fromWindow(w: Vec3, yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch)
  const f1 = w[2] * cp - w[1] * sp
  return [w[0] * cy + f1 * sy, w[1] * cp + w[2] * sp, w[0] * sy - f1 * cy]
}

export const windowAngles = (w: Vec3): [number, number] => [Math.atan2(w[0], w[2]), Math.asin(Math.min(1, Math.max(-1, w[1])))]

export function bowlAngles(x: number, y: number, lv: Vec3, aspect: number, hover: number): [number, number, number] {
  const ax: Vec3 = [1.42, 1.42 * aspect, Math.max(bowlDepth(hover), 1e-3)]
  const p: Vec3 = [x / ax[0], y / ax[1], 0]
  const d: Vec3 = [lv[0] / ax[0], lv[1] / ax[1], lv[2] / ax[2]]
  const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
  const b = p[0] * d[0] + p[1] * d[1]
  const c = p[0] * p[0] + p[1] * p[1] - 1
  const t = (-b + Math.sqrt(Math.max(b * b - a * c, 0))) / a
  const q: Vec3 = [x + lv[0] * t, y + lv[1] * t, lv[2] * t]
  const n: Vec3 = [q[0] / (ax[0] * ax[0]), q[1] / (ax[1] * ax[1]), q[2] / (ax[2] * ax[2])]
  const fh = halfField(hover)
  return [q[0] * fh, q[1] * fh, lerp(0.5, 1, smooth((n[2] / Math.hypot(...n) - 0.15) / 0.75))]
}

export function windowPicture(o: Vec3, v: Vec3, p: PortalPose, size: PortalSize): [number, number, number] | null {
  const hit = portalHit(o, v, p, size)
  if (!hit) return null
  const half = size.w / 2
  return bowlAngles(hit.x / half, hit.y / half, windowRay(v, p.az, p.el), size.h / size.w, windowHover(p.s, size))
}

export function diveAngles(o: Vec3, v: Vec3, ap: NonNullable<DiveFrame['aperture']>, aspect: number): [number, number, number] {
  const w = windowRay(v, ap.az, ap.el)
  const [qx, qy] = windowAngles(w)
  const a = qx * ap.scale, e = qy * ap.scale
  const u = fromWindow([Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)], ap.az, ap.el)
  const [fx, fy] = windowAngles(windowRay(u, ap.az * (1 - ap.k), ap.el * (1 - ap.k)))
  if (ap.bowl <= 0) return [fx, fy, 1]
  const ob = o[0] * v[0] + o[1] * v[1] + o[2] * v[2]
  const t = -ob + Math.sqrt(Math.max(ob * ob - (o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - ap.rp * ap.rp), 0))
  const [dx, dy] = windowAngles(windowRay([o[0] + v[0] * t, o[1] + v[1] * t, o[2] + v[2] * t].map((c) => c / ap.rp) as Vec3, ap.az, ap.el))
  const [bx, by, shade] = bowlAngles(dx / ap.hw, (dy / ap.hh) * aspect, w, aspect, ap.hover)
  return [lerp(fx, bx, ap.bowl), lerp(fy, by, ap.bowl), lerp(1, shade, ap.bowl)]
}

export function stillUv(az: number, el: number, hh: number, hv: number): [number, number] | null {
  if (Math.abs(az) > hh || Math.abs(el) > hv) return null
  return [0.5 + az / (2 * hh), 0.5 - el / (2 * hv)]
}

export type DiveKind = 'vr' | 'flat' | 'back' | 'flatBack'
export interface ApertureFrom { az: number; el: number; hw: number; hh: number; rr: number; rp: number; hover: number }

export function portalAngles(azRad: number, y: number, r: number, s: number, size: PortalSize): ApertureFrom {
  const d = Math.hypot(r, y)
  return { az: azRad, el: Math.atan2(y, r), hw: (size.w * s) / 2 / d, hh: (size.h * s) / 2 / d, rr: (size.corner * s) / d, rp: d, hover: windowHover(s, size) }
}

export interface TilePose { a: number; y: number; r: number; w: number; h: number; crop: number; bend: number; tilt: number; rad: number }
export interface DiveSpec {
  kind: DiveKind
  startMs: number
  slideMs: number
  same: boolean
  full: 180 | 360
  from: ApertureFrom
  slideFrom?: { az: number; y: number; r: number; s: number; h: number }
  tile?: TilePose
  screen?: TilePose
}
export interface Transition { spec: DiveSpec; reversedAtMs: number | null; reversedFromE: number | null; liveAtMs: number | null; failed: boolean; held: boolean }
export const startTransition = (spec: DiveSpec): Transition => ({ spec, reversedAtMs: null, reversedFromE: null, liveAtMs: null, failed: false, held: false })

export function slideMsFor(azDeg: number, elDeg: number): number {
  const dist = Math.hypot(azDeg, elDeg - diveElDeg)
  return dist < VR_PORTAL.slideMinDeg ? 0 : VR_PORTAL.ms.slideBase + VR_PORTAL.ms.slidePerDeg * dist
}

export function reverse(t: Transition, nowMs: number, failed: boolean): Transition {
  if (t.reversedAtMs !== null) return failed && !t.failed ? { ...t, failed } : t
  const e = Math.min(Math.max(0, elapsed(t, nowMs)), growEnd(t.spec))
  return { ...t, reversedAtMs: nowMs, reversedFromE: e, failed: t.failed || failed }
}

export function elapsed(t: Transition, nowMs: number): number {
  if (t.reversedAtMs === null || t.reversedFromE === null) return nowMs - t.spec.startMs
  return t.reversedFromE - (nowMs - t.reversedAtMs)
}

export function growEnd(spec: DiveSpec): number {
  const M = VR_PORTAL.ms
  if (spec.kind === 'vr') return spec.slideMs + M.grow
  if (spec.kind === 'back') return M.live + M.grow
  return M.flat
}

export interface DiveFrame {
  e: number
  libF: number
  textF: number
  flash: number
  sliding: boolean
  portal: { az: number; y: number; r: number; s: number; hover: number; op: number } | null
  aperture: { az: number; el: number; hw: number; hh: number; rr: number; feather: number; rim: number; rp: number; scale: number; bowl: number; k: number; hover: number } | null
  inB: number; outB: number; outA: number
  outLive: number
  tile: TilePose | null
  live: number
  loading: number
  done: boolean; undone: boolean
}

function lerpPose(a: TilePose, b: TilePose, t: number): TilePose {
  return {
    a: lerp(a.a, b.a, t), y: lerp(a.y, b.y, t), r: lerp(a.r, b.r, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t),
    crop: lerp(a.crop, b.crop, t), bend: lerp(a.bend, b.bend, t), tilt: lerp(a.tilt, b.tilt, t), rad: lerp(a.rad, b.rad, t),
  }
}

function aperture(from: ApertureFrom, full: 180 | 360, k: number): NonNullable<DiveFrame['aperture']> {
  const A = VR_PORTAL.aperture
  const [tw, th] = full === 360 ? A.full360 : A.full180
  const hw = from.hw * ((tw * DEG) / from.hw) ** k
  const hh = from.hh * ((th * DEG) / from.hh) ** k
  return {
    az: from.az, el: from.el, hw, hh,
    rr: lerp(from.rr, Math.min(hw, hh) * A.corner, smooth(k / A.cornerK)),
    feather: A.feather * hh * smooth(k / A.featherK),
    rim: A.rimVr * (1 - smooth(k / A.rimK)),
    rp: from.rp,
    scale: (halfField(from.hover) / from.hw) ** (1 - k),
    bowl: 1 - smooth(k / A.bowlK),
    k,
    hover: from.hover,
  }
}

export function diveFrame(t: Transition, nowMs: number, dim: number): DiveFrame {
  const s = t.spec, M = VR_PORTAL.ms, A = VR_PORTAL.aperture
  const reversed = t.reversedAtMs !== null
  const raw = elapsed(t, nowMs)
  const forward = s.kind === 'vr' || s.kind === 'flat'
  const end = growEnd(s)
  const fades = forward && (!s.same || s.kind === 'vr')
  const tReady = !fades ? 0 : t.held ? Infinity : s.same ? end : t.liveAtMs === null ? Infinity : Math.max(end + M.liveAfterEnd, t.liveAtMs - s.startMs)
  const total = fades ? tReady + M.live : end
  const e = Math.min(Math.max(raw, 0), total)
  const done = !reversed && raw >= total
  const undone = reversed && raw <= 0
  const frame: DiveFrame = {
    e, libF: 1, textF: 1, flash: 0, sliding: false, portal: null, aperture: null,
    inB: 1, outB: 1, outA: 1, outLive: 1, tile: null, live: 1, loading: 0, done, undone,
  }

  if (forward) {
    const eMax = reversed ? (t.reversedFromE ?? e) : e
    frame.flash = 1 - smooth(eMax / M.flash)
    frame.textF = 1 - smooth(e / M.textFade)
    frame.live = fades ? smooth((e - tReady) / M.live) : 1
    frame.outLive = s.same ? 1 : frame.live
    frame.loading = !s.same && !t.held && tReady > end + M.grace
      ? smooth((e - end - M.grace) / M.loadingFade) * (1 - smooth((e - tReady) / M.loadingFade))
      : 0
  }

  if (s.kind === 'vr') {
    const Tg = s.slideMs
    frame.libF = 1 - smooth(e / (Tg ? M.fade : M.fadeNoSlide))
    frame.sliding = e < Tg
    const k = frame.sliding ? 0 : 1 - (1 - clamp01((e - Tg) / M.grow)) ** A.growPow
    if (frame.sliding && s.slideFrom) {
      const f = s.slideFrom, g = ease('inOut', e / Tg)
      const yD = (VR_PORTAL.diveDrop * f.r) / VR_PORTAL.radius
      frame.portal = { az: f.az * (1 - g), y: lerp(f.y, yD, g), r: f.r, s: f.s, hover: f.h * (1 - g), op: 1 }
    }
    if (!frame.sliding) frame.aperture = aperture(s.from, s.full, k)
    frame.outB = s.same ? lerp(dim, 1, smooth((k - 0.4) / 0.6)) : 1
    frame.outA = s.same ? 1 : smooth((k - 0.55) / 0.45)
  } else if (s.kind === 'flat') {
    frame.libF = 1 - smooth(e / M.fade)
    if (s.tile && s.screen) frame.tile = lerpPose(s.tile, s.screen, ease('out', e / M.flat))
  } else if (s.kind === 'back') {
    frame.live = 1 - smooth(e / M.live)
    const k = (1 - clamp01((e - M.live) / M.grow)) ** A.growPow
    frame.aperture = aperture(s.from, s.full, k)
    frame.outB = lerp(1, dim, smooth((0.8 - k) / 0.45))
    frame.libF = smooth((e - M.backLibDelay) / M.backLib)
    frame.textF = frame.libF
    const f = s.from
    frame.portal = { az: f.az / DEG, y: f.rp * Math.sin(f.el), r: f.rp * Math.cos(f.el), s: 1, hover: 0, op: e >= end ? 1 : 0 }
  } else {
    frame.libF = smooth((e - M.backLibDelay) / M.backLib)
    frame.textF = frame.libF
    if (s.tile && s.screen) {
      frame.tile = lerpPose(s.tile, s.screen, 1 - ease('out', e / M.flat))
      frame.portal = { az: s.tile.a, y: s.tile.y, r: s.tile.r, s: 1, hover: 0, op: e >= M.flat ? 1 : 0 }
    }
  }
  return frame
}

export type ChipKind = 'text' | 'tag' | 'vr' | '2d' | 'fav' | 'under' | 'over' | 'fastest'
export interface Chip { id: string; kind: ChipKind; label: string; n?: number }

const FILLER = new Set(['with', 'in', 'on', 'the', 'and', 'show', 'me', 'videos', 'video', 'first', 'a', 'of', 'for', 'find', 'tag'])

export function textChips(text: string, tags: readonly string[], idPrefix = 'k'): Chip[] {
  const words = (t: string) => t.toLowerCase().split(/\s+/).filter(Boolean)
  const known = new Map(tags.map((t) => [words(t).join(' '), t]))
  const longest = tags.reduce((most, t) => Math.max(most, words(t).length), 0)
  const ws = words(text)
  const tagAt = (i: number): [string, number] | null => {
    for (let k = 1; k <= longest && i + k < ws.length; k++) {
      const tag = ws[i + k] === 'tag' ? known.get(ws.slice(i, i + k).join(' ')) : undefined
      if (tag !== undefined) return [tag, k]
    }
    return null
  }
  const chips: Chip[] = []
  let run: Chip | null = null
  const end = () => { if (run) chips.push(run); run = null }
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!, n1 = ws[i + 1] ?? '', n2 = ws[i + 2] ?? '', id = idPrefix + i
    const tag = tagAt(i)
    if ((w === 'under' || w === 'over') && /^\d+$/.test(n1) && /^min/.test(n2)) {
      end()
      const n = Number(n1)
      chips.push({ id, kind: w, label: `${w === 'under' ? 'Under' : 'Over'} ${n} minutes`, n })
      i += 2
    } else if (tag) {
      end(); chips.push({ id, kind: 'tag', label: tag[0] }); i += tag[1]
    } else if (w === 'vr') { end(); chips.push({ id, kind: 'vr', label: 'VR' })
    } else if (w === '2d') { end(); chips.push({ id, kind: '2d', label: '2D' })
    } else if (w === 'favourites' || w === 'favorites') { end(); chips.push({ id, kind: 'fav', label: 'Favourites' })
    } else if (w === 'fastest') { end(); chips.push({ id, kind: 'fastest', label: 'Fastest' })
    } else if (FILLER.has(w)) end()
    else if (run) run.label += ' ' + w
    else run = { id, kind: 'text', label: w }
  }
  end()
  return chips
}

export function chipText(chips: readonly Chip[]): string {
  return chips.map((c) => {
    if (c.kind === 'under' || c.kind === 'over') return `${c.kind} ${c.n ?? 0} minutes`
    if (c.kind === 'tag') return `${c.label.toLowerCase()} tag`
    if (c.kind === 'fav') return 'favourites'
    return c.label.toLowerCase()
  }).join(' ')
}

function searchTerm(word: string): string {
  const syntax = /[:#"]/.test(word) || word.startsWith('-') || ['OR', 'AND', 'NOT'].includes(word)
  return syntax ? `"${word.replace(/["\\]/g, (ch) => '\\' + ch)}"` : word
}

export function chipsQuery(chips: readonly Chip[], limit: number = VR_PORTAL.rows.results): MediaQuery {
  const terms: string[] = []
  const filters: MediaQuery['filters'] = {}
  const tags: string[] = []
  let over: number | null = null
  let fav = false
  let fastest = false
  for (const c of chips) {
    if (c.kind === 'text') terms.push(...c.label.split(/\s+/).filter(Boolean).map(searchTerm))
    else if (c.kind === 'tag') { if (!tags.includes(c.label)) tags.push(c.label) }
    else if (c.kind === 'vr' || c.kind === '2d') filters.type = c.kind
    else if (c.kind === 'fav') fav = true
    else if (c.kind === 'fastest') fastest = true
    else if (c.kind === 'under' && c.n !== undefined) filters.maxDurationMs = Math.min(filters.maxDurationMs ?? Infinity, c.n * 60_000)
    else if (c.kind === 'over' && c.n !== undefined) over = Math.max(over ?? 0, c.n)
  }
  if (over !== null) terms.push(`duration:>${over}`)
  if (tags.length) filters.tags = tags
  const query: MediaQuery = { section: fav ? 'favourites' : 'all', sort: fastest ? 'speed' : 'recommended', desc: true, filters, limit, offset: 0 }
  if (terms.length) query.search = terms.join(' ')
  return query
}

export const CONTINUE_QUERY: MediaQuery = { section: 'continue', sort: 'lastPlayed', desc: true, filters: {}, limit: VR_PORTAL.rows.limit, offset: 0 }
export const VR_ROW_QUERY: MediaQuery = { section: 'vr', sort: 'recommended', desc: true, filters: {}, limit: VR_PORTAL.rows.limit, offset: 0 }
export const RECOMMENDED_QUERY: MediaQuery = { section: 'all', sort: 'recommended', desc: true, filters: {}, limit: VR_PORTAL.rows.limit, offset: 0, continueRow: true }

export function shelfRows<R extends { id: number }>(input: { continueRows: R[]; vrRows: R[]; recommended: R[]; playing: R | null }): { top: 'continue' | 'vr'; topRows: R[]; bottomRows: R[] } {
  const { continueRows, vrRows, recommended, playing } = input
  const top = continueRows.length === 0 && playing === null ? 'vr' : 'continue'
  const topRows = top === 'vr'
    ? vrRows.slice(0, VR_PORTAL.rows.limit)
    : [...(playing ? [playing] : []), ...continueRows.filter((r) => r.id !== playing?.id)].slice(0, VR_PORTAL.rows.limit)
  const shown = new Set(topRows.map((r) => r.id))
  return { top, topRows, bottomRows: recommended.filter((r) => !shown.has(r.id)) }
}

export const lockedFor = (durationMs: number, freeMs: number | null) => freeMs !== null && durationMs > freeMs

export type PortalStillKind = 'equirect' | 'poster' | 'blank'
export interface PortalStillInfo { kind: PortalStillKind; halfDeg: [number, number]; arcDeg: number; ms: number; censor: string }
export const PORTAL_HEADERS = { kind: 'X-Portal-Kind', half: 'X-Portal-Half', arc: 'X-Portal-Arc', ms: 'X-Portal-Ms', censor: 'X-Portal-Censor' } as const

export function portalPath(id: number, width: 1024 | 2048, ms: number | null): string {
  return `portal/${id}?w=${width}${ms === null ? '' : `&ms=${Math.round(ms)}`}`
}

export function readPortalHeaders(get: (name: string) => string | null): PortalStillInfo | null {
  const kind = get(PORTAL_HEADERS.kind)
  if (kind !== 'equirect' && kind !== 'poster' && kind !== 'blank') return null
  const num = (raw: string | null | undefined) => { const n = Number(raw); return raw && Number.isFinite(n) ? n : 0 }
  const half = (get(PORTAL_HEADERS.half) ?? '').split(',')
  return {
    kind,
    halfDeg: [num(half[0]), num(half[1])],
    arcDeg: num(get(PORTAL_HEADERS.arc)),
    ms: num(get(PORTAL_HEADERS.ms)),
    censor: get(PORTAL_HEADERS.censor) || 'off',
  }
}

export type PortalBand = 'rows' | 'strip'
export interface PortalSceneItem {
  key: string
  x: number; y: number
  size: PortalSize
  row: number
  mediaId: number | null
  stillMs: number | null
  lift: Keyframe
  shade: Keyframe
  enter: Keyframe
  dz: number
  op: number
}
export interface PortalScene {
  rev: number
  interactive: boolean
  shown: Keyframe
  dim: number
  scroll: Keyframe[]
  items: PortalSceneItem[]
}
export interface PortalBandPose { band: PortalBand; pose: number[]; metres: number; curvature: number; width: number; height: number }
export interface PortalSceneWorld extends PortalScene {
  seat: number[]
  bands: PortalBandPose[]
  fade: Keyframe
}
export interface PortalWarm { mediaId: number; path: string; stillMs: number | null; startMs: number | null; width: number; height: number; durationMs: number }
export interface PortalDiveAsk {
  kind: DiveKind; key: string; startMs: number; slideMs: number; same: boolean; full: 180 | 360
  mediaId: number | null; path: string | null
  width: number; height: number
  resumeMs: number | null
  keyframeMs: number | null
}
export interface PortalStatus {
  phase: 'library' | 'dive' | 'watching' | 'back'
  diveKey: string | null
  liveAtMs: number | null
  failedKey: string | null
  error: { key: string; atMs: number } | null
  playing: { path: string; mediaId: number | null; positionMs: number; projection: ProjectionKind; title: string } | null
  offer: boolean
  offerCheck: { checking: boolean; message: string | null }
  limited: boolean
  device: string | null
  pc: string
}
export type PortalUp =
  | { kind: 'scene'; scene: PortalScene }
  | { kind: 'warm'; warm: PortalWarm | null }
  | { kind: 'dive'; dive: PortalDiveAsk }
  | { kind: 'reverse'; atMs: number; failed: boolean }
  | { kind: 'offer'; action: 'show' | 'hide' | 'purchased' }
  | { kind: 'buzz'; buzz: 'hover' | 'pick' | 'error' }
  | { kind: 'hide' }
  | { kind: 'status'; status: PortalStatus }
  | { kind: 'back' }
export type PortalToScene =
  | { kind: 'scene'; scene: PortalSceneWorld }
  | { kind: 'warm'; warm: PortalWarm | null }
  | { kind: 'dive'; dive: PortalDiveAsk }
  | { kind: 'reverse'; atMs: number; failed: boolean }
  | { kind: 'offer'; action: 'show' | 'hide' | 'purchased' }
  | { kind: 'devShortcut'; name: 'back' }
  | { kind: 'censor' }
export type PortalToPanel =
  | { kind: 'status'; status: PortalStatus }
  | { kind: 'back' }
  | { kind: 'summon'; atMs: number }
  | { kind: 'changed' }
  | { kind: 'dev'; op: PortalDevOp }
export type PortalDevOp =
  | { op: 'hover'; key: string | null } | { op: 'trigger' } | { op: 'back' }
  | { op: 'scroll'; row: number; steps: number }
  | { op: 'press'; target: 'search' | 'keyboard' | 'tags' | 'return' | 'retry' | 'hint' | string } | { op: 'type'; text: string }
  | { op: 'dump'; path: string } | { op: 'mirror'; prefix: string } | { op: 'eye'; offset: Vec3 | null } | { op: 'debug'; on: boolean }
  | { op: 'hold'; on: boolean }
  | { op: 'trace' }
  | { op: 'frames'; since: number }
