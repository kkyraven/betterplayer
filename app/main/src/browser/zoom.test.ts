import { describe, expect, it } from 'vitest'
import { nextZoom, zoomStep } from './zoom'

const key = (key: string, mods: { control?: boolean; meta?: boolean; alt?: boolean } = { control: true }) =>
  ({ type: 'keyDown', key, control: false, meta: false, alt: false, ...mods })

describe('zoomStep', () => {
  it('reads Ctrl on Windows and Cmd on macOS', () => {
    expect(zoomStep(key('='), false)).toBe(1)
    expect(zoomStep(key('+'), false)).toBe(1)
    expect(zoomStep(key('-'), false)).toBe(-1)
    expect(zoomStep(key('0'), false)).toBe(0)
    expect(zoomStep(key('=', { meta: true }), true)).toBe(1)
    expect(zoomStep(key('=', { meta: true }), false)).toBeNull()
  })

  it('ignores other keys, AltGr and key up', () => {
    expect(zoomStep(key('r'), false)).toBeNull()
    expect(zoomStep(key('=', { control: true, alt: true }), false)).toBeNull()
    expect(zoomStep({ ...key('='), type: 'keyUp' }, false)).toBeNull()
  })
})

describe('nextZoom', () => {
  it('steps through presets and stops at the ends', () => {
    expect(nextZoom(1, 1)).toBe(1.1)
    expect(nextZoom(1, -1)).toBe(0.9)
    expect(nextZoom(1.3, -1)).toBe(1.25)
    expect(nextZoom(5, 1)).toBe(5)
    expect(nextZoom(0.25, -1)).toBe(0.25)
    expect(nextZoom(2.5, 0)).toBe(1)
  })
})
