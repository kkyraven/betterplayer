import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/settings'
import { migrate } from './store'

describe('Stash app path', () => {
  it('starts empty and survives a round trip', () => {
    expect(defaultSettings().library.stashApp).toBe('')
    expect(migrate({ version: 1 }).library.stashApp).toBe('')
    const settings = migrate({ version: 1, library: { stashApp: 'C:\\Stash\\stash.exe' } })
    expect(settings.library.stashApp).toBe('C:\\Stash\\stash.exe')
    expect(migrate(JSON.parse(JSON.stringify(settings))).library.stashApp).toBe('C:\\Stash\\stash.exe')
  })

  it('drops malformed values', () => {
    for (const stashApp of [null, 0, true, {}]) expect(migrate({ version: 1, library: { stashApp } }).library.stashApp).toBe('')
  })
})
