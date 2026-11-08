import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowState } from 'bp-engine'
import type { IpcEvents, RemoteStatus } from '@shared/ipc'

const native = vi.hoisted(() => ({
  follow: vi.fn(),
  unfollow: vi.fn(),
  unload: vi.fn(),
  followState: vi.fn(),
  haltSensation: vi.fn(),
  resumeSensation: vi.fn(),
  loadScripts: vi.fn(async () => ({ path: '', scripts: [{ axis: 'L0', selected: true }, { axis: 'R1', selected: false }] })),
  followFile: vi.fn(),
  lookaheadFrame: vi.fn(),
}))
const listeners = vi.hoisted(() => new Map<string, (payload: unknown) => void>())
const invoke = vi.hoisted(() => vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>())
const player = vi.hoisted(() => ({ path: null as string | null, snapshot: { paused: true }, close: vi.fn() }))
const vr = vi.hoisted(() => ({ active: false, starting: false }))
const storage = vi.hoisted(() => new Map<string, string>())
const applyVideoToEngine = vi.hoisted(() => vi.fn())
const tracking = vi.hoisted(() => ({ followHeadset: vi.fn(async () => {}) }))
vi.mock('@/engine/client', () => ({ engine: native }))
vi.mock('./axisDefaults', () => ({ applyVideoToEngine }))
vi.mock('./estimAudio', () => ({ clearEstimAudio: vi.fn(), loadEstimAudio: vi.fn(async () => undefined) }))
vi.mock('@/ipc', () => ({
  invoke,
  on: (event: string, listener: (payload: unknown) => void) => {
    listeners.set(event, listener)
    return () => listeners.delete(event)
  },
}))
vi.mock('@/lib/format', () => ({ fileTitle: (path: string) => path }))
vi.mock('./player', () => ({ usePlayer: { getState: () => player } }))
vi.mock('./vr', () => ({ useVr: { getState: () => vr } }))
vi.mock('./tracking', () => ({ useTracking: { getState: () => tracking } }))

const QUEST = '192.168.1.40'
const CONNECTING: FollowState = { kind: 'quest', address: `${QUEST}:23554`, status: 'connecting', playing: false, timeMs: 0, durationMs: 0, rate: 1 }
const SERVER: RemoteStatus = { running: true, port: 8420, urls: ['http://192.168.1.10:8420'] }
const TWELVE = { id: 12, path: 'D:/v/Twelve.mp4', title: 'Twelve' }
const TWELVE_SETTINGS = { globalOffsetMs: -40, axes: { L0: { amplitude: 1.5 } } }
const ELSEWHERE = { id: 30, path: 'http://192.168.1.77:8420/media/12', title: 'Elsewhere' }
const STASHED = { id: 14, path: 'http://stash:9999/scene/5/stream', title: 'Stashed' }
const A = 'http://192.168.1.10:8420/media/12'
const B = 'http://192.168.1.10:8420/media/13'

let follow: typeof import('./follow')
let source = ''
let reencoded = new Set<number>()
const store = () => follow.useFollow.getState()
const hello = (session: string, host = QUEST, port = 23554) => listeners.get('headset:hello')?.({ name: 'Quest 3', port, session, host } satisfies IpcEvents['headset:hello'])
const headsetStop = (host = QUEST) => listeners.get('headset:stop')?.({ host } satisfies IpcEvents['headset:stop'])
const poll = (path: string | undefined, playing: boolean, status = 'connected') => store().update({ ...CONNECTING, status, path, playing })
const flush = () => new Promise((done) => setTimeout(done, 0))

async function load() {
  vi.resetModules()
  listeners.clear()
  follow = await import('./follow')
  follow.startHeadsets()
}

beforeEach(async () => {
  vi.clearAllMocks()
  storage.clear()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  Object.assign(player, { path: null, snapshot: { paused: true } })
  Object.assign(vr, { active: false, starting: false })
  source = ''
  reencoded = new Set()
  native.followState.mockReturnValue(CONNECTING)
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'remote:status') return SERVER
    if (channel === 'remote:source') return { source, connected: source !== '', error: null }
    if (channel === 'library:media') return args[0] === 12 ? TWELVE : args[0] === STASHED.id ? STASHED : null
    if (channel === 'library:byPath') return args[0] === ELSEWHERE.path ? ELSEWHERE : null
    if (channel === 'library:scriptFolders') return []
    if (channel === 'video:get') return args[0] === TWELVE.path ? TWELVE_SETTINGS : null
    if (channel === 'quest:reencoded') return reencoded.has(args[0] as number)
    return null
  })
  await load()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Quest hellos', () => {
  it('keep one connection while they repeat, across the videos the headset opens', () => {
    hello('s1')
    hello('s1')
    hello('s2')
    expect(native.follow).toHaveBeenCalledTimes(1)
    expect(native.follow).toHaveBeenCalledWith('quest', QUEST, 23554)
    expect(store().quest).toEqual({ name: 'Quest 3', port: 23554, session: 's2' })
  })

  it('are ignored after Stop following until the headset opens another video', () => {
    hello('s1')
    store().stop()
    expect(native.unfollow).toHaveBeenCalledTimes(1)
    expect(store()).toMatchObject({ kind: 'heresphere', quest: null, state: null })
    hello('s1')
    expect(native.follow).toHaveBeenCalledTimes(1)
    hello('s1', '192.168.1.41')
    expect(native.follow).toHaveBeenCalledTimes(2)
    store().stop()
    hello('s2')
    expect(native.follow).toHaveBeenCalledTimes(3)
    expect(store()).toMatchObject({ kind: 'quest', host: QUEST, quest: { session: 's2' } })
  })

  it('stay ignored after Stop following across a reload, for a few hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    hello('s1')
    store().stop()
    await load()
    hello('s1')
    expect(native.follow).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 5 * 60 * 60_000)
    hello('s1')
    expect(native.follow).toHaveBeenCalledTimes(2)
  })

  it('are ignored while a video plays here, and followed once it is paused', () => {
    Object.assign(player, { path: 'D:/v/local.mp4', snapshot: { paused: false } })
    hello('s1')
    expect(native.follow).not.toHaveBeenCalled()
    expect(player.close).not.toHaveBeenCalled()
    player.snapshot.paused = true
    hello('s1')
    expect(player.close).toHaveBeenCalledTimes(1)
    expect(native.follow).toHaveBeenCalledTimes(1)
  })

  it('are ignored while a picked player is followed, connected or not', () => {
    store().start()
    hello('s1')
    poll(undefined, false, 'error')
    hello('s1')
    expect(native.follow).toHaveBeenCalledTimes(1)
    expect(native.follow).toHaveBeenCalledWith('heresphere', '127.0.0.1', undefined)
  })

  it('from a second Quest are ignored while the first is connected, so the two do not take turns', () => {
    hello('a1')
    poll(A, true)
    hello('b1', '192.168.1.41')
    hello('a1')
    hello('b1', '192.168.1.41')
    expect(native.follow).toHaveBeenCalledTimes(1)
    poll(undefined, false, 'error')
    hello('b1', '192.168.1.41')
    expect(native.follow).toHaveBeenCalledTimes(2)
    expect(store().host).toBe('192.168.1.41')
  })

  it('are ignored in PC VR', () => {
    vr.active = true
    hello('s1')
    vr.active = false
    vr.starting = true
    hello('s1')
    expect(native.follow).not.toHaveBeenCalled()
  })
})

describe('HereSphere or DeoVR playing from this library', () => {
  const play = (mediaId: number, kind: 'deovr' | 'heresphere' = 'deovr', host = QUEST) => listeners.get('headset:play')?.({ kind, host, mediaId } satisfies IpcEvents['headset:play'])

  it('is followed on its usual port, and after Stop following only once it plays another video', () => {
    play(12)
    play(12)
    play(13)
    expect(native.follow).toHaveBeenCalledTimes(1)
    expect(native.follow).toHaveBeenCalledWith('deovr', QUEST, undefined)
    store().stop()
    expect(store()).toMatchObject({ kind: 'heresphere', host: '127.0.0.1', state: null })
    play(13)
    expect(native.follow).toHaveBeenCalledTimes(1)
    play(12)
    expect(native.follow).toHaveBeenCalledTimes(2)
  })

  it('picked on the Headsets page is not followed again after Stop following while it streams the same video', () => {
    store().setKind('deovr')
    store().setHost(QUEST)
    store().start()
    play(12)
    store().stop()
    expect(store()).toMatchObject({ kind: 'deovr', host: QUEST, state: null })
    play(12)
    expect(native.follow).toHaveBeenCalledTimes(1)
  })

  it('is ignored while a connected Quest is followed, and takes over one that is not', () => {
    hello('s1')
    poll(A, true)
    play(12, 'heresphere', '192.168.1.41')
    expect(native.follow).toHaveBeenCalledTimes(1)
    poll(undefined, false, 'error')
    play(12, 'heresphere', '192.168.1.41')
    expect(native.follow).toHaveBeenLastCalledWith('heresphere', '192.168.1.41', undefined)
  })
})

describe('a Quest Stop', () => {
  beforeEach(() => {
    hello('s1')
    poll(A, true)
  })

  it('is released by that headset pausing and playing the same video', () => {
    headsetStop()
    expect(native.haltSensation).toHaveBeenCalledTimes(1)
    poll(A, true)
    poll(A, false)
    expect(native.resumeSensation).not.toHaveBeenCalled()
    poll(A, true)
    expect(native.resumeSensation).toHaveBeenCalledTimes(1)
    expect(store().halted).toBeNull()
  })

  it('that arrives after the headset played again is released by one Pause/Play', () => {
    poll(A, false)
    poll(A, true)
    headsetStop()
    poll(A, true)
    expect(native.resumeSensation).not.toHaveBeenCalled()
    poll(A, false)
    poll(A, true)
    expect(native.resumeSensation).toHaveBeenCalledTimes(1)
  })

  it('is not released by another video starting; a Pause/Play on that video releases it', () => {
    headsetStop()
    poll(A, false)
    poll(B, false)
    poll(B, true)
    expect(native.resumeSensation).not.toHaveBeenCalled()
    expect(store().halted).toEqual({ host: QUEST, path: B })
    poll(B, false)
    poll(B, true)
    expect(native.resumeSensation).toHaveBeenCalledTimes(1)
  })

  it('from a headset not followed halts but is left to the desktop', () => {
    headsetStop('192.168.1.41')
    expect(native.haltSensation).toHaveBeenCalledTimes(1)
    expect(store().halted).toBeNull()
    poll(A, false)
    poll(A, true)
    expect(native.resumeSensation).not.toHaveBeenCalled()
  })

  it('needs a pause from a new connection before its play counts', () => {
    headsetStop()
    poll(A, false)
    hello('s1', QUEST, 23555)
    expect(native.follow).toHaveBeenCalledTimes(2)
    poll(A, true)
    expect(native.resumeSensation).not.toHaveBeenCalled()
    poll(A, false)
    poll(A, true)
    expect(native.resumeSensation).toHaveBeenCalledTimes(1)
  })

  it('is left to the desktop once following ends', () => {
    headsetStop()
    store().stop()
    expect(store().halted).toBeNull()
    hello('s2')
    poll(A, false)
    poll(A, true)
    expect(native.resumeSensation).not.toHaveBeenCalled()
  })
})

describe('a served URL', () => {
  const matched = async (path: string) => {
    poll(path, true)
    await flush()
    return store().matched?.title ?? null
  }
  const followPicked = () => {
    store().setHost('192.168.1.50')
    store().start()
  }

  it('is read by id on this desktop: a LAN address or loopback on the server port', async () => {
    followPicked()
    expect(await matched(A)).toBe('Twelve')
    expect(await matched('http://127.0.0.1:8420/media/12')).toBe('Twelve')
  })

  it('from another server or port is matched by path, then title, never by id', async () => {
    followPicked()
    expect(await matched(ELSEWHERE.path)).toBe('Elsewhere')
    expect(await matched('http://192.168.1.10:9000/media/12')).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('library:media', 12)
    expect(invoke).toHaveBeenCalledWith('library:byTitle', 'http://192.168.1.10:9000/media/12')
  })

  it('is not read by id while a source library answers the lookups', async () => {
    source = 'otherpc:8420'
    followPicked()
    expect(await matched(A)).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('library:media', 12)
  })

  it('from a followed Quest is read by id whatever name it reached this desktop by', async () => {
    hello('s1')
    expect(await matched('http://desktop-pc:8420/media/12')).toBe('Twelve')
  })

  it("gets the matched video's own toy settings, and the defaults once unmatched or stopped", async () => {
    hello('s1')
    expect(await matched(A)).toBe('Twelve')
    expect(applyVideoToEngine).toHaveBeenLastCalledWith(TWELVE_SETTINGS)
    expect(await matched(B)).toBeNull()
    expect(applyVideoToEngine).toHaveBeenLastCalledWith(null)
    await matched(A)
    store().stop()
    expect(applyVideoToEngine).toHaveBeenLastCalledWith(null)
  })

  it("is tracked from this desktop's copy for a Quest only, and let go when the headset moves on", async () => {
    hello('s1')
    await matched(A)
    expect(native.followFile).toHaveBeenLastCalledWith(TWELVE.path, false)
    expect(tracking.followHeadset).toHaveBeenLastCalledWith({ media: TWELVE, scripted: ['L0'] })
    await matched(B)
    expect(native.followFile).toHaveBeenLastCalledWith(null, false)
    expect(tracking.followHeadset).toHaveBeenLastCalledWith(null)
    store().stop()
    tracking.followHeadset.mockClear()
    followPicked()
    await matched(A)
    expect(native.followFile).toHaveBeenLastCalledWith(null, false)
    expect(tracking.followHeadset).not.toHaveBeenCalledWith(expect.objectContaining({ media: TWELVE }))
  })

  it('is not tracked for a URL row, which has no copy here', async () => {
    hello('s1')
    expect(await matched('http://192.168.1.10:8420/media/14')).toBe('Stashed')
    expect(tracking.followHeadset).not.toHaveBeenCalledWith(expect.objectContaining({ media: STASHED }))
  })

  it("is tracked from the frames of this PC's re-encode for the Quest, not a second decode, for as long as it is followed", async () => {
    reencoded.add(12)
    hello('s1')
    await matched(A)
    expect(native.followFile).toHaveBeenLastCalledWith(TWELVE.path, true)
    expect(invoke).toHaveBeenLastCalledWith('quest:frames', { host: QUEST, mediaId: 12 })
    const bytes = new Uint8Array(384 * 192 * 4)
    listeners.get('headset:frame')?.({ run: 1, timeMs: 500, width: 384, height: 192, bytes } satisfies IpcEvents['headset:frame'])
    expect(native.lookaheadFrame).toHaveBeenCalledWith(1, bytes, 384, 192, 500)
    invoke.mockClear()
    await matched(B)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'quest:frames')).toEqual([['quest:frames', null]])
  })

  it('is decoded here once the re-encode fails and the headset plays the file itself', async () => {
    const feedFailed = (mediaId: number, host = QUEST) => listeners.get('headset:feedFailed')?.({ host, mediaId } satisfies IpcEvents['headset:feedFailed'])
    reencoded.add(12)
    hello('s1')
    await matched(A)
    invoke.mockClear()
    feedFailed(13)
    feedFailed(12, '192.168.1.41')
    expect(native.followFile).toHaveBeenLastCalledWith(TWELVE.path, true)
    feedFailed(12)
    expect(native.followFile).toHaveBeenLastCalledWith(TWELVE.path, false)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'quest:frames')).toEqual([['quest:frames', null]])
    await matched(B)
    await matched(A)
    expect(native.followFile).toHaveBeenLastCalledWith(TWELVE.path, false)
  })
})
