import type { Bookmark } from 'bp-engine'

export function nearestBookmark(bookmarks: readonly Bookmark[], timeMs: number, toleranceMs: number, durationMs: number): Bookmark | undefined {
  let nearest: Bookmark | undefined
  let distance = toleranceMs
  for (const bookmark of bookmarks) {
    if (!Number.isFinite(bookmark.atMs) || bookmark.atMs < 0 || bookmark.atMs > durationMs) continue
    const delta = Math.abs(bookmark.atMs - timeMs)
    if (delta <= distance) {
      nearest = bookmark
      distance = delta
    }
  }
  return nearest
}

export function nextBookmarkTime(bookmarks: readonly Bookmark[], timeMs: number, direction: -1 | 1, durationMs: number): number | undefined {
  let target: number | undefined
  for (const { atMs } of bookmarks) {
    if (!Number.isFinite(atMs) || atMs < 0 || atMs > durationMs) continue
    if ((atMs - timeMs) * direction <= 250) continue
    if (target === undefined || (atMs - target) * direction < 0) target = atMs
  }
  return target
}
