import type { AxisId } from '@shared/axes'
import type { MediaRow } from '@shared/library'
import { rowMatches, type ChanceRule, type Range, type SessionClip, type SessionEntry, type SessionPhase, type SessionSetup, type SourceRef } from '@shared/session'
import { buildPhases, intensityAt, phaseAt, type Rng } from './pacing'
import { eligibleVideos, intensityWeight, matchesTimeRule, sessionIssues, videoIntensities, type SessionIssue } from './rules'

export interface PlanInput {
  candidates: MediaRow[]
  setup: SessionSetup
  playlists: ReadonlyMap<number, ReadonlySet<number>>
  skip: ReadonlySet<number>
}

export interface Plan {
  clips: SessionClip[]
  phases: SessionPhase[]
  totalMs: number
  pool: MediaRow[]
  issues: SessionIssue[]
}

const MAX_CLIPS = 1000
const REPEAT_PENALTY = 0.05
const KIND_RANK: Record<SourceRef['kind'], number> = { section: 1, tag: 2, folder: 3, playlist: 4, video: 5 }
const START_SAMPLES = 64
const TOP_SHARE = [0.6, 0.3, 0.1]

interface RowRules {
  clip: Range | null
  axesOff: AxisId[]
  chance: ChanceRule[]
}

function rulesFor(row: MediaRow, entries: SessionEntry[], playlists: PlanInput['playlists']): RowRules {
  let clip: Range | null = null
  let clipRank = 0
  const axesOff = new Set<AxisId>()
  const chance: ChanceRule[] = []
  for (const e of entries) {
    if (e.role === 'exclude' || !rowMatches(row, e.ref, playlists)) continue
    if (e.clipMinS !== undefined && e.clipMaxS !== undefined && KIND_RANK[e.ref.kind] >= clipRank) {
      clip = [e.clipMinS, e.clipMaxS]
      clipRank = KIND_RANK[e.ref.kind]
    }
    for (const a of e.axesOff ?? []) axesOff.add(a)
    if (e.chance) chance.push(e.chance)
  }
  return { clip, axesOff: [...axesOff], chance }
}

function weightedIndex(weights: number[], rng: Rng): number {
  let sum = 0
  for (const w of weights) sum += w
  if (sum <= 0) return Math.floor(rng() * weights.length)
  let r = rng() * sum
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i] ?? 0
    if (r < 0) return i
  }
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i]! > 0) return i
  return 0
}

const DEAD_FLOOR = 0.08
const RANDOM_TRIES = 8
const DEAD_TOLERANCE = 0.25

export function pickStart(row: MediaRow, lenMs: number, target: number | null, rng: Rng): number {
  const latest = Math.max(0, row.durationMs - lenMs)
  if (latest === 0) return 0
  const heat = row.heat
  const n = heat.length
  let max = 0
  for (const h of heat) if (h > max) max = h
  if (n === 0 || max <= 0) return Math.round(rng() * latest)

  const bucketMs = row.durationMs / n
  const floor = max * DEAD_FLOOR
  const speed = [0]
  const active = [0]
  for (const h of heat) {
    const on = h >= floor
    speed.push((speed[speed.length - 1] ?? 0) + (on ? h / max : 0))
    active.push((active[active.length - 1] ?? 0) + (on ? 1 : 0))
  }
  const at = (prefix: number[], per: (i: number) => number, x: number) => {
    if (x >= n) return prefix[n] ?? 0
    const i = Math.floor(x)
    return (prefix[i] ?? 0) + (x - i) * per(i)
  }
  const win = lenMs / bucketMs
  const stats = (s: number) => {
    const e = Math.min(n, s + win)
    const span = Math.max(1e-9, e - s)
    const on = at(active, (i) => ((heat[i] ?? 0) >= floor ? 1 : 0), e) - at(active, (i) => ((heat[i] ?? 0) >= floor ? 1 : 0), s)
    const sum = at(speed, (i) => ((heat[i] ?? 0) >= floor ? (heat[i] ?? 0) / max : 0), e) - at(speed, (i) => ((heat[i] ?? 0) >= floor ? (heat[i] ?? 0) / max : 0), s)
    return { mean: on > 0 ? sum / on : 0, dead: 1 - on / span }
  }
  const latestBucket = latest / bucketMs
  const toMs = (s: number) => Math.round(Math.min(latest, Math.max(0, s * bucketMs + (rng() - 0.5) * bucketMs * 0.5)))

  if (target === null) {
    let best: { s: number; dead: number } | null = null
    for (let k = 0; k < RANDOM_TRIES; k++) {
      const s = rng() * latestBucket
      const { dead } = stats(s)
      if (dead <= DEAD_TOLERANCE) return toMs(s)
      if (!best || dead < best.dead) best = { s, dead }
    }
    return best ? toMs(best.s) : 0
  }

  const samples = Math.min(START_SAMPLES, Math.ceil(latestBucket) + 1)
  const scored: Array<{ s: number; score: number }> = []
  for (let k = 0; k < samples; k++) {
    const s = samples === 1 ? 0 : (k / (samples - 1)) * latestBucket
    const { mean, dead } = stats(s)
    scored.push({ s, score: -Math.abs(mean - target) - dead })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, TOP_SHARE.length)
  const pick = top[Math.min(top.length - 1, weightedIndex(TOP_SHARE.slice(0, top.length), rng))] ?? scored[0]
  return pick ? toMs(pick.s) : 0
}

export function planSession(input: PlanInput, rng: Rng = Math.random): Plan {
  const { setup, playlists } = input
  const totalMs = Math.round(setup.totalMin + rng() * Math.max(0, setup.totalMax - setup.totalMin)) * 60_000
  const phases = buildPhases(setup.pacing, totalMs, rng)
  const entries = setup.entries
  const pool = eligibleVideos(input.candidates, setup, playlists, input.skip)
  const issues = sessionIssues(pool, setup, playlists)
  if (issues.length) return { clips: [], phases, totalMs, pool, issues }
  const intensities = setup.matchVideos ? videoIntensities(pool) : new Map<number, number>()
  const boundaries = [...new Set([totalMs, ...setup.timeRules.flatMap((r) => [r.from * totalMs, r.to * totalMs]), ...phases.filter((p) => p.hard).map((p) => p.endMs)])]
    .map(Math.round)
    .sort((a, b) => a - b)
  const rules = pool.map((row) => rulesFor(row, entries, playlists))
  const used = new Map<number, number>()
  const clips: SessionClip[] = []
  let t = 0
  while (t < totalMs && clips.length < MAX_CLIPS) {
    const p = t / totalMs
    const active = setup.timeRules.filter((r) => t >= Math.round(r.from * totalMs) && t < Math.round(r.to * totalMs))
    const target = intensityAt(phases, t)
    const weights = pool.map((row, i) => {
      if (active.some((rule) => rule.mode === 'require' && !matchesTimeRule(row, rule, playlists))) return 0
      let w = intensityWeight(intensities.get(row.id), target)
      for (const rule of active) if (rule.mode === 'prefer' && matchesTimeRule(row, rule, playlists)) w *= 2
      for (const c of rules[i]?.chance ?? []) if (p >= c.from && p <= c.to) w *= Math.max(0, 1 + c.percent / 100)
      return w * REPEAT_PENALTY ** Math.min(20, used.get(row.id) ?? 0)
    })
    if (weights.every((w) => w <= 0)) return { clips: [], phases, totalMs, pool, issues: [{ kind: 'required', ruleId: active[0]?.id, from: p, to: 1 }] }
    const i = weightedIndex(weights, rng)
    const row = pool[i]
    const rule = rules[i]
    if (!row || !rule) break
    const [minS, maxS] = rule.clip ?? [setup.clipMinS, setup.clipMaxS]
    const phaseIndex = phaseAt(phases, t)
    const cap = (boundaries.find((boundary) => boundary > t) ?? totalMs) - t
    let lenMs = (minS + rng() * Math.max(0, maxS - minS)) * 1000
    lenMs = Math.max(1, Math.min(Math.round(lenMs), cap, row.durationMs))
    const intensity = intensityAt(phases, t + lenMs / 2)
    const startMs = pickStart(row, lenMs, intensity, rng)
    clips.push({ row, startMs, endMs: Math.min(row.durationMs, startMs + lenMs), intensity, axesOff: rule.axesOff, phase: phaseIndex })
    used.set(row.id, (used.get(row.id) ?? 0) + 1)
    t += lenMs
  }
  return { clips: t < totalMs ? [] : clips, phases, totalMs, pool, issues: t < totalMs ? [{ kind: 'length', from: t / totalMs, to: 1 }] : [] }
}

export function sessionRemainingMs(plan: SessionClip[], index: number, timeMs: number): number {
  let ms = 0
  plan.forEach((c, i) => {
    if (i > index) ms += c.endMs - c.startMs
    else if (i === index) ms += Math.max(0, c.endMs - Math.max(timeMs, c.startMs))
  })
  return ms
}

export function sessionElapsedMs(plan: SessionClip[], index: number, timeMs: number): number {
  let ms = 0
  plan.forEach((c, i) => {
    if (i < index) ms += c.endMs - c.startMs
    else if (i === index) ms += Math.min(c.endMs - c.startMs, Math.max(0, timeMs - c.startMs))
  })
  return ms
}
