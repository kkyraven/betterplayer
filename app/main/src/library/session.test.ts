import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultSessionSetup, type SessionRun } from '@shared/session'
import { sessionSetup } from '@shared/session-settings'
import { LibraryDb } from './db'

let db: LibraryDb, dir: string, file: string, mediaId: number
const run = (): SessionRun => ({
  setup: defaultSessionSetup(),
  clips: [{ mediaId, title: 'Video', startMs: 12000, endMs: 72000, intensity: 0.4, axesOff: ['R0'], phase: 0 }],
  phases: [{ startMs: 0, endMs: 60000, from: 0.2, to: 0.8, hard: false, label: 'Ramp' }],
  totalMs: 60000,
})
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-sessions-'))
  file = join(dir, 'library.db')
  db = new LibraryDb(file)
  const rootId = db.addRoot('/fictional').id
  mediaId = db.upsertMedia(
    { rootId, path: '/fictional/video.mp4', title: 'Video', folder: '', size: 1, mtime: 1, durationMs: 120000, width: 100, height: 100, codec: 'h264', projection: 'flat' },
    1,
  )
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
it('persists a named setup, favourites it, and deletes it without losing history', () => {
  const setup = defaultSessionSetup()
  setup.timeRules = [{ id: 'period', from: 0.25, to: 0.75, mode: 'require', match: 'any', refs: [{ kind: 'tag', name: 'Slow' }] }]
  const savedId = db.saveSession('  Evening  ', setup, false, 100)
  db.favouriteSession('saved', savedId, true)
  const historyId = db.startSession(60000, 200, run(), 'Evening')
  db.finishSession(historyId, true, 300)
  db.close()
  db = new LibraryDb(file)
  expect(db.savedSessions()[0]).toEqual({ id: savedId, name: 'Evening', favourite: true, updatedAt: 100, setup: sessionSetup(setup) })
  db.deleteSavedSession(savedId)
  expect(db.savedSessions()).toEqual([])
  expect(db.sessionHistory()[0]).toMatchObject({ id: historyId, status: 'completed', endedAt: 300 })
})
it('retains exact recorded clips and metadata after the media is removed', () => {
  const original = run(),
    id = db.startSession(60000, 100, original, 'Recorded')
  db.sessionPlayed(id, mediaId, 12000, 72000)
  db.removeMedia([mediaId])
  const recorded = db.sessionHistory()[0]!
  expect(recorded.run?.clips).toEqual(original.clips)
  expect(recorded.run?.phases).toEqual(original.phases)
  expect(recorded.clipCount).toBe(1)
})
it('keeps favourite history beyond the recent fifty and marks unfinished runs after restart', () => {
  const id = db.startSession(60000, 1, run())
  db.favouriteSession('history', id, true)
  for (let i = 2; i <= 60; i++) db.startSession(60000, i, run())
  db.close()
  db = new LibraryDb(file)
  expect(db.sessionHistory()).toHaveLength(51)
  expect(db.sessionHistory().find((s) => s.id === id)).toMatchObject({ favourite: true, status: 'interrupted' })
})
it('migrates version sixteen additively while keeping old session history and watch skips', () => {
  const id = db.startSession(60000, 1)
  db.sessionPlayed(id, mediaId, 1000, 2000)
  db.close()
  const raw = new DatabaseSync(file)
  raw.exec(
    'DROP TABLE remote_asset_jobs; ALTER TABLE remote_assets DROP COLUMN validators; ALTER TABLE media DROP COLUMN favourite; DROP TABLE saved_sessions; ALTER TABLE sessions DROP COLUMN name; ALTER TABLE sessions DROP COLUMN favourite; ALTER TABLE sessions DROP COLUMN ended_at; ALTER TABLE sessions DROP COLUMN status; ALTER TABLE sessions DROP COLUMN run_json; PRAGMA user_version = 16',
  )
  raw.close()
  db = new LibraryDb(file)
  expect(db.sessionHistory()[0]).toMatchObject({ id, status: 'legacy', run: null, clipCount: 1 })
  expect(db.recentSessionMediaIds(1)).toEqual([mediaId])
  expect(db.saveSession('New', defaultSessionSetup(), false, 100)).toBeGreaterThan(0)
})
