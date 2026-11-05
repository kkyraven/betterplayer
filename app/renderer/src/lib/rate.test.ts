import { expect, it } from 'vitest'
import { stepRate } from './rate'

it('moves along tenths and stops at either end', () => {
  expect(stepRate(1, 1)).toBe(1.1)
  expect(stepRate(1.1, -1)).toBe(1)
  expect(stepRate(2.9, 1)).toBe(3)
  expect(stepRate(3, 1)).toBe(3)
  expect(stepRate(0.25, -1)).toBe(0.25)
})

it('joins the tenths from the bottom stop and from presets between them', () => {
  expect(stepRate(0.25, 1)).toBe(0.3)
  expect(stepRate(0.3, -1)).toBe(0.25)
  expect(stepRate(0.75, 1)).toBe(0.8)
  expect(stepRate(0.75, -1)).toBe(0.7)
  expect(stepRate(1.25, 1)).toBe(1.3)
})
