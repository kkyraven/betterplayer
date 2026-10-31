import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vrError, type VrCommand } from '@shared/vr'

const m = vi.hoisted(() => ({
  vrStart: vi.fn(),
  vrStop: vi.fn(),
  vrView: vi.fn(),
  vrRecentre: vi.fn(),
  vrTurn: vi.fn(),
  vrScreen: vi.fn(),
  vrState: vi.fn(),
  haltSensation: vi.fn(),
  shortcuts: [] as string[],
  hasShortcuts: true,
  invoke: vi.fn(),
  pause: vi.fn(),
  togglePlay: vi.fn(),
  seekBy: vi.fn(),
  setVolume: vi.fn(),
  setProjection: vi.fn(),
  step: vi.fn(),
  next: vi.fn(),
  previous: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
  storage: new Map<string, string>(),
}))
vi.mock('@/engine/client', () => ({
  engine: {
    vrStart: m.vrStart,
    vrStop: m.vrStop,
    vrView: m.vrView,
    vrRecentre: m.vrRecentre,
    vrTurn: m.vrTurn,
    vrScreen: m.vrScreen,
    vrState: m.vrState,
    haltSensation: m.haltSensation,
    get vrShortcuts() {
      return m.hasShortcuts ? () => m.shortcuts.splice(0) : undefined
    },
  },
  vrAvailable: () => ({ installed: true, hmd: true }),
}))
vi.mock('@/ipc', () => ({
  invoke: m.invoke,
  on: (event: string, listener: (payload: unknown) => void) => {
    m.listeners.set(event, listener)
    return () => m.listeners.delete(event)
  },
}))
vi.mock('@/node', () => ({ platform: 'linux' }))
vi.mock('./devices', () => ({ outputName: () => 'Toy', useDevices: { getState: () => ({ outputs: [], states: {} }), subscribe: () => () => {} } }))
vi.mock('./live', () => ({ get: () => ({ timeMs: 0, seekGeneration: 0 }), axisIdsWith: () => [], FLAG_SCRIPT: 1, FLAG_DERIVED: 2 }))
vi.mock('./player', async () => {
  const { create } = await import('zustand')
  const player = {
    snapshot: { loaded: true, paused: false, durationMs: 60000, rate: 1 },
    media: null,
    title: 'One',
    scripts: [],
    projection: { kind: 'flat', layout: 'mono', fov: 180, swapEyes: false },
    projectionSource: 'name',
    volume: 0.5,
    muted: false,
    path: 'C:/v/one.mp4' as string | null,
    ended: false,
    pause: m.pause,
    togglePlay: m.togglePlay,
    seekBy: m.seekBy,
    setVolume: m.setVolume,
    setProjection: m.setProjection,
    step: m.step,
  }
  return { usePlayer: create(() => player) }
})
vi.mock('./session', async () => {
  const { create } = await import('zustand')
  return { useSession: create(() => ({ stage: 'setup', next: m.next, previous: m.previous })) }
})

let vr: typeof import('./vr')
let player: typeof import('./player').usePlayer
let session: typeof import('./session').useSession
let ui: typeof import('./ui').useUi
const headset = (state: Record<string, unknown> | null) => m.vrState.mockReturnValue(state && { active: true, quit: false, mounted: true, focused: true, presses: 0, hmdName: 'Index', ...state })
const store = () => vr.useVr.getState()
const halts = () => m.pause.mock.calls.length > 0 && m.haltSensation.mock.calls.length > 0
const sent = (channel: string) => m.invoke.mock.calls.filter(([c]) => c === channel).map(([, payload]: unknown[]) => payload)
const command = (c: VrCommand) => m.listeners.get('vr:command')?.(c)
const press = (...names: string[]) => {
  m.shortcuts.push(...names)
  vi.advanceTimersByTime(50)
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval })
  m.storage.clear()
  vi.stubGlobal('localStorage', { getItem: (k: string) => m.storage.get(k) ?? null, setItem: (k: string, v: string) => m.storage.set(k, v) })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.resetModules()
  vi.clearAllMocks()
  m.listeners.clear()
  m.shortcuts.length = 0
  m.hasShortcuts = true
  m.invoke.mockImplementation((channel: string, on?: unknown) => Promise.resolve(channel === 'window:fullscreen' ? (on ?? false) : null))
  m.vrStart.mockResolvedValue(undefined)
  m.vrStop.mockResolvedValue(undefined)
  headset({})
  vr = await import('./vr')
  player = (await import('./player')).usePlayer
  session = (await import('./session')).useSession
  ui = (await import('./ui')).useUi
  player.setState({ path: 'C:/v/one.mp4', ended: false, volume: 0.5 })
  session.setState({ stage: 'setup' })
  vr.startVr()
})

afterEach(() => {
  if (store().active) store().stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('VR ending without the user', () => {
  it('halts like the deck Stop when SteamVR quits, and says so', async () => {
    await store().start()
    expect(store().active).toBe(true)
    headset({ active: false, quit: true })
    vi.advanceTimersByTime(250)
    expect(halts()).toBe(true)
    expect(m.vrStop).toHaveBeenCalled()
    expect(sent('vr:stop')).toHaveLength(1)
    expect(store()).toMatchObject({ active: false, error: 'quit' })
  })

  it('halts when main ends the session, showing the code and never the detail', async () => {
    await store().start()
    m.listeners.get('vr:ended')?.('compositor: SteamVR compositor error 105')
    expect(halts()).toBe(true)
    expect(store()).toMatchObject({ active: false, error: 'compositor' })
  })

  it('halts on a failed start', async () => {
    m.vrStart.mockRejectedValue(new Error('busy: Another app has the headset (VRInitError_Init_AnotherAppLaunching)'))
    await store().start()
    expect(halts()).toBe(true)
    expect(store()).toMatchObject({ active: false, starting: false, error: 'busy' })
  })

  it('abandons a start that main ended while it waited', async () => {
    let connect = () => {}
    m.vrStart.mockReturnValue(new Promise<void>((resolve) => (connect = resolve)))
    const starting = store().start()
    await vi.waitFor(() => expect(m.vrStart).toHaveBeenCalled())
    m.listeners.get('vr:ended')?.(null)
    connect()
    await starting
    expect(halts()).toBe(true)
    expect(store()).toMatchObject({ active: false, starting: false, error: 'quit' })
    vi.advanceTimersByTime(1000)
    expect(m.vrState).not.toHaveBeenCalled()
  })

  it('lets Back to desktop carry on playing', async () => {
    await store().start()
    store().stop()
    expect(m.pause).not.toHaveBeenCalled()
    expect(m.haltSensation).not.toHaveBeenCalled()
    expect(store()).toMatchObject({ active: false, error: null })
  })

  it('drops the error after a few seconds, so a later player visit never shows it', async () => {
    await store().start()
    m.listeners.get('vr:ended')?.('failed: the deck panel stopped (crashed)')
    expect(store().error).toBe('failed')
    vi.advanceTimersByTime(8000)
    expect(store().error).toBeNull()
  })
})

describe('The headset coming off', () => {
  it('halts until Play and shows it on the deck; back on, the view recentres once it settles', async () => {
    await store().start()
    headset({ mounted: false })
    vi.advanceTimersByTime(250)
    expect(halts()).toBe(true)
    expect(sent('vr:state').at(-1)).toMatchObject({ halted: true })
    expect(store().active).toBe(true)

    headset({ mounted: true })
    vi.advanceTimersByTime(250 + 900)
    expect(sent('vr:command')).toEqual([])
    vi.advanceTimersByTime(100)
    expect(sent('vr:command')).toEqual([{ kind: 'recentre' }, { kind: 'peek' }])
  })

  it('only peeks when tracking alone came back: the headset stayed on', async () => {
    await store().start()
    headset({ mounted: false, lostTracking: true })
    vi.advanceTimersByTime(250)
    expect(halts()).toBe(true)
    headset({ mounted: true, lostTracking: true })
    vi.advanceTimersByTime(250 + 1000)
    expect(sent('vr:command')).toEqual([{ kind: 'peek' }])
  })

  it('keeps the recline for a recentre from the deck', async () => {
    await store().start()
    m.vrRecentre.mockClear()
    command({ kind: 'recentre', keepRecline: true })
    expect(m.vrRecentre).toHaveBeenCalledWith(true)
  })

  it('does not recentre when it comes off again before settling', async () => {
    await store().start()
    headset({ mounted: false })
    vi.advanceTimersByTime(250)
    headset({ mounted: true })
    vi.advanceTimersByTime(500)
    headset({ mounted: false })
    vi.advanceTimersByTime(2000)
    expect(sent('vr:command')).toEqual([])
  })
})

describe('The deck', () => {
  it('steps as the player bar: videos, or clips in a session', async () => {
    await store().start()
    command({ kind: 'step', direction: 1 })
    expect(m.step).toHaveBeenCalledWith(1)
    expect(sent('vr:state').at(-1)).toMatchObject({ inSession: false })

    session.setState({ stage: 'running' })
    expect(sent('vr:state').at(-1)).toMatchObject({ inSession: true })
    command({ kind: 'step', direction: -1 })
    command({ kind: 'step', direction: 1 })
    expect(m.previous).toHaveBeenCalledTimes(1)
    expect(m.next).toHaveBeenCalledTimes(1)
    expect(m.step).toHaveBeenCalledTimes(1)
  })
})

describe('The View picker', () => {
  it('sets a pick for this video, and Auto clears it', async () => {
    await store().start()
    const pick = { kind: 'equirect180', layout: 'sbs', fov: 190, swapEyes: false } as const
    command({ kind: 'projection', projection: pick })
    command({ kind: 'projection', projection: null })
    expect(m.setProjection.mock.calls).toEqual([[pick], [null]])
  })
})

describe('Controller shortcuts', () => {
  it('act on the player and peek the deck; Show controls opens it', async () => {
    await store().start()
    expect(sent('vr:state').at(-1)).toMatchObject({ volume: 0.5, muted: false, projectionSource: 'name' })
    press('seekForward', 'playPause', 'recentre')
    expect(m.seekBy).toHaveBeenCalledWith(10)
    expect(m.togglePlay).toHaveBeenCalledOnce()
    expect(sent('vr:command')).toEqual([
      { kind: 'peek', shortcut: 'seekForward' },
      { kind: 'peek', shortcut: 'playPause' },
      { kind: 'recentre' },
      { kind: 'peek', shortcut: 'recentre' },
    ])
    m.invoke.mockClear()
    press('controls')
    expect(sent('vr:command')).toEqual([{ kind: 'wake' }])
  })

  it('back pauses without the halt and brings up the library; with it up, SteamVR has B', async () => {
    await store().start()
    press('back')
    expect(m.pause).toHaveBeenCalledOnce()
    expect(m.haltSensation).not.toHaveBeenCalled()
    expect(sent('vr:command')).toEqual([{ kind: 'screen', open: true }])
    command({ kind: 'screen', open: true })
    expect(ui.getState().tvTab).toBe('library')
    m.invoke.mockClear()
    press('back')
    expect(m.pause).toHaveBeenCalledOnce()
    expect(sent('vr:command')).toEqual([])
  })

  it('turn the video a step either way, without peeking the deck', async () => {
    await store().start()
    press('turnLeft', 'turnRight', 'turnRight')
    expect(m.vrTurn.mock.calls).toEqual([[-10], [10], [10]])
    expect(sent('vr:command')).toEqual([])
  })

  it('step the volume by 5 %, back onto whole steps', async () => {
    await store().start()
    press('volumeUp')
    expect(m.setVolume).toHaveBeenLastCalledWith(0.55)
    player.setState({ volume: 0.33 })
    press('volumeDown')
    expect(m.setVolume).toHaveBeenLastCalledWith(0.3)
  })

  it('stop halts as the deck Stop; play then only opens the deck', async () => {
    await store().start()
    press('stop')
    expect(halts()).toBe(true)
    expect(sent('vr:state').at(-1)).toMatchObject({ halted: true })
    m.invoke.mockClear()
    press('playPause')
    expect(m.togglePlay).not.toHaveBeenCalled()
    expect(sent('vr:command')).toEqual([{ kind: 'wake' }])
  })

  it('are dropped while the headset is off, not kept for when it is back on', async () => {
    await store().start()
    headset({ mounted: false })
    press('playPause', 'seekForward')
    headset({ mounted: true })
    vi.advanceTimersByTime(50)
    expect(m.togglePlay).not.toHaveBeenCalled()
    expect(m.seekBy).not.toHaveBeenCalled()
  })

  it('leave button presses alone; an engine without shortcuts opens the deck on each', async () => {
    await store().start()
    headset({ presses: 1 })
    vi.advanceTimersByTime(250)
    expect(sent('vr:command')).toEqual([])
    store().stop()

    m.hasShortcuts = false
    headset({ presses: 1 })
    await store().start()
    headset({ presses: 2 })
    vi.advanceTimersByTime(250)
    expect(sent('vr:command')).toEqual([{ kind: 'wake' }])
  })
})

describe('The screen size', () => {
  it('applies the saved size at start, and a new one from the deck is kept for next time', async () => {
    await store().start()
    expect(m.vrScreen).toHaveBeenLastCalledWith(50)
    expect(sent('vr:state').at(-1)).toMatchObject({ screenSize: 'medium' })
    command({ kind: 'screenSize', size: 'huge' })
    expect(m.vrScreen).toHaveBeenLastCalledWith(75)
    expect(sent('vr:state').at(-1)).toMatchObject({ screenSize: 'huge' })
    store().stop()

    await store().start()
    expect(m.vrScreen).toHaveBeenLastCalledWith(75)
    expect(sent('vr:state').at(-1)).toMatchObject({ screenSize: 'huge' })
  })

  it('falls back to the default for a value it does not know', async () => {
    m.storage.set('bp.vr.screenSize', 'toString')
    await store().start()
    expect(m.vrScreen).toHaveBeenLastCalledWith(50)
  })
})

describe('The SteamVR dashboard', () => {
  it('pauses without the halt when it takes focus, and nothing resumes after', async () => {
    await store().start()
    headset({ focused: false })
    vi.advanceTimersByTime(250)
    expect(m.pause).toHaveBeenCalledOnce()
    expect(m.haltSensation).not.toHaveBeenCalled()
    headset({ focused: true })
    vi.advanceTimersByTime(250)
    expect(m.pause).toHaveBeenCalledOnce()
    expect(m.togglePlay).not.toHaveBeenCalled()
    expect(sent('vr:state').at(-1)).toMatchObject({ halted: false })
  })
})

describe('Media Centre and the big screen', () => {
  it('turns Media Centre on for the session and off after, counting VR rather than Media Centre', async () => {
    await store().start()
    expect(ui.getState()).toMatchObject({ mediaCentre: true, tvTab: 'nowplaying' })
    store().stop()
    expect(ui.getState().mediaCentre).toBe(false)
    expect(sent('usage:track')).toEqual(['action.vr.start'])
  })

  it.each([
    { before: true, during: true, after: true },
    { before: false, during: true, after: false },
    { before: true, during: false, after: false },
  ])('puts fullscreen back as before unless the user left it: $before, then $during, ends $after', async ({ before, during, after }) => {
    ui.setState({ fullscreen: before })
    await store().start()
    ui.getState().setFullscreen(during)
    store().stop()
    expect(sent('window:fullscreen').at(-1)).toBe(after)
  })

  it('leaves Media Centre alone when it was already on, or the user left it during the session', async () => {
    ui.getState().setMediaCentre(true)
    await store().start()
    store().stop()
    expect(ui.getState().mediaCentre).toBe(true)

    ui.getState().setMediaCentre(false)
    await store().start()
    ui.getState().setMediaCentre(false)
    ui.getState().setMediaCentre(true)
    store().stop()
    expect(ui.getState().mediaCentre).toBe(true)
  })

  it('shows the library while the screen is up, keeping the grid the video came from', async () => {
    const grid = { kind: 'grid', source: { title: 'Folder' } } as const
    await store().start()
    ui.setState({ tvViews: [grid] })
    command({ kind: 'screen', open: true })
    expect(ui.getState()).toMatchObject({ tvTab: 'library', tvViews: [grid] })
    command({ kind: 'screen', open: false })
    expect(ui.getState().tvTab).toBe('nowplaying')
  })

  it('brings the screen up on start only when no video is open', async () => {
    await store().start()
    expect(sent('vr:command')).toEqual([])
    store().stop()

    player.setState({ path: null })
    await store().start()
    expect(sent('vr:command')).toEqual([{ kind: 'screen', open: true }])
  })

  it('puts the screen away when another video starts', async () => {
    await store().start()
    player.setState({ path: 'C:/v/two.mp4' })
    expect(sent('vr:command')).toEqual([])

    command({ kind: 'screen', open: true })
    player.setState({ path: 'C:/v/three.mp4' })
    expect(sent('vr:command')).toEqual([{ kind: 'screen', open: false }])
  })

  it('puts the screen away when Media Centre goes back to Now playing', async () => {
    await store().start()
    command({ kind: 'screen', open: true })
    ui.getState().setTvTab('nowplaying')
    expect(sent('vr:command')).toEqual([{ kind: 'screen', open: false }])
  })

  it('brings the screen up on the summary when a session ends', async () => {
    session.setState({ stage: 'running' })
    await store().start()
    session.setState({ stage: 'summary' })
    expect(sent('vr:command')).toEqual([{ kind: 'screen', open: true }])

    command({ kind: 'screen', open: true })
    session.setState({ stage: 'running' })
    session.setState({ stage: 'summary' })
    expect(sent('vr:command')).toHaveLength(1)
  })

  it('brings the screen up when a video ends with nothing to follow it', async () => {
    await store().start()
    player.setState({ ended: true })
    player.setState({ ended: false })
    vi.advanceTimersByTime(1500)
    expect(sent('vr:command')).toEqual([])

    player.setState({ ended: true })
    vi.advanceTimersByTime(1400)
    expect(sent('vr:command')).toEqual([])
    vi.advanceTimersByTime(100)
    expect(sent('vr:command')).toEqual([{ kind: 'screen', open: true }])
  })
})

describe('vrError', () => {
  it('reads the code in front of an engine error', () => {
    expect(vrError('not-running: SteamVR is not running')).toBe('not-running')
    expect(vrError('quit')).toBe('quit')
    expect(vrError('SteamVR overlay error VROverlayError_RequestFailed (23)')).toBe('failed')
  })
})
