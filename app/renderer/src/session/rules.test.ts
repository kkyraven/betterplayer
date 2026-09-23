import { describe, expect, it } from 'vitest'
import { defaultSessionSetup } from '@shared/session'
import { intensityWeight, toyScale } from './rules'

const toys = {
  ...defaultSessionSetup().toys,
  enabled: true,
  rules: [{ outputId: 'one', name: 'Toy', low: 0, middle: 0.5, high: 1 }],
  periods: [{ id: 'p', outputId: 'one', name: 'Toy', from: 0.2, to: 0.4, scale: 0.75 }],
}
describe('toy output rules', () => {
  it('uses each intensity band and ignores rules when disabled', () => {
    expect(toyScale(toys, 'one', 0, 0.2)).toBe(0)
    expect(toyScale(toys, 'one', 0, 0.5)).toBe(0.5)
    expect(toyScale(toys, 'one', 0, 0.9)).toBe(1)
    expect(toyScale(toys, 'one', 0, null)).toBe(0.5)
    expect(toyScale({ ...toys, enabled: false }, 'one', 0.2, 0)).toBe(1)
    expect(toyScale(toys, 'different', 0.2, 0)).toBe(1)
  })
  it('overrides intensity during a period, including its start but excluding its end', () => {
    expect(toyScale(toys, 'one', 0.2, 0)).toBe(0.75)
    expect(toyScale(toys, 'one', 0.4, 0)).toBe(0)
    const off = { ...toys, periods: [...toys.periods, { ...toys.periods[0]!, id: 'off', scale: 0 }] }
    expect(toyScale(off, 'one', 0.3, 1)).toBe(0)
  })
})
it('unmeasured videos retain neutral odds', () => {
  expect(intensityWeight(undefined, 0)).toBe(1)
  expect(intensityWeight(undefined, 1)).toBe(1)
  expect(intensityWeight(0.9, null)).toBe(1)
})
