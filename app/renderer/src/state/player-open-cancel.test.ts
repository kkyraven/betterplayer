import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/settings'
import type { MediaDetail } from '@shared/library'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), settings: null as Settings | null, settingsLoad: vi.fn(),
  engine: { load: vi.fn(), play: vi.fn(), setAxis: vi.fn(), setGlobalOffsetMs: vi.fn(), setVolume: vi.fn(), setMuted: vi.fn() },
}))
vi.mock('@/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/engine/client', () => ({ engine: mocks.engine, applyEnhance: vi.fn() }))
vi.mock('./usage', () => ({ track: vi.fn() }))
vi.mock('./params', () => ({ pushParams: vi.fn() }))
vi.mock('./live', () => ({ get: () => ({ timeMs: 0 }) }))
vi.mock('./account', () => ({ useAccount: { subscribe: vi.fn() } }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./library', () => ({ useLibrary: {} }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({ settings: mocks.settings, load: mocks.settingsLoad, addRecent: vi.fn() }) } }))
vi.mock('./subtitles', () => ({ useSubtitles: { getState: () => ({ load: vi.fn() }) } }))
vi.mock('./tracking', () => ({ useTracking: { getState: () => ({ stop: vi.fn(), autoStart: vi.fn() }) } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ setScreen: vi.fn() }) } }))

let player: typeof import('./player').usePlayer
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.stubGlobal('window', globalThis)
  mocks.settings = defaultSettings()
  mocks.invoke.mockResolvedValue(null)
  mocks.engine.load.mockResolvedValue({ scripts: [] })
  player = (await import('./player')).usePlayer
})
afterEach(() => vi.unstubAllGlobals())

it('cancels a remote open while settings are loading', async () => {
  const settings = deferred<Settings>()
  mocks.settings = null
  mocks.settingsLoad.mockReturnValue(settings.promise)
  const controller = new AbortController()
  const opening = player.getState().open('/remote.mp4', 0, undefined, true, controller.signal)
  controller.abort()
  settings.resolve(defaultSettings())
  await opening
  expect(player.getState().path).toBeNull()
  expect(mocks.invoke).not.toHaveBeenCalled()
  expect(mocks.engine.load).not.toHaveBeenCalled()
})

it('cancels a remote open while per-video settings are loading', async () => {
  const video = deferred<null>()
  mocks.invoke.mockReturnValueOnce(video.promise)
  const controller = new AbortController()
  const opening = player.getState().open('/remote.mp4', 0, undefined, true, controller.signal)
  expect(mocks.invoke).toHaveBeenCalledWith('video:get', '/remote.mp4')
  controller.abort()
  video.resolve(null)
  await opening
  expect(player.getState().path).toBeNull()
  expect(mocks.engine.load).not.toHaveBeenCalled()
})

it('keeps a subsequent local open working when the remote open is canceled', async () => {
  const video = deferred<null>()
  mocks.invoke.mockReturnValueOnce(video.promise)
  const controller = new AbortController()
  const remote = player.getState().open('/remote.mp4', 0, undefined, true, controller.signal)
  const local = player.getState().open('/local.mp4')
  controller.abort()
  video.resolve(null)
  await Promise.all([remote, local])
  expect(player.getState().path).toBe('/local.mp4')
  expect(mocks.engine.load).toHaveBeenCalledOnce()
  expect(mocks.engine.load.mock.calls[0]?.[0]).toBe('/local.mp4')
})

it('passes cancellation to native loading and suppresses playback after an aborted load', async () => {
  const loaded = deferred<{ scripts: [] }>()
  mocks.engine.load.mockReturnValueOnce(loaded.promise)
  const controller = new AbortController()
  const opening = player.getState().open('/remote.mp4', 0, undefined, true, controller.signal)
  await vi.waitFor(() => expect(mocks.engine.load).toHaveBeenCalledOnce())
  expect(mocks.engine.load.mock.calls[0]?.[5]).toBe(controller.signal)
  controller.abort()
  loaded.resolve({ scripts: [] })
  await opening
  expect(mocks.engine.play).not.toHaveBeenCalled()
})

it('passes matching script folders to playback', async () => {
  mocks.invoke.mockImplementation(async (channel) => channel === 'library:scriptFolders' ? ['/scripts'] : null)
  await player.getState().open('/videos/scene.mp4')
  expect(mocks.invoke).toHaveBeenCalledWith('library:scriptFolders', '/videos/scene.mp4')
  expect(mocks.engine.load.mock.calls[0]?.[6]).toEqual(['/scripts'])
})

it.each([false, true])('uses the renamed library title when audio tags arrive late: %s', async (lateTags) => {
  const tags = deferred<{ video: boolean; title: string }>()
  const media: Pick<MediaDetail, 'id' | 'path' | 'title' | 'titleSet'> = { id: 1, path: '/scene.mp4', title: 'My title', titleSet: true }
  mocks.invoke.mockImplementation(async (channel) => {
    if (channel === 'library:byPath') return media
    if (channel === 'media:tags') return lateTags ? tags.promise : { video: false, title: 'Embedded title' }
    return null
  })
  await player.getState().open(media.path)
  tags.resolve({ video: false, title: 'Embedded title' })
  await vi.waitFor(() => expect(player.getState().title).toBe('My title'))
})

it('cancels while matching script folders are being found', async () => {
  const folders = deferred<string[]>()
  mocks.invoke.mockImplementation(async (channel) => channel === 'library:scriptFolders' ? folders.promise : null)
  const controller = new AbortController()
  const opening = player.getState().open('/videos/scene.mp4', 0, undefined, true, controller.signal)
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('library:scriptFolders', '/videos/scene.mp4'))
  controller.abort()
  folders.resolve(['/scripts'])
  await opening
  expect(mocks.engine.load).not.toHaveBeenCalled()
  expect(player.getState().path).toBeNull()
})
