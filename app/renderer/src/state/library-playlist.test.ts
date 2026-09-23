import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { MediaRow } from '@shared/library'
const ipc = vi.hoisted(() => ({ invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>() }))
vi.mock('@/ipc', () => ({ invoke: ipc.invoke, on: vi.fn() }))
vi.mock('@/state/ui', () => ({ useUi: { getState: () => ({ screen: 'library' }), subscribe: () => () => {} } }))
import { useLibrary } from './library'

const rows: MediaRow[] = [1, 2, 3, 4, 5, 6].map(id => ({ id, playlistPosition: id, rootId: 1, path: `/fictional/${id}.mp4`, title: `Video ${id}`, folder: '', size: 1, mtime: 1, addedAt: 1, durationMs: 1000, width: 100, height: 100, codec: '', projection: 'flat', thumb: null, strip: null, axes: [], averageSpeed: 0, heat: [], rating: 0, favourite: false, watchedMs: null, playCount: 0, lastPlayed: null, tags: [], pinned: false, hidden: false }))
beforeEach(() => {
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('localStorage', { getItem: () => 'grid', setItem: vi.fn() })
  useLibrary.setState({ rows, total: 6, playlistId: 1, movingPlaylist: null, playlistError: null, search: '', filters: {}, loading: false, view: 'grid' })
  ipc.invoke.mockReset().mockResolvedValue({ rows, total: 6 })
})
afterEach(() => vi.unstubAllGlobals())

it('opens each playlist as a list and restores the Library view on leaving', () => {
  useLibrary.getState().setPlaylist(2)
  expect(useLibrary.getState().view).toBe('list')
  useLibrary.getState().setView('condensed')
  expect(localStorage.setItem).not.toHaveBeenCalled()
  useLibrary.getState().setSection('all')
  expect(useLibrary.getState().view).toBe('grid')
})

it('shows a move immediately, ignores refreshes during the save, then reconciles', async () => {
  let finish = () => {}
  ipc.invoke.mockImplementation(channel => channel === 'library:movePlaylistItems' ? new Promise<void>(resolve => { finish = resolve }) : Promise.resolve({ rows: [rows[0], rows[1], rows[3], rows[4], rows[2], rows[5]], total: 6 }))
  const saving = useLibrary.getState().movePlaylistItems(1, { mediaIds: [3], anchorId: 5, side: 'after' })
  expect(useLibrary.getState().rows.map(r => r.id)).toEqual([1, 2, 4, 5, 3, 6])
  await useLibrary.getState().query('shown')
  await useLibrary.getState().movePlaylistItems(1, { mediaIds: [1], anchorId: 6, side: 'after' })
  expect(ipc.invoke).toHaveBeenCalledTimes(1)
  finish(); await saving
  expect(useLibrary.getState().movingPlaylist).toBeNull()
  expect(useLibrary.getState().rows.map(r => r.id)).toEqual([1, 2, 4, 5, 3, 6])
})

it('restores order and reports a failed save', async () => {
  ipc.invoke.mockImplementation(channel => channel === 'library:movePlaylistItems' ? Promise.reject(new Error('disk')) : Promise.resolve({ rows, total: 6 }))
  await useLibrary.getState().movePlaylistItems(1, { mediaIds: [3], anchorId: 5, side: 'after' })
  expect(useLibrary.getState().rows.map(r => r.id)).toEqual([1, 2, 3, 4, 5, 6])
  expect(useLibrary.getState().playlistError).toBeTruthy()
})

it('does not reorder a filtered playlist', async () => {
  useLibrary.setState({ filters: { watched: 'no' } })
  await useLibrary.getState().movePlaylistItems(1, { mediaIds: [3], anchorId: 5, side: 'after' })
  expect(ipc.invoke).not.toHaveBeenCalled()
})
