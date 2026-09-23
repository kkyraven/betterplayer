import { describe, expect, it } from 'vitest'
import { adjustStrokes, cycles, fillEnd, findTurns, heights, patternFromPoints, placeAtPeriod, placePattern } from './patterns'
import { PATTERN_PRESETS } from './presets'

const full = PATTERN_PRESETS[0]!

function signal(): Array<{ t: number; v: number }> {
  const out: Array<{ t: number; v: number }> = []
  for (let t = 0; t <= 2400; t += 20) {
    const phase = t % 1000
    const leg = phase < 400 ? phase / 400 : (1000 - phase) / 600
    out.push({ t, v: 10 + 70 * (1 - Math.cos(leg * Math.PI)) * 0.5 })
  }
  return out
}

describe('turns and cycles', () => {
  it('finds the tops and bottoms with hysteresis', () => {
    const turns = findTurns(signal())
    expect(turns.map((t) => t.kind)).toEqual(['bottom', 'top', 'bottom', 'top', 'bottom'])
    expect(turns.map((t) => t.t)).toEqual([0, 400, 1000, 1400, 2000])
  })
  it('ignores jitter inside the hysteresis', () => {
    const wobble = signal().map((s) => ({ t: s.t, v: s.v + (s.t % 40 === 0 ? 4 : -4) }))
    expect(findTurns(wobble).length).toBe(5)
  })
  it('builds bottom to bottom cycles with the amplitude from the deeper bottom', () => {
    const c = cycles(findTurns(signal()))
    expect(c.length).toBe(2)
    expect(c[0]).toMatchObject({ start: 0, top: 400, end: 1000 })
    expect(c[0]?.amplitude).toBeCloseTo(70, 0)
  })
})

describe('placement', () => {
  const c = cycles(findTurns(signal()))
  it('puts the pattern top on the motion top and shares the boundary point', () => {
    const strokes = placePattern(full, c, { mode: 'pattern', min: 0, max: 100 })
    expect(strokes.length).toBe(2)
    expect(strokes[0]).toEqual([{ at: 0, pos: 0 }, { at: 400, pos: 100 }, { at: 1000, pos: 0 }])
    expect(strokes[1]).toEqual([{ at: 1400, pos: 100 }, { at: 2000, pos: 0 }])
  })
  it('scales by mode', () => {
    const cycle = c[0]!
    expect(heights(full.points, cycle, { mode: 'motion', min: 0, max: 100 }).map(([, h]) => Math.round(h))).toEqual([0, 70, 0])
    expect(heights(full.points, cycle, { mode: 'range', min: 20, max: 80 })).toEqual([[0, 20], [0.5, 80], [1, 20]])
  })
  it('repeats at a period with no motion', () => {
    const strokes = placeAtPeriod(full, 0, 2000, 1000, { mode: 'pattern', min: 0, max: 100 })
    expect(strokes.map((s) => s.map((p) => p.at))).toEqual([[0, 500, 1000], [1500, 2000]])
  })
  it('adjusts phase and depth for the ghost', () => {
    expect(adjustStrokes([[{ at: 100, pos: 0 }, { at: 200, pos: 100 }]], 16.7, 0.5)).toEqual([[{ at: 117, pos: 25 }, { at: 217, pos: 75 }]])
  })
})

describe('helpers', () => {
  it('takes a pattern from points', () => {
    expect(patternFromPoints([{ at: 1000, pos: 10 }, { at: 1500, pos: 90 }, { at: 2000, pos: 10 }])).toEqual([[0, 10], [0.5, 90], [1, 10]])
    expect(patternFromPoints([{ at: 1000, pos: 10 }])).toBeNull()
  })
  it('stops a fill at the first existing point unless replacing', () => {
    const points = [{ at: 100, pos: 0 }, { at: 800, pos: 50 }]
    expect(fillEnd(points, 200, 2000, false)).toEqual({ endMs: 800, stoppedBy: 'point' })
    expect(fillEnd(points, 200, 2000, true)).toEqual({ endMs: 2000, stoppedBy: null })
  })
})
