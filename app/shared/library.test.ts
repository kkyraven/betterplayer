import { describe, expect, it } from 'vitest'
import { titleStartsWith } from './library'

describe('titleStartsWith', () => {
  it('matches a case-insensitive prefix', () => {
    expect(titleStartsWith('Ginger Snap', 'g')).toBe(true)
    expect(titleStartsWith('Ginger Snap', 'ging')).toBe(true)
  })

  it('skips leading punctuation', () => {
    expect(titleStartsWith('"Ginger Snap" (4K)', 'g')).toBe(true)
    expect(titleStartsWith('[4K] Ginger Snap', '4')).toBe(true)
  })

  it('rejects mid-title and different letters', () => {
    expect(titleStartsWith('The Ginger Snap', 'g')).toBe(false)
    expect(titleStartsWith('Ginger Snap', 'h')).toBe(false)
  })
})
