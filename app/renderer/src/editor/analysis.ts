import type { RangeAnalysis } from 'bp-engine'
import type { Sample } from './patterns'

export interface Thumb {
  timeMs: number
  width: number
  height: number
  rgb: Uint8Array
}

export interface Run {
  startMs: number
  endMs: number
  times: Float64Array
  motion: Float64Array
  cuts: number[]
  thumbs: Thumb[]
}

const STROKE = 0

export class AnalysisCache {
  runs: Run[] = []
  version = 0

  clear() {
    this.runs = []
    this.version++
  }

  add(a: RangeAnalysis) {
    this.runs.push({
      startMs: a.startMs,
      endMs: a.endMs,
      times: a.times,
      motion: a.motion,
      cuts: a.cuts,
      thumbs: a.thumbs.map((t) => ({ timeMs: t.timeMs, width: t.width, height: t.height, rgb: t.rgb })),
    })
    this.version++
  }

  missing(startMs: number, endMs: number, minMs = 1000): Array<[number, number]> {
    const covered = this.runs.map((r) => [r.startMs, r.endMs] as [number, number]).sort((a, b) => a[0] - b[0])
    const out: Array<[number, number]> = []
    let cursor = startMs
    for (const [s, e] of covered) {
      if (e <= cursor) continue
      if (s > cursor) out.push([cursor, Math.min(s, endMs)])
      cursor = Math.max(cursor, e)
      if (cursor >= endMs) break
    }
    if (cursor < endMs) out.push([cursor, endMs])
    return out.filter(([s, e]) => e - s >= minMs)
  }

  private runAt(t: number): Run | null {
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const r = this.runs[i]
      if (r && r.startMs <= t && t <= r.endMs) return r
    }
    return null
  }

  strokeAt(t: number): number | null {
    const r = this.runAt(t)
    if (!r || r.times.length === 0) return null
    let lo = 0
    let hi = r.times.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((r.times[mid] ?? Infinity) < t) lo = mid + 1
      else hi = mid
    }
    const b = lo
    const a = lo - 1
    const ta = r.times[a]
    const tb = r.times[b]
    const va = r.motion[a * 6 + STROKE]
    const vb = r.motion[b * 6 + STROKE]
    if (ta === undefined || va === undefined) return vb === undefined ? null : vb * 100
    if (tb === undefined || vb === undefined) return va * 100
    const u = tb > ta ? (t - ta) / (tb - ta) : 0
    return (va + (vb - va) * u) * 100
  }

  samples(startMs: number, endMs: number): Sample[] {
    const out: Sample[] = []
    let cursor = startMs
    while (cursor < endMs) {
      const r = this.runAt(cursor)
      if (!r) {
        const next = this.runs.map((x) => x.startMs).filter((s) => s > cursor).sort((a, b) => a - b)[0]
        if (next === undefined || next >= endMs) break
        cursor = next
        continue
      }
      const stop = Math.min(endMs, r.endMs)
      for (let i = 0; i < r.times.length; i++) {
        const t = r.times[i] ?? 0
        if (t < cursor || t > stop) continue
        out.push({ t, v: (r.motion[i * 6 + STROKE] ?? 0.5) * 100 })
      }
      cursor = stop + 0.001
    }
    return out
  }

  cuts(startMs: number, endMs: number): number[] {
    const seen = new Set<number>()
    const out: number[] = []
    for (const r of this.runs) {
      for (const c of r.cuts) {
        const key = Math.round(c)
        if (c >= startMs && c <= endMs && !seen.has(key)) {
          seen.add(key)
          out.push(c)
        }
      }
    }
    return out.sort((a, b) => a - b)
  }

  cutsAround(t: number): { before: number | null; after: number | null } {
    let before: number | null = null
    let after: number | null = null
    for (const r of this.runs) {
      for (const c of r.cuts) {
        if (c <= t && (before === null || c > before)) before = c
        if (c > t && (after === null || c < after)) after = c
      }
    }
    return { before, after }
  }

  thumbs(startMs: number, endMs: number): Thumb[] {
    const out: Thumb[] = []
    for (const r of this.runs) for (const t of r.thumbs) if (t.timeMs >= startMs && t.timeMs <= endMs) out.push(t)
    return out.sort((a, b) => a.timeMs - b.timeMs)
  }
}
