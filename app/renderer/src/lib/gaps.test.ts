import { describe, expect, it } from 'vitest'
import { currentGapEnd, nextGapEnd } from './gaps'

const gaps = [
  { startMs: 0, endMs: 8000 },
  { startMs: 30_000, endMs: 42_000 },
]

describe('gap ends', () => {
  it('finds the gap around the time or the next one ahead', () => {
    expect(nextGapEnd(gaps, 2000)).toBe(8000)
    expect(nextGapEnd(gaps, 10_000)).toBe(42_000)
    expect(nextGapEnd(gaps, 41_800)).toBeNull()
    expect(nextGapEnd([], 0)).toBeNull()
  })

  it('reports the current gap only from inside it', () => {
    expect(currentGapEnd(gaps, 31_000)).toBe(42_000)
    expect(currentGapEnd(gaps, 10_000)).toBeNull()
    expect(currentGapEnd(gaps, 41_800)).toBeNull()
  })
})
