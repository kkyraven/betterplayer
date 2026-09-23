import type { MessageKey } from './i18n'
import type { AxisId } from './axes'

export interface OrphanFile {
  name: string
  suffix: string
  axis: AxisId
}

export interface OrphanSet {
  id: string
  rootId: number
  dir: string
  folder: string
  stem: string
  files: OrphanFile[]
  durationMs: number
  candidates: MatchCandidate[]
}

export type MatchReason = 'duration' | 'durationNear' | 'name' | 'nameNear' | 'time' | 'folder'

export interface MatchCandidate {
  mediaId: number
  title: string
  stem: string
  rootId: number
  folder: string
  durationMs: number
  confidence: number
  reasons: MatchReason[]
}

export interface MatcherReport {
  sets: OrphanSet[]
  at: number
}

export interface MatcherResolveResult {
  renamed: string[]
  failed: { name: string; error: string }[]
}

export const LIKELY = 0.8
export const MIN_CONFIDENCE = 0.3

export const REASON_LABEL: Record<MatchReason, MessageKey> = {
  duration: 'matchReason.duration',
  durationNear: 'matchReason.durationNear',
  name: 'matchReason.name',
  nameNear: 'matchReason.nameNear',
  time: 'matchReason.time',
  folder: 'matchReason.folder',
}

const SUFFIX_AXIS: ReadonlyMap<string, AxisId> = new Map<string, AxisId>([
  ...(['stroke', 'l0', 'up', 'raw'] as const).map((s) => [s, 'L0'] as const),
  ...(['surge', 'l1', 'forward'] as const).map((s) => [s, 'L1'] as const),
  ...(['sway', 'l2', 'left'] as const).map((s) => [s, 'L2'] as const),
  ...(['twist', 'r0', 'yaw'] as const).map((s) => [s, 'R0'] as const),
  ...(['roll', 'r1'] as const).map((s) => [s, 'R1'] as const),
  ...(['pitch', 'r2'] as const).map((s) => [s, 'R2'] as const),
  ...(['vib', 'v0'] as const).map((s) => [s, 'V0'] as const),
  ...(['pump', 'v1'] as const).map((s) => [s, 'V1'] as const),
  ...(['valve', 'a0'] as const).map((s) => [s, 'A0'] as const),
  ...(['suck', 'a1', 'suckmanual'] as const).map((s) => [s, 'A1'] as const),
  ...(['lube', 'a2'] as const).map((s) => [s, 'A2'] as const),
  ['alpha', 'EA'],
  ['beta', 'EB'],
  ['volume', 'EV'],
  ...(['frequency', 'c0'] as const).map((s) => [s, 'C0'] as const),
  ...(['pulse_frequency', 'p0'] as const).map((s) => [s, 'P0'] as const),
  ...(['pulse_width', 'p1'] as const).map((s) => [s, 'P1'] as const),
  ...(['pulse_interval_random', 'p2'] as const).map((s) => [s, 'P2'] as const),
  ...(['pulse_rise_time', 'p3'] as const).map((s) => [s, 'P3'] as const),
  ['e1', 'E1'],
  ['e2', 'E2'],
  ['e3', 'E3'],
  ['e4', 'E4'],
  ['shock', 'S0'],
  ['s0', 'S0'],
])

export function parseScriptName(name: string): { stem: string; suffix: string; axis: AxisId } | null {
  const m = /^(.*)\.funscript$/i.exec(name)
  if (!m || !m[1]) return null
  const base = m[1]
  const dot = base.lastIndexOf('.')
  if (dot > 0) {
    const suffix = base.slice(dot + 1)
    const axis = SUFFIX_AXIS.get(suffix.toLowerCase())
    if (axis) return { stem: base.slice(0, dot), suffix, axis }
  }
  return { stem: base, suffix: '', axis: 'L0' }
}

const NOISE = /^(\d{3,4}p|[4568]k|\d{2,3}fps|h26[45]|hevc|x26[45]|av1|sbs|ou|tb|lr|180|360|vr|2d|3d|fisheye|mkx2[02]0|rf52|fs|hq|uhd|hd|fhd|oculus|gearvr|psvr|original|funscript|script)$/

export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[\[\](){}_\-.,+'"!]/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '' && !NOISE.test(t))
}

function commonRun(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  let prev = new Uint16Array(b.length + 1)
  let cur = new Uint16Array(b.length + 1)
  let best = 0
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const v = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? prev[j - 1]! + 1 : 0
      cur[j] = v
      if (v > best) best = v
    }
    ;[prev, cur] = [cur, prev]
  }
  return best
}

export function nameSimilarity(a: string, b: string): number {
  const ta = nameTokens(a)
  const tb = nameTokens(b)
  if (ta.length === 0 || tb.length === 0) return 0
  const ja = ta.join(' ')
  const jb = tb.join(' ')
  if (ja === jb) return 1
  const setB = new Set(tb)
  const shared = new Set(ta.filter((t) => setB.has(t))).size
  const dice = (2 * shared) / (new Set(ta).size + setB.size)
  const containment = shared / Math.min(new Set(ta).size, setB.size)
  const tokenSim = 0.5 * dice + 0.5 * containment
  const ca = ja.replace(/ /g, '')
  const cb = jb.replace(/ /g, '')
  const run = ca.length <= 120 && cb.length <= 120 ? commonRun(ca, cb) / Math.max(ca.length, cb.length) : 0
  return Math.max(tokenSim, run)
}

export interface MatchFeatures {
  durationDiffMs: number | null
  videoDurationMs: number
  name: number
  timeDiffMs: number | null
  sameFolder: boolean
}

const SECOND = 1000
const HOUR = 3600 * SECOND
const DAY = 24 * HOUR

export function scoreMatch(f: MatchFeatures): { confidence: number; reasons: MatchReason[] } {
  let score = 0
  const reasons: MatchReason[] = []
  if (f.durationDiffMs !== null && f.videoDurationMs > 0) {
    const rel = f.durationDiffMs / f.videoDurationMs
    if (f.durationDiffMs <= SECOND) {
      score += 0.55
      reasons.push('duration')
    } else if (f.durationDiffMs <= 3 * SECOND || rel <= 0.005) {
      score += 0.5
      reasons.push('durationNear')
    } else if (rel <= 0.05) {
      score += 0.3 - ((rel - 0.005) / 0.045) * 0.25
      reasons.push('durationNear')
    }
  }
  if (f.name >= 0.95) {
    score += 0.45
    reasons.push('name')
  } else if (f.name >= 0.5) {
    score += 0.45 * f.name
    reasons.push('nameNear')
  }
  if (reasons.length === 0) return { confidence: 0, reasons }
  if (f.timeDiffMs !== null) {
    const bonus = f.timeDiffMs <= HOUR ? 0.1 : f.timeDiffMs <= DAY ? 0.07 : f.timeDiffMs <= 7 * DAY ? 0.04 : 0
    if (bonus > 0) {
      score += bonus
      reasons.push('time')
    }
  }
  if (f.sameFolder) {
    score += 0.05
    reasons.push('folder')
  }
  return { confidence: Math.min(1, score), reasons }
}

export function renamedScript(videoStem: string, file: OrphanFile): string {
  return `${videoStem}${file.suffix ? `.${file.suffix}` : ''}.funscript`
}
