import { expect, it } from 'vitest'
import { LibraryDb } from './db'

it('replaces only one source of marks at a time, and drops them with the video', () => {
  const db = new LibraryDb(':memory:')
  try {
    const rootId = db.addRoot('/fictional').id
    const id = db.upsertMedia({ rootId, path: '/fictional/a.mkv', title: 'a', folder: '', size: 1, mtime: 1, durationMs: 60_000, width: 1, height: 1, codec: '', projection: 'flat' }, 1)
    db.setMarks(id, 'file', [{ name: 'Intro', startMs: 0, endMs: 10_000 }])
    db.setMarks(id, 'headset', [{ name: 'Mine', startMs: 5000, endMs: null }])
    db.setMarks(id, 'file', [{ name: 'Second', startMs: 20_000, endMs: 30_000 }])
    expect(db.marks(id)).toEqual([
      { name: 'Mine', startMs: 5000, endMs: null, source: 'headset' },
      { name: 'Second', startMs: 20_000, endMs: 30_000, source: 'file' },
    ])
    db.removeMedia([id])
    expect(db.marks(id)).toEqual([])
  } finally {
    db.close()
  }
})
