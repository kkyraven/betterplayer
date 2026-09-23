import { describe, expect, it } from 'vitest'
import { applyChange, diffLane, flatten, heatBuckets, kinds, limitSpeed, loopStroke, move, nearest, normalise, quantise, rangeExtend, refit, revertChange, reverse, scaleDepth, scaleTime, stats, timesByDepth, timesBySpeed, valueAt } from './ops'

const p = (at: number, pos: number) => ({ at, pos })
const sel = (...times: number[]) => new Set(times)
const stroke = [p(0, 0), p(500, 100), p(1000, 0), p(1500, 100), p(2000, 0)]

describe('normalise and lookup', () => {
  it('sorts, rounds to whole ms, clamps and keeps the later of two at one time', () => {
    expect(normalise([p(10.4, 120), p(2, -5), p(10, 50)])).toEqual([p(2, 0), p(10, 50)])
  })
  it('interpolates between points and holds the ends', () => {
    expect(valueAt(stroke, 250)).toBe(50)
    expect(valueAt(stroke, -10)).toBe(0)
    expect(valueAt(stroke, 9000)).toBe(0)
    expect(valueAt([], 5)).toBe(50)
  })
  it('classifies tops and bottoms', () => {
    expect(kinds([p(0, 0), p(1, 50), p(2, 100), p(3, 0)])).toEqual(['bottom', 'mid', 'top', 'bottom'])
  })
  it('finds the nearest grid value', () => {
    expect(nearest([0, 100, 200], 140)).toBe(100)
    expect(nearest([0, 100, 200], 160)).toBe(200)
    expect(nearest([0, 100, 200], 999)).toBe(200)
  })
})

describe('selection edits', () => {
  it('moves up and down and holds a time move short of the unselected neighbour', () => {
    expect(move(stroke, sel(500), 10, 0)[1]).toEqual(p(500, 100))
    expect(move(stroke, sel(500), -30, 0)[1]).toEqual(p(500, 70))
    expect(move(stroke, sel(500), 0, 800)[1]).toEqual(p(999, 100))
    expect(move(stroke, sel(500, 1000), 0, -900).slice(1, 3)).toEqual([p(1, 100), p(501, 0)])
  })
  it('scales depth about the selection middle', () => {
    expect(scaleDepth([p(0, 20), p(1, 80)], sel(0, 1), 0.5)).toEqual([p(0, 35), p(1, 65)])
  })
  it('stretches time about the first point and stops before the next point', () => {
    expect(scaleTime(stroke, sel(0, 500), 2)).toEqual([p(0, 0), p(999, 100), p(1000, 0), p(1500, 100), p(2000, 0)])
    expect(scaleTime(stroke, sel(1000, 1500, 2000), 0.5)).toEqual([p(0, 0), p(500, 100), p(1000, 0), p(1250, 100), p(1500, 0)])
  })
  it('flattens tops and bottoms and leaves mids', () => {
    const out = flatten([p(0, 10), p(1, 90), p(2, 40), p(3, 5), p(4, 95)], sel(0, 1, 2, 3, 4), 100, 0)
    expect(out.map((x) => x.pos)).toEqual([0, 100, 40, 0, 100])
  })
  it('reverses in time within the span', () => {
    expect(reverse([p(0, 0), p(100, 100), p(400, 50)], sel(0, 100, 400))).toEqual([p(0, 50), p(300, 100), p(400, 0)])
  })
  it('extends the range', () => {
    expect(rangeExtend([p(0, 20), p(1, 60)], sel(0, 1), 0, 100)).toEqual([p(0, 0), p(1, 100)])
  })
  it('quantises to a grid', () => {
    expect(quantise([p(0, 0), p(480, 100)], sel(480), [0, 500, 1000])).toEqual([p(0, 0), p(500, 100)])
  })
  it('loops a stroke at its own period', () => {
    const out = loopStroke([p(0, 0), p(500, 100), p(1000, 0), p(5000, 50)], sel(0, 500, 1000), 2)
    expect(out.map((x) => x.at)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 5000])
  })
})

describe('limit speed and select by', () => {
  it('shaves tops and bottoms until no segment is faster than the limit', () => {
    const out = limitSpeed([p(0, 0), p(100, 100), p(200, 0)], sel(0, 100, 200), 500)
    expect(out.map((x) => x.pos)).toEqual([0, 50, 0])
    const kept = limitSpeed(stroke, sel(0, 500, 1000, 1500, 2000), 500)
    expect(kept).toEqual(stroke)
  })
  it('finds points by the speed around them and by depth', () => {
    expect(timesBySpeed([p(0, 0), p(100, 100), p(1100, 0)], 500, 2000)).toEqual([0, 100])
    expect(timesByDepth(stroke, 90, 100)).toEqual([500, 1500])
  })
})

describe('refit', () => {
  it('moves tops and bottoms to the nearest turn of their kind and carries the mids', () => {
    const points = [p(0, 0), p(250, 50), p(500, 100), p(1000, 0)]
    const turns = [
      { t: 20, v: 0, kind: 'bottom' as const },
      { t: 600, v: 100, kind: 'top' as const },
      { t: 1050, v: 0, kind: 'bottom' as const },
    ]
    expect(refit(points, sel(0, 250, 500, 1000), turns)).toEqual([p(20, 0), p(310, 50), p(600, 100), p(1050, 0)])
  })
  it('leaves a point with no turn near enough', () => {
    expect(refit([p(0, 0), p(500, 100)], sel(500), [{ t: 2000, v: 100, kind: 'top' }])).toEqual([p(0, 0), p(500, 100)])
  })
})

describe('diff', () => {
  it('finds the smallest splice and round trips', () => {
    const before = stroke
    const after = [p(0, 0), p(500, 100), p(900, 10), p(1500, 100), p(2000, 0)]
    const change = diffLane(before, after)
    expect(change).toEqual({ index: 2, removed: [p(1000, 0)], added: [p(900, 10)] })
    expect(applyChange(before, change!)).toEqual(after)
    expect(revertChange(after, change!)).toEqual(before)
    expect(diffLane(before, before)).toBeNull()
  })
})

describe('stats and heat', () => {
  it('measures a run of points', () => {
    expect(stats(stroke)).toEqual({ count: 5, spanMs: 2000, depth: 100, average: 200, max: 200 })
    expect(heatBuckets(stroke, 4000, 4)).toEqual([200, 200, 0, 0])
  })
})
