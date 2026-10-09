import { expect, it } from 'vitest'
import { saysSafeword } from './safeword'
it.each(['RED', 'please, red!', 'I said "red".', ' red '])('recognizes %s immediately', (text) => expect(saysSafeword(text, 'red')).toBe(true))
it.each(['redder', 'tired', 'red_2', 'reddish'])('does not treat %s as red', (text) => expect(saysSafeword(text, 'red')).toBe(false))
it('handles blank, Unicode, phrases and literal regex characters', () => {
  expect(saysSafeword('stop', '')).toBe(false)
  expect(saysSafeword('ｒｅｄ!', 'red')).toBe(true)
  expect(saysSafeword('éclair!', 'ÉCLAIR')).toBe(true)
  expect(saysSafeword('paséclair', 'éclair')).toBe(false)
  expect(saysSafeword('blue moon!', 'blue moon')).toBe(true)
  expect(saysSafeword('a.b!', 'a.b')).toBe(true)
  expect(saysSafeword('acb', 'a.b')).toBe(false)
})
