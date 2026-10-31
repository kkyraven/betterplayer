import type { BrowserWindow, NativeImage, Size } from 'electron'
import type { VrOverlayEvent } from 'bp-engine'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLAT } from '@shared/projection'
import { VR_DECK_IDLE_MS, VR_DECK_PEEK_MS, type VrPlayerState } from '@shared/vr'
import type { SettingsStore } from '../settings/store'
import { VrHost } from './host'

const fake = vi.hoisted(() => ({
  sent: [] as { to: unknown; event: string; payload: unknown }[],
  overlays: [] as FakeOverlays[],
  scale: 2,
}))
interface FakeOverlays {
  create: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  paint: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  follow: ReturnType<typeof vi.fn>
  shown: Map<number, boolean>
  events: VrOverlayEvent[]
}
vi.mock('../ipc', () => ({ send: (to: unknown, event: string, payload: unknown) => fake.sent.push({ to, event, payload }) }))
vi.mock('../log', () => ({ logEvent: vi.fn() }))
vi.mock('node:module', () => ({
  createRequire: () => () => ({
    VrOverlays: class {
      private next = 0
      create = vi.fn(() => this.next++)
      resize = vi.fn()
      paint = vi.fn()
      shown = new Map<number, boolean>()
      show = vi.fn((id: number, interactive: boolean) => this.shown.set(id, interactive))
      hide = vi.fn((id: number) => this.shown.delete(id))
      follow = vi.fn()
      place = vi.fn()
      recentre = vi.fn()
      close = vi.fn()
      events: VrOverlayEvent[] = []
      poll = () => this.events.splice(0)
      constructor() {
        fake.overlays.push(this)
      }
    },
  }),
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getPreferredSystemLanguages: () => ['en'] },
  screen: { getDisplayMatching: () => ({ scaleFactor: fake.scale }) },
  BrowserWindow: class {
    webContents = { on: vi.fn(), setFrameRate: vi.fn(), setZoomFactor: vi.fn(), sendInputEvent: vi.fn() }
    isDestroyed = () => false
    destroy = vi.fn()
    loadFile = () => Promise.resolve()
  },
}))

const SCREEN = 0
const DECK = 1
const POLL_MS = 16
const player: VrPlayerState = {
  title: 'Clip',
  loaded: true,
  playing: true,
  timeMs: 1000,
  durationMs: 60_000,
  rate: 1,
  heat: [],
  axes: [],
  devices: [],
  projection: FLAT,
  projectionSource: 'none',
  volume: 1,
  muted: false,
  screenSize: 'medium',
  halted: false,
  inSession: false,
}

function setup({ preview = false, contentSize = [2560, 1440] } = {}) {
  const contents = { on: vi.fn(), isDestroyed: () => false, beginFrameSubscription: vi.fn(), endFrameSubscription: vi.fn(), sendInputEvent: vi.fn() }
  const win = { on: vi.fn(), isDestroyed: () => false, getContentSize: () => contentSize, getBounds: () => ({ x: 0, y: 0, width: 2560, height: 1440 }), webContents: contents }
  const store = { get: () => ({ general: { language: 'en' } }) }
  const host = new VrHost(win as unknown as BrowserWindow, 'engine', store as unknown as SettingsStore, preview)
  host.start()
  const overlays = fake.overlays.at(-1)!
  const deliver = (size: Size) => {
    const image = { isEmpty: () => false, getSize: () => size, resize: vi.fn((to: Size) => ({ ...image, getSize: () => to })), toBitmap: () => Buffer.alloc(0) }
    const onFrame = contents.beginFrameSubscription.mock.calls.at(-1)?.[1] as (image: NativeImage) => void
    onFrame(image as unknown as NativeImage)
    return image
  }
  const frame = (size: Size) => {
    const image = deliver(size)
    vi.advanceTimersByTime(0)
    return image
  }
  const laser = (kind: string, x: number, y: number, overlay = SCREEN) => {
    overlays.events.push({ overlay, kind, x, y, button: 1, dx: 0, dy: 0 })
    vi.advanceTimersByTime(POLL_MS)
  }
  const deckMode = () => (!overlays.shown.has(DECK) ? 'hidden' : overlays.shown.get(DECK) ? 'open' : 'peek')
  const forwarded = () => fake.sent.filter((s) => s.to === win && s.event === 'vr:command').map((s) => s.payload)
  const deckStates = () => fake.sent.filter((s) => s.to !== win && s.event === 'vr:state').map((s) => s.payload)
  return { host, win, contents, overlays, deliver, frame, laser, deckMode, forwarded, deckStates }
}

beforeEach(() => {
  vi.useFakeTimers()
  fake.sent.length = 0
  fake.scale = 2
})

afterEach(() => vi.useRealTimers())

describe('VrHost big screen', () => {
  it('starts down, sized to the main window and scaled to fit', () => {
    const { overlays, contents } = setup()
    expect(overlays.create).toHaveBeenNthCalledWith(1, expect.stringContaining('.screen.'), 'Better Player', 3840, 2160, expect.any(Number), expect.any(Number))
    expect(overlays.shown.has(SCREEN)).toBe(false)
    expect(contents.beginFrameSubscription).not.toHaveBeenCalled()
    expect(setup({ contentSize: [0, 0] }).overlays.create).toHaveBeenNthCalledWith(1, expect.stringContaining('.screen.'), 'Better Player', 1920, 1080, expect.any(Number), expect.any(Number))
  })

  it('shows the main window live while up and maps the laser onto it', () => {
    const { host, contents, overlays, frame, laser, forwarded } = setup()
    host.command({ kind: 'screen', open: true })
    expect(overlays.show).toHaveBeenCalledWith(SCREEN, true)
    expect(contents.beginFrameSubscription).toHaveBeenCalledOnce()
    expect(forwarded()).toEqual([{ kind: 'screen', open: true }])

    const image = frame({ width: 5120, height: 2880 })
    expect(image.resize).toHaveBeenCalledWith({ width: 3840, height: 2160, quality: 'better' })
    expect(overlays.resize).toHaveBeenCalledWith(SCREEN, 3840, 2160)
    expect(overlays.paint).toHaveBeenLastCalledWith(SCREEN, expect.anything(), 0, 0, 3840, 2160)
    laser('down', 1920, 1080)
    expect(contents.sendInputEvent).toHaveBeenLastCalledWith({ type: 'mouseDown', x: 1280, y: 720, button: 'left', clickCount: 1 })

    frame({ width: 1600, height: 1200 })
    frame({ width: 1600, height: 1200 })
    expect(overlays.resize).toHaveBeenCalledTimes(2)
    expect(overlays.paint).toHaveBeenLastCalledWith(SCREEN, expect.anything(), 0, 0, 1600, 1200)
    laser('move', 1600, 600)
    expect(contents.sendInputEvent).toHaveBeenLastCalledWith({ type: 'mouseMove', x: 799, y: 300, modifiers: ['leftbuttondown'] })
  })

  it('refits the laser when the display scale changes and the frame size does not', () => {
    const { host, contents, frame, laser } = setup()
    host.command({ kind: 'screen', open: true })
    frame({ width: 3840, height: 2160 })
    laser('move', 1920, 1080)
    expect(contents.sendInputEvent).toHaveBeenLastCalledWith({ type: 'mouseMove', x: 960, y: 540 })
    fake.scale = 1.5
    frame({ width: 3840, height: 2160 })
    laser('move', 1920, 1080)
    expect(contents.sendInputEvent).toHaveBeenLastCalledWith({ type: 'mouseMove', x: 1280, y: 720 })
  })

  it('paints only the newest of the frames that queued up while main was busy', () => {
    const { host, overlays, deliver } = setup()
    host.command({ kind: 'screen', open: true })
    deliver({ width: 1600, height: 1200 })
    deliver({ width: 1920, height: 1080 })
    vi.advanceTimersByTime(0)
    expect(overlays.paint).toHaveBeenCalledOnce()
    expect(overlays.paint).toHaveBeenLastCalledWith(SCREEN, expect.anything(), 0, 0, 1920, 1080)
  })

  it('keeps the deck open while the screen is up, and idles it once the screen is put away', () => {
    const { host, deckMode } = setup()
    host.setState(player)
    host.command({ kind: 'screen', open: true })
    vi.advanceTimersByTime(VR_DECK_IDLE_MS + 100)
    expect(deckMode()).toBe('open')
    host.command({ kind: 'screen', open: false })
    vi.advanceTimersByTime(VR_DECK_IDLE_MS - 100)
    expect(deckMode()).toBe('open')
    vi.advanceTimersByTime(100 + POLL_MS)
    expect(deckMode()).toBe('hidden')
  })

  it("acts on each screen change once, so the main window's own never comes back round", () => {
    const { host, contents, overlays, forwarded } = setup()
    host.command({ kind: 'screen', open: true })
    host.command({ kind: 'screen', open: true })
    expect(forwarded()).toEqual([{ kind: 'screen', open: true }])
    host.command({ kind: 'screen', open: false })
    host.command({ kind: 'screen', open: false })
    expect(overlays.hide).toHaveBeenCalledWith(SCREEN)
    expect(contents.endFrameSubscription).toHaveBeenCalledOnce()
    expect(forwarded()).toEqual([{ kind: 'screen', open: true }, { kind: 'screen', open: false }])
    host.command({ kind: 'toggle' })
    expect(forwarded().at(-1)).toEqual({ kind: 'toggle' })
  })

  it('tells the deck whether the screen is up, with its clock moved on', () => {
    const { host, deckStates } = setup()
    host.setState(player)
    expect(deckStates()).toEqual([{ ...player, screen: false, mode: 'open', peek: null }])
    vi.advanceTimersByTime(300)
    host.command({ kind: 'screen', open: true })
    expect(deckStates().at(-1)).toEqual({ ...player, timeMs: 1300, screen: true, mode: 'open', peek: null })
    expect(host.state).toEqual({ ...player, timeMs: 1300, screen: true, mode: 'open', peek: null })
  })

  it('stops the frames when VR stops, once however often it is stopped', () => {
    const { host, contents } = setup()
    host.command({ kind: 'screen', open: true })
    host.stop()
    host.stop()
    expect(contents.endFrameSubscription).toHaveBeenCalledOnce()
    expect(host.state).toBeNull()
  })

  it('ends VR when SteamVR quits with the screen up: frames stop and the window is told', () => {
    const { host, win, contents, overlays } = setup()
    host.command({ kind: 'screen', open: true })
    overlays.events.push({ overlay: -1, kind: 'quit', x: 0, y: 0, button: 0, dx: 0, dy: 0 })
    vi.advanceTimersByTime(16)
    expect(contents.endFrameSubscription).toHaveBeenCalledOnce()
    expect(fake.sent.at(-1)).toEqual({ to: win, event: 'vr:ended', payload: null })
  })

  it('in preview still tells the deck and the main window, with no frames', () => {
    const { host, contents, forwarded, deckStates } = setup({ preview: true })
    host.setState(player)
    host.command({ kind: 'screen', open: true })
    expect(forwarded()).toEqual([{ kind: 'screen', open: true }])
    expect(deckStates().at(-1)).toMatchObject({ screen: true })
    host.stop()
    expect(contents.beginFrameSubscription).not.toHaveBeenCalled()
    expect(contents.endFrameSubscription).not.toHaveBeenCalled()
  })
})

describe('VrHost deck', () => {
  it('starts open and following the head, as does the big screen', () => {
    const { overlays, deckMode } = setup()
    expect(deckMode()).toBe('open')
    expect(overlays.follow).toHaveBeenCalledWith(SCREEN, true)
    expect(overlays.follow).toHaveBeenCalledWith(DECK, true)
  })

  it('stays open while nothing is loaded, then hides while paused as while playing', () => {
    const { host, deckMode } = setup()
    vi.advanceTimersByTime(VR_DECK_IDLE_MS * 2)
    expect(deckMode()).toBe('open')
    host.setState({ ...player, playing: false })
    vi.advanceTimersByTime(VR_DECK_IDLE_MS + POLL_MS)
    expect(deckMode()).toBe('hidden')
  })

  it('peeks without the laser for a moment and wakes with it; a peek on an open deck keeps it open', () => {
    const { host, deckMode, forwarded } = setup()
    host.setState(player)
    vi.advanceTimersByTime(VR_DECK_IDLE_MS + POLL_MS)
    host.command({ kind: 'peek' })
    expect(deckMode()).toBe('peek')
    vi.advanceTimersByTime(VR_DECK_PEEK_MS + POLL_MS)
    expect(deckMode()).toBe('hidden')

    host.command({ kind: 'peek' })
    host.command({ kind: 'wake' })
    expect(deckMode()).toBe('open')
    vi.advanceTimersByTime(VR_DECK_IDLE_MS - 100)
    host.command({ kind: 'peek' })
    vi.advanceTimersByTime(VR_DECK_IDLE_MS - 100)
    expect(deckMode()).toBe('open')
    expect(forwarded()).toEqual([])
  })

  it('stays open while the laser is used on it, not while it only trembles there', () => {
    const { host, overlays, laser, deckMode } = setup()
    host.setState(player)
    laser('move', 100, 100, DECK)
    vi.advanceTimersByTime(VR_DECK_IDLE_MS - 100)
    laser('move', 110, 100, DECK)
    vi.advanceTimersByTime(VR_DECK_IDLE_MS - 100)
    expect(deckMode()).toBe('open')
    laser('move', 114, 103, DECK)
    overlays.events.push({ overlay: -1, kind: 'press', x: 0, y: 0, button: 0, dx: 0, dy: 0 })
    vi.advanceTimersByTime(100 + POLL_MS)
    expect(deckMode()).toBe('hidden')
  })

  it('stays open while a laser button is held still, and ends hover when it hides', () => {
    const { host, laser, deckMode } = setup()
    host.setState(player)
    laser('down', 300, 250, DECK)
    vi.advanceTimersByTime(VR_DECK_IDLE_MS * 2)
    expect(deckMode()).toBe('open')
    const deck = host.deckWindow!.webContents.sendInputEvent as ReturnType<typeof vi.fn>
    deck.mockClear()
    laser('up', 300, 250, DECK)
    vi.advanceTimersByTime(VR_DECK_IDLE_MS + POLL_MS)
    expect(deckMode()).toBe('hidden')
    expect(deck.mock.calls.map(([e]) => (e as { type: string }).type)).toEqual(['mouseUp', 'mouseLeave'])
  })

  it('recentres the overlays keeping the recline for a deck press, and passes it on', () => {
    const { host, overlays, forwarded } = setup()
    const recentre = (overlays as unknown as { recentre: ReturnType<typeof vi.fn> }).recentre
    recentre.mockClear()
    host.command({ kind: 'recentre', keepRecline: true })
    host.command({ kind: 'recentre' })
    expect(recentre.mock.calls).toEqual([[true], [undefined]])
    expect(forwarded()).toEqual([{ kind: 'recentre', keepRecline: true }, { kind: 'recentre' }])
  })

  it('tells the deck its mode once per change, with the shortcut behind a peek', () => {
    const { host, deckStates } = setup()
    host.setState(player)
    const sent = deckStates().length
    vi.advanceTimersByTime(POLL_MS * 4)
    expect(deckStates()).toHaveLength(sent)
    vi.advanceTimersByTime(VR_DECK_IDLE_MS)
    expect(deckStates().at(-1)).toMatchObject({ mode: 'hidden', peek: null })
    host.command({ kind: 'peek', shortcut: 'seekForward' })
    host.command({ kind: 'peek', shortcut: 'seekForward' })
    expect(deckStates().at(-1)).toMatchObject({ mode: 'peek', peek: { shortcut: 'seekForward', count: 2 } })
    host.command({ kind: 'wake' })
    expect(deckStates().at(-1)).toMatchObject({ mode: 'open', peek: null })
  })
})
