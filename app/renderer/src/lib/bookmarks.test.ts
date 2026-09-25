import { describe, expect, it } from 'vitest'
import { nearestBookmark, nextBookmarkTime } from './bookmarks'

const bookmarks = [
  { name: 'Later', atMs: 8000 },
  { name: 'Start', atMs: 0 },
  { name: 'Middle', atMs: 4000 },
  { name: 'Duplicate', atMs: 4000 },
  { name: 'Outside', atMs: 12000 },
  { name: 'Invalid', atMs: NaN },
]

describe('bookmark navigation', () => {
  it('finds the closest timestamp in either direction across unsorted scripts', () => {
    expect(nextBookmarkTime(bookmarks, 5000, -1, 10000)).toBe(4000)
    expect(nextBookmarkTime(bookmarks, 5000, 1, 10000)).toBe(8000)
  })
  it('skips duplicates and a small playback advance after seeking', () => {
    expect(nextBookmarkTime(bookmarks, 4100, -1, 10000)).toBe(0)
    expect(nextBookmarkTime(bookmarks, 4000, 1, 10000)).toBe(8000)
  })
  it('does not wrap or seek outside the media', () => {
    expect(nextBookmarkTime(bookmarks, 0, -1, 10000)).toBeUndefined()
    expect(nextBookmarkTime(bookmarks, 8000, 1, 10000)).toBeUndefined()
    expect(nextBookmarkTime([], 5000, 1, 10000)).toBeUndefined()
  })
})

describe('bookmark hit area', () => {
  it('snaps to the nearest bookmark only within the hit area', () => {
    expect(nearestBookmark(bookmarks, 3900, 120, 10000)?.atMs).toBe(4000)
    expect(nearestBookmark(bookmarks, 3800, 120, 10000)).toBeUndefined()
    expect(nearestBookmark(bookmarks, 11950, 120, 10000)).toBeUndefined()
  })
  it('selects the closest bookmark when hit areas overlap', () => {
    expect(nearestBookmark(bookmarks, 5900, 2500, 10000)?.atMs).toBe(4000)
    expect(nearestBookmark(bookmarks, 6100, 2500, 10000)?.atMs).toBe(8000)
  })
})
