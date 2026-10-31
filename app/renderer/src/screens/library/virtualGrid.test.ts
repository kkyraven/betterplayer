import { expect, it } from 'vitest'
import { rowRange } from './virtualGrid'

it('renders the rows around the viewport', () => {
  expect(rowRange(300, 4, 228, 2280, 800)).toEqual({ start: 24, end: 72, padTop: 1368, padBottom: 12996 })
})

it('renders the last screen when the viewport is past the end of the grid', () => {
  expect(rowRange(300, 4, 228, 20000, 800)).toEqual({ start: 268, end: 300, padTop: 15276, padBottom: 0 })
})
