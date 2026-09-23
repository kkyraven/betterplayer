import { describe, expect, it } from 'vitest'
import type { GridEntry, MediaDetail, MediaPage } from '@shared/library'
import type { LibraryRoot } from '@shared/library'
import { contains, inbound, outbound, permitted } from './paths'

const BASE = 'http://10.0.0.2:8420'
const row = (id: number, path: string) => ({ id, path, title: path }) as unknown as GridEntry
const playlist = { playlist: true, id: 3, name: 'Mix', count: 2, thumbs: [] } as unknown as GridEntry

describe('outbound', () => {
  it('rewrites the path of every video row on a page and leaves playlists alone', () => {
    const page = { rows: [row(7, '/v/a.mp4'), playlist, row(9, '/v/b.mp4')], total: 2 } as MediaPage
    const out = outbound('library:query', page, BASE) as MediaPage
    expect(out.rows.map((r) => ('path' in r ? r.path : r))).toEqual([`${BASE}/media/7`, playlist, `${BASE}/media/9`])
    expect(out.total).toBe(2)
  })

  it('rewrites a detail and passes null and other results through', () => {
    const detail = { id: 4, path: '/v/c.mp4', title: 'c' } as MediaDetail
    expect((outbound('library:media', detail, BASE) as MediaDetail).path).toBe(`${BASE}/media/4`)
    expect(outbound('library:byPath', null, BASE)).toBeNull()
    expect(outbound('library:counts', { all: 3 }, BASE)).toEqual({ all: 3 })
  })
})

describe('inbound', () => {
  const pathOf = (id: number) => (id === 7 ? '/v/a.mp4' : null)

  it('turns a served URL back into the path on a path channel', () => {
    expect(inbound('video:get', [`${BASE}/media/7`], pathOf)).toEqual(['/v/a.mp4'])
    expect(inbound('video:set', [`${BASE}/media/7`, { globalOffsetMs: 0, axes: {} }], pathOf)).toEqual(['/v/a.mp4', { globalOffsetMs: 0, axes: {} }])
  })

  it('leaves unknown ids, plain paths and other channels as they are', () => {
    expect(inbound('video:get', [`${BASE}/media/8`], pathOf)).toEqual([`${BASE}/media/8`])
    expect(inbound('library:byPath', ['/v/a.mp4'], pathOf)).toEqual(['/v/a.mp4'])
    expect(inbound('library:media', [7], pathOf)).toEqual([7])
  })
})

describe('contains', () => {
  it('accepts the root and anything below it, rejects climbing out', () => {
    expect(contains('/v', '/v')).toBe(true)
    expect(contains('/v/', '/v/sub/a.mp4')).toBe(true)
    expect(contains('/v', '/v/..foo')).toBe(true)
    expect(contains('/v', '/v/../etc/passwd')).toBe(false)
    expect(contains('/v', '/v2/a.mp4')).toBe(false)
    expect(contains('/v', '/etc/passwd')).toBe(false)
  })
})

describe('permitted', () => {
  const roots = [
    { id: 1, kind: 'folder', path: '/v' },
    { id: 2, kind: 'stash', path: 'http://stash:9999' },
  ] as LibraryRoot[]

  it('lets the subtitle channels read only under a folder root', () => {
    expect(permitted('subtitles:read', ['/v/a.en.srt'], roots)).toBe(true)
    expect(permitted('subtitles:find', ['/v/a.mp4'], roots)).toBe(true)
    expect(permitted('subtitles:read', ['/etc/passwd'], roots)).toBe(false)
    expect(permitted('subtitles:read', ['/v/../etc/passwd'], roots)).toBe(false)
    expect(permitted('subtitles:find', ['http://stash:9999/x.mp4'], roots)).toBe(false)
    expect(permitted('subtitles:read', [7], roots)).toBe(false)
  })

  it('leaves other channels alone', () => {
    expect(permitted('library:counts', [], roots)).toBe(true)
    expect(permitted('library:byPath', ['/anywhere.mp4'], roots)).toBe(true)
  })
})
