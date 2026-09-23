import { describe, expect, it } from 'vitest'
import type { RangeAnalysis } from 'bp-engine'
import { AnalysisCache } from './analysis'

function run(startMs: number, endMs: number, samples: Array<[number, number]>, cuts: number[] = []): RangeAnalysis {
  const motion = new Float64Array(samples.length * 6)
  samples.forEach(([, v], i) => {
    motion[i * 6] = v
  })
  return { startMs, endMs, fps: 30, times: new Float64Array(samples.map(([t]) => t)), motion, cuts, boxes: [], model: [], hero: [], thumbs: [] }
}

describe('analysis cache', () => {
  it('reports what is missing and merges gaps', () => {
    const c = new AnalysisCache()
    expect(c.missing(0, 5000)).toEqual([[0, 5000]])
    c.add(run(1000, 2000, []))
    c.add(run(2000, 3000, []))
    expect(c.missing(0, 5000)).toEqual([[0, 1000], [3000, 5000]])
    expect(c.missing(1200, 2800)).toEqual([])
    expect(c.missing(0, 5000, 1500)).toEqual([[3000, 5000]])
  })
  it('interpolates the stroke and prefers the newest run', () => {
    const c = new AnalysisCache()
    c.add(run(0, 1000, [[0, 0], [1000, 1]]))
    expect(c.strokeAt(500)).toBeCloseTo(50)
    expect(c.strokeAt(5000)).toBeNull()
    c.add(run(400, 600, [[400, 0.2], [600, 0.2]]))
    expect(c.strokeAt(500)).toBeCloseTo(20)
    expect(c.strokeAt(100)).toBeCloseTo(10)
  })
  it('collects samples and cuts across runs without doubling up', () => {
    const c = new AnalysisCache()
    c.add(run(0, 1000, [[0, 0], [500, 0.5], [1000, 1]], [500]))
    c.add(run(1000, 2000, [[1000, 1], [1500, 0.5]], [500, 1500]))
    expect(c.samples(0, 2000).map((s) => s.t)).toEqual([0, 500, 1000, 1500])
    expect(c.cuts(0, 2000)).toEqual([500, 1500])
    expect(c.cutsAround(700)).toEqual({ before: 500, after: 1500 })
  })
})
