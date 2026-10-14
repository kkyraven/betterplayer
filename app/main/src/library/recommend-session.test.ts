import { expect, it } from 'vitest'
import type { MediaQuery } from '@shared/library'
import { isPlaylist } from '@shared/library'
import { LibraryDb } from './db'

const RECOMMENDED: MediaQuery = { section: 'all', sort: 'recommended', desc: true, filters: {}, limit: 50, offset: 0 }

function seeded(plays: number[]) {
  const db = new LibraryDb(':memory:')
  const root = db.addRoot('/fictional').id
  const base = { rootId: root, folder: '', size: 1, mtime: 1, width: 1920, height: 1080, codec: 'hevc', projection: 'flat' as const }
  for (let i = 0; i < 12; i++) db.upsertMedia({ ...base, path: `/fictional/${i}.mp4`, title: `v${i}`, durationMs: 60_000 }, i)
  for (const id of plays) db.played(id, 1_000 + id)
  return db
}
const order = (db: LibraryDb) => db.query(RECOMMENDED).rows.filter((r) => !isPlaylist(r)).map((r) => r.id)

it('holds the recommended mix until a reshuffle', () => {
  const db = seeded([])
  const before = order(db)
  const rev = db.query(RECOMMENDED).rev
  const watched = [before.at(-1)!, before.at(-2)!, before.at(-3)!]
  for (const id of [...watched, ...watched]) db.played(id, 1_000 + id)
  db.setTitle(before[0]!, 'renamed')
  expect(order(db)).toEqual(before)
  expect(db.query(RECOMMENDED).rev).toBe(rev)

  db.reshuffle()
  expect(order(db)).toEqual(order(seeded([...watched, ...watched])))
})
