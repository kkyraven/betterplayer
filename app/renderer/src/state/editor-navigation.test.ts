import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EditorStored } from '@shared/editor'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), readScripts: vi.fn(),
  engine: { videoFps: vi.fn(() => 30), analyseCancel: vi.fn(), clearDraft: vi.fn(), analyseClose: vi.fn() },
  player: { path: '/current.mp4' as string | null, title: 'Current', snapshot: { loaded: true, paused: true, error: null as string | null, durationMs: 60_000 }, open: vi.fn(), pause: vi.fn() },
  subscribePlayer: vi.fn(),
}))
vi.mock('@/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/engine/client', () => ({ engine: mocks.engine, readScripts: mocks.readScripts }))
vi.mock('./player', () => ({ usePlayer: { getState: () => mocks.player, subscribe: mocks.subscribePlayer }, isUrl: (path: string) => /^https?:/.test(path) }))
vi.mock('./usage', () => ({ track: vi.fn() }))
vi.mock('./live', () => ({ get: () => ({ timeMs: 0 }), subscribe: vi.fn() }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({ settings: null }) } }))
vi.mock('./tracking', () => ({ useTracking: { getState: () => ({}) } }))

let editor: typeof import('./editor').useEditor
let ui: typeof import('./ui').useUi
const stored: EditorStored = { saved: null, savedAt: null, draft: null, draftAt: null, exported: null, exportedAt: null }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  mocks.player.path = '/current.mp4'
  mocks.player.title = 'Current'
  mocks.player.snapshot.error = null
  mocks.player.open.mockImplementation(async (path: string) => { mocks.player.path = path })
  mocks.readScripts.mockResolvedValue([])
  mocks.invoke.mockImplementation(async (channel: string) => channel === 'editor:load' ? stored : channel === 'editor:patterns' ? [] : null)
  ui = (await import('./ui')).useUi
  editor = (await import('./editor')).useEditor
})
afterEach(() => { editor.getState().close(); vi.unstubAllGlobals() })

it('opens the file browser without loading the player’s current video', async () => {
  await editor.getState().openEditor()
  expect(ui.getState().screen).toBe('editor')
  expect(editor.getState().open).toBe(false)
  expect(mocks.player.open).not.toHaveBeenCalled()
  expect(mocks.invoke).not.toHaveBeenCalledWith('editor:load', '/current.mp4')
})

it('opens an explicitly selected file without navigating through the player screen', async () => {
  await editor.getState().openEditor('/chosen.mp4')
  expect(mocks.player.open).toHaveBeenCalledWith('/chosen.mp4', undefined, undefined, false, expect.any(AbortSignal))
  expect(mocks.player.pause).toHaveBeenCalled()
  expect(editor.getState()).toMatchObject({ open: true, key: '/chosen.mp4', openingFile: null })
  expect(ui.getState().screen).toBe('editor')
})

it('writes the draft on leaving and returns to file selection on the next visit', async () => {
  await editor.getState().openEditor('/current.mp4')
  editor.setState({ dirty: true })
  const lanes = editor.getState().lanes
  ui.getState().setScreen('utilities')
  expect(mocks.invoke).toHaveBeenCalledWith('editor:saveDraft', '/current.mp4', expect.objectContaining({ lanes }))
  ui.getState().setScreen('editor')
  expect(editor.getState()).toMatchObject({ open: false, key: null })
})

it('does not reopen a document whose load completes after returning to the file list', async () => {
  const load = deferred<EditorStored>()
  mocks.invoke.mockImplementation(async (channel: string) => channel === 'editor:load' ? load.promise : [])
  const opening = editor.getState().openEditor('/current.mp4')
  editor.getState().close()
  load.resolve(stored)
  await opening
  expect(editor.getState()).toMatchObject({ open: false, key: null, openingFile: null })
})

it('aborts a pending media open when the user leaves the editor', async () => {
  const media = deferred<void>()
  mocks.player.open.mockReturnValue(media.promise)
  const opening = editor.getState().openEditor('/slow.mp4')
  const signal: AbortSignal = mocks.player.open.mock.calls[0]?.[4]
  ui.getState().setScreen('library')
  expect(signal.aborted).toBe(true)
  media.resolve()
  await opening
  expect(editor.getState().open).toBe(false)
  expect(ui.getState().screen).toBe('library')
})

it('keeps a failed file open on the start screen with an error', async () => {
  mocks.player.open.mockRejectedValue(new Error('Missing file'))
  await editor.getState().openEditor('/missing.mp4')
  expect(editor.getState()).toMatchObject({ open: false, openingFile: null, message: 'editor.start.openFailed' })
})

it('returns to file selection when the player changes files', async () => {
  await editor.getState().openEditor('/current.mp4')
  mocks.player.path = '/next.mp4'
  mocks.subscribePlayer.mock.calls[0]?.[0](mocks.player, { ...mocks.player, path: '/current.mp4' })
  expect(editor.getState()).toMatchObject({ open: false, key: null })
  expect(mocks.invoke).not.toHaveBeenCalledWith('editor:load', '/next.mp4')
})

it('uses the metadata title that arrives while the editor document is loading', async () => {
  const load = deferred<EditorStored>()
  mocks.invoke.mockImplementation(async (channel: string) => channel === 'editor:load' ? load.promise : [])
  const opening = editor.getState().openEditor('/current.mp4')
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('editor:load', '/current.mp4'))
  mocks.player = { ...mocks.player, title: 'Renamed' }
  load.resolve(stored)
  await opening
  expect(editor.getState().title).toBe('Renamed')
})

it('updates the editor title when metadata arrives after the document opens', async () => {
  await editor.getState().openEditor('/current.mp4')
  const previous = mocks.player
  mocks.player = { ...previous, title: 'Renamed' }
  mocks.subscribePlayer.mock.calls[0]?.[0](mocks.player, previous)
  expect(editor.getState().title).toBe('Renamed')
})
