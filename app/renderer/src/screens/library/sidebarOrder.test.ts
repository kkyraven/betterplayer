import { describe, expect, it } from 'vitest'
import { dropItem, moveItem, orderedItems, sidebarKey } from './sidebarOrder'

describe('sidebar order', () => {
  it('keeps new playlists in their original order after the saved playlists', () => {
    expect(orderedItems([1, 2, 3, 4], ['3', '1', '99'], String)).toEqual([3, 1, 2, 4])
  })

  it('moves a playlist to the top without making it permanently pinned', () => {
    const pinned = moveItem([1, 2, 3], 3, 0)
    expect(pinned).toEqual([3, 1, 2])
    expect(moveItem(pinned, 3, 2)).toEqual([1, 2, 3])
  })

  it('moves in either direction and ignores stale IDs', () => {
    expect(moveItem([1, 2, 3, 4], 2, 3)).toEqual([1, 3, 4, 2])
    expect(moveItem([1, 2, 3, 4], 4, 1)).toEqual([1, 4, 2, 3])
    expect(moveItem([1, 2, 3], 9, 0)).toEqual([1, 2, 3])
  })

  it('isolates matching IDs across library sources and folder paths', () => {
    const keys = [sidebarKey('', 1), sidebarKey('remote:3456', 1), sidebarKey('', 1, ''), sidebarKey('', 1, 'clips'), sidebarKey('', 2, 'clips')]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('drops built-in sections before or after a row in either direction', () => {
    const views = ['all', 'continue', 'favourites', 'newest']
    expect(dropItem(views, 'favourites', 'all', false)).toEqual(['favourites', 'all', 'continue', 'newest'])
    expect(dropItem(views, 'favourites', 'all', true)).toEqual(['all', 'favourites', 'continue', 'newest'])
    expect(dropItem(views, 'all', 'favourites', false)).toEqual(['continue', 'all', 'favourites', 'newest'])
    expect(dropItem(views, 'all', 'favourites', true)).toEqual(['continue', 'favourites', 'all', 'newest'])
    expect(dropItem(views, 'favourites', 'favourites', true)).toEqual(views)
    expect(dropItem(views, 'hidden', 'all', false)).toEqual(views)
    expect(dropItem(views, 'all', 'hidden', false)).toEqual(views)
  })
})
