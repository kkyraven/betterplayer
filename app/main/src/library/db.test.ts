import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { FOLDED_STAMP, LibraryDb } from './db'

const scripts = (pos: number) => [
  { axis: 'L0' as const, json: `{"actions":[{"at":0,"pos":${pos}}]}` },
  { axis: 'R0' as const, json: '{"actions":[]}' },
]

it('preserves a renamed metadata title through rescans and resets it without changing the path', () => {
  const db = new LibraryDb(':memory:')
  try {
    const rootId = db.addRoot('/fictional').id
    const media = { rootId, path: '/fictional/original.mp4', title: 'original', folder: '', size: 1, mtime: 1, durationMs: 1000, width: 100, height: 100, codec: '', projection: 'flat' as const }
    const id = db.upsertMedia(media, 1)
    db.setTitle(id, '  New title  ')
    db.upsertMedia({ ...media, mtime: 2 }, 2)
    expect(db.mediaRow(id)).toMatchObject({ path: media.path, title: 'New title', titleSet: true })
    db.setTitle(id, '')
    expect(db.mediaRow(id)).toMatchObject({ path: media.path, title: 'original', titleSet: false })
  } finally {
    db.close()
  }
})

describe('resetTags', () => {
  it('marks local videos pending again and skips server rows and still images', () => {
    const db = new LibraryDb(':memory:')
    const root = db.addRoot('/fictional').id
    const base = { rootId: root, folder: '', size: 1, mtime: 1, width: 1920, height: 1080, codec: 'hevc', projection: 'flat' as const }
    const local = db.upsertMedia({ ...base, path: '/fictional/a.mp4', title: 'a', durationMs: 60_000 }, 1)
    db.upsertMedia({ ...base, path: '/fictional/b.jpg', title: 'b', durationMs: 0 }, 1)
    db.upsertMedia({ ...base, path: 'https://stash.fictional/scene/1', title: 'c', durationMs: 60_000, remoteKey: '1' }, 1)
    db.setThumbState(local, 'tags', 'ready')
    expect(db.resetTags()).toEqual([{ id: local, rootId: root, path: '/fictional/a.mp4', durationMs: 60_000 }])
    expect(db.stamp('/fictional/a.mp4')?.tags).toBe('pending')
  })

  it('includes server rows when server tagging is on', () => {
    const db = new LibraryDb(':memory:')
    const root = db.addRoot('/fictional').id
    const base = { rootId: root, folder: '', size: 1, mtime: 1, width: 1920, height: 1080, codec: 'hevc', projection: 'flat' as const }
    const local = db.upsertMedia({ ...base, path: '/fictional/a.mp4', title: 'a', durationMs: 60_000 }, 1)
    const remote = db.upsertMedia({ ...base, path: 'https://stash.fictional/scene/1', title: 'c', durationMs: 60_000, remoteKey: '1' }, 1)
    expect(db.resetTags(true).map((r) => r.id)).toEqual([local, remote])
  })
})

describe('setServerTagging', () => {
  it('queues untagged server rows on and drops the pending ones off', () => {
    const db = new LibraryDb(':memory:')
    const root = db.addRoot('/fictional').id
    const base = { rootId: root, folder: '', size: 1, mtime: 1, width: 1920, height: 1080, codec: 'hevc', projection: 'flat' as const }
    db.upsertMedia({ ...base, path: '/fictional/a.mp4', title: 'a', durationMs: 60_000 }, 1)
    const tagged = db.upsertMedia({ ...base, path: 'https://stash.fictional/scene/1', title: 'b', durationMs: 60_000, remoteKey: '1' }, 1)
    const untagged = db.upsertMedia({ ...base, path: 'https://stash.fictional/scene/2', title: 'c', durationMs: 60_000, remoteKey: '2' }, 1)
    db.setThumbState(tagged, 'tags', 'ready')
    db.setThumbState(untagged, 'tags', 'failed')
    expect(db.setServerTagging(true)).toEqual([{ id: untagged, rootId: root, path: 'https://stash.fictional/scene/2', durationMs: 60_000 }])
    expect(db.stamp('https://stash.fictional/scene/1')?.tags).toBe('ready')
    expect(db.stamp('/fictional/a.mp4')?.tags).toBe('pending')
    expect(db.setServerTagging(false)).toEqual([])
    expect(db.stamp('https://stash.fictional/scene/2')?.tags).toBe('failed')
    expect(db.stamp('/fictional/a.mp4')?.tags).toBe('pending')
  })

  it('resumes only the pending server rows at boot, leaving failed ones alone', () => {
    const db = new LibraryDb(':memory:')
    const root = db.addRoot('/fictional').id
    const base = { rootId: root, folder: '', size: 1, mtime: 1, width: 1920, height: 1080, codec: 'hevc', projection: 'flat' as const }
    db.upsertMedia({ ...base, path: '/fictional/a.mp4', title: 'a', durationMs: 60_000 }, 1)
    const failed = db.upsertMedia({ ...base, path: 'https://stash.fictional/scene/1', title: 'b', durationMs: 60_000, remoteKey: '1' }, 1)
    const pending = db.upsertMedia({ ...base, path: 'https://stash.fictional/scene/2', title: 'c', durationMs: 60_000, remoteKey: '2' }, 1)
    db.setThumbState(failed, 'tags', 'failed')
    expect(db.pendingServerTagRows()).toEqual([{ id: pending, rootId: root, path: 'https://stash.fictional/scene/2', durationMs: 60_000 }])
    expect(db.stamp('https://stash.fictional/scene/1')?.tags).toBe('failed')
  })
})

describe('generated scripts', () => {
  it('returns nothing for an unknown key', () => {
    const db = new LibraryDb(':memory:')
    expect(db.generated('/nowhere.mp4')).toBeNull()
  })

  it('replaces the rows for a key and keeps other keys', () => {
    const db = new LibraryDb(':memory:')
    db.setGenerated('/a.mp4', 'h1', '10:20', scripts(0), 1)
    db.setGenerated('/b.mp4', 'h9', '10:20', scripts(50), 1)
    db.setGenerated('/a.mp4', 'h2', '10:21', [{ axis: 'L0', json: '{"actions":[{"at":0,"pos":100}]}' }], 2)
    expect(db.generated('/a.mp4')).toEqual({ hash: 'h2', stamp: '10:21', scripts: [{ axis: 'L0', json: '{"actions":[{"at":0,"pos":100}]}' }] })
    expect(db.generated('/b.mp4')?.hash).toBe('h9')
    db.removeGenerated('/b.mp4')
    expect(db.generated('/b.mp4')).toBeNull()
  })
})

describe('favourite migration', () => {
  it('starts the flag from the old four-star rule and has HereSphere rows re-read from the server', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-db-'))
    const path = join(dir, 'library.db')
    try {
      const db = new LibraryDb(path)
      const local = db.addRoot('/fictional').id
      const hs = db.addServer({ kind: 'heresphere', url: 'http://hs', name: 'HS', username: '', secret: '' }).id
      const stash = db.addServer({ kind: 'stash', url: 'http://stash', name: 'Stash', username: '', secret: '' }).id
      const base = { folder: '', size: 1, mtime: 1, durationMs: 60_000, width: 1, height: 1, codec: '', projection: 'flat' as const }
      const rated = db.upsertMedia({ ...base, rootId: local, path: '/fictional/a.mp4', title: 'a' }, 1)
      const unrated = db.upsertMedia({ ...base, rootId: local, path: '/fictional/b.mp4', title: 'b' }, 1)
      const folded = db.upsertMedia({ ...base, rootId: hs, path: 'http://hs/stream/1', title: 'c', remoteKey: 'http://hs/scene/1' }, 1)
      const scene = db.upsertMedia({ ...base, rootId: stash, path: 'http://stash/stream/2', title: 'd', remoteKey: '2' }, 1)
      db.setRating(rated, 4)
      db.setRating(unrated, 3)
      db.setRating(folded, 4)
      db.setRemoteStamp(folded, 'hs-stamp')
      db.setRemoteStamp(scene, 'stash-stamp')
      db.close()
      const old = new DatabaseSync(path)
      old.exec('DROP TABLE remote_asset_jobs; ALTER TABLE remote_assets DROP COLUMN validators; ALTER TABLE media DROP COLUMN favourite; PRAGMA user_version = 17')
      old.close()
      const migrated = new LibraryDb(path)
      try {
        expect(migrated.mediaRow(rated)?.favourite).toBe(true)
        expect(migrated.mediaRow(unrated)?.favourite).toBe(false)
        expect(migrated.mediaRow(folded)?.favourite).toBe(true)
        expect(migrated.remoteRows(hs).map((r) => r.stamp)).toEqual([FOLDED_STAMP])
        expect(migrated.remoteRows(stash).map((r) => r.stamp)).toEqual(['stash-stamp'])
      } finally { migrated.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})


it('adds asset jobs to v19 without invalidating successful stamps or cached files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-assets-migration-'))
  const path = join(dir, 'library.db')
  try {
    const db = new LibraryDb(path)
    const rootId = db.addServer({ kind: 'stash', url: 'http://fixture', name: 'Fixture', username: '', secret: '' }).id
    const media = { rootId, path: 'http://fixture/stream', remoteKey: '1', title: 'Fixture', folder: '', size: 1, mtime: 1, durationMs: 1000, width: 32, height: 18, codec: '', projection: 'flat' as const }
    const id = db.upsertMedia(media, 1)
    db.setRemoteStamp(id, 'metadata-version')
    db.setScriptsStamp(id, 'script-version')
    db.setRemoteAsset(id, 'thumb', '["one","http://fixture/poster"]', 'digest', 1234)
    db.setThumbState(id, 'thumb', 'ready')
    const before = db.stamp(media.path)
    writeFileSync(join(dir, 'poster.jpg'), 'usable cache')
    db.close()
    const legacy = new DatabaseSync(path)
    legacy.exec('DROP TABLE remote_asset_jobs; ALTER TABLE remote_assets DROP COLUMN validators; PRAGMA user_version = 19')
    legacy.close()
    const migrated = new LibraryDb(path)
    try {
      expect(migrated.stamp(media.path)).toEqual(before)
      expect(migrated.remoteAsset(id, 'thumb')).toMatchObject({ checkedAt: 1234, digest: 'digest' })
      expect(migrated.nextAssetAttempt()).toBeNull()
      expect(readFileSync(join(dir, 'poster.jpg'), 'utf8')).toBe('usable cache')
    } finally { migrated.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
