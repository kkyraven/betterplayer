import { describe, expect, it } from 'vitest'
import type { MediaRow } from '@shared/library'
import { defaultSessionSetup, type SessionSetup } from '@shared/session'
import { buildPhases, intensityAt } from './pacing'
import { pickStart, planSession, type PlanInput } from './plan'

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

function row(id: number, patch: Partial<MediaRow> = {}): MediaRow {
  return {
    id,
    rootId: 1,
    path: `/v/${id}.mp4`,
    title: `Video ${id}`,
    folder: 'scenes',
    size: 0,
    mtime: 0,
    addedAt: 0,
    durationMs: 20 * 60_000,
    width: 1920,
    height: 1080,
    codec: 'h264',
    projection: 'flat',
    thumb: null,
    strip: null,
    axes: ['L0'],
    averageSpeed: 100,
    heat: Array.from({ length: 60 }, () => 100),
    rating: 0,
    favourite: false,
    watchedMs: null,
    playCount: 0,
    lastPlayed: null,
    tags: [],
    pinned: false,
    hidden: false,
    ...patch,
  }
}

function input(candidates: MediaRow[], setup: Partial<SessionSetup> = {}): PlanInput {
  return { candidates, setup: { ...defaultSessionSetup(), ...setup }, playlists: new Map(), skip: new Set() }
}

describe('buildPhases', () => {
  it('alternates green and red with lengths from the ranges and covers the total', () => {
    const pacing = { ...defaultSessionSetup().pacing, kind: 'rlgl' as const, rlgl: { fastS: [30, 60] as [number, number], slowS: [10, 20] as [number, number], fast: 1, slow: 0.2 } }
    const phases = buildPhases(pacing, 10 * 60_000, lcg(1))
    expect(phases[0]?.label).toBe('Green')
    expect(phases[1]?.label).toBe('Red')
    expect(phases.every((p) => p.hard)).toBe(true)
    expect(phases[phases.length - 1]?.endMs).toBe(10 * 60_000)
    for (const p of phases.slice(0, -1)) {
      const len = (p.endMs - p.startMs) / 1000
      if (p.label === 'Green') expect(len).toBeGreaterThanOrEqual(30)
      if (p.label === 'Green') expect(len).toBeLessThanOrEqual(60)
      if (p.label === 'Red') expect(len).toBeGreaterThanOrEqual(10)
      if (p.label === 'Red') expect(len).toBeLessThanOrEqual(20)
    }
  })

  it('draws different lengths on every build', () => {
    const pacing = { ...defaultSessionSetup().pacing, kind: 'rlgl' as const }
    const a = buildPhases(pacing, 30 * 60_000, lcg(2)).map((p) => p.endMs)
    const b = buildPhases(pacing, 30 * 60_000, lcg(3)).map((p) => p.endMs)
    expect(a).not.toEqual(b)
  })

  it('a ramp runs from its start to its end intensity', () => {
    const pacing = { ...defaultSessionSetup().pacing, kind: 'ramp' as const, ramp: { from: 0.2, to: 0.8 } }
    const phases = buildPhases(pacing, 100_000, lcg(1))
    expect(intensityAt(phases, 0)).toBeCloseTo(0.2)
    expect(intensityAt(phases, 50_000)).toBeCloseTo(0.5)
    expect(intensityAt(phases, 100_000)).toBeCloseTo(0.8)
  })

  it('a custom list that does not repeat holds its last step to the end', () => {
    const pacing = { ...defaultSessionSetup().pacing, kind: 'custom' as const, custom: { steps: [{ lengthS: [10, 10] as [number, number], intensity: 0.3 }, { lengthS: [10, 10] as [number, number], intensity: 0.9 }], repeat: false } }
    const phases = buildPhases(pacing, 100_000, lcg(1))
    expect(phases).toHaveLength(2)
    expect(phases[1]?.endMs).toBe(100_000)
    expect(intensityAt(phases, 90_000)).toBe(0.9)
  })

  it('random pacing has no target', () => {
    const phases = buildPhases({ ...defaultSessionSetup().pacing, kind: 'random' }, 60_000, lcg(1))
    expect(intensityAt(phases, 30_000)).toBeNull()
  })
})

describe('pickStart', () => {
  const heat = Array.from({ length: 60 }, (_, i) => (i < 10 ? 30 : i < 20 ? 0 : i >= 40 && i < 50 ? 200 : 100))
  const r = row(1, { heat, durationMs: 60 * 60_000 })

  it('a target of 1 lands in the busiest stretch', () => {
    for (let seed = 1; seed < 20; seed++) {
      const start = pickStart(r, 120_000, 1, lcg(seed))
      const bucket = start / 60_000
      expect(bucket).toBeGreaterThanOrEqual(39)
      expect(bucket).toBeLessThan(50)
    }
  })

  it('a low target lands in the calmest stretch', () => {
    for (let seed = 1; seed < 20; seed++) {
      const start = pickStart(r, 120_000, 0.05, lcg(seed))
      expect(start / 60_000).toBeLessThan(10)
    }
  })

  it('a one second clip in a long video still lands on its bucket', () => {
    const start = pickStart(r, 1000, 1, lcg(7))
    expect(start / 60_000).toBeGreaterThanOrEqual(39)
    expect(start / 60_000).toBeLessThan(50)
  })

  it('a middle target lands on medium speed, not on a mix of dead and fast', () => {
    for (let seed = 1; seed < 20; seed++) {
      const bucket = pickStart(r, 120_000, 0.5, lcg(seed)) / 60_000
      expect(bucket).toBeGreaterThanOrEqual(19)
      expect(bucket).toBeLessThan(40)
    }
  })

  it('no target means anywhere with action, never the dead stretch', () => {
    const starts = Array.from({ length: 30 }, (_, i) => pickStart(r, 60_000, null, lcg(i * 7919 + 1)) / 60_000)
    expect(new Set(starts.map((s) => Math.floor(s))).size).toBeGreaterThan(5)
    for (const s of starts) expect(s >= 10 && s < 20).toBe(false)
  })
})

describe('planSession', () => {
  it('fills the exact total, shortening the final clip, without repeats while the pool lasts', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1))
    const { clips } = planSession(input(rows, { totalMin: 20, totalMax: 20, clipMinS: 60, clipMaxS: 120 }), lcg(5))
    const total = clips.reduce((a, c) => a + c.endMs - c.startMs, 0)
    expect(total).toBe(20 * 60_000)
    expect(clips.at(-1)!.endMs - clips.at(-1)!.startMs).toBeGreaterThan(0)
    for (const c of clips.slice(0, -1)) {
      expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(60_000)
      expect(c.endMs - c.startMs).toBeLessThanOrEqual(120_000)
    }
    expect(new Set(clips.map((c) => c.row.id)).size).toBe(clips.length)
  })

  it('accepts one second clips', () => {
    const rows = [row(1), row(2), row(3)]
    const { clips } = planSession(input(rows, { totalMin: 1, totalMax: 1, clipMinS: 1, clipMaxS: 1 }), lcg(9))
    expect(clips).toHaveLength(60)
    expect(clips.every((c) => c.endMs - c.startMs === 1000)).toBe(true)
  })

  it('never crosses a red or green boundary', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i + 1))
    const setup: Partial<SessionSetup> = { totalMin: 15, totalMax: 15, clipMinS: 30, clipMaxS: 240, pacing: { ...defaultSessionSetup().pacing, kind: 'rlgl' } }
    const { clips, phases } = planSession(input(rows, setup), lcg(11))
    let t = 0
    for (const c of clips) {
      const len = c.endMs - c.startMs
      const phase = phases[c.phase]
      expect(phase).toBeDefined()
      expect(t).toBeGreaterThanOrEqual(phase?.startMs ?? 0)
      expect(t + len).toBeLessThanOrEqual(phase?.endMs ?? 0)
      t += len
    }
    expect(clips.some((c) => c.intensity === 1)).toBe(true)
    expect(clips.some((c) => c.intensity !== null && c.intensity < 0.5)).toBe(true)
  })

  it('exclude entries, skipped ids, scripted only and required axes shrink the pool', () => {
    const rows = [row(1, { tags: ['pmv'] }), row(2), row(3, { axes: [] }), row(4, { axes: ['L0', 'R0'] }), row(5)]
    const setup: Partial<SessionSetup> = {
      entries: [
        { ref: { kind: 'section', section: 'all' }, role: 'include' },
        { ref: { kind: 'tag', name: 'pmv' }, role: 'exclude' },
      ],
    }
    const base = input(rows, setup)
    const ids = (p: PlanInput) => new Set(planSession(p, lcg(3)).clips.map((c) => c.row.id))
    expect(ids(base)).toEqual(new Set([2, 4, 5]))
    expect(ids({ ...base, skip: new Set([5]) })).toEqual(new Set([2, 4]))
    expect(ids({ ...base, setup: { ...base.setup, requireAxes: ['R0'] } })).toEqual(new Set([4]))
    expect(ids({ ...base, setup: { ...base.setup, scriptedOnly: false } })).toEqual(new Set([2, 3, 4, 5]))
  })

  it('a chance rule of -100% keeps its matches out of that stretch and lets them back after', () => {
    const rows = [row(1, { folder: 'pmv' }), row(2), row(3), row(4)]
    const setup: Partial<SessionSetup> = {
      totalMin: 20,
      totalMax: 20,
      clipMinS: 60,
      clipMaxS: 60,
      entries: [
        { ref: { kind: 'section', section: 'all' }, role: 'include' },
        { ref: { kind: 'folder', rootId: 1, folder: 'pmv', name: 'pmv' }, role: 'modify', chance: { percent: -100, from: 0, to: 0.5 } },
      ],
    }
    const { clips } = planSession(input(rows, setup), lcg(21))
    const firstHalf = clips.slice(0, 10)
    expect(firstHalf.some((c) => c.row.id === 1)).toBe(false)
    expect(clips.slice(10).some((c) => c.row.id === 1)).toBe(true)
  })

  it('a chance rule of +900% makes its matches dominate', () => {
    const rows = [row(1, { tags: ['fav'] }), row(2), row(3), row(4), row(5)]
    const setup: Partial<SessionSetup> = {
      totalMin: 10,
      totalMax: 10,
      clipMinS: 30,
      clipMaxS: 30,
      entries: [
        { ref: { kind: 'section', section: 'all' }, role: 'include' },
        { ref: { kind: 'tag', name: 'fav' }, role: 'modify', chance: { percent: 900, from: 0, to: 1 } },
      ],
    }
    const { clips } = planSession(input(rows, setup), lcg(4))
    expect(clips[0]?.row.id).toBe(1)
  })

  it('entry clip lengths and held axes apply to their matches, the most specific length winning', () => {
    const rows = [row(1, { folder: 'estim', axes: ['L0', 'EA', 'EB'] }), row(2)]
    const setup: Partial<SessionSetup> = {
      totalMin: 5,
      totalMax: 5,
      clipMinS: 60,
      clipMaxS: 60,
      entries: [
        { ref: { kind: 'section', section: 'all' }, role: 'include', clipMinS: 20, clipMaxS: 20 },
        { ref: { kind: 'folder', rootId: 1, folder: 'estim', name: 'estim' }, role: 'modify', clipMinS: 5, clipMaxS: 5, axesOff: ['EA', 'EB'] },
        { ref: { kind: 'video', id: 1, title: 'Video 1' }, role: 'modify', axesOff: ['R0'] },
      ],
    }
    const { clips } = planSession(input(rows, setup), lcg(8))
    const estim = clips.filter((c) => c.row.id === 1)
    const other = clips.filter((c) => c.row.id === 2)
    expect(estim.length).toBeGreaterThan(0)
    expect(estim.every((c) => c.endMs - c.startMs === 5000)).toBe(true)
    expect(estim.every((c) => new Set(c.axesOff).size === 3)).toBe(true)
    expect(other.every((c) => c.endMs - c.startMs === 20_000 && c.axesOff.length === 0)).toBe(true)
  })

  it('draws the length between the two bounds', () => {
    const rows = [row(1), row(2), row(3)]
    const totals = new Set<number>()
    for (let seed = 1; seed < 30; seed++) {
      const { totalMs } = planSession(input(rows, { totalMin: 10, totalMax: 20 }), lcg(seed * 104729))
      expect(totalMs).toBeGreaterThanOrEqual(10 * 60_000)
      expect(totalMs).toBeLessThanOrEqual(20 * 60_000)
      totals.add(totalMs)
    }
    expect(totals.size).toBeGreaterThan(3)
  })

  it('an empty pool plans nothing', () => {
    expect(planSession(input([]), lcg(1)).clips).toEqual([])
  })
})


describe('timeline selection', () => {
  it('splits clips exactly at fractional boundaries and requires the right source on each side', () => {
    const p = input([row(1, { tags: ['slow'] }), row(2, { tags: ['fast'] })], {
      totalMin: 1, totalMax: 1, clipMinS: 60, clipMaxS: 60,
      timeRules: [
        { id: 'first', from: 0, to: .33333, mode: 'require', match: 'any', refs: [{ kind: 'tag', name: 'slow' }] },
        { id: 'second', from: .33333, to: 1, mode: 'require', match: 'any', refs: [{ kind: 'tag', name: 'fast' }] },
      ],
    })
    const result = planSession(p, lcg(42))
    expect(result.issues).toEqual([])
    expect(result.clips.map(c => [c.row.id, c.endMs - c.startMs])).toEqual([[1, 20000], [2, 40000]])
  })

  it('blocks contradictory overlapping requirements even when each separately has matches', () => {
    const result = planSession(input([row(1, { tags: ['slow'] }), row(2, { tags: ['fast'] })], {
      timeRules: [
        { id: 'a', from: 0, to: .7, mode: 'require', match: 'any', refs: [{ kind: 'tag', name: 'slow' }] },
        { id: 'b', from: .5, to: 1, mode: 'require', match: 'any', refs: [{ kind: 'tag', name: 'fast' }] },
      ],
    }), lcg(7))
    expect(result.clips).toEqual([])
    expect(result.issues).toContainEqual({ kind: 'required', ruleId: 'a', from: .5, to: .7 })
  })

  it('keeps preferences within the pool and falls back when a preference is empty', () => {
    const result = planSession(input([row(1)], { totalMin: 1, totalMax: 1, timeRules: [{ id: 'a', from: 0, to: 1, mode: 'prefer', match: 'any', refs: [{ kind: 'video', id: 999, title: 'Outside selection' }] }] }), lcg(5))
    expect(result.issues).toEqual([])
    expect(result.clips.every(c => c.row.id === 1)).toBe(true)
  })

  it('intersects multiple refs in Match all and respects playlist membership and skips', () => {
    const p = input([row(1, { tags: ['slow'] }), row(2), row(3, { tags: ['slow'] })], { totalMin: 1, totalMax: 1, timeRules: [{ id: 'a', from: 0, to: 1, mode: 'require', match: 'all', refs: [{ kind: 'playlist', id: 10, name: 'Mix' }, { kind: 'tag', name: 'slow' }] }] })
    p.playlists = new Map([[10, new Set([1, 2])]])
    expect(planSession(p, lcg(1)).clips.every(c => c.row.id === 1)).toBe(true)
    expect(planSession({ ...p, skip: new Set([1]) }, lcg(1)).clips).toEqual([])
  })

  it('prefers slower and faster videos according to measured speed, and can turn this off', () => {
    const rows = [row(1, { averageSpeed: 10 }), row(2, { averageSpeed: 200 })]
    const picks = (target: number, matchVideos = true) => Array.from({ length: 300 }, (_, i) => planSession(input(rows, { totalMin: 1, totalMax: 1, clipMinS: 60, clipMaxS: 60, matchVideos, pacing: { ...defaultSessionSetup().pacing, kind: 'ramp', ramp: { from: target, to: target } } }), lcg(i * 7919 + 1)).clips[0]!.row.id)
    expect(picks(0).filter(id => id === 1).length).toBeGreaterThan(240)
    expect(picks(1).filter(id => id === 2).length).toBeGreaterThan(240)
    expect(picks(0, false)).toEqual(picks(1, false))
  })

  it('continues repeating a small pool without weight underflow', () => {
    const result = planSession(input([row(1)], { totalMin: 10, totalMax: 10, clipMinS: 1, clipMaxS: 1 }), lcg(7))
    expect(result.clips).toHaveLength(600)
    expect(result.issues).toEqual([])
  })
})
