import { create } from 'zustand'
import type { BeatState, HeroState, ModelState, TrackAxis, TrackOptions, TrackState, ZoneMatch, ZoneRule } from 'bp-engine'
import { CAPTURE_WIDTH, type Region, type RegionBox } from '@shared/browser'
import type { PerVideoSettings } from '@shared/settings'
import {
  CUT_THRESHOLD,
  entitledMusicModel,
  isSupporterModel,
  MODEL_KINDS,
  FAPTAP_HOST,
  PLAYER_ONLY_SOURCES,
  BROWSER_STROKE_SOURCES,
  TRACK_AXIS_IDS,
  defaultTrackingDefaults,
  looksLikeMusicVideo,
  type ModelInfo,
  type ModelKind,
  type RegionSourceKind,
  type RegionTarget,
  type HeroColourRule,
  type HeroMusicSettings,
  type HeroMusicRule,
  defaultHeroMusic,
  defaultHeroMusicRule,
  normalizeHeroMusic,
  type HeroColourRules,
  type HeroDirection,
  type HeroFlourish,
  type EffectZone,
  type ZoneEffects,
  defaultZoneEffects,
  newZone,
  normalizeZoneEffects,
  heroFileText,
  parseHeroFile,
  type TrackAxesConfig,
  type TrackAxisConfig,
  type TrackAxisId,
  type TrackSource as AxisSource,
  type TrackingDefaults,
  type TrackingSettings,
} from '@shared/tracking'
import { engine, models } from '@/engine/client'
import { invoke } from '@/ipc'
import { t } from '@/state/i18n'
import { ensureAudio, ensureFullAudio, releaseAudio } from './audio'
import { isPremium, useAccount } from './account'
import { siteName } from '@/screens/browser/StartPage'
import { feedColour, subscribeFrames, useBrowser } from './browser'
import { usePlayer } from './player'
import { pushParams } from './params'
import { useSettings } from './settings'

export type TrackSource = 'browser' | 'player' | 'game'

export interface GameStart {
  axes: TrackAxesConfig
}

interface TrackingStore {
  source: TrackSource | null
  key: string | null
  state: TrackState | null
  sensitivity: number
  axes: TrackAxesConfig
  regionSource: RegionSourceKind
  regionTarget: RegionTarget | null
  region: Region | null
  regionShown: boolean
  beat: BeatState | null
  beatError: string | null
  beatTempoFactor: number
  pace: number
  motion: ModelState | null
  music: ModelState | null
  present: Record<ModelKind, boolean>
  heroMusic: HeroMusicSettings
  setHeroMusicEnabled: (enabled: boolean) => void
  setHeroMusicRule: (bucket: number, patch: Partial<HeroMusicRule> | null) => void
  setBasePlaybackRate: (rate: number) => void
  playbackBaseRate: number | null
  heroZone: Region | null
  heroDirection: HeroDirection
  heroColours: HeroColourRules
  heroAxisColours: Partial<Record<TrackAxisId, HeroColourRules>>
  hero: HeroState | null
  zones: ZoneEffects
  zoneMatches: ZoneMatch[]
  heroFileStamp?: string
  zonesShown: boolean
  setZonesEnabled: (enabled: boolean) => void
  addZone: () => string
  updateZone: (id: string, patch: Partial<Omit<EffectZone, 'id'>>) => void
  removeZone: (id: string) => void
  showZones: (on: boolean) => void
  zoneEdit: boolean
  heroTip: boolean
  start: (source: TrackSource, game?: GameStart) => Promise<void>
  autoStart: () => Promise<void>
  stop: () => void
  flushSave: () => Promise<void>
  setSensitivity: (s: number) => void
  setAxis: (id: TrackAxisId, patch: Partial<TrackAxisConfig>) => void
  setBeatTempoFactor: (factor: number) => void
  setPace: (pace: number) => void
  setBeatVolumeDepth: (on: boolean) => void
  setHeroZone: (zone: Region | null) => void
  pickHeroZone: () => void
  setZoneEdit: (on: boolean) => void
  dismissHeroTip: () => void
  exportHero: () => Promise<void>
  importHero: () => Promise<boolean>
  setHeroDirection: (direction: HeroDirection) => void
  setHeroColour: (axis: TrackAxisId | null, bucket: number, patch: Partial<HeroColourRule>) => void
  resetHeroAxis: (axis: TrackAxisId) => void
  setRegionSource: (kind: RegionSourceKind) => void
  setRegionTarget: (target: RegionTarget | null) => void
  setRegion: (region: Region) => void
  setAsDefault: () => Promise<void>
  reset: () => void
  refreshModels: () => Promise<void>
  unloadMusic: () => void
  update: (state: TrackState) => void
}

const DEFAULT_REGION: Region = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
const FULL_REGION: Region = { x: 0, y: 0, w: 1, h: 1 }
export const REGION_SHOW_MS = 4000
function pickTrackAxes(saved: TrackingSettings['heroAxisColours']): Partial<Record<TrackAxisId, HeroColourRules>> {
  const out: Partial<Record<TrackAxisId, HeroColourRules>> = {}
  for (const id of TRACK_AXIS_IDS) if (saved?.[id]) out[id] = saved[id]
  return out
}

const DEFAULT_ZONE: Region = { x: 0.12, y: 0.38, w: 0.1, h: 0.24 }
const EMPTY_VIDEO: PerVideoSettings = { globalOffsetMs: 0, axes: {} }
const CUT_EVERY_MS = 100
const HERO_EVERY_MS = 1000 / 30
const PACE_PUSH_MS = 250

function freshAxes(defaults: TrackAxesConfig, scripted: ReadonlySet<string>, faptap: boolean, music: boolean, hero: boolean, motion: boolean): TrackAxesConfig {
  const pick = (id: string, a: TrackAxisConfig): AxisSource => {
    if (scripted.has(id) || a.source === 'off') return 'off'
    if (faptap && id === 'L0') return 'faptap'
    if (music) return 'ai-music'
    if (hero) return id === 'L0' ? 'hero' : 'video'
    if (a.source === 'video' || a.source === 'ai-motion') return motion ? 'ai-motion' : 'video'
    return a.source
  }
  return Object.fromEntries(Object.entries(defaults).map(([id, a]) => [id, { ...a, source: pick(id, a) }])) as TrackAxesConfig
}

const GAME_FOREIGN_SOURCES: readonly AxisSource[] = ['faptap', 'hero', 'ai-music']

function usableOn(source: TrackSource, axes: TrackAxesConfig): TrackAxesConfig {
  const foreign = source === 'player' ? BROWSER_STROKE_SOURCES : source === 'game' ? GAME_FOREIGN_SOURCES : PLAYER_ONLY_SOURCES
  return Object.fromEntries(Object.entries(axes).map(([id, a]) => [id, foreign.includes(a.source) ? { ...a, source: 'video' } : a])) as TrackAxesConfig
}

const rows = (axes: TrackAxesConfig): TrackAxis[] => TRACK_AXIS_IDS.map((id) => ({ axis: id, ...axes[id] }))

function options(d: TrackingDefaults, sensitivity: number, pace: number): TrackOptions {
  return { sensitivity, pace, cutThreshold: CUT_THRESHOLD[d.cutSensitivity], easeMs: d.easeMs, flourishes: d.flourishes, clampJumps: d.clampJumps }
}

function sameModel(a: ModelState | null, b: ModelState): boolean {
  return a !== null && a.status === b.status && a.error === b.error && a.provider === b.provider && a.tooSlow === b.tooSlow && Math.round(a.runMs * 10) === Math.round(b.runMs * 10)
}

function sameShown(a: TrackState, b: TrackState): boolean {
  return (
    a.state === b.state &&
    Math.round(a.position * 100) === Math.round(b.position * 100) &&
    a.region?.x === b.region?.x &&
    a.region?.y === b.region?.y &&
    a.region?.w === b.region?.w &&
    a.region?.h === b.region?.h &&
    a.detector.status === b.detector.status &&
    a.detector.error === b.detector.error &&
    a.detector.provider === b.detector.provider &&
    a.detector.found?.class === b.detector.found?.class &&
    sameModel(a.model, b.model) &&
    Math.round(a.fps) === Math.round(b.fps) &&
    (a.frames === 0) === (b.frames === 0) &&
    Math.round((a.aheadMs ?? -1000) / 1000) === Math.round((b.aheadMs ?? -1000) / 1000)
  )
}

export function trackingSettings(s: Pick<TrackingStore, 'axes' | 'sensitivity' | 'region' | 'regionSource' | 'regionTarget' | 'beatTempoFactor' | 'pace' | 'heroZone' | 'heroDirection' | 'heroColours' | 'heroAxisColours' | 'heroMusic' | 'zones' | 'heroFileStamp'>): TrackingSettings {
  const { axes, sensitivity, region, regionSource, regionTarget, beatTempoFactor, pace, heroZone, heroDirection, heroColours, heroAxisColours, heroMusic, zones, heroFileStamp } = s
  return {
    axes,
    sensitivity,
    region,
    regionSource,
    ...(regionTarget ? { regionTarget } : {}),
    beatTempoFactor,
    pace,
    heroZone,
    heroDirection,
    heroColours,
    heroAxisColours,
    ...(heroMusic.enabled || Object.keys(heroMusic.rules).length ? { heroMusic } : {}),
    ...(zones.enabled || zones.zones.length ? { zones } : {}),
    ...(heroFileStamp ? { heroFileStamp } : {}),
  }
}

function zoneRule(z: EffectZone): ZoneRule {
  const { trigger, effect } = z
  return {
    id: z.id,
    region: z.region,
    trigger: trigger.kind,
    buckets: trigger.kind === 'colour' ? trigger.buckets : [],
    part: trigger.kind === 'part' ? trigger.target : undefined,
    colourMatches: trigger.kind === 'colour' ? trigger.buckets.flatMap((bucket) => {
      const match = trigger.matches?.[bucket]
      return match ? [{ bucket, ...match }] : []
    }) : undefined,
    cover: z.cover,
    holdMs: z.holdMs,
    tempo: effect.tempo,
    intensity: effect.intensity,
    playbackSpeed: effect.playbackSpeed,
    strokeSpeed: effect.strokeSpeed ?? undefined,
    estimMax: effect.estimMax ?? undefined,
    estimMaxRelative: effect.estimMaxRelative ?? undefined,
    vibeMax: effect.vibeMax ?? undefined,
  }
}

function sameMatches(a: ZoneMatch[], b: ZoneMatch[]): boolean {
  return a.length === b.length && a.every((m, i) => m.id === b[i]?.id && m.active === b[i]?.active && m.leading === b[i]?.leading && Math.round(m.share * 100) === Math.round((b[i]?.share ?? 0) * 100))
}

export function targetLabel(cls: string | undefined): string | null {
  if (!cls) return null
  const covered = (label: string) => (cls.endsWith('COVERED') ? t('tracking.target.covered', { label }) : label)
  if (cls.includes('GENITALIA') || cls.startsWith('ANUS')) return covered(t('tracking.target.genitals'))
  if (cls.includes('BREAST')) return covered(t('tracking.target.breasts'))
  if (cls.startsWith('BUTTOCKS')) return covered(t('tracking.target.buttocks'))
  if (cls.includes('FACE')) return t('tracking.target.face')
  if (cls === 'FEET_EXPOSED') return t('tracking.target.feet')
  return null
}

export const useTracking = create<TrackingStore>()((set, get) => {
  let unsubscribe: (() => void) | null = null
  let persistTimer = 0
  let pendingSave: (() => void) | null = null
  let saving: Promise<unknown> = Promise.resolve()
  let playbackMultiplier = 1
  const applyPlaybackSpeed = (multiplier: number) => {
    if (multiplier === playbackMultiplier) return
    const base = get().playbackBaseRate ?? usePlayer.getState().snapshot.rate
    set({ playbackBaseRate: base })
    engine.setRate(base * multiplier)
    playbackMultiplier = multiplier
  }
  const loaded: Record<ModelKind, string | null> = { detector: null, motion: null, music: null }
  let modelsDir: string | null = null
  let lastBox = ''
  let showTimer = 0
  let paceTimer = 0

  const current = () => trackingSettings(get())
  const anyBeat = () => Object.values(get().axes).some((a) => a.source === 'beat' || a.source === 'ai-music')
  const anyMusic = () => Object.values(get().axes).some((a) => a.source === 'ai-music')
  const anyHero = () => Object.values(get().axes).some((a) => a.source === 'hero') || (get().heroMusic.enabled && anyMusic())
  const effectsOn = () => (get().heroMusic.enabled && anyMusic()) || (get().zones.enabled && get().zones.zones.length > 0)
  const colourEveryMs = (): number | null => {
    if (anyHero()) return HERO_EVERY_MS
    if (engine.wantsCuts()) return CUT_EVERY_MS
    if (get().regionSource === 'auto' || engine.wantsFrames()) return defaults().detectEveryMs
    return null
  }
  const pushHero = () => {
    const { heroZone, heroDirection, heroColours, heroAxisColours, source } = get()
    engine.setHeroOptions(heroZone, heroDirection)
    pushHeroMusic()
    for (const [bucket, rule] of Object.entries(heroColours)) engine.setHeroColour(null, Number(bucket), rule)
    for (const [axis, rules] of Object.entries(heroAxisColours)) {
      for (const [bucket, rule] of Object.entries(rules)) engine.setHeroColour(axis, Number(bucket), rule)
    }
    if (source === 'browser') void useBrowser.getState().setZone(anyHero() ? heroZone : null)
  }
  const pushHeroMusic = () => {
    const { heroMusic } = get()
    engine.setHeroMusic(heroMusic.enabled && anyMusic(), Object.entries(heroMusic.rules).map(([bucket, rule]) => ({ bucket: Number(bucket), ...rule, colour: rule.match?.colour, tolerance: rule.match?.tolerance, estimMaxRelative: rule.estimMaxRelative ?? undefined, estimMax: rule.estimMax ?? undefined, strokeSpeed: rule.strokeSpeed ?? undefined, vibeMax: rule.vibeMax ?? undefined })))
    if (!effectsOn()) applyPlaybackSpeed(1)
  }
  const pushZones = () => {
    const { zones, source } = get()
    const on = source === 'player' && zones.enabled
    engine.setZones(on, on ? zones.zones.map(zoneRule) : [])
    if (!effectsOn()) applyPlaybackSpeed(1)
  }
  const editZones = (change: (zones: EffectZone[]) => EffectZone[]) => {
    const { zones } = get()
    set({ zones: { ...zones, zones: change(zones.zones) } })
    pushZones()
    persist()
  }
  const pushBeatOptions = () => {
    const d = defaults()
    engine.setBeatOptions({ style: 'strokes', volumeDepth: d.beatVolumeDepth, bounce: d.beatBounce, bounceDepth: d.beatBounceDepth, bounceSpeed: d.beatBounceSpeed, tempoFactor: get().beatTempoFactor })
  }
  const ensureBeat = async () => {
    const { source, key } = get()
    if (source !== 'player' || !key || !anyBeat()) {
      releaseAudio()
      return
    }
    set({ beatError: null })
    try {
      await ensureAudio(key)
      if (get().key === key && anyMusic()) await ensureFullAudio(key)
      if (get().key === key) set({ beat: engine.beatState() })
    } catch (e) {
      if (get().key === key) set({ beatError: e instanceof Error ? e.message : String(e) })
    }
  }
  const persist = () => {
    window.clearTimeout(persistTimer)
    const { key, source } = get()
    if (!key) return
    const tracking = current()
    if (source === 'player' && usePlayer.getState().path === key) {
      usePlayer.getState().setTracking(tracking)
      return
    }
    pendingSave = () => {
      pendingSave = null
      saving = saving.catch(() => {}).then(() => invoke('video:get', key)).then((existing) => invoke('video:set', key, { ...(existing ?? EMPTY_VIDEO), tracking }))
      void saving.catch((error: unknown) => console.warn('save browser tracking', error))
    }
    persistTimer = window.setTimeout(() => pendingSave?.(), 300)
  }
  const defaults = () => useSettings.getState().settings?.tracking ?? defaultTrackingDefaults()
  const pushOptions = () => {
    engine.setTrackOptions(options(defaults(), get().sensitivity, get().pace))
  }
  const pullModels = () => {
    const motion = engine.modelState('motion')
    const music = engine.modelState('music')
    const { motion: m, music: u } = get()
    if (!sameModel(m, motion) || !sameModel(u, music)) set({ motion, music })
  }
  const pushPageBox = () => {
    const { regionSource, region, regionShown, source } = get()
    if (source !== 'browser') return
    const box: RegionBox | null = regionSource === 'pick' && region && regionShown ? { region, auto: false, label: null } : null
    lastBox = ''
    void useBrowser.getState().setRegion(box)
  }
  const pushRegion = () => {
    const { regionSource, regionTarget, region } = get()
    engine.setTrackRegionSource(regionSource, regionSource === 'pick' ? region : null, regionTarget)
    pushPageBox()
  }
  const showRegion = () => {
    window.clearTimeout(showTimer)
    set({ regionShown: true })
    showTimer = window.setTimeout(() => {
      set({ regionShown: false })
      pushPageBox()
    }, REGION_SHOW_MS)
  }

  return {
    source: null,
    key: null,
    state: null,
    sensitivity: 1,
    axes: defaultTrackingDefaults().axes,
    regionSource: 'centre',
    regionTarget: null,
    region: null,
    regionShown: false,
    beat: null,
    beatError: null,
    beatTempoFactor: 1,
    pace: defaultTrackingDefaults().defaultPace,
    motion: null,
    music: null,
    present: { detector: false, motion: false, music: false },
    playbackBaseRate: null,
    heroMusic: defaultHeroMusic(),
    heroZone: null,
    heroDirection: 'auto',
    heroColours: {},
    heroAxisColours: {},
    hero: null,
    zones: defaultZoneEffects(),
    zoneMatches: [],
    zonesShown: false,
    zoneEdit: false,
    heroTip: false,
    autoStart: async () => {
      const player = usePlayer.getState()
      const scripted = new Set(player.scripts.map((s) => s.axis))
      const defaults = useSettings.getState().settings?.tracking.axes
      const wants = player.video.tracking !== undefined || TRACK_AXIS_IDS.some((id) => !scripted.has(id) && defaults?.[id]?.source !== 'off')
      if (wants) await get().start('player')
      else get().stop()
    },
    start: async (source, game) => {
      get().stop()
      const settingsStore = useSettings.getState()
      const settings = settingsStore.settings ?? (await settingsStore.load())
      const tab = useBrowser.getState().tabs.find((t) => t.active)
      const key = source === 'player' ? usePlayer.getState().path : source === 'browser' ? (tab?.url ?? null) : null
      const saved = source === 'player' ? usePlayer.getState().video.tracking : key ? (await invoke('video:get', key))?.tracking : undefined
      const player = usePlayer.getState()
      const title = source === 'player' ? player.title : source === 'browser' ? (tab?.title ?? '') : ''
      const scripted = new Set(source === 'player' ? player.scripts.map((s) => s.axis) : [])
      const model = (kind: ModelKind) => get().present[kind] && Boolean(settings.tracking.models[kind])
      const musicVideo = !saved && looksLikeMusicVideo(title)
      const autoMusic = musicVideo && source === 'player' && model('music')
      const autoHero = musicVideo && !autoMusic && !scripted.has('L0')
      const motionDefault = settings.tracking.motionDefault && model('motion')
      const faptapPage = source === 'browser' && siteName(tab?.url ?? '') === FAPTAP_HOST
      const axes = game?.axes ?? saved?.axes ?? freshAxes(settings.tracking.axes, scripted, faptapPage, autoMusic, autoHero, motionDefault)
      const sensitivity = saved?.sensitivity ?? settings.tracking.sensitivity
      const pace = saved?.pace ?? settings.tracking.defaultPace
      const region = game ? { ...FULL_REGION } : (saved?.region ?? null)
      const regionSource = game ? 'pick' : (saved?.regionSource ?? (settings.tracking.models.detector ? settings.tracking.regionSource : 'centre'))
      const beatTempoFactor = saved?.beatTempoFactor ?? 1
      const local = source === 'player' && key !== null && !/^https?:\/\//i.test(key)
      const sidecar = local ? ((await invoke('hero:sidecar', key)) ?? null) : null
      const fromFile = sidecar && sidecar.stamp !== saved?.heroFileStamp ? parseHeroFile(sidecar.text) : null
      const usable = usableOn(source, axes)
      set({
        source,
        key: key && key !== 'about:blank' ? key : null,
        axes: usable,
        sensitivity,
        pace,
        region,
        regionSource,
        regionTarget: saved?.regionTarget ?? null,
        beatTempoFactor,
        beat: null,
        beatError: null,
        heroMusic: normalizeHeroMusic(fromFile ? fromFile.music : saved?.heroMusic),
        heroZone: fromFile ? fromFile.zone : (saved?.heroZone ?? (autoHero ? { ...DEFAULT_ZONE } : null)),
        heroTip: source === 'player' && autoHero && !fromFile,
        heroDirection: fromFile?.direction ?? saved?.heroDirection ?? 'auto',
        heroColours: fromFile?.colours ?? saved?.heroColours ?? {},
        heroAxisColours: pickTrackAxes(fromFile?.axisColours ?? saved?.heroAxisColours),
        hero: null,
        zones: normalizeZoneEffects(fromFile ? fromFile.zones : saved?.zones),
        zoneMatches: [],
        heroFileStamp: fromFile ? sidecar?.stamp : saved?.heroFileStamp,
      })
      pushBeatOptions()
      engine.trackStart(options(settings.tracking, sensitivity, pace), rows(usable), source === 'player')
      set({ state: engine.trackState() })
      pullModels()
      pushRegion()
      pushHero()
      pushZones()
      if (fromFile) persist()
      if (anyHero() && !get().heroZone) get().pickHeroZone()
      void ensureBeat()
      pushParams()
      if (source === 'browser') {
        const syncPlayback = () => {
          const browser = useBrowser.getState()
          const active = browser.tabs.find((t) => t.active)
          if (active?.id !== tab?.id) {
            get().stop()
            return
          }
          const video = active?.video
          engine.trackPlayback((video?.mediaTime ?? 0) * 1000, Boolean(video?.present && video.playing), video?.rate ?? 1)
        }
        const stopPlayback = useBrowser.subscribe((s, prev) => { if (s.tabs !== prev.tabs) syncPlayback() })
        const stopGray = subscribeFrames((f) => {
          if (f.id === tab?.id) engine.trackFrame(f.bytes, f.width, f.height, f.mediaTime * 1000, f.channels)
        })
        const stopColour = feedColour(colourEveryMs, CAPTURE_WIDTH)
        unsubscribe = () => {
          stopGray()
          stopColour()
          stopPlayback()
        }
        syncPlayback()
        if (get().source !== 'browser') return
        void useBrowser.getState().capture(true)
        window.setTimeout(() => {
          if (get().source === 'browser' && (get().state?.frames ?? 0) === 0) void useBrowser.getState().capture(true)
        }, 2000)
      }
    },
    flushSave: async () => {
      window.clearTimeout(persistTimer)
      pendingSave?.()
      await saving
    },
    stop: () => {
      releaseAudio()
      window.clearTimeout(persistTimer)
      window.clearTimeout(paceTimer)
      pendingSave?.()
      applyPlaybackSpeed(1)
      set({ playbackBaseRate: null })
      if (!get().source) return
      unsubscribe?.()
      unsubscribe = null
      window.clearTimeout(showTimer)
      void useBrowser.getState().capture(false)
      void useBrowser.getState().setRegion(null)
      void useBrowser.getState().setZone(null)
      engine.trackStop()
      engine.setZones(false, [])
      set({ source: null, key: null, state: null, beat: null, hero: null, heroMusic: defaultHeroMusic(), zones: defaultZoneEffects(), zoneMatches: [], zonesShown: false, heroFileStamp: undefined, zoneEdit: false, heroTip: false, regionShown: false, axes: defaults().axes, sensitivity: defaults().sensitivity, pace: defaults().defaultPace })
      pushParams()
    },
    setSensitivity: (sensitivity) => {
      set({ sensitivity })
      pushOptions()
      persist()
    },
    setAxis: (id, patch) => {
      const row = { ...get().axes[id], ...patch }
      const source = get().source
      if (source === 'game' && GAME_FOREIGN_SOURCES.includes(row.source)) return
      if (PLAYER_ONLY_SOURCES.includes(row.source) && source !== 'player' && !(source === 'game' && row.source === 'beat')) return
      if (BROWSER_STROKE_SOURCES.includes(row.source) && (id !== 'L0' || get().source !== 'browser')) return
      const hadHero = anyHero()
      set({ axes: { ...get().axes, [id]: row } })
      engine.setTrackAxes([{ axis: id, ...row }])
      persist()
      void ensureBeat()
      if (anyHero() && !get().heroZone) get().pickHeroZone()
      else if (hadHero !== anyHero()) pushHero()
      if (get().heroMusic.enabled) pushHeroMusic()
    },
    setBeatTempoFactor: (beatTempoFactor) => {
      set({ beatTempoFactor })
      pushBeatOptions()
      persist()
    },
    setPace: (pace) => {
      set({ pace: Math.max(0, Math.min(1, pace)) })
      window.clearTimeout(paceTimer)
      paceTimer = window.setTimeout(pushOptions, PACE_PUSH_MS)
      persist()
    },
    setBeatVolumeDepth: (beatVolumeDepth) => {
      void useSettings.getState().update((s) => ({ ...s, tracking: { ...s.tracking, beatVolumeDepth } }))
    },
    setHeroMusicEnabled: (enabled) => {
      set({ heroMusic: { ...get().heroMusic, enabled } })
      pushHeroMusic()
      if (enabled && anyMusic() && !get().heroZone) get().pickHeroZone()
      persist()
    },
    setHeroMusicRule: (bucket, patch) => {
      if (!Number.isInteger(bucket) || bucket < 0 || bucket > 12) return
      const heroMusic = get().heroMusic
      const rules = { ...heroMusic.rules }
      if (patch === null) delete rules[bucket]
      else rules[bucket] = { ...(rules[bucket] ?? defaultHeroMusicRule()), ...patch }
      set({ heroMusic: normalizeHeroMusic({ ...heroMusic, rules }) })
      pushHeroMusic()
      persist()
    },
    setBasePlaybackRate: (rate) => {
      set({ playbackBaseRate: rate })
      engine.setRate(rate * playbackMultiplier)
    },
    setZonesEnabled: (enabled) => {
      set({ zones: { ...get().zones, enabled } })
      pushZones()
      persist()
    },
    addZone: () => {
      const { zones } = get()
      const n = zones.zones.length
      const zone = newZone({ x: Math.min(0.06 + 0.05 * n, 0.7), y: Math.min(0.1 + 0.05 * n, 0.6), w: 0.2, h: 0.2 })
      set({ zones: { enabled: true, zones: [...zones.zones, zone] }, zonesShown: true })
      pushZones()
      persist()
      return zone.id
    },
    updateZone: (id, patch) => editZones((zones) => zones.map((z) => (z.id === id ? { ...z, ...patch } : z))),
    removeZone: (id) => editZones((zones) => zones.filter((z) => z.id !== id)),
    showZones: (zonesShown) => set({ zonesShown }),
    setHeroZone: (heroZone) => {
      set({ heroZone, heroTip: false })
      pushHero()
      persist()
    },
    pickHeroZone: () => {
      if (get().heroZone) return
      set({ heroZone: { ...DEFAULT_ZONE }, heroTip: get().source === 'player' })
      pushHero()
      persist()
    },
    setZoneEdit: (on) => set({ zoneEdit: on && get().source === 'player', heroTip: get().heroTip && !(get().zoneEdit && !on) }),
    dismissHeroTip: () => set({ heroTip: false }),
    exportHero: async () => {
      const { key, source } = get()
      if (!key) return
      const title = source === 'player' ? usePlayer.getState().title : (useBrowser.getState().tabs.find((t) => t.active)?.title ?? '')
      await invoke('hero:export', key, title, heroFileText(get()))
    },
    importHero: async () => {
      const key = get().key
      if (!key) return false
      const text = await invoke('hero:import')
      if (get().key !== key) return false
      if (text === null) return true
      const file = parseHeroFile(text)
      if (!file) return false
      set({ heroZone: file.zone, heroDirection: file.direction, heroColours: file.colours, heroAxisColours: pickTrackAxes(file.axisColours), heroMusic: file.music ?? defaultHeroMusic(), zones: file.zones ?? defaultZoneEffects(), heroTip: false })
      pushHero()
      pushZones()
      if (anyHero() && !get().heroZone) get().pickHeroZone()
      persist()
      return true
    },
    setHeroDirection: (heroDirection) => {
      set({ heroDirection })
      pushHero()
      persist()
    },
    setHeroColour: (axis, bucket, patch) => {
      const { heroColours, heroAxisColours } = get()
      const shared = (b: number): HeroColourRule => {
        const e = get().hero?.colours.find((c) => c.bucket === b)
        return heroColours[b] ?? { intensity: e?.intensity ?? 0.6, flourish: (e?.flourish as HeroFlourish | undefined) ?? 'none', smooth: e?.smooth ?? 0, ignore: e?.ignore ?? false }
      }
      if (axis === null) {
        const rule = { ...shared(bucket), ...patch }
        set({ heroColours: { ...heroColours, [bucket]: rule } })
        engine.setHeroColour(null, bucket, rule)
      } else {
        const own = heroAxisColours[axis]
        const table: HeroColourRules = own ?? Object.fromEntries((get().hero?.colours ?? []).map((c) => [c.bucket, shared(c.bucket)]))
        const rule = { ...(table[bucket] ?? shared(bucket)), ...patch }
        table[bucket] = rule
        set({ heroAxisColours: { ...heroAxisColours, [axis]: table } })
        if (own) engine.setHeroColour(axis, bucket, rule)
        else for (const [b, r] of Object.entries(table)) engine.setHeroColour(axis, Number(b), r)
      }
      persist()
    },
    resetHeroAxis: (axis) => {
      const { [axis]: _dropped, ...rest } = get().heroAxisColours
      set({ heroAxisColours: rest })
      engine.clearHeroAxisColours(axis)
      persist()
    },
    setRegionSource: (kind) => {
      set({ regionSource: kind, region: kind === 'pick' ? (get().region ?? { ...DEFAULT_REGION }) : get().region })
      showRegion()
      pushRegion()
      persist()
    },
    setRegionTarget: (target) => {
      set({ regionSource: 'auto', regionTarget: target })
      showRegion()
      pushRegion()
      persist()
    },
    setRegion: (region) => {
      set({ region, regionSource: 'pick' })
      showRegion()
      pushRegion()
      persist()
    },
    setAsDefault: () => {
      const { axes, sensitivity } = get()
      return useSettings.getState().update((s) => ({ ...s, tracking: { ...s.tracking, axes: usableOn('player', axes), sensitivity } }))
    },
    reset: () => {
      const d = defaults()
      set({ axes: usableOn(get().source ?? 'player', d.axes), sensitivity: d.sensitivity, pace: d.defaultPace, region: null, regionTarget: null, heroMusic: defaultHeroMusic(), zones: defaultZoneEffects() })
      pushHeroMusic()
      pushZones()
      engine.setTrackAxes(rows(get().axes))
      pushOptions()
      get().setRegionSource(d.models.detector ? d.regionSource : 'centre')
    },
    unloadMusic: () => {
      if (loaded.music === null) return
      engine.setModel('music', null, null, null, null)
      loaded.music = null
      set({ music: null, present: { ...get().present, music: false } })
    },
    refreshModels: async () => {
      const d = defaults()
      engine.setDetectOptions(d.detectEveryMs, d.regionPadding)
      modelsDir ??= await invoke('models:dir')
      const all = models()
      const status = await invoke('models:status', all.flatMap((m) => m.files.map((f) => f.file)))
      const present = { detector: false, motion: false, music: false }
      for (const kind of MODEL_KINDS) {
        const wanted = kind === 'music' ? entitledMusicModel(d.models.music, isPremium(useAccount.getState())) : d.models[kind]
        const spec: ModelInfo | undefined = wanted ? all.find((m) => m.kind === kind && m.id === wanted) : undefined
        const paths = spec?.files.map((f) => status[f.file]?.path ?? null) ?? []
        present[kind] = spec !== undefined && paths.every((p) => p !== null)
        if (!spec || !present[kind]) {
          if (loaded[kind] !== null) engine.setModel(kind, null, null, null, null)
          loaded[kind] = null
          continue
        }
        if (loaded[kind] === spec.id) continue
        loaded[kind] = spec.id
        if (kind === 'detector') engine.setDetector(spec.id, paths[0] ?? '', `${modelsDir}/coreml-cache`)
        else engine.setModel(kind, spec.id, paths[0] ?? '', paths[1] ?? '', modelsDir)
      }
      set({ present })
      pullModels()
    },
    update: (state) => {
      const prev = get().state
      if (!prev || !sameShown(prev, state)) set({ state })
      if (anyBeat()) {
        const beat = engine.beatState()
        if (beat.status === 'ready' && get().beatError) set({ beatError: null })
        const old = get().beat
        if (!old || old.status !== beat.status || old.error !== beat.error || Math.round(old.bpm) !== Math.round(beat.bpm) || old.beats !== beat.beats || old.tempoFactor !== beat.tempoFactor || old.model.status !== beat.model.status || Math.round(old.model.percent) !== Math.round(beat.model.percent)) set({ beat })
      }
      if (anyMusic() || state.frames % 30 === 0) pullModels()
      if (anyHero()) set({ hero: engine.heroState() })
      if (get().zones.enabled && get().zones.zones.length > 0) {
        const matches = engine.zoneState()
        if (!sameMatches(get().zoneMatches, matches)) set({ zoneMatches: matches })
      }
      if (effectsOn() || playbackMultiplier !== 1) applyPlaybackSpeed(engine.effectSpeed())
      if (get().source === 'browser' && get().regionSource === 'auto') {
        const box: RegionBox | null = state.region && defaults().showBox && get().regionShown ? { region: state.region, auto: true, label: targetLabel(state.detector.found?.class) } : null
        const key = JSON.stringify(box)
        if (key !== lastBox) {
          lastBox = key
          void useBrowser.getState().setRegion(box)
        }
      }
    },
  }
})

useAccount.subscribe((s, prev) => {
  if (isPremium(s) === isPremium(prev) || !engine) return
  const t = useTracking.getState()
  if (!isPremium(s) && isSupporterModel(useSettings.getState().settings?.tracking.models.music)) {
    if (Object.values(t.axes).some((a) => a.source === 'ai-music')) engine.generateCancel()
    t.unloadMusic()
  }
  void t.refreshModels()
})

useSettings.subscribe((s, prev) => {
  if (!s.settings || s.settings.tracking === prev.settings?.tracking) return
  const t = useTracking.getState()
  if (t.source) {
    engine.setTrackOptions(options(s.settings.tracking, t.sensitivity, t.pace))
    engine.setBeatOptions({ style: 'strokes', volumeDepth: s.settings.tracking.beatVolumeDepth, bounce: s.settings.tracking.beatBounce, bounceDepth: s.settings.tracking.beatBounceDepth, bounceSpeed: s.settings.tracking.beatBounceSpeed, tempoFactor: t.beatTempoFactor })
  }
  void t.refreshModels()
})

useBrowser.subscribe((s, prev) => {
  const t = useTracking.getState()
  if (t.source !== 'browser') return
  if (s.region !== prev.region && s.region && s.region !== t.region) t.setRegion(s.region)
  if (s.zone !== prev.zone && s.zone && s.zone !== t.heroZone) t.setHeroZone(s.zone)
})
