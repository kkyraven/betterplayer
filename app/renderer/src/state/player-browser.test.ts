import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/settings'
import type { BrowserHandoff } from '@shared/browser'

const mocks = vi.hoisted(() => ({
  timeMs: 0, invoke: vi.fn(), addRecent: vi.fn(), autoStart: vi.fn(), setBasePlaybackRate: vi.fn(),
  engine: { load: vi.fn(), play: vi.fn(), unload: vi.fn(), setAxis: vi.fn(), setGlobalOffsetMs: vi.fn(), setVolume: vi.fn(), setMuted: vi.fn() },
}))
vi.mock('@/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/engine/client', () => ({ engine: mocks.engine, applyEnhance: vi.fn() }))
vi.mock('./usage', () => ({ track: vi.fn() }))
vi.mock('./params', () => ({ pushParams: vi.fn() }))
vi.mock('./live', () => ({ get: () => ({ timeMs: mocks.timeMs }) }))
vi.mock('./account', () => ({ useAccount: { subscribe: vi.fn() } }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./library', () => ({ useLibrary: {} }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({ settings: defaultSettings(), addRecent: mocks.addRecent }) } }))
vi.mock('./subtitles', () => ({ useSubtitles: { getState: () => ({ load: vi.fn(), clear: vi.fn() }) } }))
vi.mock('./tracking', () => ({ useTracking: { getState: () => ({ stop: vi.fn(), autoStart: mocks.autoStart, setBasePlaybackRate: mocks.setBasePlaybackRate }) } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ setScreen: vi.fn() }) } }))

const handoff: BrowserHandoff = { pageUrl: 'https://example.com/watch/123', url: 'https://cdn.example.com/video.mp4', headers: 'Referer: https://example.com/watch/123,Cookie: session=test', position: 42, rate: 1.5 }
let player: typeof import('./player').usePlayer
function errorSnapshot(error = 'HTTP error') {
  player.getState().setSnapshot({ ...player.getState().snapshot, error })
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const open = (signal?: AbortSignal) => player.getState().open(handoff.pageUrl, handoff.position, undefined, true, signal, handoff)

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.timeMs = 0
  vi.stubGlobal('window', globalThis)
  mocks.invoke.mockResolvedValue(null)
  mocks.engine.load.mockResolvedValue({ scripts: [] })
  player = (await import('./player')).usePlayer
})
afterEach(() => vi.unstubAllGlobals())

it('loads browser media directly while keeping page identity, position and speed', async () => {
  await open()
  expect(mocks.engine.load).toHaveBeenCalledExactlyOnceWith(handoff.url, 42, undefined, undefined, handoff.headers, expect.any(AbortSignal))
  expect(player.getState().path).toBe(handoff.pageUrl)
  expect(mocks.invoke).toHaveBeenCalledWith('video:get', handoff.pageUrl)
  expect(mocks.invoke).toHaveBeenCalledWith('library:played', handoff.pageUrl)
  expect(mocks.addRecent).toHaveBeenCalledWith(handoff.pageUrl)
  expect(mocks.autoStart).toHaveBeenCalledOnce()
  expect(mocks.setBasePlaybackRate).toHaveBeenCalledWith(1.5)
  expect(mocks.setBasePlaybackRate.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.autoStart.mock.invocationCallOrder[0]!)
})

it('falls back to page extraction without browser headers when direct loading rejects', async () => {
  mocks.engine.load.mockRejectedValueOnce(new Error('unsupported media'))
  await open()
  expect(mocks.engine.load).toHaveBeenCalledTimes(2)
  expect(mocks.engine.load).toHaveBeenLastCalledWith(handoff.pageUrl, 42, undefined, undefined, undefined, expect.any(AbortSignal), undefined)
  expect(mocks.autoStart).toHaveBeenCalledOnce()
})

it('retries a delayed native media error once and exposes a failed fallback', async () => {
  await open()
  errorSnapshot()
  expect(player.getState().snapshot.error).toBeNull()
  await flush()
  expect(mocks.engine.load).toHaveBeenCalledTimes(2)
  expect(mocks.engine.load).toHaveBeenLastCalledWith(handoff.pageUrl, 42, undefined, undefined, undefined, expect.any(AbortSignal), undefined)
  errorSnapshot('page extraction failed')
  await flush()
  expect(mocks.engine.load).toHaveBeenCalledTimes(2)
  expect(player.getState().snapshot.error).toBe('page extraction failed')
})

it('does not retry browser media after another open replaces it', async () => {
  await open()
  await player.getState().open('/local.mp4')
  errorSnapshot()
  await flush()
  expect(mocks.engine.load).toHaveBeenCalledTimes(2)
  expect(player.getState().path).toBe('/local.mp4')
})

it('does not retry browser media after close or cancellation', async () => {
  const controller = new AbortController()
  await open(controller.signal)
  controller.abort()
  errorSnapshot()
  await flush()
  expect(mocks.engine.load).toHaveBeenCalledOnce()
  player.getState().close()
  errorSnapshot()
  await flush()
  expect(mocks.engine.load).toHaveBeenCalledOnce()
})

it('does not fall back from a rejected direct load after cancellation', async () => {
  const direct = deferred<{ scripts: [] }>()
  mocks.engine.load.mockReturnValueOnce(direct.promise)
  const controller = new AbortController()
  const opening = open(controller.signal)
  await flush()
  controller.abort()
  direct.reject(new Error('cancelled'))
  await expect(opening).rejects.toThrow('cancelled')
  expect(mocks.engine.load).toHaveBeenCalledOnce()
  expect(mocks.engine.play).not.toHaveBeenCalled()
})

it('uses page extraction immediately for browser-only sources', async () => {
  await player.getState().open(handoff.pageUrl, 42, undefined, true, undefined, { ...handoff, url: null })
  expect(mocks.engine.load).toHaveBeenCalledExactlyOnceWith(handoff.pageUrl, 42, undefined, undefined, undefined, expect.any(AbortSignal), undefined)
})


it('aborts a pending native fallback when another video opens', async () => {
  await open()
  const fallback = deferred<{ scripts: [] }>()
  mocks.engine.load.mockReturnValueOnce(fallback.promise)
  errorSnapshot()
  const fallbackSignal = mocks.engine.load.mock.calls[1]?.[5] as AbortSignal
  expect(fallbackSignal.aborted).toBe(false)
  await player.getState().open('/replacement.mp4')
  expect(fallbackSignal.aborted).toBe(true)
  const plays = mocks.engine.play.mock.calls.length
  fallback.resolve({ scripts: [] })
  await flush()
  expect(mocks.engine.play).toHaveBeenCalledTimes(plays)
  expect(player.getState().path).toBe('/replacement.mp4')
})


it('resumes fallback from the current position after playback has progressed', async () => {
  await open()
  mocks.timeMs = 142_750
  errorSnapshot()
  await flush()
  expect(mocks.engine.load).toHaveBeenLastCalledWith(handoff.pageUrl, 142.75, undefined, undefined, undefined, expect.any(AbortSignal), undefined)
})
