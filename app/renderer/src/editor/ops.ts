import type { EditorPoint } from '@shared/editor'

export type Point = EditorPoint
export type Simplify = (points: Point[], eps: number) => Point[]

export const clampPos = (pos: number) => Math.min(100, Math.max(0, pos))

export function normalise(points: Point[]): Point[] {
  const sorted = points
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.pos))
    .map((p) => ({ at: Math.max(0, Math.round(p.at)), pos: clampPos(p.pos) }))
    .sort((a, b) => a.at - b.at)
  const out: Point[] = []
  for (const p of sorted) {
    const last = out[out.length - 1]
    if (last && last.at === p.at) out[out.length - 1] = p
    else out.push(p)
  }
  return out
}

export function indexAt(points: Point[], t: number): number {
  let lo = 0
  let hi = points.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((points[mid]?.at ?? Infinity) < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function valueAt(points: Point[], t: number): number {
  if (points.length === 0) return 50
  const i = indexAt(points, t)
  const b = points[i]
  const a = points[i - 1]
  if (!a) return b?.pos ?? 50
  if (!b) return a.pos
  if (b.at === a.at) return b.pos
  return a.pos + ((b.pos - a.pos) * (t - a.at)) / (b.at - a.at)
}

export function around(points: Point[], t: number): { before: Point | null; after: Point | null } {
  const i = indexAt(points, t)
  const atT = points[i]?.at === t ? i : -1
  return { before: (atT >= 0 ? points[atT - 1] : points[i - 1]) ?? null, after: (atT >= 0 ? points[atT + 1] : points[i]) ?? null }
}

export function selectedIndices(points: Point[], selection: ReadonlySet<number>): number[] {
  if (selection.size === 0) return []
  const out: number[] = []
  for (let i = 0; i < points.length; i++) if (selection.has(points[i]?.at ?? -1)) out.push(i)
  return out
}

export function selectionSpan(points: Point[], selection: ReadonlySet<number>): { startMs: number; endMs: number } | null {
  const idx = selectedIndices(points, selection)
  const first = points[idx[0] ?? -1]
  const last = points[idx[idx.length - 1] ?? -1]
  return first && last ? { startMs: first.at, endMs: last.at } : null
}

export function insertPoint(points: Point[], p: Point): Point[] {
  return normalise([...points, p])
}

export function removeTimes(points: Point[], times: ReadonlySet<number>): Point[] {
  return points.filter((p) => !times.has(p.at))
}

export function replaceRange(points: Point[], startMs: number, endMs: number, added: Point[]): Point[] {
  return normalise([...points.filter((p) => p.at < startMs || p.at > endMs), ...added])
}

export type Kind = 'top' | 'bottom' | 'mid'

export function kinds(points: Point[]): Kind[] {
  return points.map((p, i) => {
    const a = points[i - 1]
    const b = points[i + 1]
    const up = a ? p.pos > a.pos : b ? p.pos > b.pos : false
    const down = a ? p.pos < a.pos : b ? p.pos < b.pos : false
    const nextUp = b ? b.pos > p.pos : a ? a.pos < p.pos : false
    const nextDown = b ? b.pos < p.pos : a ? a.pos > p.pos : false
    if ((up || (!a && nextDown)) && (nextDown || (!b && up))) return 'top'
    if ((down || (!a && nextUp)) && (nextUp || (!b && down))) return 'bottom'
    return 'mid'
  })
}

export function move(points: Point[], selection: ReadonlySet<number>, dPos: number, dMs: number): Point[] {
  const idx = selectedIndices(points, selection)
  if (idx.length === 0) return points
  let limit = dMs
  if (dMs !== 0) {
    for (const i of idx) {
      const p = points[i]
      if (!p) continue
      if (dMs > 0) {
        const next = points[i + 1]
        if (next && !selection.has(next.at)) limit = Math.min(limit, next.at - 1 - p.at)
      } else {
        const prev = points[i - 1]
        if (prev && !selection.has(prev.at)) limit = Math.max(limit, prev.at + 1 - p.at)
      }
    }
  }
  const shift = Math.round(limit)
  return normalise(points.map((p) => (selection.has(p.at) ? { at: p.at + shift, pos: clampPos(p.pos + dPos) } : p)))
}

export function scaleDepth(points: Point[], selection: ReadonlySet<number>, factor: number): Point[] {
  const idx = selectedIndices(points, selection)
  if (idx.length === 0) return points
  const values = idx.map((i) => points[i]?.pos ?? 50)
  const centre = (Math.min(...values) + Math.max(...values)) / 2
  return points.map((p) => (selection.has(p.at) ? { at: p.at, pos: clampPos(centre + (p.pos - centre) * factor) } : p))
}

export function scaleTime(points: Point[], selection: ReadonlySet<number>, factor: number): Point[] {
  const idx = selectedIndices(points, selection)
  const first = points[idx[0] ?? -1]
  const last = points[idx[idx.length - 1] ?? -1]
  if (!first || !last || idx.length < 2) return points
  let f = Math.max(0.05, factor)
  const next = points[(idx[idx.length - 1] ?? 0) + 1]
  if (next && !selection.has(next.at)) f = Math.min(f, (next.at - 1 - first.at) / Math.max(1, last.at - first.at))
  return normalise(points.map((p) => (selection.has(p.at) ? { at: first.at + (p.at - first.at) * f, pos: p.pos } : p)))
}

export function flatten(points: Point[], selection: ReadonlySet<number>, top?: number, bottom?: number): Point[] {
  const idx = selectedIndices(points, selection)
  if (idx.length === 0) return points
  const k = kinds(points)
  const values = idx.map((i) => points[i]?.pos ?? 50)
  const hi = top ?? Math.max(...values)
  const lo = bottom ?? Math.min(...values)
  return points.map((p, i) => (selection.has(p.at) && k[i] !== 'mid' ? { at: p.at, pos: clampPos(k[i] === 'top' ? hi : lo) } : p))
}

export function invert(points: Point[], selection: ReadonlySet<number>): Point[] {
  return points.map((p) => (selection.has(p.at) ? { at: p.at, pos: 100 - p.pos } : p))
}

export function reverse(points: Point[], selection: ReadonlySet<number>): Point[] {
  const span = selectionSpan(points, selection)
  if (!span) return points
  return normalise(points.map((p) => (selection.has(p.at) ? { at: span.startMs + span.endMs - p.at, pos: p.pos } : p)))
}

export function rangeExtend(points: Point[], selection: ReadonlySet<number>, min: number, max: number): Point[] {
  const idx = selectedIndices(points, selection)
  if (idx.length === 0) return points
  const values = idx.map((i) => points[i]?.pos ?? 50)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const scale = hi > lo ? (max - min) / (hi - lo) : 0
  return points.map((p) => (selection.has(p.at) ? { at: p.at, pos: clampPos(hi > lo ? min + (p.pos - lo) * scale : (min + max) / 2) } : p))
}

export function quantise(points: Point[], selection: ReadonlySet<number>, grid: ArrayLike<number>): Point[] {
  if (grid.length === 0) return points
  return normalise(points.map((p) => (selection.has(p.at) ? { at: nearest(grid, p.at), pos: p.pos } : p)))
}

export function nearest(sorted: ArrayLike<number>, t: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((sorted[mid] ?? Infinity) < t) lo = mid + 1
    else hi = mid
  }
  const a = sorted[lo - 1]
  const b = sorted[lo]
  if (a === undefined) return b ?? t
  if (b === undefined) return a
  return t - a <= b - t ? a : b
}

export function loopStroke(points: Point[], selection: ReadonlySet<number>, times: number): Point[] {
  const idx = selectedIndices(points, selection)
  const first = points[idx[0] ?? -1]
  const last = points[idx[idx.length - 1] ?? -1]
  if (!first || !last || idx.length < 2 || times < 1) return points
  const stroke = idx.map((i) => points[i]).filter((p): p is Point => p !== undefined)
  const period = last.at - first.at
  const copies: Point[] = []
  for (let n = 1; n <= times; n++) for (const p of stroke.slice(n === 0 ? 0 : 1)) copies.push({ at: p.at + period * n, pos: p.pos })
  const end = last.at + period * times
  return normalise([...points.filter((p) => p.at <= last.at || p.at > end), ...copies])
}

export function loopOnCycles(points: Point[], selection: ReadonlySet<number>, cycles: ReadonlyArray<{ start: number; top: number; end: number }>): Point[] {
  const idx = selectedIndices(points, selection)
  const stroke = idx.map((i) => points[i]).filter((p): p is Point => p !== undefined)
  const first = stroke[0]
  const last = stroke[stroke.length - 1]
  if (!first || !last || stroke.length < 2 || cycles.length === 0) return points
  const shape: Array<[number, number]> = stroke.map((p) => [(p.at - first.at) / Math.max(1, last.at - first.at), p.pos])
  const placed = cycles.flatMap((c) => placeShape(shape, c.start, c.top, c.end))
  const from = cycles[0]?.start ?? 0
  const to = cycles[cycles.length - 1]?.end ?? 0
  return replaceRange(points, from, to, placed)
}

export function placeShape(shape: ReadonlyArray<[number, number]>, start: number, top: number, end: number): Point[] {
  let topPhase = 0.5
  let best = -Infinity
  for (const [phase, h] of shape) if (h > best) [best, topPhase] = [h, phase]
  topPhase = Math.min(0.99, Math.max(0.01, topPhase))
  return shape.map(([phase, h]) => ({
    at: Math.round(phase <= topPhase ? start + (phase / topPhase) * (top - start) : top + ((phase - topPhase) / (1 - topPhase)) * (end - top)),
    pos: clampPos(h),
  }))
}

export function limitSpeed(points: Point[], selection: ReadonlySet<number>, max: number): Point[] {
  if (max <= 0) return points
  const out = points.map((p) => ({ ...p }))
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    const k = kinds(out)
    for (const kind of ['top', 'bottom', 'mid'] as const) {
      for (let i = 0; i < out.length; i++) {
        const p = out[i]
        if (!p || k[i] !== kind || !selection.has(p.at)) continue
        const a = out[i - 1]
        const b = out[i + 1]
        const reachA = a ? (max * (p.at - a.at)) / 1000 : Infinity
        const reachB = b ? (max * (b.at - p.at)) / 1000 : Infinity
        const hi = Math.min(a ? a.pos + reachA : 100, b ? b.pos + reachB : 100)
        const lo = Math.max(a ? a.pos - reachA : 0, b ? b.pos - reachB : 0)
        let next = p.pos
        if (kind === 'top') next = Math.min(p.pos, hi)
        else if (kind === 'bottom') next = Math.max(p.pos, lo)
        else if (lo <= hi) next = Math.min(hi, Math.max(lo, p.pos))
        next = clampPos(next)
        if (Math.abs(next - p.pos) > 1e-9) {
          p.pos = next
          changed = true
        }
      }
    }
    if (!changed) break
  }
  return out
}

export function timesBySpeed(points: Point[], min: number, max: number): number[] {
  const hit = new Set<number>()
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (!a || !b) continue
    const dt = b.at - a.at
    if (dt <= 0) continue
    const speed = (Math.abs(b.pos - a.pos) * 1000) / dt
    if (speed >= min && speed <= max) {
      hit.add(a.at)
      hit.add(b.at)
    }
  }
  return [...hit]
}

export function timesByDepth(points: Point[], min: number, max: number): number[] {
  return points.filter((p) => p.pos >= min && p.pos <= max).map((p) => p.at)
}

export interface Turn {
  t: number
  v: number
  kind: 'top' | 'bottom'
}

export function refit(points: Point[], selection: ReadonlySet<number>, turns: Turn[], maxMs = 250): Point[] {
  const idx = selectedIndices(points, selection)
  if (idx.length === 0 || turns.length === 0) return points
  const k = kinds(points)
  const tops = turns.filter((t) => t.kind === 'top').map((t) => t.t)
  const bottoms = turns.filter((t) => t.kind === 'bottom').map((t) => t.t)
  const target = points.map((p) => p.at)
  for (const i of idx) {
    const p = points[i]
    if (!p || k[i] === 'mid') continue
    const list = k[i] === 'top' ? tops : bottoms
    if (list.length === 0) continue
    const t = nearest(list, p.at)
    if (Math.abs(t - p.at) <= maxMs) target[i] = t
  }
  for (const i of idx) {
    if (k[i] === 'mid') continue
    const lo = (target[i - 1] ?? -Infinity) + 1
    const hi = (points[i + 1]?.at ?? Infinity) - 1
    target[i] = Math.min(hi, Math.max(lo, target[i] ?? 0))
  }
  for (const i of idx) {
    if (k[i] !== 'mid') continue
    let a = i - 1
    while (a >= 0 && k[a] === 'mid') a--
    let b = i + 1
    while (b < points.length && k[b] === 'mid') b++
    const pa = points[a]
    const pb = points[b]
    const p = points[i]
    if (!p) continue
    const shiftA = pa ? (target[a] ?? pa.at) - pa.at : 0
    const shiftB = pb ? (target[b] ?? pb.at) - pb.at : 0
    const u = pa && pb && pb.at > pa.at ? (p.at - pa.at) / (pb.at - pa.at) : 0
    target[i] = p.at + shiftA + (shiftB - shiftA) * u
  }
  return normalise(points.map((p, i) => ({ at: target[i] ?? p.at, pos: p.pos })))
}

export interface LaneChange {
  index: number
  removed: Point[]
  added: Point[]
}

export function diffLane(before: Point[], after: Point[]): LaneChange | null {
  const same = (a: Point | undefined, b: Point | undefined) => a !== undefined && b !== undefined && a.at === b.at && a.pos === b.pos
  let head = 0
  while (head < before.length && head < after.length && same(before[head], after[head])) head++
  let tail = 0
  while (tail < before.length - head && tail < after.length - head && same(before[before.length - 1 - tail], after[after.length - 1 - tail])) tail++
  const removed = before.slice(head, before.length - tail)
  const added = after.slice(head, after.length - tail)
  if (removed.length === 0 && added.length === 0) return null
  return { index: head, removed, added }
}

export function applyChange(points: Point[], change: LaneChange): Point[] {
  return [...points.slice(0, change.index), ...change.added, ...points.slice(change.index + change.removed.length)]
}

export function revertChange(points: Point[], change: LaneChange): Point[] {
  return [...points.slice(0, change.index), ...change.removed, ...points.slice(change.index + change.added.length)]
}

export interface Stats {
  count: number
  spanMs: number
  depth: number
  average: number
  max: number
}

export function stats(points: Point[]): Stats {
  let total = 0
  let time = 0
  let max = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (!a || !b) continue
    const dt = b.at - a.at
    if (dt <= 0) continue
    const speed = (Math.abs(b.pos - a.pos) * 1000) / dt
    total += speed * dt
    time += dt
    if (speed > max) max = speed
  }
  const values = points.map((p) => p.pos)
  const first = points[0]
  const last = points[points.length - 1]
  return {
    count: points.length,
    spanMs: first && last ? last.at - first.at : 0,
    depth: values.length > 0 ? Math.max(...values) - Math.min(...values) : 0,
    average: time > 0 ? total / time : 0,
    max,
  }
}

export function heatBuckets(points: Point[], durationMs: number, n: number): number[] {
  const buckets = new Array<number>(n).fill(0)
  const weights = new Array<number>(n).fill(0)
  if (n === 0 || durationMs <= 0) return buckets
  const bucketMs = durationMs / n
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (!a || !b) continue
    const dt = b.at - a.at
    if (dt <= 0) continue
    const speed = (Math.abs(b.pos - a.pos) * 1000) / dt
    const first = Math.min(n - 1, Math.floor(a.at / bucketMs))
    const last = Math.min(n - 1, Math.floor(b.at / bucketMs))
    for (let k = first; k <= last; k++) {
      const lo = Math.max(a.at, k * bucketMs)
      const hi = Math.min(b.at, (k + 1) * bucketMs)
      const overlap = Math.max(0, hi - lo)
      buckets[k] = (buckets[k] ?? 0) + speed * overlap
      weights[k] = (weights[k] ?? 0) + overlap
    }
  }
  return buckets.map((b, k) => ((weights[k] ?? 0) > 0 ? b / (weights[k] ?? 1) : 0))
}

export function shapeOf(points: Point[]): Array<[number, number]> | null {
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last || points.length < 2 || last.at <= first.at) return null
  return points.map((p) => [(p.at - first.at) / (last.at - first.at), p.pos])
}

export function strokes(points: Point[]): Array<{ from: number; to: number }> {
  const k = kinds(points)
  const bottoms: number[] = []
  k.forEach((kind, i) => {
    if (kind === 'bottom') bottoms.push(i)
  })
  const out: Array<{ from: number; to: number }> = []
  for (let i = 1; i < bottoms.length; i++) out.push({ from: bottoms[i - 1] ?? 0, to: bottoms[i] ?? 0 })
  return out
}
