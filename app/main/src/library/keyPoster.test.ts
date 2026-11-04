import { describe, expect, it } from 'vitest'
import { PASSTHROUGH_DEFAULTS } from '@shared/passthrough'
import { keyPixels, posterKeyed, type KeyLook } from './keyPoster'

function frame(w: number, h: number, at: (x: number, y: number) => number): Uint8Array {
  const rgb = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = at(x, y)
    rgb.set([(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff], (y * w + x) * 3)
  }
  return rgb
}
const alpha = (rgba: Uint8Array, w: number, x: number, y: number) => rgba[(y * w + x) * 4 + 3]

describe('keyPixels', () => {
  const look: KeyLook = { key: 0x00b140, feather: 'edges', featherPx: 0, layout: 'mono' }

  it('keys the backdrop and keeps the picture', () => {
    const rgba = keyPixels(frame(40, 20, (x) => (x < 20 ? 0x00b140 : 0xc04030)), 40, 20, look)
    expect(alpha(rgba, 40, 5, 10)).toBe(0)
    expect(alpha(rgba, 40, 35, 10)).toBe(255)
  })

  it('fills a dark hole the picture encloses over a black key, not the open backdrop', () => {
    const ring = (x: number, y: number) => Math.max(Math.abs(x - 50), Math.abs(y - 50)) <= 12 && Math.max(Math.abs(x - 50), Math.abs(y - 50)) >= 4
    const rgba = keyPixels(frame(100, 100, (x, y) => (ring(x, y) ? 0xd0b090 : 0x000000)), 100, 100, { ...look, key: 0x000000 })
    expect(alpha(rgba, 100, 50, 50)).toBe(255)
    expect(alpha(rgba, 100, 5, 5)).toBe(0)
  })
})

describe('posterKeyed', () => {
  it('keys a passthrough name unless AI is picked or it is off', () => {
    expect(posterKeyed(undefined, 'scene passthrough', null)).toBe(true)
    expect(posterKeyed(undefined, 'scene passthrough', { key: null, candidates: [] })).toBe(true)
    expect(posterKeyed({ ...PASSTHROUGH_DEFAULTS, on: true, mode: 'ai' }, 'scene', null)).toBe(false)
    expect(posterKeyed(undefined, 'scene', null)).toBe(false)
  })
})
