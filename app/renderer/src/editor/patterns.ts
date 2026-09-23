import type { EditorPoint, Pattern } from '@shared/editor'
import { clampPos, normalise, placeShape, type Turn } from './ops'

export interface Sample {
  t: number
  v: number
}

export const TURN_HYSTERESIS = 0.15
export const TURN_MIN_PERIOD_MS = 120

export function findTurns(samples: Sample[], hysteresis = TURN_HYSTERESIS * 100, minPeriodMs = TURN_MIN_PERIOD_MS): Turn[] {
  const out: Turn[] = []
  const first = samples[0]
  if (!first) return out
  let dir: 1 | -1 | 0 = 0
  let hi = first
  let lo = first
  const confirm = (turn: Turn) => {
    const last = out[out.length - 1]
    if (last && turn.t - last.t < minPeriodMs) {
      out.pop()
      return
    }
    out.push(turn)
  }
  for (const s of samples) {
    if (dir >= 0 && s.v > hi.v) hi = s
    if (dir <= 0 && s.v < lo.v) lo = s
    if (dir >= 0 && hi.v - s.v > hysteresis) {
      if (dir === 0 && lo.t < hi.t && hi.v - lo.v > hysteresis) confirm({ t: lo.t, v: lo.v, kind: 'bottom' })
      confirm({ t: hi.t, v: hi.v, kind: 'top' })
      dir = -1
      lo = s
    } else if (dir <= 0 && s.v - lo.v > hysteresis) {
      if (dir === 0 && hi.t < lo.t && hi.v - lo.v > hysteresis) confirm({ t: hi.t, v: hi.v, kind: 'top' })
      confirm({ t: lo.t, v: lo.v, kind: 'bottom' })
      dir = 1
      hi = s
    }
  }
  return out
}

export interface Cycle {
  start: number
  top: number
  end: number
  startV: number
  topV: number
  endV: number
  amplitude: number
}

export function cycles(turns: Turn[]): Cycle[] {
  const out: Cycle[] = []
  for (let i = 0; i < turns.length - 2; i++) {
    const a = turns[i]
    const top = turns[i + 1]
    const b = turns[i + 2]
    if (!a || !top || !b || a.kind !== 'bottom' || top.kind !== 'top' || b.kind !== 'bottom') continue
    out.push({ start: a.t, top: top.t, end: b.t, startV: a.v, topV: top.v, endV: b.v, amplitude: top.v - Math.min(a.v, b.v) })
  }
  return out
}

export type HeightMode = 'pattern' | 'motion' | 'range'

export interface PlaceOptions {
  mode: HeightMode
  min: number
  max: number
}

const extent = (shape: ReadonlyArray<[number, number]>) => {
  let lo = 100
  let hi = 0
  for (const [, h] of shape) {
    lo = Math.min(lo, h)
    hi = Math.max(hi, h)
  }
  return { lo, hi }
}

export function heights(shape: ReadonlyArray<[number, number]>, cycle: Cycle, o: PlaceOptions): Array<[number, number]> {
  const { lo, hi } = extent(shape)
  const span = Math.max(1, hi - lo)
  if (o.mode === 'pattern') return shape.map(([p, h]) => [p, h])
  if (o.mode === 'motion') return shape.map(([p, h]) => [p, clampPos(lo + (h - lo) * (cycle.amplitude / span))])
  return shape.map(([p, h]) => [p, clampPos(o.min + ((h - lo) / span) * (o.max - o.min))])
}

export function placePattern(pattern: Pattern, cycles: Cycle[], o: PlaceOptions): EditorPoint[][] {
  const out: EditorPoint[][] = []
  let previousEnd = -1
  for (const c of cycles) {
    const stroke = normalise(placeShape(heights(pattern.points, c, o), c.start, c.top, c.end))
    if (stroke.length < 2) continue
    if (stroke[0]?.at === previousEnd) stroke.shift()
    if (stroke.length === 0) continue
    previousEnd = stroke[stroke.length - 1]?.at ?? -1
    out.push(stroke)
  }
  return out
}

export function placeAtPeriod(pattern: Pattern, startMs: number, endMs: number, periodMs: number, o: PlaceOptions): EditorPoint[][] {
  if (periodMs < TURN_MIN_PERIOD_MS) return []
  const made: Cycle[] = []
  for (let t = startMs; t + periodMs <= endMs + 1; t += periodMs) {
    let topPhase = 0.5
    let best = -Infinity
    for (const [p, h] of pattern.points) if (h > best) [best, topPhase] = [h, p]
    made.push({ start: t, top: t + periodMs * topPhase, end: t + periodMs, startV: 0, topV: 100, endV: 0, amplitude: 100 })
  }
  return placePattern(pattern, made, o)
}

export function adjustStrokes(strokes: EditorPoint[][], phaseMs: number, depth: number): EditorPoint[][] {
  return strokes.map((s) => s.map((p) => ({ at: Math.round(p.at + phaseMs), pos: clampPos(50 + (p.pos - 50) * depth) })))
}

export function patternFromPoints(points: EditorPoint[]): Array<[number, number]> | null {
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last || points.length < 2 || last.at <= first.at) return null
  return points.map((p) => [Math.round(((p.at - first.at) / (last.at - first.at)) * 1000) / 1000, Math.round(p.pos)])
}

export function fillEnd(points: EditorPoint[], startMs: number, endMs: number, replace: boolean): { endMs: number; stoppedBy: 'point' | null } {
  if (replace) return { endMs, stoppedBy: null }
  const blocker = points.find((p) => p.at > startMs && p.at < endMs)
  return blocker ? { endMs: blocker.at, stoppedBy: 'point' } : { endMs, stoppedBy: null }
}
