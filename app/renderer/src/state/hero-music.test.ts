import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PerVideoSettings } from '@shared/settings'
const EMPTY_VIDEO: PerVideoSettings = { globalOffsetMs: 0, axes: {} }
import { defaultEffect, defaultHeroMusic, defaultHeroMusicRule, defaultTrackAxes, defaultTrackingDefaults, normalizeHeroMusic, heroFileText, newZone } from '@shared/tracking'

const native = vi.hoisted(() => ({
  setHeroMusic: vi.fn(), setHeroOptions: vi.fn(), setHeroColour: vi.fn(), setRate: vi.fn(),
  setTrackAxes: vi.fn(), trackStop: vi.fn(), setBeatOptions: vi.fn(), trackStart: vi.fn(),
  setTrackOptions: vi.fn(),
  setTrackRegionSource: vi.fn(), trackState: vi.fn(() => ({ state: 'idle' })),
  modelState: vi.fn(() => ({ status: 'none' })), beatState: vi.fn(() => ({ status: 'ready' })),
  heroState: vi.fn(() => ({ colours: [] })), effectSpeed: vi.fn(() => 1.5),
  setZones: vi.fn(), zoneState: vi.fn(() => []),
}))
vi.mock('@/engine/client', () => ({ engine: native, models: () => [] }))
vi.mock('@/ipc', () => ({ invoke: vi.fn(), on: vi.fn() }))
vi.mock('./audio', () => ({ releaseAudio: vi.fn(), ensureFullAudio: vi.fn(() => Promise.resolve()), ensureAudio: vi.fn() }))
vi.mock('@/screens/browser/StartPage', () => ({ siteName: vi.fn() }))
vi.mock('./browser', () => ({ useBrowser: { subscribe: vi.fn(), getState: () => ({ tabs: [], capture: vi.fn(), setRegion: vi.fn(), setZone: vi.fn() }) }, feedColour: vi.fn(), subscribeFrames: vi.fn() }))
vi.mock('./params', () => ({ pushParams: vi.fn() }))
vi.mock('./settings', () => ({ useSettings: { subscribe: vi.fn(), getState: () => ({ settings: { tracking: defaultTrackingDefaults(), intiface: { alwaysOn: false } } }) } }))
vi.mock('./player', async () => {
  const { create } = await import('zustand')
  return { usePlayer: create(() => ({ path: '/a.mp4', title: 'Video', scripts: [], video: { globalOffsetMs: 0, axes: {} }, snapshot: { rate: 1.25 }, setTracking: vi.fn() })) }
})
import { usePlayer } from './player'
import { invoke } from '@/ipc'
import { trackingSettings, useTracking } from './tracking'

beforeEach(() => {
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.useFakeTimers()
  vi.clearAllMocks()
  usePlayer.setState({ path: '/a.mp4', video: { ...EMPTY_VIDEO }, snapshot: { ...usePlayer.getState().snapshot, rate: 1.25 } })
  const axes = defaultTrackAxes()
  axes.L0.source = 'ai-music'
  useTracking.setState({ source: 'player', key: '/a.mp4', axes, heroMusic: defaultHeroMusic(), heroZone: null, zones: { enabled: false, zones: [] }, heroFileStamp: undefined })
})
afterEach(() => {
  useTracking.getState().stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('finishes the browser tracking save before the player reads the same page settings', async () => {
  let finishWrite!: () => void
  const writing = new Promise<void>((resolve) => { finishWrite = resolve })
  vi.mocked(invoke).mockResolvedValueOnce(EMPTY_VIDEO).mockReturnValueOnce(writing)
  useTracking.setState({ source: 'browser', key: 'https://example.com/watch' })
  useTracking.getState().setSensitivity(0.7)
  useTracking.getState().stop()
  let finished = false
  const flushing = useTracking.getState().flushSave().then(() => { finished = true })
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenCalledWith('video:set', 'https://example.com/watch', expect.objectContaining({ tracking: expect.objectContaining({ sensitivity: 0.7 }) }))
  expect(finished).toBe(false)
  finishWrite()
  await flushing
  expect(finished).toBe(true)
})

it('saves enabled mode, its zone and colour rules immediately to the open video', () => {
  const t = useTracking.getState()
  t.setHeroMusicEnabled(true)
  t.setHeroMusicRule(0, { estimMax: 0.95, durationMs: 4000, tempo: 2 })
  expect(useTracking.getState().axes.L0.source).toBe('ai-music')
  expect(useTracking.getState().heroZone).not.toBeNull()
  expect(usePlayer.getState().setTracking).toHaveBeenLastCalledWith(expect.objectContaining({ heroMusic: { enabled: true, rules: { 0: { ...defaultHeroMusicRule(), estimMax: 0.95, durationMs: 4000, tempo: 2 } } } }))
  expect(native.setHeroMusic).toHaveBeenLastCalledWith(true, [expect.objectContaining({ bucket: 0, tempo: 2 })])
})

it('restores video rules and clears them on an unsaved video', async () => {
  const saved = { ...trackingSettings(useTracking.getState()), heroMusic: { enabled: true, rules: { 4: { ...defaultHeroMusicRule(), intensity: 1.5 } } } }
  usePlayer.setState({ video: { ...EMPTY_VIDEO, tracking: saved } })
  await useTracking.getState().start('player')
  expect(useTracking.getState().heroMusic).toEqual(saved.heroMusic)
  usePlayer.setState({ path: '/b.mp4', video: { ...EMPTY_VIDEO } })
  await useTracking.getState().start('player')
  expect(useTracking.getState().heroMusic).toEqual(defaultHeroMusic())
  expect(native.setHeroMusic).toHaveBeenLastCalledWith(false, [])
})

it('restores playback speed on disabling and keeps manual rate changes as the base', () => {
  useTracking.getState().setHeroMusicEnabled(true)
  useTracking.getState().update({ frames: 1, state: 'idle' } as Parameters<ReturnType<typeof useTracking.getState>['update']>[0])
  expect(native.setRate).toHaveBeenLastCalledWith(1.875)
  useTracking.getState().setBasePlaybackRate(1)
  expect(native.setRate).toHaveBeenLastCalledWith(1.5)
  useTracking.getState().setHeroMusicEnabled(false)
  expect(native.setRate).toHaveBeenLastCalledWith(1)
})

it('releases overrides when the last AI music axis changes source', () => {
  useTracking.getState().setHeroMusicEnabled(true)
  useTracking.getState().setAxis('L0', { source: 'video' })
  expect(native.setHeroMusic).toHaveBeenLastCalledWith(false, [])
  expect(useTracking.getState().heroMusic.enabled).toBe(true)
})

it('bounds saved values and rejects invalid buckets', () => {
  expect(normalizeHeroMusic({ enabled: true, rules: { 99: defaultHeroMusicRule(), 0: { durationMs: Infinity, tempo: 100, intensity: -2, playbackSpeed: NaN, estimMax: 2 } } })).toEqual({ enabled: true, rules: { 0: { durationMs: 2000, tempo: 4, intensity: 0, playbackSpeed: 1, estimMax: 1 } } })
})


it('imports advanced rules into the current video and exports them again', async () => {
  const heroMusic = { enabled: true, rules: { 11: { ...defaultHeroMusicRule(), tempo: 2, estimMax: 0.85 } } }
  const file = heroFileText({ heroMusic, heroZone: { x: 0.1, y: 0.4, w: 0.08, h: 0.2 } })
  vi.mocked(invoke).mockResolvedValueOnce(file)
  expect(await useTracking.getState().importHero()).toBe(true)
  expect(useTracking.getState().heroMusic).toEqual(heroMusic)
  expect(usePlayer.getState().setTracking).toHaveBeenLastCalledWith(expect.objectContaining({ heroMusic }))
  await useTracking.getState().exportHero()
  expect(invoke).toHaveBeenLastCalledWith('hero:export', '/a.mp4', 'Video', expect.stringContaining('"music"'))
})

it('adds a zone, sends the setup to the engine and saves it with the video', () => {
  const t = useTracking.getState()
  const id = t.addZone()
  useTracking.getState().updateZone(id, { trigger: { kind: 'part', target: 'faces' }, effect: { tempo: 2, intensity: 1, playbackSpeed: 1, estimMax: 0.9 } })
  const { zones } = useTracking.getState()
  expect(zones).toEqual({ enabled: true, zones: [expect.objectContaining({ id, cover: 0.2, holdMs: 500 })] })
  expect(native.setZones).toHaveBeenLastCalledWith(true, [expect.objectContaining({ id, trigger: 'part', part: 'faces', buckets: [], tempo: 2, estimMax: 0.9, vibeMax: undefined })])
  expect(usePlayer.getState().setTracking).toHaveBeenLastCalledWith(expect.objectContaining({ zones }))
  useTracking.getState().update({ frames: 1, state: 'idle' } as Parameters<ReturnType<typeof useTracking.getState>['update']>[0])
  expect(native.setRate).toHaveBeenLastCalledWith(1.875)
  useTracking.getState().setZonesEnabled(false)
  expect(native.setZones).toHaveBeenLastCalledWith(false, [])
  expect(native.setRate).toHaveBeenLastCalledWith(1.25)
  useTracking.getState().removeZone(id)
  expect(useTracking.getState().zones.zones).toEqual([])
})

const sidecar = (text: string, stamp: string) => vi.mocked(invoke).mockImplementation((async (channel: string) => (channel === 'hero:sidecar' ? { text, stamp } : undefined)) as never)

it('reads the setup file beside the video once per version of it', async () => {
  const zone = newZone({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })
  const file = heroFileText({ zones: { enabled: true, zones: [zone] } })
  sidecar(file, '10:1')
  await useTracking.getState().start('player')
  expect(useTracking.getState().zones).toEqual({ enabled: true, zones: [zone] })
  expect(native.setZones).toHaveBeenLastCalledWith(true, [expect.objectContaining({ id: zone.id })])
  expect(usePlayer.getState().setTracking).toHaveBeenLastCalledWith(expect.objectContaining({ heroFileStamp: '10:1', zones: { enabled: true, zones: [zone] } }))
  const edited = { ...trackingSettings(useTracking.getState()), zones: { enabled: false, zones: [{ ...zone, cover: 0.5 }] }, heroFileStamp: '10:1' }
  usePlayer.setState({ video: { ...EMPTY_VIDEO, tracking: edited } })
  await useTracking.getState().start('player')
  expect(useTracking.getState().zones).toEqual(edited.zones)
  sidecar(file, '10:2')
  await useTracking.getState().start('player')
  expect(useTracking.getState().zones).toEqual({ enabled: true, zones: [zone] })
  expect(useTracking.getState().heroFileStamp).toBe('10:2')
})

it('leaves the current rules unchanged after a rejected import', async () => {
  useTracking.getState().setHeroMusicEnabled(true)
  useTracking.getState().setHeroMusicRule(1, { tempo: 2 })
  const before = useTracking.getState().heroMusic
  vi.mocked(invoke).mockResolvedValueOnce('{"format":"wrong"}')
  expect(await useTracking.getState().importHero()).toBe(false)
  expect(useTracking.getState().heroMusic).toBe(before)
})

it('saves custom colour matches and relative estim for Hero and zones through export and import', async () => {
  const match = { colour: 0xf06d9d, tolerance: 0.15 }
  const t = useTracking.getState()
  t.setHeroMusicEnabled(true)
  t.setHeroMusicRule(11, { match, estimMax: null, estimMaxRelative: 0.8 })
  expect(native.setHeroMusic).toHaveBeenLastCalledWith(true, [expect.objectContaining({ colour: match.colour, tolerance: 0.15, estimMaxRelative: 0.8, estimMax: undefined })])
  const id = t.addZone()
  t.updateZone(id, { trigger: { kind: 'colour', buckets: [11], matches: { 11: match } }, effect: { ...defaultEffect(), estimMaxRelative: 0.8 } })
  expect(native.setZones).toHaveBeenLastCalledWith(true, [expect.objectContaining({ colourMatches: [{ bucket: 11, ...match }], estimMaxRelative: 0.8 })])
  const saved = trackingSettings(useTracking.getState())
  vi.mocked(invoke).mockResolvedValueOnce(heroFileText(saved))
  expect(await t.importHero()).toBe(true)
  expect(useTracking.getState().heroMusic).toEqual(saved.heroMusic)
  expect(useTracking.getState().zones).toEqual(saved.zones)
})

it('rejects malformed custom matches and conflicting estim overrides on import', async () => {
  for (const patch of [
    { match: { colour: -1, tolerance: 0.15 } },
    { match: { colour: 0xff0000, tolerance: 1.1 } },
    { estimMax: 0.5, estimMaxRelative: 0.8 },
    { estimMaxRelative: 3 },
  ]) {
    vi.mocked(invoke).mockResolvedValueOnce(heroFileText({ heroMusic: { enabled: true, rules: { 0: { ...defaultHeroMusicRule(), ...patch } } } }))
    expect(await useTracking.getState().importHero()).toBe(false)
  }
})

it('clears custom matching and optional overrides when resetting a colour', () => {
  const t = useTracking.getState()
  t.setHeroMusicEnabled(true)
  t.setHeroMusicRule(11, { match: { colour: 0xf06d9d, tolerance: 0.2 }, estimMaxRelative: 0.8, strokeSpeed: 2, vibeMax: 0.5 })
  t.setHeroMusicRule(11, { ...defaultHeroMusicRule(), match: undefined, estimMaxRelative: null, strokeSpeed: null, vibeMax: null })
  expect(useTracking.getState().heroMusic.rules[11]).toEqual(defaultHeroMusicRule())
  expect(native.setHeroMusic).toHaveBeenLastCalledWith(true, [expect.objectContaining({ bucket: 11, colour: undefined, tolerance: undefined, estimMaxRelative: undefined, strokeSpeed: undefined, vibeMax: undefined })])
})

it('starts game tracking without video settings and permits Beat row adjustments', async () => {
  const axes = defaultTrackAxes()
  axes.L0.source = 'beat'
  await useTracking.getState().start('game', { axes })
  expect(useTracking.getState().key).toBeNull()
  expect(native.trackStart).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), false)
  useTracking.getState().setAxis('L0', { intensity: 0.7 })
  expect(useTracking.getState().axes.L0).toMatchObject({ source: 'beat', intensity: 0.7 })
  expect(native.setTrackAxes).toHaveBeenLastCalledWith([expect.objectContaining({ axis: 'L0', source: 'beat', intensity: 0.7 })])
  for (const source of ['hero', 'ai-music', 'faptap'] as const) {
    useTracking.getState().setAxis('L0', { source })
    expect(useTracking.getState().axes.L0.source).toBe('beat')
  }
  expect(usePlayer.getState().setTracking).not.toHaveBeenCalled()
})
