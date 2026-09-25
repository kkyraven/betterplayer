import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import type { MediaQuery } from '@shared/library'
import { LibraryDb } from './db'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function file() {
  const dir = mkdtempSync(join(tmpdir(), 'betterplayer-search-test-'))
  temporary.push(dir)
  return join(dir, 'library.db')
}
const query: MediaQuery = { section: 'all', sort: 'recommended', desc: true, filters: {}, search: 'coast outdoor 4k under 20m', limit: 120, offset: 0 }

function populate(db: LibraryDb, count: number) {
  const root = db.addRoot('/fictional').id
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = db.upsertMedia({ rootId: root, path: `/fictional/${i}.mp4`, folder: `Folder ${i % 20}`, title: `Coast sample ${i}`, size: 1000, mtime: 1, durationMs: 600_000, width: 3840, height: 2160, codec: 'hevc', projection: 'flat' }, i)
      db.addTags(id, [i % 5 === 0 ? 'outdoor' : 'nature'])
    }
  })
}

it('resumes an interrupted backfill and retains all library rows after reopening', async () => {
  const path = file()
  let db = new LibraryDb(path)
  populate(db, 1000)
  const pending = db.prepareSearch()
  db.close()
  await pending
  db = new LibraryDb(path)
  try {
    await db.prepareSearch()
    expect(db.query(query).total).toBe(200)
    expect(db.allMediaIds()).toHaveLength(1000)
    expect(db.query({ ...query, search: 'source:fictional' }).total).toBe(1000)
  } finally { db.close() }
})

it('adds search storage to an existing version 14 database without losing metadata', async () => {
  const path = file()
  const old = new DatabaseSync(path)
  old.exec(`
    CREATE TABLE roots (id INTEGER PRIMARY KEY, path TEXT, kind TEXT, name TEXT);
    CREATE TABLE media (id INTEGER PRIMARY KEY, root_id INTEGER, title TEXT, path TEXT, folder TEXT, pinned INTEGER, hidden INTEGER,
      duration_ms INTEGER, width INTEGER, height INTEGER, size INTEGER, mtime INTEGER, added_at INTEGER, codec TEXT, projection TEXT, rating INTEGER, remote_stamp TEXT NOT NULL DEFAULT '');
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE media_tags (media_id INTEGER, tag_id INTEGER);
    CREATE TABLE scripts (media_id INTEGER, source TEXT, axis TEXT);
    CREATE TABLE playlists (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE playlist_items (playlist_id INTEGER, media_id INTEGER, position INTEGER);
    CREATE TABLE watch (media_id INTEGER, play_count INTEGER, last_played INTEGER);
    CREATE TABLE video_settings (key TEXT, position_ms INTEGER);
    CREATE TABLE excluded_folders (root_id INTEGER, folder TEXT);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, planned_ms INTEGER NOT NULL DEFAULT 0);
    INSERT INTO roots VALUES (1, '/fictional', 'folder', '');
    INSERT INTO media VALUES (1, 1, 'Coast', '/fictional/coast.mp4', '', 0, 0, 600000, 3840, 2160, 1000, 1, 1, 'hevc', 'flat', 5, '');
    INSERT INTO tags VALUES (1, 'outdoor');
    INSERT INTO media_tags VALUES (1, 1);
    PRAGMA user_version = 14;
  `)
  old.close()
  const db = new LibraryDb(path)
  try {
    await db.prepareSearch()
    expect(db.query(query).total).toBe(1)
    expect(db.mediaRow(1)).toMatchObject({ title: 'Coast', rating: 5, tags: ['outdoor'] })
  } finally { db.close() }
  const check = new DatabaseSync(path)
  expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(21)
  check.close()
})

it.each([1000, 50_000])('indexes and searches %i generated rows while yielding between batches', async (count) => {
  const db = new LibraryDb(':memory:')
  try {
    populate(db, count)
    let yielded = false
    setImmediate(() => { yielded = true })
    const start = performance.now()
    await db.prepareSearch()
    const indexed = performance.now()
    const page = db.query(query)
    const searched = performance.now()
    expect(yielded).toBe(true)
    expect(page.total).toBe(count / 5)
    expect(page.rows).toHaveLength(Math.min(120, count / 5))
    const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024)
    process.stderr.write(`Synthetic search: ${count} rows, index ${Math.round(indexed - start)} ms, query ${Math.round(searched - indexed)} ms, process RSS ${memoryMb} MB\n`)
  } finally { db.close() }
}, 30_000)
