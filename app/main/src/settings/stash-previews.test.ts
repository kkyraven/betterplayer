import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/settings'
import { migrate } from './store'

describe('Stash preview preference', () => {
  it('starts enabled on new installs and when reading existing settings', () => {
    expect(defaultSettings().library.stashPreviews).toBe(true)
    expect(migrate(null).library.stashPreviews).toBe(true)
    expect(migrate({ version: 1 }).library.stashPreviews).toBe(true)
    expect(migrate({ version: 1, library: { autoTag: false } }).library.stashPreviews).toBe(true)
  })

  it('preserves an explicit choice through settings round trips', () => {
    for (const stashPreviews of [false, true]) {
      const settings = migrate({ version: 1, library: { stashPreviews } })
      expect(settings.library.stashPreviews).toBe(stashPreviews)
      expect(migrate(JSON.parse(JSON.stringify(settings))).library.stashPreviews).toBe(stashPreviews)
    }
  })

  it('defaults malformed values to enabled', () => {
    for (const stashPreviews of ['false', null, 0]) {
      expect(migrate({ version: 1, library: { stashPreviews } }).library.stashPreviews).toBe(true)
    }
  })
})
