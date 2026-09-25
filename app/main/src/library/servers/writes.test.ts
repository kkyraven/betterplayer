import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FOLDED_STAMP, LibraryDb, type ServerRoot } from '../db'
import type { Adapter } from './adapter'
import { RemoteWrites } from './writes'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
  vi.useRealTimers()
})

function setup(path = ':memory:', kind: ServerRoot['kind'] = 'stash') {
  const db = new LibraryDb(path)
  cleanup.push(() => db.close())
  const root = db.addServer({ kind, url: 'http://stash', name: 'Stash', username: '', secret: '' })
  const id = db.upsertMedia({ rootId: root.id, path: 'http://stash/stream/1', folder: '', title: 'Scene', size: 0, mtime: 0, durationMs: 0, width: 0, height: 0, codec: '', projection: 'flat', remoteKey: '1' }, 1)
  const writeBack = vi.fn<Adapter['writeBack']>().mockResolvedValue(undefined)
  const adapter: Adapter = { kind, headers: {}, probe: async () => 'Stash', async *scenes() {}, writeBack }
  const queue = new RemoteWrites(db, () => adapter, () => {})
  cleanup.push(() => queue.close())
  return { db, root, id, writeBack, queue }
}

describe('remote edits', () => {
  it('keeps failures pending and exposes the error until a retry succeeds', async () => {
    const { db, root, id, writeBack, queue } = setup()
    db.setRating(id, 4)
    queue.add([id])
    writeBack.mockRejectedValueOnce(new Error('sign in failed'))
    await queue.flush()
    expect(db.hasRemoteWrite(id)).toBe(true)
    expect(db.root(root.id)?.error).toBe('sign in failed')
    db.setRootError(root.id, 'Asset download failed\nsign in failed')
    await queue.flush()
    expect(writeBack).toHaveBeenLastCalledWith('1', { rating: 4, favourite: false, tags: [] })
    expect(db.hasRemoteWrite(id)).toBe(false)
    expect(db.root(root.id)?.error).toBe('Asset download failed')
  })

  it('retains newer edits while serializing requests', async () => {
    vi.useFakeTimers()
    const { db, id, writeBack, queue } = setup()
    let finish = () => {}
    writeBack.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    queue.add([id])
    const first = queue.flush()
    expect(db.hasRemoteWrite(id)).toBe(true)
    db.setRating(id, 5)
    queue.add([id])
    await queue.flush()
    expect(writeBack).toHaveBeenCalledTimes(1)
    finish()
    await first
    expect(db.hasRemoteWrite(id)).toBe(true)
    await vi.advanceTimersByTimeAsync(600)
    expect(writeBack).toHaveBeenLastCalledWith('1', { rating: 5, favourite: false, tags: [] })
    expect(db.hasRemoteWrite(id)).toBe(false)
  })

  it('holds a HereSphere edit on a v18 folded row until a sync stamps it', async () => {
    const { db, id, writeBack, queue } = setup(':memory:', 'heresphere')
    db.setRating(id, 4)
    db.setRemoteStamp(id, FOLDED_STAMP)
    queue.add([id])
    await queue.flush()
    expect(writeBack).not.toHaveBeenCalled()
    expect(db.hasRemoteWrite(id)).toBe(true)
    db.setRemoteStamp(id, 'synced')
    await queue.flush()
    expect(writeBack).toHaveBeenCalledWith('1', { rating: 4, favourite: false, tags: [] })
    expect(db.hasRemoteWrite(id)).toBe(false)
  })

  it('still posts edits on a HereSphere row whose assets are incomplete', async () => {
    const { db, id, writeBack, queue } = setup(':memory:', 'heresphere')
    db.setRating(id, 4)
    db.setRemoteStamp(id, '')
    queue.add([id])
    await queue.flush()
    expect(writeBack).toHaveBeenCalledWith('1', { rating: 4, favourite: false, tags: [] })
    expect(db.hasRemoteWrite(id)).toBe(false)
  })

  it('persists pending edits on disk and cascades them when media is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-writes-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'library.db')
    const { db, id, queue } = setup(path)
    queue.add([id])
    const reopened = new LibraryDb(path)
    try {
      expect(reopened.hasRemoteWrite(id)).toBe(true)
      reopened.removeMedia([id])
      expect(reopened.remoteWrites()).toEqual([])
      expect(db.hasRemoteWrite(id)).toBe(false)
    } finally { reopened.close() }
  })

  it('does not access the database after shutdown during a request', async () => {
    const { db, id, writeBack, queue } = setup()
    let finish = () => {}
    writeBack.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    queue.add([id])
    const pending = queue.flush()
    queue.close()
    const completion = vi.spyOn(db, 'finishRemoteWrite')
    finish()
    await pending
    expect(completion).not.toHaveBeenCalled()
    expect(db.hasRemoteWrite(id)).toBe(true)
  })

  it('adds the pending-write table to an existing v13 library without changing media', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-write-migration-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'library.db')
    const { db, id } = setup(path)
    db.setRating(id, 5)
    const old = new DatabaseSync(path)
    for (const row of old.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name GLOB 'search_*'").all()) {
      old.exec(`DROP TRIGGER "${String(row.name).replace(/"/g, '""')}"`)
    }
    old.exec('DROP TABLE search_vocab; DROP TABLE search_fts; DROP TABLE search_pending; DROP TABLE media_performers; DROP TABLE performers; DROP TABLE media_details')
    old.exec('DROP TABLE remote_assets; DROP TABLE imported_groups; ALTER TABLE media DROP COLUMN strip_stamp')
    old.exec('ALTER TABLE media DROP COLUMN favourite; DROP TABLE saved_sessions; ALTER TABLE sessions DROP COLUMN name; ALTER TABLE sessions DROP COLUMN favourite; ALTER TABLE sessions DROP COLUMN ended_at; ALTER TABLE sessions DROP COLUMN status; ALTER TABLE sessions DROP COLUMN run_json')
    old.exec('DROP TABLE remote_asset_jobs; DROP TABLE remote_writes; PRAGMA user_version = 13')
    old.close()
    const migrated = new LibraryDb(path)
    try {
      expect(migrated.mediaRow(id)).toMatchObject({ rating: 5, favourite: true })
      migrated.queueRemoteWrite(id)
      expect(migrated.hasRemoteWrite(id)).toBe(true)
    } finally { migrated.close() }
  })
})
