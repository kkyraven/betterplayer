import { describe, expect, it } from 'vitest'
import { stepIndex, stepNumber } from './rowStep'

describe('stepNumber', () => {
  it('steps and clamps', () => {
    expect(stepNumber(0.95, 1, { min: 0, max: 1, step: 0.05 })).toBe(1)
    expect(stepNumber(1, 1, { min: 0, max: 1, step: 0.05 })).toBe(1)
    expect(stepNumber(0, -1, { min: 0, max: 1, step: 0.05 })).toBe(0)
  })
  it('snaps an off-grid value to the grid first', () => {
    expect(stepNumber(0.93, 1, { min: 0, max: 2, step: 0.05 })).toBe(1)
    expect(stepNumber(-37, 1, { min: -5000, max: 5000, step: 10 })).toBe(-30)
  })
  it('keeps float steps tidy', () => {
    expect(stepNumber(0.1, 1, { min: 0, max: 1, step: 0.1 })).toBe(0.2)
  })
})

describe('stepIndex', () => {
  it('clamps by default and wraps when asked', () => {
    expect(stepIndex(2, 1, 3, false)).toBe(2)
    expect(stepIndex(2, 1, 3, true)).toBe(0)
    expect(stepIndex(0, -1, 3, true)).toBe(2)
    expect(stepIndex(0, -1, 0, true)).toBe(0)
  })
})
