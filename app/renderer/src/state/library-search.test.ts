import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaPage, MediaRow } from '@shared/library'

const ipc = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (event: unknown) => void>(),
}))
vi.mock('@/ipc', () => ({ invoke: ipc.invoke, on: (channel: string, listener: (event: unknown) => void) => { ipc.listeners.set(channel, listener); return () => {} } }))
vi.mock('@/state/ui', () => ({ useUi: { getState: () => ({ screen: 'library' }), subscribe: () => () => {} } }))
import { useLibrary } from './library'

function page(id: number, query: string, rev = 1): MediaPage {
  const row: MediaRow = { id, rootId: 1, path: `/fictional/${id}.mp4`, title: `Sample ${id}`, folder: '', size: 1, mtime: 1, addedAt: 1, durationMs: 1000, width: 100, height: 100, codec: '', projection: 'flat', thumb: null, strip: null, axes: [], averageSpeed: 0, heat: [], rating: 0, favourite: false, watchedMs: null, playCount: 0, lastPlayed: null, tags: [], pinned: false, hidden: false }
  return { rows: [row], total: 2, rev, search: { query, conditions: [], corrections: [] } }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  ipc.invoke.mockReset().mockResolvedValue({ rows: [], total: 0 })
  useLibrary.setState({ search: '', searchInfo: null, sort: 'name', desc: false, rows: [], total: 0, rev: null, section: 'all', folder: null, playlistId: null, filters: {}, loading: false })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('library search responses', () => {
  it('rejects an old result during the next query debounce', async () => {
    let resolve: (page: MediaPage) => void = () => {}
    ipc.invoke.mockImplementation(() => new Promise<MediaPage>((r) => { resolve = r }))
    useLibrary.getState().setSearch('coast')
    await vi.advanceTimersByTimeAsync(150)
    useLibrary.getState().setSearch('forest')
    resolve(page(1, 'coast'))
    await Promise.resolve(); await Promise.resolve()
    expect(useLibrary.getState().rows).toEqual([])
    expect(useLibrary.getState().searchInfo).toBeNull()
  })

  it('defaults to Best match and restores the browsing sort on clear', () => {
    useLibrary.getState().setSearch('coast')
    expect(useLibrary.getState()).toMatchObject({ sort: 'recommended', desc: true })
    useLibrary.getState().setSort('rating', true)
    useLibrary.getState().setSearch('')
    expect(useLibrary.getState()).toMatchObject({ sort: 'name', desc: false })
  })

  it('restarts paging when the search revision changes', async () => {
    useLibrary.setState({ search: 'coast', rows: page(1, 'coast').rows, total: 2, rev: 1 })
    ipc.invoke.mockResolvedValueOnce(page(2, 'coast', 2)).mockResolvedValueOnce(page(3, 'coast', 2))
    await useLibrary.getState().query('more')
    await Promise.resolve(); await Promise.resolve()
    expect(useLibrary.getState().rows.map((r) => r.id)).toEqual([3])
  })

  it('preserves hash tag syntax and exposes query failures without remaining busy', async () => {
    ipc.invoke.mockRejectedValue(new Error('test failure'))
    useLibrary.getState().setSearch('#outdoor')
    await vi.advanceTimersByTimeAsync(150)
    expect(ipc.invoke).toHaveBeenCalledWith('library:query', expect.objectContaining({ search: '#outdoor' }))
    expect(useLibrary.getState()).toMatchObject({ loading: false, searchInfo: { error: 'Search unavailable' } })
  })

  it('queries again when automatic tags make another video match', async () => {
    useLibrary.setState({ search: 'coast' })
    ipc.invoke.mockImplementation(async (channel) => channel === 'library:query' ? page(1, 'coast') : [])
    useLibrary.getState().init()
    const unmount = useLibrary.getState().mount('library')
    try {
      await vi.advanceTimersByTimeAsync(0)
      ipc.invoke.mockImplementation(async (channel) => channel === 'library:query' ? page(2, 'coast', 2) : [])
      ipc.listeners.get('library:changed')?.({ kind: 'tags', ids: [2] })
      await vi.advanceTimersByTimeAsync(0)
      expect(useLibrary.getState().rows.map((r) => r.id)).toEqual([2])
    } finally { unmount() }
  })
})
