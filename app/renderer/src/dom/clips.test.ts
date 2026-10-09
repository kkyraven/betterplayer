import { expect, it } from 'vitest'
import { videoRange } from './clips'

it('keeps fractional absolute timestamps and defaults immediate playback to the whole video', () => {
  expect(videoRange({ start_seconds: 1.25, end_seconds: 10.75 }, 20000, true)).toEqual({ start_seconds: 1.25, end_seconds: 10.75 })
  expect(videoRange({}, 20000, false)).toEqual({ start_seconds: 0, end_seconds: 20 })
  expect(videoRange({ start_seconds: 5 }, 20000, false)).toEqual({ start_seconds: 5, end_seconds: 20 })
})

it('allows immediate playback with an unknown duration without weakening queue validation', () => {
  expect(videoRange({}, 0, false)).toEqual({ start_seconds: 0 })
  expect(videoRange({ start_seconds: 12.5 }, 0, false)).toEqual({ start_seconds: 12.5 })
  expect(typeof videoRange({ start_seconds: 0, end_seconds: 20 }, 0, true)).toBe('string')
  expect(typeof videoRange({ start_seconds: -1 }, 0, false)).toBe('string')
})

it.each([
  {}, { start_seconds: 1 }, { start_seconds: -1, end_seconds: 5 },
  { start_seconds: 5, end_seconds: 5 }, { start_seconds: 6, end_seconds: 5 },
  { start_seconds: 0, end_seconds: 21 }, { start_seconds: '1', end_seconds: 5 },
  { start_seconds: 0, end_seconds: Number.POSITIVE_INFINITY },
  { start_seconds: Number.NaN, end_seconds: 5 },
])('rejects invalid queue ranges: %j', (args) => {
  expect(typeof videoRange(args, 20000, true)).toBe('string')
})
