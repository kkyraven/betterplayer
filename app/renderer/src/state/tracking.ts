import { create } from 'zustand'
import type { BeatState, HeroState, ModelState, TrackAxis, TrackOptions, TrackState, ZoneMatch, ZoneRule } from 'bp-engine'
import { CAPTURE_WIDTH, type BrowserTab, type Region, type RegionBox } from '@shared/browser'
import type { PerVideoSettings } from '@shared/settings'
import {
  CUT_THRESHOLD,
  entitledMusicModel,
  isSupporterModel,
  MODEL_KINDS,
  FAPTAP_HOST,
  TRACK_AXIS_IDS,
  defaultTrackingDefaults,
  type ModelInfo,
  type ModelKind,
  type OwnAxes,
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
import {
  allVideosChange,
  convertLegacy,
  hasOverrides,
  musicFolders,
  musicMatters,
  musicSignal,
  resolve,
  usableSource,
  withoutOverrides,
  type AllVideosChange,
  type MusicInput,
  type MusicSignal,
  type Resolved,
  type VideoResolveInput,
} from '@shared/trackingRules'
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

export interface TrackToast {
  id: number
  kind: 'off' | 'on' | 'changed'
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
  resolved: Resolved | null
  musicSignal: MusicSignal | null
  saved: boolean
  hold: boolean
  toast: TrackToast | null
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
  pressCrosshair: () => Promise<void>
  allVideos: () => Promise<void>
  undoAllVideos: () => Promise<void>
  dismissToast: () => void
  setHold: (hold: boolean) => void
  setNotMusic: () => void
  setSensitivity: (s: number) => void
  setAxis: (id: TrackAxisId, patch: Partial<TrackAxisConfig>) => void
  releaseAxis: (id: TrackAxisId) => void
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
  reset: () => void
  afterOverridesReset: () => void
  refreshModels: () => Promise<void>
  loadModel: (kind: 'motion' | 'music') => void
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
const MODEL_SOURCE: Partial<Record<ModelKind, AxisSource>> = { motion: 'ai-motion', music: 'ai-music' }
const FRAME_SOURCES: readonly AxisSource[] = ['video', 'ai-motion', 'hero']

const rows = (axes: TrackAxesConfig): TrackAxis[] => TRACK_AXIS_IDS.map((id) => ({ axis: id, ...axes[id] }))
const sameRow = (a: TrackAxisConfig, b: TrackAxisConfig) =>
  a.source === b.source && a.min === b.min && a.max === b.max && a.intensity === b.intensity && a.smoothingMs === b.smoothingMs && a.invert === b.invert

function options(d: TrackingDefaults, sensitivity: number, pace: number): TrackOptions {
  return { sensitivity, pace, cutThreshold: CUT_THRESHOLD[d.cutSensitivity], easeMs: d.easeMs, flourishes: d.flourishes, clampJumps: d.clampJumps }
}

const startRegion = (d: TrackingDefaults): RegionSourceKind => (d.models.detector ? d.regionSource : 'centre')

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

export function needsFrames(s: Pick<TrackingStore, 'axes' | 'heroMusic' | 'zones'>): boolean {
  const sources = Object.values(s.axes).map((a) => a.source)
  return sources.some((src) => FRAME_SOURCES.includes(src)) || (s.heroMusic.enabled && sources.includes('ai-music')) || (s.zones.enabled && s.zones.zones.length > 0)
}

function hasOwnSetup(r: TrackingSettings | undefined, d: TrackingDefaults): boolean {
  if (!r) return false
  return (
    hasOverrides(r) ||
    (r.pace !== undefined && r.pace !== d.defaultPace) ||
    r.region != null ||
    (r.regionSource !== undefined && r.regionSource !== startRegion(d)) ||
    r.regionTarget !== undefined ||
    (r.beatTempoFactor !== undefined && r.beatTempoFactor !== 1) ||
    r.heroZone != null ||
    (r.heroDirection !== undefined && r.heroDirection !== 'auto') ||
    Object.keys(r.heroColours ?? {}).length > 0 ||
    Object.keys(r.heroAxisColours ?? {}).length > 0 ||
    r.heroMusic !== undefined ||
    r.zones !== undefined
  )
}

function withOn(record: TrackingSettings, on: boolean | undefined): TrackingSettings {
  const { on: _old, ...rest } = record
  return on === undefined ? rest : { ...rest, on }
}

function ownWith(own: OwnAxes, id: TrackAxisId, patch: Partial<TrackAxisConfig>, auto: AxisSource, row: TrackAxisConfig): OwnAxes {
  const entry: Partial<TrackAxisConfig> = { ...own[id], ...patch }
  for (const field of Object.keys(patch) as (keyof TrackAxisConfig)[]) {
    if (entry[field] === (field === 'source' ? auto : row[field])) delete entry[field]
  }
  const { [id]: _old, ...rest } = own
  return Object.keys(entry).length > 0 ? { ...rest, [id]: entry } : rest
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

interface Subject {
  side: 'player' | 'browser'
  key: string | null
  memory: TrackingSettings | undefined
  music: Omit<MusicInput, 'notMusic'> | null
  faptapPage: boolean
  manual: boolean
  tab?: BrowserTab
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
  const available: Record<ModelKind, { id: string; paths: (string | null)[] } | null> = { detector: null, motion: null, music: null }
  const wanted = new Set<ModelKind>()
  let modelsDir: string | null = null
  let lastBox = ''
  let showTimer = 0
  let paceTimer = 0
  let subject: Subject | null = null
  let pressed: { input: VideoResolveInput; started: boolean } | null = null
  let undo: AllVideosChange['undo'] | null = null
  let toastId = 0

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
  const save = (side: TrackSource, key: string | null, record: TrackingSettings | undefined) => {
    if (!key || side === 'game') return
    if (side === 'player') {
      if (usePlayer.getState().path === key) usePlayer.getState().setTracking(record)
      return
    }
    window.clearTimeout(persistTimer)
    pendingSave = () => {
      pendingSave = null
      saving = saving.catch(() => {}).then(() => invoke('video:get', key)).then((existing) => invoke('video:set', key, { ...(existing ?? EMPTY_VIDEO), tracking: record }))
      void saving.catch((error: unknown) => console.warn('save browser tracking', error))
    }
    persistTimer = window.setTimeout(() => pendingSave?.(), 300)
  }
  const keep = (sub: Subject, memory: TrackingSettings | undefined) => {
    sub.memory = memory
    set({ saved: hasOwnSetup(memory, defaults()) })
  }
  const persist = () => {
    window.clearTimeout(persistTimer)
    const { key, source } = get()
    if (!key || !source || source === 'game') return
    const sub = subject?.side === source && subject.key === key ? subject : null
    const memory = sub?.memory
    const { sensitivity: _sensitivity, ...live } = trackingSettings(get())
    const { sensitivity } = get()
    const record: TrackingSettings = {
      ...live,
      own: memory?.own ?? {},
      ...(memory?.on !== undefined ? { on: memory.on } : {}),
      ...(memory?.notMusic ? { notMusic: true as const } : {}),
      ...(sensitivity !== defaults().sensitivity ? { sensitivity } : {}),
    }
    if (sub) keep(sub, record)
    save(source, key, record)
  }
  const defaults = () => useSettings.getState().settings?.tracking ?? defaultTrackingDefaults()
  const loadSettings = async () => {
    const store = useSettings.getState()
    if (!store.settings) await store.load()
  }
  const pushOptions = () => {
    engine.setTrackOptions(options(defaults(), get().sensitivity, get().pace))
  }
  const pullModels = () => {
    const motion = engine.modelState('motion')
    const music = engine.modelState('music')
    const { motion: m, music: u } = get()
    if (!sameModel(m, motion) || !sameModel(u, music)) set({ motion, music })
  }
  const inUse = (kind: ModelKind) => wanted.has(kind) || (get().source !== null && Object.values(get().axes).some((a) => a.source === MODEL_SOURCE[kind]))
  const syncModels = () => {
    for (const kind of MODEL_KINDS) {
      const want = available[kind]
      if (!want) {
        if (loaded[kind] !== null) engine.setModel(kind, null, null, null, null)
        loaded[kind] = null
        continue
      }
      if (loaded[kind] === want.id || (kind !== 'detector' && loaded[kind] === null && !inUse(kind))) continue
      loaded[kind] = want.id
      if (kind === 'detector') engine.setDetector(want.id, want.paths[0] ?? '', `${modelsDir}/coreml-cache`)
      else engine.setModel(kind, want.id, want.paths[0] ?? '', want.paths[1] ?? '', modelsDir)
    }
    pullModels()
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
  const fieldsFrom = (m: TrackingSettings | undefined) => {
    const d = defaults()
    return {
      sensitivity: m?.sensitivity ?? d.sensitivity,
      pace: m?.pace ?? d.defaultPace,
      region: m?.region ?? null,
      regionSource: m?.regionSource ?? startRegion(d),
      regionTarget: m?.regionTarget ?? null,
      beatTempoFactor: m?.beatTempoFactor ?? 1,
      heroMusic: normalizeHeroMusic(m?.heroMusic),
      heroZone: m?.heroZone ?? null,
      heroDirection: m?.heroDirection ?? 'auto',
      heroColours: m?.heroColours ?? {},
      heroAxisColours: pickTrackAxes(m?.heroAxisColours),
      zones: normalizeZoneEffects(m?.zones),
      heroFileStamp: m?.heroFileStamp,
    }
  }

  const halt = () => {
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
  }

  const begin = (source: TrackSource, key: string | null, axes: TrackAxesConfig, memory: TrackingSettings | undefined, tab?: BrowserTab) => {
    halt()
    const fields = fieldsFrom(memory)
    const region = source === 'game' ? { region: { ...FULL_REGION }, regionSource: 'pick' as const } : {}
    set({ source, key, axes, beat: null, beatError: null, hero: null, zoneMatches: [], ...fields, ...region })
    pushBeatOptions()
    engine.trackStart(options(defaults(), get().sensitivity, get().pace), rows(axes), source === 'player')
    set({ state: engine.trackState() })
    syncModels()
    pushRegion()
    pushHero()
    pushZones()
    if (anyHero() && !get().heroZone) get().pickHeroZone()
    void ensureBeat()
    pushParams()
    if (source !== 'browser') return
    const syncPlayback = () => {
      const active = useBrowser.getState().tabs.find((t) => t.active)
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

  const applyAxes = (axes: TrackAxesConfig) => {
    const before = get().axes
    const changed = TRACK_AXIS_IDS.filter((id) => !sameRow(before[id], axes[id]))
    if (changed.length === 0) return
    const hadHero = anyHero()
    set({ axes })
    engine.setTrackAxes(changed.map((id) => ({ axis: id, ...axes[id] })))
    void ensureBeat()
    if (anyHero() && !get().heroZone) get().pickHeroZone()
    else if (hadHero !== anyHero()) pushHero()
    if (get().heroMusic.enabled) pushHeroMusic()
    syncModels()
  }

  const scriptedOn = (side: Subject['side']): ReadonlySet<TrackAxisId> => {
    if (side !== 'player') return new Set()
    const { scripts } = usePlayer.getState()
    return new Set(TRACK_AXIS_IDS.filter((id) => scripts.some((s) => s.axis === id && s.selected)))
  }
  const signalOf = (sub: Subject) => (sub.music ? musicSignal({ ...sub.music, notMusic: sub.memory?.notMusic }) : null)
  const inputFor = (sub: Subject, manual: boolean, video: TrackingSettings | undefined, hold: boolean): VideoResolveInput => {
    const rules = defaults()
    const music = musicMatters(rules, manual ? true : video?.on) ? signalOf(sub) : null
    return { side: sub.side, rules, video, scripted: scriptedOn(sub.side), music, manual, hold, faptapPage: sub.faptapPage }
  }
  const current = (sub: Subject) => inputFor(sub, sub.manual, sub.memory, sub.side === 'player' && get().hold)
  const startsAlone = (sub: Subject) => resolve(inputFor(sub, false, sub.memory && withOn(sub.memory, undefined), false)).start

  const rerun = (stay = false) => {
    const sub = subject
    if (!sub || (sub.side === 'player' && usePlayer.getState().path !== sub.key)) return
    const input = current(sub)
    const resolved = resolve(input)
    set({ resolved, musicSignal: input.music })
    const running = get().source === sub.side && get().key === sub.key
    if (running && (resolved.start || stay)) applyAxes(resolved.axes)
    else if (running) halt()
    else if (resolved.start) begin(sub.side, sub.key, resolved.axes, sub.memory, sub.tab)
  }

  const adopt = (sub: Subject) => {
    if (subject === sub) return
    get().stop()
    subject = sub
    set({ saved: hasOwnSetup(sub.memory, defaults()) })
  }

  const remember = (sub: Subject, change: (memory: TrackingSettings) => TrackingSettings) => {
    const memory = change({ ...(sub.memory ?? { region: null }), own: sub.memory?.own ?? {} })
    keep(sub, memory)
    save(sub.side, sub.key, { ...memory, axes: resolve(current(sub)).axes })
  }
  const setOn = (sub: Subject, on: boolean | undefined) => {
    if (sub.memory?.on !== on) remember(sub, (m) => withOn(m, on))
  }
  const showToast = (kind: TrackToast['kind']) => set({ toast: { id: ++toastId, kind } })

  const playerSubject = async (): Promise<Subject | null> => {
    const key = usePlayer.getState().path
    if (!key) return null
    const local = !/^https?:\/\//i.test(key)
    const sidecar = local ? ((await invoke('hero:sidecar', key)) ?? null) : null
    const player = usePlayer.getState()
    if (player.path !== key) return null
    const title = player.media?.title ?? player.title
    const raw = player.video.tracking
    const file = sidecar && sidecar.stamp !== raw?.heroFileStamp ? parseHeroFile(sidecar.text) : null
    const stored: TrackingSettings | undefined = sidecar && file
      ? { ...(raw ?? { region: null, own: {} }), heroMusic: file.music, zones: file.zones, heroZone: file.zone, heroDirection: file.direction, heroColours: file.colours, heroAxisColours: file.axisColours, heroFileStamp: sidecar.stamp }
      : raw
    const memory = convertLegacy(stored, { side: 'player', rules: defaults(), scripted: scriptedOn('player'), title })
    const music = { heroFile: sidecar !== null, tags: player.media?.tags ?? [], folders: musicFolders(key, player.media?.folder), title }
    const sub: Subject = { side: 'player', key, memory, music, faptapPage: false, manual: false }
    if (stored && stored !== raw) save('player', key, stored.own ? { ...stored, axes: resolve(inputFor(sub, false, memory, false)).axes } : stored)
    return sub
  }
  const pageSubject = async (): Promise<Subject> => {
    const tab = useBrowser.getState().tabs.find((t) => t.active)
    const key = tab?.url && tab.url !== 'about:blank' ? tab.url : null
    const stored = key ? (await invoke('video:get', key))?.tracking : undefined
    const faptapPage = siteName(tab?.url ?? '') === FAPTAP_HOST
    const memory = convertLegacy(stored, { side: 'browser', rules: defaults(), scripted: new Set(), title: tab?.title ?? '', faptapPage })
    return { side: 'browser', key, memory, music: null, faptapPage, manual: true, tab }
  }

  useSettings.subscribe((s, prev) => {
    const a = s.settings?.tracking
    const b = prev.settings?.tracking
    if (a && b && a !== b && (a.axes !== b.axes || a.fill !== b.fill || a.musicFill !== b.musicFill || a.fillScripted !== b.fillScripted)) rerun()
  })

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
    resolved: null,
    musicSignal: null,
    saved: false,
    hold: false,
    toast: null,
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
      await loadSettings()
      const sub = await playerSubject()
      if (!sub) return
      const pressedEarly = subject?.side === 'player' && subject.key === sub.key && subject.manual
      adopt(sub)
      rerun()
      if (pressedEarly && get().source !== 'player') await get().pressCrosshair()
    },
    start: async (source, game) => {
      await loadSettings()
      if (source === 'game') {
        get().stop()
        begin('game', null, resolve({ side: 'game', game: game?.axes ?? defaults().axes }).axes, undefined)
        return
      }
      const sub = source === 'player' ? await playerSubject() : await pageSubject()
      if (!sub) return
      adopt(sub)
      sub.manual = true
      rerun()
    },
    flushSave: async () => {
      window.clearTimeout(persistTimer)
      pendingSave?.()
      await saving
    },
    stop: () => {
      subject = null
      pressed = null
      undo = null
      halt()
      set({ resolved: null, musicSignal: null, saved: false, toast: null })
    },
    pressCrosshair: async () => {
      const { hold } = get()
      const running = subject?.side === 'player' && get().source === 'player' ? subject : null
      if (running) {
        const byRule = !hold && resolve(current(running)).byRule
        const alone = startsAlone(running)
        running.manual = false
        halt()
        if (!hold) setOn(running, alone ? false : undefined)
        rerun()
        pressed = byRule ? { input: { ...current(running), music: signalOf(running) }, started: false } : null
        if (byRule) showToast('off')
        else set({ toast: null })
        return
      }
      await loadSettings()
      const path = usePlayer.getState().path
      const sub = subject?.side === 'player' && subject.key === path ? subject : await playerSubject()
      if (!sub) return
      adopt(sub)
      const offer = !hold && !resolve(current(sub)).byRule
      const alone = startsAlone(sub)
      sub.manual = true
      if (!hold) setOn(sub, alone ? undefined : true)
      pressed = offer ? { input: { ...current(sub), music: signalOf(sub) }, started: true } : null
      if (offer) showToast('on')
      else set({ toast: null })
      rerun()
    },
    allVideos: async () => {
      const p = pressed
      const sub = subject
      if (!p || !sub) return
      pressed = null
      const change = allVideosChange(p.input, p.started)
      undo = change.undo
      showToast('changed')
      await useSettings.getState().update((s) => ({ ...s, tracking: { ...s.tracking, ...change.rules } }))
      if (subject !== sub) return
      setOn(sub, change.on)
      rerun()
    },
    undoAllVideos: async () => {
      const u = undo
      const sub = subject
      undo = null
      set({ toast: null })
      if (!u) return
      if (sub) setOn(sub, u.on)
      await useSettings.getState().update((s) => ({ ...s, tracking: { ...s.tracking, ...u.rules } }))
      if (sub && subject === sub) rerun()
    },
    dismissToast: () => {
      pressed = null
      set({ toast: null })
    },
    setHold: (hold) => set({ hold }),
    setNotMusic: () => {
      const sub = subject
      if (!sub || sub.memory?.notMusic) return
      remember(sub, (m) => ({ ...m, notMusic: true }))
      rerun()
    },
    setSensitivity: (sensitivity) => {
      set({ sensitivity })
      pushOptions()
      persist()
    },
    setAxis: (id, patch) => {
      const source = get().source
      if (patch.source !== undefined && usableSource(source ?? 'player', id, patch.source) !== patch.source) return
      const sub = subject?.side === source && subject.key === get().key ? subject : null
      const auto = get().resolved?.auto[id]
      if (!sub || !auto) {
        applyAxes({ ...get().axes, [id]: { ...get().axes[id], ...patch } })
        persist()
        return
      }
      keep(sub, { ...(sub.memory ?? { region: null }), own: ownWith(sub.memory?.own ?? {}, id, patch, auto, defaults().axes[id]) })
      rerun(true)
      persist()
    },
    releaseAxis: (id) => {
      const auto = get().resolved?.auto[id]
      if (auto) get().setAxis(id, { source: auto })
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
    reset: () => {
      const sub = subject
      if (!sub) return
      keep(sub, undefined)
      save(sub.side, sub.key, undefined)
      if (get().source === sub.side) {
        for (const axis of Object.keys(get().heroAxisColours)) engine.clearHeroAxisColours(axis)
        set({ ...fieldsFrom(undefined), heroTip: false })
        pushOptions()
        pushBeatOptions()
        pushRegion()
        pushHero()
        pushZones()
      }
      rerun()
    },
    afterOverridesReset: () => {
      if (useSettings.getState().settings?.remote?.source) return
      usePlayer.getState().dropOverrides()
      const sub = subject
      if (!sub?.memory || !hasOverrides(sub.memory)) return
      keep(sub, withoutOverrides(sub.memory))
      if (sub.side === 'browser') save('browser', sub.key, sub.memory)
      if (get().source === sub.side) {
        set({ sensitivity: defaults().sensitivity })
        pushOptions()
      }
      rerun()
    },
    loadModel: (kind) => {
      wanted.add(kind)
      syncModels()
    },
    unloadMusic: () => {
      available.music = null
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
        const chosen = kind === 'music' ? entitledMusicModel(d.models.music, isPremium(useAccount.getState())) : d.models[kind]
        const spec: ModelInfo | undefined = chosen ? all.find((m) => m.kind === kind && m.id === chosen) : undefined
        const paths = spec?.files.map((f) => status[f.file]?.path ?? null) ?? []
        present[kind] = spec !== undefined && paths.every((p) => p !== null)
        available[kind] = spec && present[kind] ? { id: spec.id, paths } : null
      }
      set({ present })
      syncModels()
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
      if (anyMusic() || state.frames % 30 === 0 || state.model.status !== get().motion?.status) pullModels()
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

export function afterOverridesReset(): void {
  useTracking.getState().afterOverridesReset()
}

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
