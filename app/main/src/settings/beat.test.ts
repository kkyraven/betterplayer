import { describe, expect, it } from 'vitest'
import { migrate } from './store'

describe('Beat replacement', () => {
  it.each(['half', 'full', 'double', 'smash', 'raw'])('migrates %s to strokes and preserves explicit volume preference', (beatStyle) => {
    expect(migrate({ version: 1, tracking: { beatStyle, beatVolumeDepth: true } }).tracking)
      .toMatchObject({ beatStyle: 'strokes', beatVolumeDepth: true })
  })

  it('defaults to strokes and repairs a saved raw selection', () => {
    expect(migrate(null).tracking).toMatchObject({ beatStyle: 'strokes', beatVolumeDepth: false })
    expect(migrate({ version: 1, tracking: { beatStyle: 'raw' } }).tracking)
      .toMatchObject({ beatStyle: 'strokes', beatVolumeDepth: false })
  })

  it('enables bottom bounce by default and preserves an explicit off preference', () => {
    expect(migrate(null).tracking.beatBounce).toBe(true)
    const saved = migrate({ version: 1, tracking: { beatBounce: false, flourishes: true } })
    expect(migrate(saved).tracking).toMatchObject({ beatBounce: false, flourishes: true })
  })

  it('keeps bounce defaults exact and persists custom depth and speed while disabled', () => {
    expect(migrate(null).tracking).toMatchObject({ beatBounceDepth: 1 / 6, beatBounceSpeed: 3 })
    const saved = migrate({ version: 1, tracking: { beatBounce: false, beatBounceDepth: 0.35, beatBounceSpeed: 4.25 } })
    expect(migrate(saved).tracking).toMatchObject({ beatBounce: false, beatBounceDepth: 0.35, beatBounceSpeed: 4.25 })
  })

  it.each([
    [-1, 0.01, 0.5], [100, 1, 6], [NaN, 1 / 6, 3], [Infinity, 1 / 6, 3], ['bad', 1 / 6, 3],
  ])('repairs invalid bounce settings %s', (value, depth, speed) => {
    expect(migrate({ version: 1, tracking: { beatBounceDepth: value, beatBounceSpeed: value } }).tracking)
      .toMatchObject({ beatBounceDepth: depth, beatBounceSpeed: speed })
  })
})
