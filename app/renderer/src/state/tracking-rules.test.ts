import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScriptInfo } from 'bp-engine'
import type { MediaDetail, MediaRow } from '@shared/library'
import { defaultSettings, type PerVideoSettings } from '@shared/settings'
import { defaultHeroMusic, defaultTrackAxes, defaultTrackingDefaults, defaultZoneEffects, heroFileText, newZone, TRACK_AXIS_IDS, type TrackAxesConfig, type TrackAxisId, type TrackingDefaults, type TrackingSettings, type TrackSource } from '@shared/tracking'

const native = vi.hoisted(() => ({
  setHeroMusic: vi.fn(), setHeroOptions: vi.fn(), setHeroColour: vi.fn(), clearHeroAxisColours: vi.fn(), setRate: vi.fn(),
  setTrackAxes: vi.fn(), trackStop: vi.fn(), setBeatOptions: vi.fn(), trackStart: vi.fn(), setTrackOptions: vi.fn(),
  setTrackRegionSource: vi.fn(), trackState: vi.fn(() => ({ state: 'idle' })), setZones: vi.fn(), setModel: vi.fn(),
  setDetector: vi.fn(), setDetectOptions: vi.fn(), modelState: vi.fn(() => ({ status: 'none' })), beatState: vi.fn(() => ({ status: 'ready' })),
}))
const writes = vi.hoisted(() => vi.fn())
const sidecar = vi.hoisted(() => ({ file: null as { text: string; stamp: string } | null }))
vi.mock('@/engine/client', () => ({ engine: native, models: () => [] }))
vi.mock('@/ipc', () => ({ invoke: vi.fn(async (channel: string) => (channel === 'hero:sidecar' ? sidecar.file : channel === 'models:catalog' ? [] : null)), on: vi.fn() }))
vi.mock('./audio', () => ({ releaseAudio: vi.fn(), ensureFullAudio: vi.fn(async () => {}), ensureAudio: vi.fn(async () => {}) }))
vi.mock('@/screens/browser/StartPage', () => ({ siteName: vi.fn(() => '') }))
vi.mock('./browser', () => ({ useBrowser: { subscribe: vi.fn(), getState: () => ({ tabs: [], capture: vi.fn(), setRegion: vi.fn(), setZone: vi.fn() }) }, feedColour: vi.fn(), subscribeFrames: vi.fn() }))
vi.mock('./params', () => ({ pushParams: vi.fn() }))
vi.mock('./settings', async () => {
  const { create } = await import('zustand')
  const { defaultTrackingDefaults } = await import('@shared/tracking')
  type Doc = { tracking: TrackingDefaults }
  const useSettings = create<{ settings: Doc; update: (change: (s: Doc) => Doc) => Promise<void>; load: () => Promise<void> }>()((set, get) => ({
    settings: { tracking: defaultTrackingDefaults() },
    update: async (change) => set({ settings: change(get().settings) }),
    load: async () => {},
  }))
  return { useSettings }
})
vi.mock('./player', async () => {
  const { create } = await import('zustand')
  const { hasOverrides, withoutOverrides } = await import('@shared/trackingRules')
  interface Player {
    path: string | null
    title: string
    scripts: { axis: string; selected: boolean }[]
    media: Pick<MediaDetail, 'title' | 'tags' | 'folder'> | null
    video: PerVideoSettings
    snapshot: { rate: number }
    setTracking: (tracking: TrackingSettings | undefined) => void
    dropOverrides: () => void
  }
  const usePlayer = create<Player>()((set, get) => ({
    path: null,
    title: '',
    scripts: [],
    media: null,
    video: { globalOffsetMs: 0, axes: {} },
    snapshot: { rate: 1 },
    setTracking: (tracking) => {
      writes(tracking)
      set((s) => {
        const { tracking: _old, ...rest } = s.video
        return { video: tracking ? { ...rest, tracking } : rest }
      })
    },
    dropOverrides: () => {
      const { tracking } = get().video
      if (tracking && hasOverrides(tracking)) get().setTracking(withoutOverrides(tracking))
    },
  }))
  return { usePlayer }
})

import { invoke } from '@/ipc'
import { usePlayer } from './player'
import { useSettings } from './settings'
import { afterOverridesReset, needsFrames, useTracking } from './tracking'

let n = 0
async function open({ title = 'Clip', scripts = [] as TrackAxisId[], tracking, media }: { title?: string; scripts?: TrackAxisId[]; tracking?: TrackingSettings; media?: Pick<MediaDetail, 'title' | 'tags' | 'folder'> } = {}) {
  useTracking.getState().stop()
  usePlayer.setState({
    path: `/videos/${++n}.mp4`,
    title,
    scripts: scripts.map((axis) => ({ axis, selected: true }) as ScriptInfo),
    media: media ? (media as MediaDetail) : null,
    video: { globalOffsetMs: 0, axes: {}, ...(tracking ? { tracking } : {}) },
  })
  await useTracking.getState().autoStart()
}
const sources = () => Object.fromEntries(TRACK_AXIS_IDS.map((id) => [id, useTracking.getState().axes[id].source]))
const saved = () => usePlayer.getState().video.tracking
const rules = (patch: Partial<TrackingDefaults>) => useSettings.getState().update((s) => ({ ...s, tracking: { ...s.tracking, ...patch } }))
const filled = (source: TrackSource) => ({ L0: source, L1: source, L2: source, R1: source, R2: source, R0: 'off' })

beforeEach(() => {
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.useFakeTimers()
  useSettings.setState({ settings: defaultSettings() })
  useTracking.setState({ hold: false })
  sidecar.file = null
  vi.clearAllMocks()
})
afterEach(() => {
  useTracking.getState().stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('opening a video', () => {
  it('starts nothing beside a stroke-only script on an SR6 set of axes', async () => {
    await open({ scripts: ['L0'] })
    expect(native.trackStart).not.toHaveBeenCalled()
    expect(useTracking.getState().source).toBeNull()
    expect(useTracking.getState().resolved?.start).toBe(false)
    expect(writes).not.toHaveBeenCalled()
  })

  it('starts AI Motion on an unscripted video and writes nothing', async () => {
    await open()
    expect(native.trackStart).toHaveBeenCalledOnce()
    expect(sources()).toEqual(filled('ai-motion'))
    expect(useTracking.getState().saved).toBe(false)
    expect(writes).not.toHaveBeenCalled()
  })

  it('starts AI CH/PMV on a PMV title and names why', async () => {
    await open({ title: 'Neon Nights PMV_Mix' })
    expect(sources()).toEqual(filled('ai-music'))
    expect(useTracking.getState().musicSignal).toEqual({ kind: 'title', text: 'PMV' })
    expect(useTracking.getState().resolved?.musicChanged).toBe(true)
    await open({ title: 'Beach day', media: { title: 'Beach day', tags: ['PMV'], folder: '' } })
    expect(useTracking.getState().musicSignal).toEqual({ kind: 'tag', text: 'PMV' })
  })

  it('leaves BEACH on AI Motion', async () => {
    await open({ title: 'BEACH day' })
    expect(sources()).toEqual(filled('ai-motion'))
    expect(useTracking.getState().musicSignal).toBeNull()
    expect(useTracking.getState().resolved?.musicChanged).toBe(false)
  })

  it('holds a session clip until the crosshair is pressed, and remembers nothing for it', async () => {
    useTracking.getState().setHold(true)
    await open({ scripts: ['L0'] })
    expect(native.trackStart).not.toHaveBeenCalled()
    await useTracking.getState().pressCrosshair()
    expect(useTracking.getState().source).toBe('player')
    await useTracking.getState().pressCrosshair()
    expect(useTracking.getState().source).toBeNull()
    expect(useTracking.getState().toast).toBeNull()
    expect(writes).not.toHaveBeenCalled()
  })

  it('follows a rule change in Settings live', async () => {
    await open({ scripts: ['L0'] })
    await rules({ fillScripted: true })
    expect(useTracking.getState().source).toBe('player')
    expect(sources()).toEqual({ ...filled('ai-motion'), L0: 'off' })
  })
})

describe('the crosshair', () => {
  it('remembers a Stop the rules went against, offers All videos, and forgets it on Start', async () => {
    await open()
    await useTracking.getState().pressCrosshair()
    expect(native.trackStop).toHaveBeenCalled()
    expect(saved()?.on).toBe(false)
    expect(useTracking.getState().toast?.kind).toBe('off')
    native.trackStart.mockClear()
    useTracking.getState().stop()
    await useTracking.getState().autoStart()
    expect(native.trackStart).not.toHaveBeenCalled()
    await useTracking.getState().pressCrosshair()
    expect(useTracking.getState().source).toBe('player')
    expect(saved()?.on).toBeUndefined()
    expect(useTracking.getState().toast).toBeNull()
  })

  it('remembers a Start on a scripted video, offers All videos, and forgets it on Stop without a toast', async () => {
    await open({ scripts: ['L0'] })
    await useTracking.getState().pressCrosshair()
    expect(sources()).toEqual({ ...filled('ai-motion'), L0: 'off' })
    expect(saved()?.on).toBe(true)
    expect(useTracking.getState().toast?.kind).toBe('on')
    await useTracking.getState().pressCrosshair()
    expect(useTracking.getState().source).toBeNull()
    expect(saved()?.on).toBeUndefined()
    expect(useTracking.getState().toast).toBeNull()
  })

  it('makes a Stop the rule for all videos, and Undo puts the rule and the memory back', async () => {
    await open()
    await useTracking.getState().pressCrosshair()
    await useTracking.getState().allVideos()
    expect(useSettings.getState().settings?.tracking.fill).toBe('off')
    expect(useTracking.getState().toast?.kind).toBe('changed')
    expect(saved()?.on).toBeUndefined()
    native.trackStart.mockClear()
    await useTracking.getState().undoAllVideos()
    expect(useSettings.getState().settings?.tracking.fill).toBe('ai-motion')
    expect(saved()?.on).toBe(false)
    expect(useTracking.getState().source).toBeNull()
    expect(native.trackStart).not.toHaveBeenCalled()
  })

  it('keeps a press made while the video loaded, once its scripts are in', async () => {
    useTracking.getState().stop()
    usePlayer.setState({ path: `/videos/${++n}.mp4`, title: 'Clip', scripts: [], media: null, video: { globalOffsetMs: 0, axes: {} } })
    await useTracking.getState().pressCrosshair()
    usePlayer.setState({ scripts: [{ axis: 'L0', selected: true } as ScriptInfo] })
    await useTracking.getState().autoStart()
    expect(useTracking.getState().source).toBe('player')
    expect(sources()).toEqual({ ...filled('ai-motion'), L0: 'off' })
    expect(saved()?.on).toBe(true)
    expect(useTracking.getState().toast?.kind).toBe('on')
  })

  it('runs a hand-off from a page as a press: AI Motion with the fill off, and nothing remembered', async () => {
    await rules({ fill: 'off' })
    useTracking.getState().stop()
    usePlayer.setState({ path: 'https://example.com/watch', title: 'Watch', scripts: [], media: null, video: { globalOffsetMs: 0, axes: {} } })
    await useTracking.getState().start('player')
    expect(sources()).toEqual(filled('ai-motion'))
    expect(useTracking.getState().toast).toBeNull()
    expect(writes).not.toHaveBeenCalled()
  })

  it('makes a Start on a scripted video fill empty axes everywhere', async () => {
    await open({ scripts: ['L0'] })
    await useTracking.getState().pressCrosshair()
    await useTracking.getState().allVideos()
    expect(useSettings.getState().settings?.tracking.fillScripted).toBe(true)
    expect(saved()?.on).toBeUndefined()
    expect(useTracking.getState().source).toBe('player')
  })
})

describe('per-video memory', () => {
  const legacy = (axes: TrackAxesConfig): TrackingSettings => ({ axes, sensitivity: 1, region: null, regionSource: 'centre', beatTempoFactor: 1, pace: defaultTrackingDefaults().defaultPace, heroZone: null, heroDirection: 'auto', heroColours: {}, heroAxisColours: {} })
  const motion = () => Object.fromEntries(TRACK_AXIS_IDS.map((id) => [id, { ...defaultTrackAxes()[id], source: id === 'R0' ? 'off' : 'ai-motion' }])) as TrackAxesConfig

  it('converts an old table in memory, and writes picks only on the first edit', async () => {
    await open({ tracking: legacy(motion()) })
    expect(writes).not.toHaveBeenCalled()
    expect(useTracking.getState().saved).toBe(false)
    useTracking.getState().setAxis('L0', { source: 'beat' })
    expect(saved()).toMatchObject({ own: { L0: { source: 'beat' } }, axes: { L0: { source: 'beat' } } })
    expect(useTracking.getState().resolved?.picked).toEqual(['L0'])
    expect(useTracking.getState().saved).toBe(true)
    useTracking.getState().setAxis('L2', { intensity: defaultTrackAxes().L2.intensity })
    useTracking.getState().releaseAxis('L0')
    expect(saved()?.own).toEqual({})
    expect(useTracking.getState().axes.L0.source).toBe('ai-motion')
  })

  it('keeps a deliberate pick from an old table', async () => {
    await open({ tracking: legacy({ ...motion(), L0: { ...motion().L0, source: 'beat' } }) })
    expect(useTracking.getState().axes.L0.source).toBe('beat')
    expect(useTracking.getState().resolved?.picked).toEqual(['L0'])
  })

  it('writes a Hero setup file at open without picks, keeping a table for older builds', async () => {
    sidecar.file = { text: heroFileText({ heroZone: { x: 0.1, y: 0.4, w: 0.08, h: 0.2 } }), stamp: 's1' }
    const old = legacy({ ...motion(), L0: { ...motion().L0, source: 'beat' } })
    await open({ tracking: old })
    expect(writes).toHaveBeenCalledOnce()
    expect(saved()).toMatchObject({ axes: old.axes, heroZone: { x: 0.1 }, heroFileStamp: 's1' })
    expect(saved()).not.toHaveProperty('own')
    expect(useTracking.getState().axes.L0.source).toBe('beat')
    writes.mockClear()
    await open()
    expect(writes).toHaveBeenCalledOnce()
    expect(saved()).toMatchObject({ own: {}, heroFileStamp: 's1' })
    expect(Object.fromEntries(TRACK_AXIS_IDS.map((id) => [id, saved()?.axes?.[id].source]))).toEqual(filled('ai-music'))
  })

  it('marks a video as not music and follows the rule for other videos at once', async () => {
    await open({ title: 'Cock Hero 4' })
    useTracking.getState().setNotMusic()
    expect(sources()).toEqual(filled('ai-motion'))
    expect(saved()).toMatchObject({ notMusic: true, own: {} })
    expect(useTracking.getState().resolved?.musicChanged).toBe(false)
  })

  it('resets to the rules: the record goes and the table follows live', async () => {
    await open({ tracking: { region: null, own: { L0: { source: 'beat' } }, pace: 0.8 } })
    expect(useTracking.getState().saved).toBe(true)
    useTracking.getState().reset()
    expect(saved()).toBeUndefined()
    expect(useTracking.getState().axes.L0.source).toBe('ai-motion')
    expect(useTracking.getState().pace).toBe(defaultTrackingDefaults().defaultPace)
    expect(useTracking.getState().saved).toBe(false)
  })

  it('drops overrides from the open copy after Reset all overrides, keeping the rest', async () => {
    await open({ title: 'PMV', tracking: { region: null, own: { L0: { source: 'beat' } }, notMusic: true, sensitivity: 1.4, pace: 0.8 } })
    afterOverridesReset()
    expect(saved()).toMatchObject({ own: {}, pace: 0.8 })
    expect(saved()).not.toHaveProperty('notMusic')
    expect(saved()).not.toHaveProperty('sensitivity')
    expect(sources()).toEqual(filled('ai-music'))
    expect(useTracking.getState().sensitivity).toBe(defaultTrackingDefaults().sensitivity)
    writes.mockClear()
    afterOverridesReset()
    expect(writes).not.toHaveBeenCalled()
    const withSource = { ...defaultSettings(), remote: { ...defaultSettings().remote, source: 'http://192.168.1.5:8787' } }
    useSettings.setState({ settings: withSource })
    await open({ tracking: { region: null, own: { L0: { source: 'beat' } } } })
    writes.mockClear()
    afterOverridesReset()
    expect(writes).not.toHaveBeenCalled()
    expect(useTracking.getState().axes.L0.source).toBe('beat')
  })
})

describe('a followed Quest video', () => {
  const media = { path: 'C:/videos/quest.mp4', title: 'Clip', tags: [], folder: '' } as Pick<MediaRow, 'path' | 'title' | 'tags' | 'folder'> as MediaRow

  it('tracks by the rules ahead of the clock, and the Quest switch stops it as the crosshair does', async () => {
    await useTracking.getState().followHeadset({ media, scripted: [] })
    expect(useTracking.getState()).toMatchObject({ source: 'headset', key: media.path })
    expect(native.trackStart).toHaveBeenCalledWith(expect.anything(), expect.anything(), true)
    expect(sources()).toEqual(filled('ai-motion'))
    useTracking.getState().switchHeadset(false)
    expect(useTracking.getState().source).toBeNull()
    await useTracking.getState().flushSave()
    expect(invoke).toHaveBeenCalledWith('video:set', media.path, expect.objectContaining({ tracking: expect.objectContaining({ on: false }) }))
  })

  it('waits beside a full set of scripts for the switch, and stops when the follow moves on', async () => {
    await useTracking.getState().followHeadset({ media, scripted: ['L0', 'L1', 'L2', 'R1', 'R2'] })
    expect(native.trackStart).not.toHaveBeenCalled()
    useTracking.getState().switchHeadset(true)
    expect(useTracking.getState().source).toBe('headset')
    expect(sources()).toEqual({ ...filled('off'), L0: 'ai-motion' })
    await useTracking.getState().followHeadset(null)
    expect(useTracking.getState().source).toBeNull()
  })
})

it('reads frames only for an axis that follows the picture, Hero colours or zones', () => {
  const table = (source: TrackSource) => Object.fromEntries(TRACK_AXIS_IDS.map((id) => [id, { ...defaultTrackAxes()[id], source }])) as TrackAxesConfig
  const at = (source: TrackSource, heroMusic = defaultHeroMusic(), zones = defaultZoneEffects()) => needsFrames({ axes: table(source), heroMusic, zones })
  expect(at('beat')).toBe(false)
  expect(at('ai-music')).toBe(false)
  expect(at('off')).toBe(false)
  expect(at('ai-motion')).toBe(true)
  expect(at('video')).toBe(true)
  expect(at('ai-music', { ...defaultHeroMusic(), enabled: true })).toBe(true)
  expect(at('beat', defaultHeroMusic(), { enabled: true, zones: [newZone({ x: 0, y: 0, w: 0.2, h: 0.2 })] })).toBe(true)
})
