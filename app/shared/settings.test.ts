import { describe, expect, it } from 'vitest'
import { defaultFeatureLevel, featureLevelOutput, normalizeFeatureLevel } from './settings'

describe('featureLevelOutput', () => {
  it('is off up to the start, climbs from the floor to the cap across the window and holds', () => {
    const level = { from: 0.2, to: 0.6, floor: 0.3, cap: 0.9 }
    expect(featureLevelOutput(level, 0)).toBe(0)
    expect(featureLevelOutput(level, 0.2)).toBe(0)
    expect(featureLevelOutput(level, 0.21)).toBeCloseTo(0.315)
    expect(featureLevelOutput(level, 0.4)).toBeCloseTo(0.6)
    expect(featureLevelOutput(level, 0.6)).toBeCloseTo(0.9)
    expect(featureLevelOutput(level, 1)).toBeCloseTo(0.9)
  })

  it('is the identity by default, with zero staying zero under a floor', () => {
    expect(featureLevelOutput(defaultFeatureLevel(), 0.37)).toBeCloseTo(0.37)
    expect(featureLevelOutput({ ...defaultFeatureLevel(), floor: 0.3 }, 0)).toBe(0)
    expect(featureLevelOutput({ ...defaultFeatureLevel(), floor: 0.3 }, 0.001)).toBeCloseTo(0.3007)
  })

  it('treats a window with no width as a switch to the cap', () => {
    const step = { from: 0.5, to: 0.5, floor: 0.2, cap: 0.8 }
    expect(featureLevelOutput(step, 0.5)).toBe(0)
    expect(featureLevelOutput(step, 0.51)).toBeCloseTo(0.8)
  })
})

describe('normalizeFeatureLevel', () => {
  it('fills gaps with the identity, clamps to 0..1 and keeps the pairs in order', () => {
    expect(normalizeFeatureLevel({})).toEqual(defaultFeatureLevel())
    expect(normalizeFeatureLevel({ from: 0.7, to: 0.2, floor: 1.4, cap: NaN })).toEqual({ from: 0.7, to: 0.7, floor: 1, cap: 1 })
    expect(normalizeFeatureLevel({ from: -1, cap: 0.5 })).toEqual({ from: 0, to: 1, floor: 0, cap: 0.5 })
  })
})
