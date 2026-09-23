import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MediaQuery } from '@shared/library'
import { LibraryDb } from '../db'

describe('Stash group playlists', () => {
  let db: LibraryDb
  let root: number
  let a: number
  let b: number
  const query: MediaQuery = { section: 'all', sort: 'name', desc: false, filters: {}, offset: 0, limit: 100 }
  beforeEach(() => {
    db = new LibraryDb(':memory:')
    root = db.addServer({ kind: 'stash', url: 'https://stash.example', name: 'Stash', username: '', secret: '' }).id
    const base = { rootId: root, folder: '', size: 1, mtime: 1, width: 1920, height: 1080, durationMs: 60_000, codec: 'h264', projection: 'flat' as const }
    a = db.upsertMedia({ ...base, path: 'https://stash.example/a', remoteKey: 'a', title: 'A' }, 1)
    b = db.upsertMedia({ ...base, path: 'https://stash.example/b', remoteKey: 'b', title: 'B' }, 1)
  })
  afterEach(() => db.close())
  const members = (id: number) => db.queryIds({ ...query, playlistId: id })

  it('uses server and group IDs, preserves order, and updates without creating duplicates', () => {
    db.createPlaylist('Collection')
    expect(db.importGroups(root, [{ key: 'g', name: 'Collection', sceneKeys: ['b', 'a', 'missing', 'a'] }])).toEqual({ created: 1, updated: 0, skipped: 0 })
    const id = db.playlists().find((p) => p.count === 2)!.id
    expect(members(id)).toEqual([b, a])
    expect(db.importGroups(root, [{ key: 'g', name: 'Renamed', sceneKeys: ['a'] }])).toEqual({ created: 0, updated: 1, skipped: 0 })
    expect(db.playlists()).toContainEqual({ id, name: 'Renamed', count: 1 })
    const second = db.addServer({ kind: 'stash', url: 'https://other.example', name: 'Other', username: '', secret: '' }).id
    expect(db.importGroups(second, [{ key: 'g', name: 'Collection', sceneKeys: ['a'] }]).created).toBe(1)
    expect(db.playlists()).toHaveLength(3)
  })

  it('preserves renamed playlists and local membership edits', () => {
    db.importGroups(root, [{ key: 'g', name: 'Collection', sceneKeys: ['a', 'b'] }])
    const id = db.playlists()[0]!.id
    db.removeFromPlaylist(id, [a])
    expect(db.importGroups(root, [{ key: 'g', name: 'Changed remotely', sceneKeys: ['a'] }]).skipped).toBe(1)
    expect(members(id)).toEqual([b])
    db.renamePlaylist(id, 'My playlist')
    db.importGroups(root, [{ key: 'g', name: 'Changed remotely', sceneKeys: [] }])
    expect(db.playlists()[0]!.name).toBe('My playlist')
  })

  it('still updates when deleted library videos were removed by cascade', () => {
    db.importGroups(root, [{ key: 'g', name: 'Collection', sceneKeys: ['a', 'b'] }])
    const id = db.playlists()[0]!.id
    db.removeMedia([a])
    expect(db.importGroups(root, [{ key: 'g', name: 'Updated', sceneKeys: ['b'] }]).updated).toBe(1)
    expect(members(id)).toEqual([b])
    expect(db.playlists()[0]!.name).toBe('Updated')
  })

  it('excludes hidden videos and keeps playlists when a group disappears remotely', () => {
    db.setHidden([b], true)
    db.importGroups(root, [{ key: 'g', name: 'Collection', sceneKeys: ['a', 'b'] }])
    const id = db.playlists()[0]!.id
    expect(members(id)).toEqual([a])
    db.importGroups(root, [])
    expect(db.playlists()).toHaveLength(1)
  })
})
