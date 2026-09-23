import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPlaylist, type MediaQuery } from '@shared/library'
import { LibraryDb } from './db'

let db: LibraryDb, dir: string, playlist: number, ids: number[]
const query = (extra: Partial<MediaQuery> = {}): MediaQuery => ({ section: 'all', playlistId: playlist, sort: 'name', desc: true, filters: {}, limit: 120, offset: 0, ...extra })
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-playlist-'))
  db = new LibraryDb(join(dir, 'library.db'))
  const rootId = db.addRoot('/fictional').id
  ids = Array.from({ length: 8 }, (_, i) => db.upsertMedia({ rootId, path: `/fictional/${i}.mp4`, title: `Video ${i + 1}`, folder: '', size: 1, mtime: 1, durationMs: 60000, width: 1920, height: 1080, codec: 'hevc', projection: 'flat' }, i + 1))
  playlist = db.createPlaylist('Friday').id
  db.addToPlaylist(playlist, ids)
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

it('moves third to fifth, persists across reopening, and agrees across pages and playback IDs', () => {
  db.movePlaylistItems(playlist, { mediaIds: [ids[2]!], anchorId: ids[4]!, side: 'after' })
  const expected = [ids[0], ids[1], ids[3], ids[4], ids[2], ...ids.slice(5)]
  db.close(); db = new LibraryDb(join(dir, 'library.db'))
  expect(db.queryIds(query())).toEqual(expected)
  expect(db.query(query({ limit: 2, offset: 4 })).rows.map(r => r.id)).toEqual(expected.slice(4, 6))
  expect(db.jump(query(), 'video 3')).toEqual({ id: ids[2], index: 4 })
})

it('moves groups in playlist order and leaves other playlists alone', () => {
  const other = db.createPlaylist('Other').id
  db.addToPlaylist(other, ids)
  db.movePlaylistItems(playlist, { mediaIds: [ids[5]!, ids[2]!], anchorId: ids[0]!, side: 'before' })
  expect(db.queryIds(query())).toEqual([ids[2], ids[5], ids[0], ids[1], ids[3], ids[4], ids[6], ids[7]])
  expect(db.queryIds(query({ playlistId: other }))).toEqual(ids)
})

it('ignores pins and other sorts in playlists, including searches', () => {
  db.setPinned([ids[7]!], 100)
  expect(db.queryIds(query())).toEqual(ids)
  expect(db.queryIds(query({ search: 'Video', sort: 'recommended' }))).toEqual(ids)
  expect(db.queryIds(query({ playlistId: undefined }))[0]).toBe(ids[7])
})

it('keeps excluded membership and full positions while filtering', () => {
  db.setHidden([ids[3]!], true)
  db.movePlaylistItems(playlist, { mediaIds: [ids[2]!], anchorId: ids[4]!, side: 'after' })
  expect(db.queryIds(query())).toEqual([ids[0], ids[1], ids[4], ids[2], ...ids.slice(5)])
  db.setHidden([ids[3]!], false)
  const row = db.query(query({ search: '"Video 3"' })).rows[0]!
  expect(!isPlaylist(row) && row.playlistPosition).toBe(5)
  expect(db.queryIds(query())[2]).toBe(ids[3])
})

it('rejects stale anchors or members without writing a partial order', () => {
  expect(() => db.movePlaylistItems(playlist, { mediaIds: [ids[2]!], anchorId: 9999, side: 'after' })).toThrow()
  expect(() => db.movePlaylistItems(playlist, { mediaIds: [ids[2]!, 9999], anchorId: ids[4]!, side: 'after' })).toThrow()
  expect(db.queryIds(query())).toEqual(ids)
})

it('handles endpoints, no-ops and gaps after removal', () => {
  db.movePlaylistItems(playlist, { mediaIds: [ids[7]!], anchorId: ids[0]!, side: 'before' })
  db.movePlaylistItems(playlist, { mediaIds: [ids[7]!], anchorId: ids[6]!, side: 'after' })
  db.movePlaylistItems(playlist, { mediaIds: [ids[2]!], anchorId: ids[2]!, side: 'before' })
  expect(db.queryIds(query())).toEqual(ids)
  db.removeFromPlaylist(playlist, [ids[1]!])
  expect(db.query(query()).rows.map(r => !isPlaylist(r) && r.playlistPosition)).toEqual([1, 2, 3, 4, 5, 6, 7])
})
