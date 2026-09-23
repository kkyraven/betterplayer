import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/settings'
import { migrate } from './store'

describe('sidebar preferences', () => {
  it('starts empty for new and existing settings', () => {
    for (const settings of [defaultSettings(), migrate(null), migrate({ version: 1, library: { views: [] } })]) {
      expect(settings.library.playlistOrder).toEqual([])
      expect(settings.library.hiddenPlaylists).toEqual([])
      expect(settings.library.pinnedFolders).toEqual([])
    }
  })

  it('preserves order and unavailable entries while rejecting malformed values', () => {
    const library = { playlistOrder: ['remote:1', 'local:2', 'remote:1', null, 3, ''], hiddenPlaylists: ['local:2'], pinnedFolders: ['folder:1', 'folder:2'] }
    const saved = migrate({ version: 1, library })
    expect(saved.library.playlistOrder).toEqual(['remote:1', 'local:2'])
    expect(saved.library.hiddenPlaylists).toEqual(['local:2'])
    expect(saved.library.pinnedFolders).toEqual(['folder:1', 'folder:2'])
    expect(migrate(saved).library).toEqual(saved.library)
    expect(migrate({ version: 1, library: { playlistOrder: {}, hiddenPlaylists: false, pinnedFolders: null } }).library.pinnedFolders).toEqual([])
  })
})
