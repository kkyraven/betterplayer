import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  time: 1_760_000,
  player: { path: '/long.mp4' as string | null, snapshot: { durationMs: 3_600_000 } },
  listeners: [] as Array<(state: { path: string | null }, previous: { path: string | null }) => void>,
  status: 'none',
  fullStatus: 'none',
  token: 0,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  analyse: vi.fn<() => Promise<{ beats: number[] }>>(),
  begin: vi.fn(),
  install: vi.fn(() => true),
  error: vi.fn(),
  load: vi.fn(),
}))
vi.mock('@/ipc', () => ({ invoke: mock.invoke }))
vi.mock('@/engine/client', () => ({
  beatAnalyseAsync: mock.analyse,
  engine: {
    beatState: () => ({ status: mock.status, fullStatus: mock.fullStatus }),
    beatWindowBegin: mock.begin,
    beatSetWindow: mock.install,
    beatWindowError: mock.error,
    beatLoad: mock.load,
  },
}))
vi.mock('./live', () => ({ get: () => ({ timeMs: mock.time }) }))
vi.mock('./player', () => ({ usePlayer: {
  getState: () => mock.player,
  subscribe: (listener: typeof mock.listeners[number]) => { mock.listeners.push(listener); return () => {} },
} }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function changeMedia(path: string | null) {
  const previous = { path: mock.player.path }
  mock.player.path = path
  for (const listener of mock.listeners) listener(mock.player, previous)
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.clearAllMocks()
  mock.listeners = []
  mock.time = 1_760_000
  mock.player = { path: '/long.mp4', snapshot: { durationMs: 3_600_000 } }
  mock.status = 'none'
  mock.fullStatus = 'none'
  mock.token = 0
  mock.begin.mockImplementation(() => { mock.status = 'analysing'; return ++mock.token })
  mock.install.mockImplementation(() => { mock.status = 'ready'; return true })
  mock.load.mockImplementation(() => { mock.fullStatus = 'analysing' })
  mock.analyse.mockResolvedValue({ beats: [500, 1000] })
  mock.invoke.mockImplementation(async (channel, _source, start, duration) => {
    if (channel === 'audio:window') return { path: '/window.f32', startMs: Number(start), endMs: Number(start) + Number(duration) }
    if (channel === 'audio:decode') return '/complete.f32'
  })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('playback audio windows', () => {
  it('starts near the playhead of a long video, shares requests, and prefetches an overlapping window', async () => {
    const audio = await import('./audio')
    const first = audio.ensureAudio('/long.mp4')
    expect(audio.ensureAudio('/long.mp4')).toBe(first)
    await first
    expect(mock.invoke).toHaveBeenCalledWith('audio:window', '/long.mp4', 1_746_000, 24_000, expect.any(String))
    expect(mock.invoke).not.toHaveBeenCalledWith('audio:decode', expect.anything())
    expect(mock.install).toHaveBeenCalledWith({ beats: [500, 1000] }, 1_746_000, 1, false)
    mock.time = 1_764_000
    await vi.advanceTimersByTimeAsync(250)
    expect(mock.invoke).toHaveBeenCalledWith('audio:window', '/long.mp4', 1_752_000, 24_000, expect.any(String))
    expect(mock.install).toHaveBeenLastCalledWith({ beats: [500, 1000] }, 1_752_000, 2, true)
  })

  it('cancels a stale seek while native analysis is pending', async () => {
    const audio = await import('./audio')
    const old = deferred<{ beats: number[] }>()
    mock.analyse.mockImplementationOnce(() => old.promise)
    const first = audio.ensureAudio('/long.mp4')
    await Promise.resolve()
    mock.time = 300_000
    await vi.advanceTimersByTimeAsync(250)
    expect(mock.invoke).toHaveBeenCalledWith('audio:cancelWindow', 'beat-1')
    old.resolve({ beats: [999] })
    await first
    expect(mock.install).toHaveBeenCalledTimes(1)
    expect(mock.install).toHaveBeenCalledWith({ beats: [500, 1000] }, 288_000, 2, false)
  })

  it('does not let a previous range failure delay a seek', async () => {
    const audio = await import('./audio')
    mock.invoke.mockRejectedValueOnce(new Error('decode failed'))
    await expect(audio.ensureAudio('/long.mp4')).rejects.toThrow('decode failed')
    mock.time = 300_000
    await vi.advanceTimersByTimeAsync(250)
    expect(mock.invoke).toHaveBeenCalledWith('audio:window', '/long.mp4', 288_000, 24_000, expect.any(String))
    expect(mock.install).toHaveBeenCalledTimes(1)
  })

  it('preserves the new media request started by an earlier parameter subscription', async () => {
    const audio = await import('./audio')
    mock.listeners.push((state) => { if (state.path) void audio.ensureAudio(state.path, 'parameters') })
    await audio.ensureAudio('/long.mp4', 'parameters')
    mock.invoke.mockClear()
    changeMedia('/next.mp4')
    await vi.advanceTimersByTimeAsync(1)
    expect(mock.invoke).not.toHaveBeenCalledWith('audio:cancelWindow', 'beat-2')
    expect(mock.install).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('treats a successful empty window as silence without continuously reanalysing it', async () => {
    const audio = await import('./audio')
    mock.invoke.mockImplementation(async (channel, _source, start) => channel === 'audio:window' ? { path: '/empty.f32', startMs: Number(start), endMs: Number(start) } : undefined)
    mock.analyse.mockResolvedValue({ beats: [] })
    await audio.ensureAudio('/long.mp4')
    await vi.advanceTimersByTimeAsync(5000)
    expect(mock.analyse).toHaveBeenCalledTimes(1)
    expect(mock.install).toHaveBeenCalledWith({ beats: [] }, 1_746_000, 1, false)
  })

  it('restarts when media loading finishes after an already installed window', async () => {
    const audio = await import('./audio')
    await audio.ensureAudio('/long.mp4')
    mock.status = 'none'
    await vi.advanceTimersByTimeAsync(250)
    expect(mock.install).toHaveBeenCalledTimes(2)
    expect(mock.install).toHaveBeenLastCalledWith({ beats: [500, 1000] }, 1_746_000, 2, false)
  })

  it('keeps full-file readiness separate and rejects decoded audio after a media switch', async () => {
    const audio = await import('./audio')
    await audio.ensureAudio('/long.mp4')
    const old = deferred<string>()
    mock.invoke.mockImplementationOnce(() => old.promise)
    const full = audio.ensureFullAudio('/long.mp4')
    expect(audio.ensureFullAudio('/long.mp4')).toBe(full)
    changeMedia('/next.mp4')
    old.resolve('/old.f32')
    await full
    expect(mock.load).not.toHaveBeenCalled()
    await audio.ensureFullAudio('/next.mp4')
    expect(mock.load).toHaveBeenCalledWith('/complete.f32')
  })

  it('stops prefetching when its last consumer leaves, and cancels pending work on close', async () => {
    const audio = await import('./audio')
    await audio.ensureAudio('/long.mp4')
    await audio.ensureAudio('/long.mp4', 'parameters')
    audio.releaseAudio()
    expect(vi.getTimerCount()).toBe(1)
    audio.releaseAudio('parameters')
    expect(vi.getTimerCount()).toBe(0)
    const old = deferred<unknown>()
    mock.invoke.mockImplementationOnce(() => old.promise)
    const request = audio.ensureAudio('/long.mp4')
    changeMedia(null)
    old.resolve({ path: '/old.f32', startMs: 1_746_000, endMs: 1_770_000 })
    await request
    expect(mock.install).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
