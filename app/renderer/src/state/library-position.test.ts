import { beforeEach, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({ invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>() }))
vi.mock('@/ipc', () => ({ invoke: ipc.invoke, on: vi.fn() }))
vi.mock('@/state/ui', () => ({ useUi: { getState: () => ({ screen: 'library' }), subscribe: () => () => {} } }))
import { libraryGridPosition, useLibrary } from './library'

const position = { top: 4000, anchor: { index: 64, offset: 0.5 }, range: { start: 40, end: 120, padTop: 2280, padBottom: 0 } }

beforeEach(() => {
  ipc.invoke.mockReset().mockResolvedValue({ rows: [], total: 0 })
  libraryGridPosition.current = position
  useLibrary.setState({ section: 'all', sort: 'recommended', playlistId: null, search: '', listId: 0 })
})

it.each([
  ['a name sort', { sort: 'name' as const }],
  ['a playlist', { playlistId: 3 }],
  ['a search', { search: 'beach' }],
])('keeps the grid position when an idle reshuffle cannot reorder %s', async (_, state) => {
  useLibrary.setState(state)
  await useLibrary.getState().reshuffle()
  expect(libraryGridPosition.current).toBe(position)
  expect(useLibrary.getState().listId).toBe(0)
})

it('starts the grid at the top for a reshuffled mix', async () => {
  await useLibrary.getState().reshuffle()
  expect(libraryGridPosition.current).toBeNull()
  expect(useLibrary.getState().listId).toBe(1)
})

it('keeps the grid position when Escape clears an empty search', () => {
  useLibrary.getState().setSearch('')
  expect(libraryGridPosition.current).toBe(position)
  expect(useLibrary.getState().listId).toBe(0)
})

it('starts the grid at the top for another list', () => {
  useLibrary.getState().setSection('favourites')
  expect(libraryGridPosition.current).toBeNull()
  expect(useLibrary.getState().listId).toBe(1)
})
