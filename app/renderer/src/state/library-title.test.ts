import { beforeEach, expect, it, vi } from 'vitest'
import type { MediaRow } from '@shared/library'

const ipc = vi.hoisted(() => ({ invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>() }))
vi.mock('@/ipc', () => ({ invoke: ipc.invoke, on: vi.fn() }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ screen: 'library' }), subscribe: () => () => {} } }))
vi.mock('./player', async () => {
  const { create } = await import('zustand')
  return { usePlayer: create(() => ({ path: '/fictional/one.mp4', title: 'One', media: null, audio: null })) }
})
vi.mock('./editor', async () => {
  const { create } = await import('zustand')
  return { useEditor: create(() => ({ key: '/fictional/one.mp4', title: 'One' })) }
})
import { useLibrary } from './library'
import { usePlayer } from './player'
import { useEditor } from './editor'

const row: MediaRow = { id: 1, rootId: 1, path: '/fictional/one.mp4', title: 'One', folder: '', size: 1, mtime: 1, addedAt: 1, durationMs: 1000, width: 100, height: 100, codec: '', projection: 'flat', thumb: null, strip: null, axes: [], averageSpeed: 0, heat: [], rating: 0, favourite: false, watchedMs: null, playCount: 0, lastPlayed: null, tags: ['original'], pinned: false, hidden: false }
beforeEach(() => {
  ipc.invoke.mockReset().mockImplementation(async (channel) => channel === 'library:media' ? { ...row, title: 'Renamed', titleSet: true, scripts: [] } : undefined)
  useLibrary.setState({ rows: [row], continueRows: [row], detail: { ...row, scripts: [] }, selectedId: row.id })
  usePlayer.setState({ path: row.path, title: row.title, media: null, audio: null })
  useEditor.setState({ key: row.path, title: row.title })
})

it('updates library rows, details, playback and the open editor with the saved metadata title', async () => {
  await useLibrary.getState().setTitle(row.id, ' Renamed ')
  expect(ipc.invoke).toHaveBeenCalledWith('library:setTitle', row.id, ' Renamed ')
  expect(useLibrary.getState().rows[0]).toMatchObject({ title: 'Renamed', titleSet: true })
  expect(useLibrary.getState().continueRows[0]?.title).toBe('Renamed')
  expect(useLibrary.getState().detail?.title).toBe('Renamed')
  expect(usePlayer.getState()).toMatchObject({ title: 'Renamed', media: { title: 'Renamed' } })
  expect(useEditor.getState().title).toBe('Renamed')
})

it('does not rename another file opened while saving', async () => {
  let finish!: () => void
  ipc.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
  const saving = useLibrary.getState().setTitle(row.id, 'Renamed')
  usePlayer.setState({ path: '/other.mp4', title: 'Other' })
  useEditor.setState({ key: '/other.mp4', title: 'Other' })
  finish()
  await saving
  expect(usePlayer.getState().title).toBe('Other')
  expect(useEditor.getState().title).toBe('Other')
})

it('keeps the old title if saving fails', async () => {
  ipc.invoke.mockRejectedValueOnce(new Error('write failed'))
  await expect(useLibrary.getState().setTitle(row.id, 'Renamed')).rejects.toThrow('write failed')
  expect(useLibrary.getState().detail?.title).toBe('One')
  expect(usePlayer.getState().title).toBe('One')
})
