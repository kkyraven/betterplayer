import { expect, it } from 'vitest'
import type { MediaQuery } from '@shared/library'
import { isPlaylist } from '@shared/library'
import { LibraryDb } from './db'

const RECOMMENDED: MediaQuery = { section: 'all', sort: 'recommended', desc: true, filters: {}, limit: 10, offset: 0 }

it('holds partly watched videos back from the recommended mix only for a query with the row', () => {
  const db = new LibraryDb(':memory:')
  const root = db.addRoot('/fictional').id
  const base = { rootId: root, folder: '', size: 1, mtime: 1, width: 1920, height: 1080, codec: 'hevc', projection: 'flat' as const }
  for (const name of ['a', 'b', 'c', 'd', 'e']) db.upsertMedia({ ...base, path: `/fictional/${name}.mp4`, title: name, durationMs: 60_000 }, 1)
  db.setVideoSettings('/fictional/b.mp4', { positionMs: 10_000, settings: '{}' }, 1)
  db.setVideoSettings('/fictional/d.mp4', { positionMs: 20_000, settings: '{}' }, 1)
  const ids = (q: MediaQuery) => db.query(q).rows.filter((r) => !isPlaylist(r)).map((r) => r.id)
  const partlyWatched = new Set(ids({ ...RECOMMENDED, section: 'continue', sort: 'lastPlayed' }))
  expect(partlyWatched.size).toBe(2)

  const plain = ids(RECOMMENDED)
  expect(plain).toHaveLength(5)
  const held = ids({ ...RECOMMENDED, continueRow: true })
  expect(held).toEqual([...plain.filter((id) => !partlyWatched.has(id)), ...plain.filter((id) => partlyWatched.has(id))])
  expect(db.queryIds({ ...RECOMMENDED, continueRow: true })).toEqual(held)
})
