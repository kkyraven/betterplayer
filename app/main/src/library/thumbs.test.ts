import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { LibraryDb } from './db'
import { ThumbQueue } from './thumbs'
import { runTool } from './tools'

it('refreshes older local previews without hiding them or invalidating server images', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-thumb-quality-'))
  const file = join(dir, 'library.db')
  let db = new LibraryDb(file)
  try {
    const rootId = db.addRoot(dir).id
    const path = join(__dirname, 'servers/fixtures/preview.mp4')
    const base = { rootId, folder: '', size: 1, mtime: 1, durationMs: 4000, width: 1920, height: 1080, codec: '', projection: 'flat' as const }
    const id = db.upsertMedia({ ...base, path, title: 'Local' }, 1)
    const remotePath = 'https://example.test/video'
    const remote = db.upsertMedia({ ...base, path: remotePath, title: 'Remote', remoteKey: '1' }, 1)
    for (const mediaId of [id, remote]) {
      db.setThumbState(mediaId, 'thumb', 'ready')
      db.setThumbState(mediaId, 'strip', 'ready')
    }
    db.close()
    const old = new DatabaseSync(file)
    old.exec('DROP TABLE remote_asset_jobs; ALTER TABLE remote_assets DROP COLUMN validators; ALTER TABLE media DROP COLUMN thumb_quality; ALTER TABLE media DROP COLUMN strip_quality; PRAGMA user_version = 18')
    old.close()
    db = new LibraryDb(file)
    expect(db.stamp(path)).toMatchObject({ thumb: 'pending', strip: 'pending' })
    expect(db.stamp(remotePath)).toMatchObject({ thumb: 'ready', strip: 'ready' })
    const before = db.mediaRow(id)
    expect(before?.thumb).toBeTruthy()
    expect(before?.strip).toBeTruthy()
    const queue = new ThumbQueue(dir, db, { done: () => {}, progress: () => {} })
    queue.enqueue({ id, path, durationMs: 4000, cover: null, thumb: true, strip: true })
    await vi.waitFor(() => expect(queue.pending()).toBe(0), { timeout: 30_000 })
    expect(db.stamp(path)).toMatchObject({ thumb: 'ready', strip: 'ready' })
    for (const [kind, width] of [['thumb', 960], ['strip', 12800]] as const) {
      const dimensions = await runTool('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', queue.file(kind, id)], 5000)
      expect(Number(dimensions.trim())).toBe(width)
      expect(db.mediaRow(id)?.[kind]).not.toBe(before?.[kind])
    }
    expect(readdirSync(join(dir, 'thumbs'))).toEqual([`${id}.jpg`])
    expect(readdirSync(join(dir, 'strips'))).toEqual([`${id}.jpg`])
    db.close()
    db = new LibraryDb(file)
    expect(db.stamp(path)).toMatchObject({ thumb: 'ready', strip: 'ready' })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 40_000)

it('keeps the existing preview when its replacement cannot be decoded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-thumb-failure-'))
  const file = join(dir, 'library.db')
  const db = new LibraryDb(file)
  const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    const path = join(dir, 'broken.mp4')
    writeFileSync(path, 'broken video')
    const rootId = db.addRoot(dir).id
    const id = db.upsertMedia({ rootId, path, title: 'Broken', folder: '', size: 1, mtime: 1, durationMs: 4000, width: 1, height: 1, codec: '', projection: 'flat' }, 1)
    const raw = new DatabaseSync(file)
    raw.prepare('UPDATE media SET thumb_ready = 1 WHERE id = ?').run(id)
    raw.close()
    const queue = new ThumbQueue(dir, db, { done: () => {}, progress: () => {} })
    const image = readFileSync(join(__dirname, 'servers/fixtures/poster.jpg'))
    writeFileSync(queue.file('thumb', id), image)
    const url = db.mediaRow(id)?.thumb
    queue.enqueue({ id, path, durationMs: 4000, cover: null, thumb: true, strip: false })
    await vi.waitFor(() => expect(queue.pending()).toBe(0), { timeout: 10_000 })
    expect(readFileSync(queue.file('thumb', id))).toEqual(image)
    expect(db.mediaRow(id)?.thumb).toBe(url)
    expect(db.stamp(path)?.thumb).toBe('pending')
    expect(readdirSync(join(dir, 'thumbs'))).toEqual([`${id}.jpg`])
  } finally {
    errors.mockRestore()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
