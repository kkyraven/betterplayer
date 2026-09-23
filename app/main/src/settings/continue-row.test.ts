import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/settings'
import { migrate } from './store'

describe('Continue watching row preference', () => {
  it('starts off on new installs and on settings saved before it existed', () => {
    expect(defaultSettings().library.continueRow).toBe(false)
    expect(migrate(null).library.continueRow).toBe(false)
    expect(migrate({ version: 1, library: { autoTag: false } }).library.continueRow).toBe(false)
  })

  it('keeps an explicit choice and treats malformed values as off', () => {
    expect(migrate({ version: 1, library: { continueRow: true } }).library.continueRow).toBe(true)
    expect(migrate({ version: 1, library: { continueRow: 'true' } }).library.continueRow).toBe(false)
  })
})

describe('Axis badges preference', () => {
  it('starts on, and stays on for settings saved before it existed', () => {
    expect(defaultSettings().library.axisBadges).toBe(true)
    expect(migrate({ version: 1, library: { continueRow: true } }).library.axisBadges).toBe(true)
  })

  it('keeps an explicit off', () => {
    expect(migrate({ version: 1, library: { axisBadges: false } }).library.axisBadges).toBe(false)
  })
})
