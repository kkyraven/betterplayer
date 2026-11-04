import { describe, expect, it } from 'vitest'
import { FLAT, type Projection } from './projection'
import {
  autoKey,
  eyeToFrame,
  isAlphaName,
  keyColour,
  keyName,
  keySamplePoints,
  PASSTHROUGH_DEFAULTS,
  PASSTHROUGH_FALLBACK_KEY,
  passthroughModelId,
  patchColour,
  readPassthrough,
  resolvePassthrough,
  type AutoKey,
} from './passthrough'

const GREEN = 0x00b140
const GREEN_LIT = 0x10b848
const LIME = 0x9acd32
const BLUE = 0x2050e0
const view = (kind: Projection['kind'], layout: Projection['layout'], swapEyes = false): Projection => ({ kind, layout, fov: 190, swapEyes })

function frame(w: number, h: number, at: (x: number, y: number) => number | null): Uint8Array {
  const out = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = at(x, y) ?? ((x + y) % 2 === 0 ? 0xffffff : 0x000000)
      out.set([(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff], (y * w + x) * 3)
    }
  }
  return out
}

function sampled(colours: (number | null)[]): Uint8Array {
  const w = 160, h = 90
  const points = keySamplePoints(2, FLAT).map(([x, y]) => [x * w, y * h] as const)
  return frame(w, h, (x, y) => {
    let best = 0
    let near = Infinity
    points.forEach(([px, py], i) => {
      const d = Math.hypot(px - x, py - y)
      if (d < near) [best, near] = [i, d]
    })
    return colours[best] ?? null
  })
}

describe('keyColour', () => {
  it('takes the colour three of four agree on', () => {
    expect(keyColour([GREEN, GREEN, LIME, GREEN])).toBe(GREEN)
  })

  it('finds no winner in a split, or where nulls leave no majority', () => {
    expect(keyColour([GREEN, LIME, GREEN, LIME])).toBeNull()
    expect(keyColour([GREEN, GREEN, null, null])).toBeNull()
    expect(keyColour([GREEN, GREEN, GREEN, null])).toBe(GREEN)
  })

  it('never picks near-black', () => {
    expect(keyColour([0x050505, 0x060606, 0x050505, 0x040404])).toBeNull()
  })

  it('keeps close colours in one group and returns their mean', () => {
    const key = keyColour([GREEN, GREEN_LIT, GREEN, LIME])
    expect(key).not.toBeNull()
    expect(Math.abs(((key ?? 0) >> 8 & 0xff) - 0xb3)).toBeLessThanOrEqual(1)
  })
})

describe('patchColour', () => {
  it('reads a flat patch and refuses texture', () => {
    const flat = frame(20, 20, () => GREEN)
    expect(patchColour(flat, 20, 20, 10, 10, 2)).toBe(GREEN)
    const textured = frame(20, 20, () => null)
    expect(patchColour(textured, 20, 20, 10, 10, 2)).toBeNull()
  })
})

describe('autoKey', () => {
  it('stops at the corners when three agree', () => {
    expect(autoKey(sampled([GREEN, LIME, GREEN, GREEN, BLUE, BLUE, BLUE, BLUE, null]), 160, 90, FLAT)).toEqual({ key: GREEN, candidates: [LIME] })
  })

  it('moves to stage 2 on a tie and finds five of nine', () => {
    expect(autoKey(sampled([GREEN, LIME, LIME, GREEN, GREEN, GREEN, GREEN, LIME, null]), 160, 90, FLAT)).toEqual({ key: GREEN, candidates: [LIME] })
  })

  it('gives every colour as a candidate when nothing wins', () => {
    const auto = autoKey(sampled([GREEN, LIME, BLUE, 0xe02020, GREEN, LIME, BLUE, null, null]), 160, 90, FLAT)
    expect(auto.key).toBeNull()
    expect(auto.candidates).toHaveLength(4)
  })
})

describe('keySamplePoints', () => {
  it('keeps fisheye points inside the circle', () => {
    for (const [x, y] of keySamplePoints(2, view('fisheye', 'mono'))) expect(Math.hypot(x - 0.5, y - 0.5)).toBeLessThan(0.5)
  })

  it('keeps stereo points inside the shown eye, off the seam', () => {
    for (const [x] of keySamplePoints(2, view('equirect180', 'sbs'))) expect(x > 0.01 && x < 0.49).toBe(true)
    for (const [x] of keySamplePoints(2, view('fisheye', 'sbs', true))) expect(x > 0.51 && x < 0.99).toBe(true)
    for (const [, y] of keySamplePoints(2, view('equirect180', 'ou'))) expect(y > 0.01 && y < 0.49).toBe(true)
  })

  it('maps a pick in the shown eye to the frame', () => {
    expect(eyeToFrame(0.5, 0.5, view('equirect180', 'ou', true))).toEqual([0.5, 0.75])
    expect(eyeToFrame(1.2, 0, view('fisheye', 'sbs'))).toEqual([0.5, 0])
  })
})

describe('resolvePassthrough', () => {
  const found: AutoKey = { key: GREEN, candidates: [LIME, BLUE] }
  const none: AutoKey = { key: null, candidates: [LIME, BLUE] }

  it('turns on from the file name only when nothing is saved', () => {
    expect(resolvePassthrough(undefined, 'scene_PASSTHROUGH.mp4', found, false)).toMatchObject({ on: true, onSource: 'name', key: GREEN, keySource: 'auto', auto: GREEN, candidates: [LIME, BLUE] })
    expect(resolvePassthrough({ ...PASSTHROUGH_DEFAULTS, on: false }, 'scene_passthrough.mp4', found, false)).toMatchObject({ on: false, onSource: 'user' })
    expect(resolvePassthrough(undefined, 'scene.mp4', found, false)).toMatchObject({ on: false, onSource: 'none' })
  })

  it('keeps the key and feather when turned off', () => {
    const saved = { on: false, mode: 'colour' as const, key: LIME, feather: 'distance' as const, featherPx: 16 }
    expect(resolvePassthrough(saved, 'x', found, true)).toMatchObject({ on: false, key: LIME, keySource: 'user', modeSource: 'user', feather: 'distance', featherPx: 16, settings: saved })
  })

  it('goes to AI when a mask is made, else keys the commonest colour', () => {
    expect(resolvePassthrough(undefined, 'passthrough', found, true)).toMatchObject({ mode: 'ai', modeSource: 'auto' })
    expect(resolvePassthrough(undefined, 'passthrough', none, false)).toMatchObject({ mode: 'colour', key: LIME, auto: LIME, candidates: [BLUE] })
    expect(resolvePassthrough({ ...PASSTHROUGH_DEFAULTS, on: true, mode: 'ai' }, 'x', found, false)).toMatchObject({ mode: 'colour', modeSource: 'user' })
  })

  it('keys chroma green before the colour is sampled', () => {
    expect(resolvePassthrough(undefined, 'passthrough', null, false)).toMatchObject({ mode: 'colour', key: PASSTHROUGH_FALLBACK_KEY, auto: null, candidates: [] })
  })

  it('knows an external alpha by its name', () => {
    expect(isAlphaName('scene_XALPHA.mp4')).toBe(true)
    expect(isAlphaName('Scene_xalpha.MKV')).toBe(true)
    expect(isAlphaName('scene_XALPHA')).toBe(false)
    expect(isAlphaName('scene_XALPHA.mp4.part')).toBe(false)
    expect(isAlphaName('my_XALPHA_cut.mp4')).toBe(false)
  })
})

describe('readPassthrough and keyName', () => {
  it('snaps feather to a stop and drops a bad key', () => {
    expect(readPassthrough({ on: true, mode: 'x', key: 0x1000000, feather: 'edges', featherPx: 5 })).toEqual({ on: true, mode: null, key: null, feather: 'edges', featherPx: 4 })
  })

  it('names swatches with the Hero hue names', () => {
    expect(keyName(0x00ff00)).toBe('heroColour.green')
    expect(keyName(0x60ff00)).toBe('heroColour.lime')
    expect(keyName(0xf0f0f0)).toBe('heroColour.white')
    expect(keyName(0x111111)).toBeNull()
  })
})

describe('passthroughModelId', () => {
  it('runs Latex Passthrough at the picked size, Medium below it, and Latex when picked', () => {
    expect(passthroughModelId('nevermore-big')).toBe('latex-passthrough-big')
    expect(passthroughModelId('nevermore-tiny')).toBe('latex-passthrough-medium')
    expect(passthroughModelId(null)).toBe('latex-passthrough-medium')
    expect(passthroughModelId('nevermore-small', 'skin')).toBe('latex-small')
  })
})
