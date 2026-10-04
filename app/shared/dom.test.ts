import { describe, expect, it } from 'vitest'
import { DOM_LEVEL_MAX, LORA_WEIGHT_MAX, clampLevel, defaultPleasurePain, domAccess, normalizeDom, normalizeLoras, normalizePleasurePain, windowAround, painOutput, pointAt, spanAt } from './dom'

describe('pleasure and pain', () => {
  it('runs each setting from its value at 0 to its value at the top', () => {
    const p = { on: true, at0: 0.8, at15: 0.2 }
    expect(pointAt(p, 0)).toBeCloseTo(0.8)
    expect(pointAt(p, DOM_LEVEL_MAX)).toBeCloseTo(0.2)
    expect(pointAt(p, 5)).toBeCloseTo(0.6)
    expect(spanAt({ on: true, at0: [0.3, 0.7], at15: [0, 1] }, 6)).toEqual([0.18, 0.82].map((v) => expect.closeTo(v)))
  })

  it('keeps the dom inside the two ends the user set', () => {
    expect(clampLevel(40)).toBe(DOM_LEVEL_MAX)
    expect(clampLevel(-3)).toBe(0)
    expect(clampLevel(Number.NaN)).toBe(0)
    expect(pointAt({ on: true, at0: 0.1, at15: 0.9 }, 99)).toBeCloseTo(0.9)
  })

  it('sends only what is on, and nothing while it is off', () => {
    const pp = defaultPleasurePain()
    expect(painOutput(pp, 10)).toEqual({ points: {}, spans: {} })
    const out = painOutput({ ...pp, enabled: true }, 10)
    expect(Object.keys(out.points).sort()).toEqual(['C0', 'P0', 'volume'])
    expect(Object.keys(out.spans).sort()).toEqual(['L0', 'V0'])
  })
})

describe('normalizing what is stored', () => {
  it('fills what is missing and orders a reversed range', () => {
    const pp = normalizePleasurePain({ enabled: true, spans: { L0: { on: true, at0: [0.9, 0.1], at15: [0, 2] } } })
    expect(pp.enabled).toBe(true)
    expect(pp.spans.L0).toEqual({ on: true, at0: [0.1, 0.9], at15: [0, 1] })
    expect(pp.points.C0).toEqual(defaultPleasurePain().points.C0)
    const dom = normalizeDom({ name: 'Vale' }, 'a', 1)
    expect(dom.name).toBe('Vale')
    expect(dom.images.provider).toBe('off')
  })
})

describe('domAccess', () => {
  const al = { ai: { provider: 'agenticlover' as const }, account: { signedIn: true, freeSecondsLeft: 600 } }
  it('lets free accounts run on their free minutes until they are used', () => {
    expect(domAccess(al, false)).toBe('ok')
    expect(domAccess({ ...al, account: { signedIn: true, freeSecondsLeft: 0 } }, false)).toBe('freeUsed')
    expect(domAccess({ ...al, account: { signedIn: false, freeSecondsLeft: null } }, true)).toBe('signIn')
  })
  it('lets anyone run on their own AI, signed out included', () => {
    expect(domAccess({ ai: { provider: 'own' }, account: { signedIn: false, freeSecondsLeft: null } }, false)).toBe('ok')
  })
})

describe('normalizeLoras', () => {
  it('keeps named LoRAs and holds weights in range', () => {
    expect(normalizeLoras([{ name: ' face.safetensors ', weight: 9 }, { name: '' }, { weight: 1 }, { name: 'a', weight: 'x' }])).toEqual([
      { name: 'face.safetensors', weight: LORA_WEIGHT_MAX },
      { name: 'a', weight: 1 },
    ])
  })
})

describe('windowAround', () => {
  it('leaves 20% of room around the value, kept inside the range', () => {
    expect(windowAround(0.5).map((v) => Math.round(v * 100))).toEqual([40, 60])
    expect(windowAround(0.95).map((v) => Math.round(v * 100))).toEqual([80, 100])
    expect(windowAround(0).map((v) => Math.round(v * 100))).toEqual([0, 20])
  })
})
