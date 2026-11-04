import { DEFAULT_MODEL_SIZE, sizeOf, skinId, type ModelSize } from './censor'
import type { MessageKey } from './i18n'
import { HERO_BUCKET_NAMES, WHITE_BUCKET } from './tracking'
import type { Projection } from './projection'

export const PASSTHROUGH_MODES = ['colour', 'ai'] as const
export type PassthroughMode = (typeof PASSTHROUGH_MODES)[number]

export const FEATHER_KINDS = ['edges', 'distance'] as const
export type FeatherKind = (typeof FEATHER_KINDS)[number]

export const FEATHER_STOPS = [0, 1, 2, 4, 8, 16, 32] as const

export interface PassthroughSettings {
  on: boolean
  mode: PassthroughMode | null
  key: number | null
  feather: FeatherKind
  featherPx: number
}

export const PASSTHROUGH_DEFAULTS: PassthroughSettings = { on: false, mode: null, key: null, feather: 'edges', featherPx: 2 }

export const PASSTHROUGH_FALLBACK_KEY = 0x00b140

export const KEY_CHROMA_TOL = 0.12
export const KEY_LUMA_TOL = 0.24

export const KEY_SOFT_FROM = 0.03
export const KEY_SOFT_TO = 0.95
export const KEY_GREY_FROM = 0.005
export const KEY_GREY_TO = 0.06
export const KEY_FILL = 0.06
export const KEY_FILL_NEAR_FROM = 0.008
export const KEY_FILL_NEAR_TO = 0.02
export const KEY_FILL_FAR_FROM = 0.025
export const KEY_FILL_FAR_TO = 0.06
export const KEY_SPILL = 0.27
export const KEY_MIN_LUMA = 0.08
export const KEY_PATCH_SPREAD = 0.06

export interface AutoKey {
  key: number | null
  candidates: number[]
}

export type PassthroughSource = 'user' | 'auto'
export type PassthroughOnSource = 'user' | 'name' | 'none'

export interface ResolvedPassthrough {
  settings: PassthroughSettings
  on: boolean
  mode: PassthroughMode
  key: number
  feather: FeatherKind
  featherPx: number
  onSource: PassthroughOnSource
  keySource: PassthroughSource
  modeSource: PassthroughSource
  auto: number | null
  candidates: number[]
  aiReady: boolean
  maskDir?: string
}

export const PASSTHROUGH_MODELS = ['people', 'skin'] as const
export type PassthroughModel = (typeof PASSTHROUGH_MODELS)[number]

export const PEOPLE_SIZES = ['medium', 'big', 'huge'] as const satisfies readonly ModelSize[]
export const peopleId = (size: (typeof PEOPLE_SIZES)[number]) => `latex-passthrough-${size}`

export function passthroughModelId(detector: string | null | undefined, model: PassthroughModel = 'people'): string {
  const size = sizeOf(detector) ?? DEFAULT_MODEL_SIZE
  if (model === 'skin') return skinId(size)
  return peopleId(size === 'tiny' || size === 'small' ? 'medium' : size)
}

const unpack = (c: number): [number, number, number] => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]
const unit = (c: number): [number, number, number] => [((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255]
const pack = (r: number, g: number, b: number) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)

export function ycbcr(colour: number): [number, number, number] {
  const [r, g, b] = unit(colour)
  return [0.299 * r + 0.587 * g + 0.114 * b, 0.5 - 0.168736 * r - 0.331264 * g + 0.5 * b, 0.5 + 0.5 * r - 0.418688 * g - 0.081312 * b]
}

export function sameKey(a: number, b: number): boolean {
  const [ya, ba, ra] = ycbcr(a)
  const [yb, bb, rb] = ycbcr(b)
  return Math.hypot(ba - bb, ra - rb) <= KEY_CHROMA_TOL && Math.abs(ya - yb) <= KEY_LUMA_TOL
}

export function keyName(colour: number): MessageKey | null {
  const [r, g, b] = unit(colour)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (max < 0.15) return null
  if (d / max < 0.25) return max >= 0.75 ? (HERO_BUCKET_NAMES[WHITE_BUCKET] ?? null) : null
  const sector = max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  const hue = (sector * 60 + 360) % 360
  return HERO_BUCKET_NAMES[Math.min(WHITE_BUCKET - 1, Math.floor(hue / 30))] ?? null
}

export function eyeRect(p: Projection): { x: number; y: number; w: number; h: number } {
  const second = p.swapEyes ? 0.5 : 0
  if (p.layout === 'sbs') return { x: second, y: 0, w: 0.5, h: 1 }
  if (p.layout === 'ou') return { x: 0, y: second, w: 1, h: 0.5 }
  return { x: 0, y: 0, w: 1, h: 1 }
}

export function eyeToFrame(u: number, v: number, p: Projection): [number, number] {
  const r = eyeRect(p)
  const clamp = (n: number) => Math.max(0, Math.min(1, n))
  return [r.x + clamp(u) * r.w, r.y + clamp(v) * r.h]
}

const INSET = 0.06
const FISHEYE_RING = 0.92

export function keySamplePoints(stage: 1 | 2, p: Projection): [number, number][] {
  const lo = INSET
  const hi = 1 - INSET
  let eye: [number, number][]
  if (p.kind === 'fisheye') {
    const at = (deg: number): [number, number] => [0.5 + 0.5 * FISHEYE_RING * Math.cos((deg * Math.PI) / 180), 0.5 + 0.5 * FISHEYE_RING * Math.sin((deg * Math.PI) / 180)]
    eye = [at(225), at(315), at(135), at(45)]
    if (stage === 2) eye.push(at(270), at(90), at(180), at(0), [0.5, 0.5])
  } else {
    eye = [[lo, lo], [hi, lo], [lo, hi], [hi, hi]]
    if (stage === 2) eye.push([0.5, lo], [0.5, hi], [lo, 0.5], [hi, 0.5], [0.5, 0.5])
  }
  return eye.map(([u, v]) => eyeToFrame(u, v, p))
}

export function patchColour(rgb: Uint8Array, w: number, h: number, x: number, y: number, r: number): number | null {
  const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r)
  const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r)
  if (x0 > x1 || y0 > y1) return null
  let r0 = 0, g0 = 0, b0 = 0, sq = 0, n = 0
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      const at = (j * w + i) * 3
      const pr = (rgb[at] ?? 0) / 255, pg = (rgb[at + 1] ?? 0) / 255, pb = (rgb[at + 2] ?? 0) / 255
      r0 += pr
      g0 += pg
      b0 += pb
      sq += pr * pr + pg * pg + pb * pb
      n++
    }
  }
  const [mr, mg, mb] = [r0 / n, g0 / n, b0 / n]
  if (Math.sqrt(Math.max(0, sq / n - mr * mr - mg * mg - mb * mb) / 3) > KEY_PATCH_SPREAD) return null
  return pack(mr * 255, mg * 255, mb * 255)
}

interface Group {
  colour: number
  votes: number
}

function keyGroups(samples: readonly (number | null)[]): Group[] {
  let left = samples.filter((s): s is number => s !== null)
  const groups: Group[] = []
  while (left.length > 0) {
    let seed = 0
    let best = -1
    for (const s of left) {
      const votes = left.filter((o) => sameKey(s, o)).length
      if (votes > best) [seed, best] = [s, votes]
    }
    const members = left.filter((o) => sameKey(seed, o))
    left = left.filter((o) => !sameKey(seed, o))
    const [r, g, b] = members.reduce<[number, number, number]>(([r, g, b], m) => {
      const [mr, mg, mb] = unpack(m)
      return [r + mr, g + mg, b + mb]
    }, [0, 0, 0])
    groups.push({ colour: pack(r / members.length, g / members.length, b / members.length), votes: members.length })
  }
  const dark = (g: Group) => ycbcr(g.colour)[0] < KEY_MIN_LUMA
  return groups.sort((a, b) => Number(dark(a)) - Number(dark(b)) || b.votes - a.votes)
}

const wins = (g: Group | undefined, n: number): g is Group => g !== undefined && g.votes * 2 > n && ycbcr(g.colour)[0] >= KEY_MIN_LUMA

export function keyColour(samples: readonly (number | null)[]): number | null {
  const [top] = keyGroups(samples)
  return wins(top, samples.length) ? top.colour : null
}

export function autoKey(rgb: Uint8Array, w: number, h: number, p: Projection): AutoKey {
  const r = Math.max(1, Math.round(Math.min(w, h) * 0.02))
  const sample = ([x, y]: [number, number]) => patchColour(rgb, w, h, Math.min(w - 1, Math.floor(x * w)), Math.min(h - 1, Math.floor(y * h)), r)
  const first = keySamplePoints(1, p).map(sample)
  const [top, ...rest] = keyGroups(first)
  if (wins(top, first.length)) return { key: top.colour, candidates: rest.map((g) => g.colour) }
  const all = [...first, ...keySamplePoints(2, p).slice(4).map(sample)]
  const groups = keyGroups(all)
  const [winner, ...others] = groups
  if (wins(winner, all.length)) return { key: winner.colour, candidates: others.map((g) => g.colour) }
  return { key: null, candidates: groups.map((g) => g.colour) }
}

const isColour = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff

export const featherStop = (px: number) => FEATHER_STOPS.reduce((best, s) => (Math.abs(s - px) < Math.abs(best - px) ? s : best), FEATHER_STOPS[0])

export function readPassthrough(raw: unknown): PassthroughSettings | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.on !== 'boolean') return undefined
  const d = PASSTHROUGH_DEFAULTS
  return {
    on: r.on,
    mode: PASSTHROUGH_MODES.find((m) => m === r.mode) ?? null,
    key: isColour(r.key) ? r.key : null,
    feather: FEATHER_KINDS.find((k) => k === r.feather) ?? d.feather,
    featherPx: typeof r.featherPx === 'number' && Number.isFinite(r.featherPx) ? featherStop(r.featherPx) : d.featherPx,
  }
}

export function resolvePassthrough(saved: PassthroughSettings | undefined, name: string, auto: AutoKey | null, aiReady: boolean): ResolvedPassthrough {
  const nameOn = saved === undefined && /passthrough/i.test(name)
  const settings = saved ?? { ...PASSTHROUGH_DEFAULTS, on: nameOn }
  const autoColour = auto ? (auto.key ?? auto.candidates[0] ?? null) : null
  const wanted = settings.mode ?? (auto !== null && auto.key === null ? 'ai' : 'colour')
  return {
    settings,
    on: settings.on,
    mode: wanted === 'ai' && aiReady ? 'ai' : 'colour',
    key: settings.key ?? autoColour ?? PASSTHROUGH_FALLBACK_KEY,
    feather: settings.feather,
    featherPx: settings.featherPx,
    onSource: saved !== undefined ? 'user' : nameOn ? 'name' : 'none',
    keySource: settings.key !== null ? 'user' : 'auto',
    modeSource: settings.mode !== null ? 'user' : 'auto',
    auto: autoColour,
    candidates: auto ? (auto.key !== null ? auto.candidates : auto.candidates.slice(1)) : [],
    aiReady,
  }
}
