import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  allIds: vi.fn(async () => [99]),
  load: vi.fn(async (_path: string, ..._args: unknown[]) => ({ scripts: [] })),
  play: vi.fn(),
  setScreen: vi.fn(),
  time: 10000,
  playlistId: null as number | null,
  librarySetState: vi.fn(),
}))
vi.mock('@/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/state/usage', () => ({ track: vi.fn() }))
vi.mock('./params', () => ({ effectiveParam: vi.fn(), pushParams: vi.fn() }))
vi.mock('./live', () => ({ get: () => ({ timeMs: mocks.time }) }))
vi.mock('./account', () => ({ isFree: () => true, useAccount: { subscribe: vi.fn() } }))
vi.mock('./library', () => ({ useLibrary: { getState: () => ({ allIds: mocks.allIds, playlistId: mocks.playlistId }), setState: mocks.librarySetState } }))
vi.mock('./session', () => ({ useSession: { getState: () => ({ stage: 'setup' }) } }))
vi.mock('./settings', async () => {
  const { defaultSettings } = await import('@shared/settings')
  return { useSettings: { getState: () => ({ settings: defaultSettings(), addRecent: vi.fn(async () => {}) }) } }
})
vi.mock('./subtitles', () => ({ useSubtitles: { getState: () => ({ load: vi.fn(), clear: vi.fn() }) } }))
vi.mock('./tracking', () => ({ useTracking: { getState: () => ({ stop: vi.fn(), autoStart: vi.fn(async () => {}) }) } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ setScreen: mocks.setScreen, mediaCentre: false }) } }))
vi.mock('@/engine/client', () => ({ applyEnhance: vi.fn(), warm: vi.fn(), engine: {
  setAxis: vi.fn(), setGlobalOffsetMs: vi.fn(), setVolume: vi.fn(), setMuted: vi.fn(),
  load: mocks.load, play: mocks.play, unload: vi.fn(), seek: vi.fn(),
} }))
import { usePlayer } from './player'

beforeEach(() => {
  mocks.playlistId = null
  mocks.librarySetState.mockClear()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  mocks.invoke.mockReset().mockImplementation(async (channel, value) => {
    if (channel === 'library:scriptFolders') return []
    if (channel === 'library:queryIds') return [1, 2, 3, 4]
    if (channel === 'library:media') return { id: value, path: `/fictional/${value}.mp4` }
    return null
  })
  mocks.load.mockClear(); mocks.play.mockClear(); mocks.allIds.mockClear(); mocks.setScreen.mockClear()
  usePlayer.setState({ path: null, media: null, playlist: null, autoplay: 'off', repeat: 'all', snapshot: { durationMs: 10000, paused: true, loaded: false, rate: 1, flagsVersion: 0, videoWidth: 100, videoHeight: 100, error: null } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('plays the full saved sequence from zero and navigates independently of Library browsing', async () => {
  await usePlayer.getState().openPlaylist(7)
  expect(mocks.invoke).toHaveBeenCalledWith('library:queryIds', expect.objectContaining({ playlistId: 7, filters: {}, offset: 0, limit: 0 }))
  expect(usePlayer.getState()).toMatchObject({ path: '/fictional/1.mp4', autoplay: 'next', repeat: 'off' })
  expect(mocks.load).toHaveBeenLastCalledWith('/fictional/1.mp4', 0, undefined, undefined, undefined, undefined, [])
  await usePlayer.getState().step(1)
  expect(usePlayer.getState().path).toBe('/fictional/2.mp4')
  await usePlayer.getState().step(-1)
  expect(usePlayer.getState().path).toBe('/fictional/1.mp4')
  expect(mocks.allIds).not.toHaveBeenCalled()
})

it('shuffled autoplay visits every video once and stops at the end', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
  await usePlayer.getState().openPlaylist(7, true)
  const order = usePlayer.getState().playlist!.ids
  expect(order).not.toEqual([1, 2, 3, 4])
  for (let i = 1; i < order.length; i++) {
    await usePlayer.getState().onEnded()
    expect(usePlayer.getState().path).toBe(`/fictional/${order[i]}.mp4`)
  }
  await usePlayer.getState().onEnded()
  expect(mocks.load).toHaveBeenCalledTimes(4)
  expect(mocks.setScreen).toHaveBeenCalledTimes(1)
  expect(new Set(mocks.load.mock.calls.map(call => call[0])).size).toBe(4)
  expect(mocks.allIds).not.toHaveBeenCalled()
})

it('opening a separate file clears the playlist sequence', async () => {
  await usePlayer.getState().openPlaylist(7)
  await usePlayer.getState().open('/fictional/99.mp4')
  expect(usePlayer.getState().playlist).toBeNull()
})

it('does not open a stale next video after the player closes', async () => {
  await usePlayer.getState().openPlaylist(7)
  let resolve: (value: unknown) => void = () => {}
  mocks.invoke.mockImplementation(channel => channel === 'library:media' ? new Promise(r => { resolve = r }) : Promise.resolve(null))
  const next = usePlayer.getState().step(1)
  usePlayer.getState().close()
  resolve({ id: 2, path: '/fictional/2.mp4' })
  await next
  expect(usePlayer.getState().path).toBeNull()
  expect(mocks.load).toHaveBeenCalledTimes(1)
})

it('reorders only the current queue, keeping the playing item and following the new order', async () => {
  await usePlayer.getState().openPlaylist(7)
  await usePlayer.getState().step(1)
  const loads = mocks.load.mock.calls.length
  usePlayer.getState().moveQueue({ mediaIds: [4], anchorId: 2, side: 'before' })
  expect(usePlayer.getState().playlist).toMatchObject({ ids: [1, 4, 2, 3], index: 2 })
  expect(usePlayer.getState().path).toBe('/fictional/2.mp4')
  expect(mocks.load).toHaveBeenCalledTimes(loads)
  await usePlayer.getState().onEnded()
  expect(usePlayer.getState().path).toBe('/fictional/3.mp4')
  expect(mocks.invoke.mock.calls.some(([channel]) => channel === 'library:movePlaylistItems')).toBe(false)
})

it('jumps to a queue item from zero and then follows its successor', async () => {
  await usePlayer.getState().openPlaylist(7)
  await usePlayer.getState().jumpQueue(3)
  expect(usePlayer.getState().playlist?.index).toBe(2)
  expect(mocks.load).toHaveBeenLastCalledWith('/fictional/3.mp4', 0, undefined, undefined, undefined, undefined, [])
  await usePlayer.getState().step(1)
  expect(usePlayer.getState().path).toBe('/fictional/4.mp4')
})

it('ignores a pending jump after the queue is reordered', async () => {
  await usePlayer.getState().openPlaylist(7)
  let resolve: (value: unknown) => void = () => {}
  mocks.invoke.mockImplementation(channel => channel === 'library:media' ? new Promise(r => { resolve = r }) : Promise.resolve(null))
  const jump = usePlayer.getState().jumpQueue(3)
  usePlayer.getState().moveQueue({ mediaIds: [4], anchorId: 2, side: 'before' })
  resolve({ id: 3, path: '/fictional/3.mp4' })
  await jump
  expect(usePlayer.getState().path).toBe('/fictional/1.mp4')
  expect(usePlayer.getState().playlist?.ids).toEqual([1, 4, 2, 3])
})

it('closes the queue viewer when opening an unrelated file', async () => {
  await usePlayer.getState().openPlaylist(7)
  usePlayer.getState().setSheet('queue')
  await usePlayer.getState().open('/fictional/99.mp4')
  expect(usePlayer.getState().sheet).toBeNull()
})

it('playing a library row inside a playlist starts its queue at that row', async () => {
  mocks.playlistId = 7
  await usePlayer.getState().openLibraryMedia({ id: 3, path: '/fictional/3.mp4' })
  expect(usePlayer.getState().playlist).toMatchObject({ id: 7, ids: [1, 2, 3, 4], index: 2 })
  expect(usePlayer.getState().path).toBe('/fictional/3.mp4')
  await usePlayer.getState().step(1)
  expect(usePlayer.getState().path).toBe('/fictional/4.mp4')
})

it('playing a library row outside a playlist opens it without a queue', async () => {
  await usePlayer.getState().openLibraryMedia({ id: 3, path: '/fictional/3.mp4' })
  expect(usePlayer.getState().path).toBe('/fictional/3.mp4')
  expect(usePlayer.getState().playlist).toBeNull()
})

it('reports a playlist row removed before playback starts', async () => {
  mocks.playlistId = 7
  await usePlayer.getState().openLibraryMedia({ id: 9, path: '/fictional/9.mp4' })
  expect(mocks.librarySetState).toHaveBeenCalledWith({ playlistError: "Couldn't play playlist" })
  expect(mocks.load).not.toHaveBeenCalled()
})

it('restores the saved volume, hands it to the engine on open and writes changes', async () => {
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ volume: 0.4, muted: true }), setItem: vi.fn() })
  vi.resetModules()
  const { usePlayer: fresh } = await import('./player')
  const { engine } = await import('@/engine/client')
  expect(fresh.getState()).toMatchObject({ volume: 0.4, muted: true })
  await fresh.getState().open('/fictional/1.mp4')
  expect(engine.setVolume).toHaveBeenLastCalledWith(0.4)
  expect(engine.setMuted).toHaveBeenLastCalledWith(true)
  fresh.getState().setVolume(0.7)
  expect(fresh.getState()).toMatchObject({ volume: 0.7, muted: false })
  expect(JSON.parse(vi.mocked(localStorage.setItem).mock.lastCall![1])).toMatchObject({ volume: 0.7, muted: false })
})
