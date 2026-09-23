import { afterEach, expect, it, vi } from 'vitest'
import { movePlaylistItems, shufflePlaylist } from './playlist'

afterEach(() => vi.restoreAllMocks())
it('moves forward without counting the dragged item twice', () => {
  const ids = [1, 2, 3, 4, 5, 6]
  expect(movePlaylistItems(ids, { mediaIds: [3], anchorId: 5, side: 'after' })).toEqual([1, 2, 4, 5, 3, 6])
  expect(ids).toEqual([1, 2, 3, 4, 5, 6])
})
it('shuffles once without duplicates or changing the source', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
  const ids = [1, 2, 3, 4, 5]
  const shuffled = shufflePlaylist(ids)
  expect(shuffled).not.toEqual(ids)
  expect([...shuffled].sort()).toEqual(ids)
  expect(ids).toEqual([1, 2, 3, 4, 5])
  expect(shufflePlaylist([])).toEqual([])
  expect(shufflePlaylist([1])).toEqual([1])
})
