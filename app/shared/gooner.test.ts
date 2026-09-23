import { describe, expect, it } from 'vitest'
import { denialFires, detectKindIds, goonerLocked, restrictDenial, restrictGooner } from './gooner'
import { defaultDenial, defaultGooner, type DenialSettings, type GoonerSettings } from './settings'

const on: GoonerSettings = { ...defaultGooner(), enabled: true, kinds: ['genitals', 'faces'], strength: 0.6 }

describe('goonerLocked', () => {
  it('is free without a lock', () => {
    expect(goonerLocked(on, 1000, 'locked')).toBe(false)
  })
  it('holds a timed lock until its moment', () => {
    const g = { ...on, lock: { kind: 'until', endsAt: 2000 } as const }
    expect(goonerLocked(g, 1999, 'unlocked')).toBe(true)
    expect(goonerLocked(g, 2000, 'unlocked')).toBe(false)
  })
  it('holds a Chaster lock until Chaster says unlocked, including while unknown', () => {
    const g = { ...on, lock: { kind: 'chaster' } as const }
    expect(goonerLocked(g, 0, 'locked')).toBe(true)
    expect(goonerLocked(g, 0, 'unknown')).toBe(true)
    expect(goonerLocked(g, 0, 'unlocked')).toBe(false)
  })
})

describe('restrictGooner', () => {
  const locked = { ...on, lock: { kind: 'chaster' } as const }
  it('lets everything through unlocked', () => {
    expect(restrictGooner(on, { ...on, enabled: false, kinds: [] }, false)).toEqual({ ...on, enabled: false, kinds: [] })
  })
  it('keeps the mode on, the lock, every hidden kind and the strength while locked', () => {
    const next = restrictGooner(locked, { ...locked, enabled: false, lock: null, kinds: ['breasts'], strength: 0.2, style: 'blur' }, true)
    expect(next).toEqual({ ...locked, style: 'blur', kinds: ['genitals', 'faces', 'breasts'] })
  })
  it('accepts a stronger effect while locked', () => {
    expect(restrictGooner(locked, { ...locked, strength: 0.9 }, true).strength).toBe(0.9)
  })
})

describe('restrictDenial', () => {
  const on: DenialSettings = { ...defaultDenial(), enabled: true, kinds: ['genitals'], axes: { L0: { action: 'hold', by: 0.5 } }, holdMs: 1000 }
  it('lets everything through unlocked', () => {
    expect(restrictDenial(on, { ...on, enabled: false, axes: {} }, false)).toEqual({ ...on, enabled: false, axes: {} })
  })
  it('keeps it on, its shape, every kind and axis rule, and the longer hold while locked', () => {
    const next: DenialSettings = { ...on, enabled: false, when: 'unseen', clothing: 'either', kinds: ['breasts'], axes: { L0: { action: 'slower', by: 0.1 }, V0: { action: 'zero', by: 0.5 } }, holdMs: 200 }
    expect(restrictDenial(on, next, true)).toEqual({ ...on, kinds: ['genitals', 'breasts'], axes: { L0: { action: 'hold', by: 0.5 }, V0: { action: 'zero', by: 0.5 } } })
  })
  it('can be switched on while locked, not off', () => {
    const off = { ...on, enabled: false }
    expect(restrictDenial(off, { ...off, enabled: true }, true).enabled).toBe(true)
    expect(restrictDenial(on, { ...on, enabled: false }, true).enabled).toBe(true)
  })
})

describe('detectKindIds', () => {
  it('maps kinds to the engine ids for each clothing choice', () => {
    expect(detectKindIds(['genitals', 'faces', 'skin'], 'exposed')).toEqual(['genitals', 'faces', 'skin'])
    expect(detectKindIds(['genitals', 'faces', 'skin'], 'clothed')).toEqual(['genitalsCovered', 'faces'])
    expect(detectKindIds(['genitals', 'faces'], 'either')).toEqual(['genitals', 'genitalsCovered', 'faces'])
  })
})

describe('denialFires', () => {
  const seen = { when: 'seen', holdMs: 1000 } as const
  const unseen = { when: 'unseen', holdMs: 1000 } as const
  it('fires on a sighting and for the hold after it', () => {
    expect(denialFires(seen, 5000, null, true)).toBe(false)
    expect(denialFires(seen, 5000, 4500, true)).toBe(true)
    expect(denialFires(seen, 5000, 4000, true)).toBe(true)
    expect(denialFires(seen, 5001, 4000, true)).toBe(false)
  })
  it('fires off screen only once the detector has run and the last sighting has aged out', () => {
    expect(denialFires(unseen, 5000, null, false)).toBe(false)
    expect(denialFires(unseen, 5000, null, true)).toBe(true)
    expect(denialFires(unseen, 5000, 4500, true)).toBe(false)
    expect(denialFires(unseen, 6000, 4500, true)).toBe(true)
  })
})
