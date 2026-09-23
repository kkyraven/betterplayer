import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/settings'
import { migrate } from './store'

describe('matching scripts in other folders', () => {
  it('defaults on for new and existing installs', () => {
    expect(defaultSettings().library.matchOtherFolders).toBe(true)
    expect(migrate(null).library.matchOtherFolders).toBe(true)
    expect(migrate({ version: 1, library: { autoTag: false } }).library.matchOtherFolders).toBe(true)
  })

  it('preserves an explicit off and defaults malformed values to on', () => {
    expect(migrate({ version: 1, library: { matchOtherFolders: false } }).library.matchOtherFolders).toBe(false)
    expect(migrate({ version: 1, library: { matchOtherFolders: 'false' } }).library.matchOtherFolders).toBe(true)
  })
})
