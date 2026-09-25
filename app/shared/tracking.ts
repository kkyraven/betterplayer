import type { MessageKey, Translate } from './i18n'
import type { AxisId } from './axes'
import type { Region } from './browser'

export const TRACK_SOURCES = ['video', 'beat', 'hero', 'ai-motion', 'ai-music', 'faptap', 'off'] as const
export type TrackSource = (typeof TRACK_SOURCES)[number]
export const TRACK_SOURCE_LABEL: Record<TrackSource, MessageKey> = { video: 'trackSource.video', beat: 'trackSource.beat', hero: 'trackSource.hero', 'ai-motion': 'trackSource.ai-motion', 'ai-music': 'trackSource.ai-music', faptap: 'trackSource.faptap', off: 'trackSource.off' }
export const PLAYER_ONLY_SOURCES: readonly TrackSource[] = ['beat', 'ai-music']
export const BROWSER_STROKE_SOURCES: readonly TrackSource[] = ['faptap']
export const FAPTAP_HOST = 'faptap.net'

export const MODEL_KINDS = ['detector', 'motion', 'music'] as const
export type ModelKind = (typeof MODEL_KINDS)[number]
export type ModelChoice = Record<ModelKind, string | null>

export const PACE_DEFAULT = 0.5
export const PACE_SLIDER_MIN = 0.05
export const PACE_SLIDER_MAX = 1
export const paceFromSlider = (percent: number) => PACE_SLIDER_MIN + (Math.max(0, Math.min(100, percent)) / 100) * (PACE_SLIDER_MAX - PACE_SLIDER_MIN)
export const paceToSlider = (pace: number) => Math.round(Math.max(0, Math.min(100, ((pace - PACE_SLIDER_MIN) / (PACE_SLIDER_MAX - PACE_SLIDER_MIN)) * 100)))
export const DEFAULT_MODELS: ModelChoice = { detector: null, motion: 'movement-a', music: 'music' }
export const SUPPORTER_MODELS: readonly string[] = ['music-variation']
export const isSupporterModel = (id: string | null | undefined) => id !== null && id !== undefined && SUPPORTER_MODELS.includes(id)

export const HERO_DIRECTIONS = ['auto', 'right-to-left', 'left-to-right', 'top-down', 'bottom-up'] as const
export type HeroDirection = (typeof HERO_DIRECTIONS)[number]
export const HERO_DIRECTION_LABEL: Record<HeroDirection, MessageKey> = { auto: 'heroDirection.auto', 'right-to-left': 'heroDirection.right-to-left', 'left-to-right': 'heroDirection.left-to-right', 'top-down': 'heroDirection.top-down', 'bottom-up': 'heroDirection.bottom-up' }

export const HERO_FLOURISHES = ['none', 'hold', 'vibrate', 'double', 'triple', 'slam', 'bounce', 'rise', 'whip', 'shake', 'grind'] as const
export type HeroFlourish = (typeof HERO_FLOURISHES)[number]
export const HERO_FLOURISH_LABEL: Record<HeroFlourish, MessageKey> = {
  none: 'heroFlourish.none',
  hold: 'heroFlourish.hold',
  vibrate: 'heroFlourish.vibrate',
  double: 'heroFlourish.double',
  triple: 'heroFlourish.triple',
  slam: 'heroFlourish.slam',
  bounce: 'heroFlourish.bounce',
  rise: 'heroFlourish.rise',
  whip: 'heroFlourish.whip',
  shake: 'heroFlourish.shake',
  grind: 'heroFlourish.grind',
}
export const HERO_FLOURISH_DESC: Record<HeroFlourish, MessageKey> = {
  none: 'heroFlourishDesc.none',
  hold: 'heroFlourishDesc.hold',
  vibrate: 'heroFlourishDesc.vibrate',
  double: 'heroFlourishDesc.double',
  triple: 'heroFlourishDesc.triple',
  slam: 'heroFlourishDesc.slam',
  bounce: 'heroFlourishDesc.bounce',
  rise: 'heroFlourishDesc.rise',
  whip: 'heroFlourishDesc.whip',
  shake: 'heroFlourishDesc.shake',
  grind: 'heroFlourishDesc.grind',
}

export const HERO_BUCKET_NAMES = ['heroColour.red', 'heroColour.orange', 'heroColour.yellow', 'heroColour.lime', 'heroColour.green', 'heroColour.teal', 'heroColour.cyan', 'heroColour.azure', 'heroColour.blue', 'heroColour.violet', 'heroColour.magenta', 'heroColour.pink', 'heroColour.white'] as const satisfies readonly MessageKey[]
export const HERO_BUCKETS = HERO_BUCKET_NAMES.length
export const WHITE_BUCKET = HERO_BUCKETS - 1
export const heroBucketColour = (bucket: number) => (bucket === WHITE_BUCKET ? '#ffffff' : `hsl(${bucket * 30 + 15} 90% 62%)`)
export const isBucket = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < HERO_BUCKETS

export interface HeroColourRule {
  intensity: number
  flourish: HeroFlourish
  smooth: number
  ignore: boolean
}
export type HeroColourRules = Record<number, HeroColourRule>

export interface ColourMatch {
  colour: number
  tolerance: number
}
export const DEFAULT_COLOUR_TOLERANCE = 0.15
export const colourHex = (colour: number) => `#${colour.toString(16).padStart(6, '0')}`
export const bucketRgb = (bucket: number) => {
  if (bucket === WHITE_BUCKET) return 0xffffff
  const hue = (bucket * 30 + 15) / 60
  const c = 0.684, x = c * (1 - Math.abs(hue % 2 - 1)), m = 0.278
  const channels = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x]
  return channels.reduce((rgb, channel) => rgb * 256 + Math.round((channel + m) * 255), 0)
}

export interface EffectOverride {
  tempo: number
  intensity: number
  playbackSpeed: number
  strokeSpeed?: number | null
  estimMax: number | null
  estimMaxRelative?: number | null
  vibeMax?: number | null
}
export const EFFECT_RANGE = { tempo: [0.25, 4], intensity: [0, 2], playbackSpeed: [0.25, 2], strokeSpeed: [0.1, 20], estimMax: [0, 1], estimMaxRelative: [0, 2], vibeMax: [0, 1] } as const satisfies Record<keyof EffectOverride, readonly [number, number]>
export const defaultEffect = (): EffectOverride => ({ tempo: 1, intensity: 1, playbackSpeed: 1, estimMax: null })

export interface HeroMusicRule extends EffectOverride {
  durationMs: number
  match?: ColourMatch
}
export interface HeroMusicSettings {
  enabled: boolean
  rules: Record<number, HeroMusicRule>
}
export const defaultHeroMusicRule = (): HeroMusicRule => ({ durationMs: 2000, ...defaultEffect() })
export const defaultHeroMusic = (): HeroMusicSettings => ({ enabled: false, rules: {} })

const bounded = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback)

function normalizeEffect(rule: Record<string, unknown>): EffectOverride {
  const r = EFFECT_RANGE
  return {
    tempo: bounded(rule.tempo, r.tempo[0], r.tempo[1], 1),
    intensity: bounded(rule.intensity, r.intensity[0], r.intensity[1], 1),
    playbackSpeed: bounded(rule.playbackSpeed, r.playbackSpeed[0], r.playbackSpeed[1], 1),
    ...(rule.strokeSpeed == null ? {} : { strokeSpeed: bounded(rule.strokeSpeed, r.strokeSpeed[0], r.strokeSpeed[1], 1) }),
    estimMax: rule.estimMaxRelative != null || rule.estimMax == null ? null : bounded(rule.estimMax, r.estimMax[0], r.estimMax[1], 0),
    ...(rule.estimMaxRelative == null ? {} : { estimMaxRelative: bounded(rule.estimMaxRelative, 0, 2, 1) }),
    ...(rule.vibeMax == null ? {} : { vibeMax: bounded(rule.vibeMax, r.vibeMax[0], r.vibeMax[1], 0) }),
  }
}

function normalizeMatch(value: unknown): ColourMatch | undefined {
  if (!isRecord(value) || !Number.isInteger(value.colour) || !range(value.colour, 0, 0xffffff)) return undefined
  return { colour: value.colour, tolerance: bounded(value.tolerance, 0, 1, DEFAULT_COLOUR_TOLERANCE) }
}

function validMatch(value: unknown): boolean {
  return isRecord(value) && Number.isInteger(value.colour) && range(value.colour, 0, 0xffffff) && unit(value.tolerance)
}

export function normalizeHeroMusic(value: unknown): HeroMusicSettings {
  const raw = isRecord(value) ? value : {}
  const rules: Record<number, HeroMusicRule> = {}
  for (const [key, rule] of Object.entries(isRecord(raw.rules) ? raw.rules : {})) {
    const bucket = Number(key)
    if (!isBucket(bucket) || !isRecord(rule)) continue
    const match = normalizeMatch(rule.match)
    rules[bucket] = { durationMs: bounded(rule.durationMs, 100, 30000, 2000), ...normalizeEffect(rule), ...(match ? { match } : {}) }
  }
  return { enabled: raw.enabled === true, rules }
}

export const ZONE_TRIGGERS = ['colour', 'part'] as const
export type ZoneTriggerKind = (typeof ZONE_TRIGGERS)[number]
export const ZONE_TRIGGER_LABEL: Record<ZoneTriggerKind, MessageKey> = { colour: 'zoneTrigger.colour', part: 'zoneTrigger.part' }
export type ZoneTrigger = { kind: 'colour'; buckets: number[]; matches?: Record<number, ColourMatch> } | { kind: 'part'; target: RegionTarget }
export interface EffectZone {
  id: string
  region: Region
  trigger: ZoneTrigger
  cover: number
  holdMs: number
  effect: EffectOverride
}
export interface ZoneEffects {
  enabled: boolean
  zones: EffectZone[]
}
export const ZONE_COVER_DEFAULT = 0.2
export const ZONE_HOLD_DEFAULT_MS = 500
export const ZONE_HOLD_MAX_MS = 60000
export const defaultZoneEffects = (): ZoneEffects => ({ enabled: false, zones: [] })
export const newZoneId = () => Math.random().toString(36).slice(2, 8)
export const newZone = (region: Region): EffectZone => ({ id: newZoneId(), region, trigger: { kind: 'colour', buckets: [] }, cover: ZONE_COVER_DEFAULT, holdMs: ZONE_HOLD_DEFAULT_MS, effect: defaultEffect() })
export const zoneName = (index: number, t: Translate) => t('tracking.zone.name', { n: index + 1 })

export function describeTrigger(z: EffectZone, t: Translate): string {
  if (z.trigger.kind === 'part') return t('tracking.zone.partInZone', { part: t(REGION_TARGET_LABEL[z.trigger.target]) })
  const trigger = z.trigger
  const names = trigger.buckets.map((b) => trigger.matches?.[b] ? colourHex(trigger.matches[b].colour) : HERO_BUCKET_NAMES[b] ? t(HERO_BUCKET_NAMES[b]) : '').filter(Boolean)
  return t('tracking.zone.colourTrigger', { colours: names.length ? names.join(', ') : t('tracking.zone.noColour'), percent: Math.round(z.cover * 100) })
}

const times = (v: number) => `${Number(v.toFixed(2))}×`
export function describeEffect(e: EffectOverride, t: Translate): string {
  const parts: string[] = []
  if (e.tempo !== 1) parts.push(t('tracking.effect.tempo', { value: times(e.tempo) }))
  if (e.intensity !== 1) parts.push(t('tracking.effect.intensity', { percent: Math.round(e.intensity * 100) }))
  if (e.playbackSpeed !== 1) parts.push(t('tracking.effect.playback', { value: times(e.playbackSpeed) }))
  if (e.strokeSpeed != null) parts.push(t('tracking.effect.strokeSpeed', { percent: Math.round(e.strokeSpeed * 100) }))
  if (e.estimMax != null) parts.push(t('tracking.effect.estimMax', { percent: Math.round(e.estimMax * 100) }))
  if (e.estimMaxRelative != null) parts.push(t('tracking.effect.estimMaxRelative', { percent: Math.round(e.estimMaxRelative * 100) }))
  if (e.vibeMax != null) parts.push(t('tracking.effect.vibeMax', { percent: Math.round(e.vibeMax * 100) }))
  return parts.length ? parts.join(' · ') : t('tracking.effect.noChange')
}

function normalizeTrigger(value: unknown): ZoneTrigger | null {
  if (!isRecord(value)) return null
  if (value.kind === 'colour') {
    const buckets = Array.isArray(value.buckets) ? [...new Set(value.buckets.filter(isBucket))].sort((a, b) => a - b) : []
    const matches: Record<number, ColourMatch> = {}
    if (isRecord(value.matches)) for (const b of buckets) {
      const match = normalizeMatch(value.matches[b])
      if (match) matches[b] = match
    }
    return { kind: 'colour', buckets, ...(Object.keys(matches).length ? { matches } : {}) }
  }
  if (value.kind === 'part' && REGION_TARGETS.includes(value.target as RegionTarget)) return { kind: 'part', target: value.target as RegionTarget }
  return null
}

export function normalizeZoneEffects(value: unknown): ZoneEffects {
  const raw = isRecord(value) ? value : {}
  const zones: EffectZone[] = []
  for (const z of Array.isArray(raw.zones) ? raw.zones : []) {
    if (!isRecord(z) || typeof z.id !== 'string' || !z.id) continue
    const region = parseRegion(z.region)
    const trigger = normalizeTrigger(z.trigger)
    if (!region || !trigger || zones.some((o) => o.id === z.id)) continue
    zones.push({ id: z.id, region, trigger, cover: bounded(z.cover, 0, 1, ZONE_COVER_DEFAULT), holdMs: bounded(z.holdMs, 0, ZONE_HOLD_MAX_MS, ZONE_HOLD_DEFAULT_MS), effect: normalizeEffect(isRecord(z.effect) ? z.effect : {}) })
  }
  return { enabled: raw.enabled === true, zones }
}

export const HERO_FILE_SUFFIX = '.betterplayer.cockhero.json'
export const HERO_FILE_FORMAT = 'betterplayer.cockhero'
export interface HeroFile {
  format: typeof HERO_FILE_FORMAT
  version: 1
  music?: HeroMusicSettings
  zones?: ZoneEffects
  zone: Region | null
  direction: HeroDirection
  colours: HeroColourRules
  axisColours: Partial<Record<AxisId, HeroColourRules>>
}
export type HeroSetup = Pick<TrackingSettings, 'heroZone' | 'heroDirection' | 'heroColours' | 'heroAxisColours' | 'heroMusic' | 'zones'>

export function heroFileText(s: HeroSetup): string {
  const zones = s.zones && (s.zones.enabled || s.zones.zones.length > 0) ? { zones: s.zones } : {}
  const file: HeroFile = { format: HERO_FILE_FORMAT, version: 1, zone: s.heroZone ?? null, direction: s.heroDirection ?? 'auto', colours: s.heroColours ?? {}, axisColours: s.heroAxisColours ?? {}, ...(s.heroMusic ? { music: s.heroMusic } : {}), ...zones }
  return JSON.stringify(file, null, 2)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

function parseRegion(v: unknown): Region | null | undefined {
  if (v === null) return null
  if (!isRecord(v) || !unit(v.x) || !unit(v.y) || !unit(v.w) || !unit(v.h) || v.w === 0 || v.h === 0) return undefined
  return { x: v.x, y: v.y, w: v.w, h: v.h }
}

function parseRules(v: unknown): HeroColourRules | undefined {
  if (!isRecord(v)) return undefined
  const out: HeroColourRules = {}
  for (const [key, rule] of Object.entries(v)) {
    const bucket = Number(key)
    if (!Number.isInteger(bucket) || bucket < 0 || !isRecord(rule)) return undefined
    const { intensity, flourish, smooth, ignore } = rule
    if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0 || intensity > 2) return undefined
    if (!HERO_FLOURISHES.includes(flourish as HeroFlourish) || !unit(smooth) || typeof ignore !== 'boolean') return undefined
    out[bucket] = { intensity, flourish: flourish as HeroFlourish, smooth, ignore }
  }
  return out
}

const range = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

function parseEffect(rule: Record<string, unknown>): EffectOverride | null {
  const { tempo, intensity, playbackSpeed, strokeSpeed, estimMax, estimMaxRelative, vibeMax } = rule
  const r = EFFECT_RANGE
  if (!range(tempo, r.tempo[0], r.tempo[1]) || !range(intensity, r.intensity[0], r.intensity[1]) || !range(playbackSpeed, r.playbackSpeed[0], r.playbackSpeed[1])) return null
  if ((estimMax !== null && !unit(estimMax)) || (strokeSpeed != null && !range(strokeSpeed, r.strokeSpeed[0], r.strokeSpeed[1])) || (vibeMax != null && !unit(vibeMax))) return null
  if (estimMaxRelative != null && (!range(estimMaxRelative, 0, 2) || estimMax != null)) return null
  return { tempo, intensity, playbackSpeed, estimMax, ...(estimMaxRelative == null ? {} : { estimMaxRelative }), ...(strokeSpeed == null ? {} : { strokeSpeed }), ...(vibeMax == null ? {} : { vibeMax }) }
}

function parseHeroMusic(value: unknown): HeroMusicSettings | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !isRecord(value.rules)) return null
  const rules: Record<number, HeroMusicRule> = {}
  for (const [key, rule] of Object.entries(value.rules)) {
    const bucket = Number(key)
    if (!isBucket(bucket) || !isRecord(rule)) return null
    const effect = parseEffect(rule)
    if (!effect || !range(rule.durationMs, 100, 30000)) return null
    if (rule.match !== undefined && !validMatch(rule.match)) return null
    const match = normalizeMatch(rule.match)
    rules[bucket] = { durationMs: rule.durationMs, ...effect, ...(match ? { match } : {}) }
  }
  return { enabled: value.enabled, rules }
}

function parseTrigger(value: unknown): ZoneTrigger | null {
  const trigger = normalizeTrigger(value)
  if (!trigger || !isRecord(value)) return null
  if (trigger.kind === 'colour' && (!Array.isArray(value.buckets) || !value.buckets.every(isBucket))) return null
  if (trigger.kind === 'colour' && value.matches !== undefined && (!isRecord(value.matches) || Object.entries(value.matches).some(([key, match]) => !isBucket(Number(key)) || !trigger.buckets.includes(Number(key)) || !validMatch(match)))) return null
  return trigger
}

function parseZones(value: unknown): ZoneEffects | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.zones)) return null
  const zones: EffectZone[] = []
  for (const z of value.zones) {
    if (!isRecord(z) || typeof z.id !== 'string' || !z.id || zones.some((o) => o.id === z.id)) return null
    const region = parseRegion(z.region)
    const trigger = parseTrigger(z.trigger)
    if (!region || !trigger) return null
    const effect = isRecord(z.effect) ? parseEffect(z.effect) : null
    if (!effect || !unit(z.cover) || !range(z.holdMs, 0, ZONE_HOLD_MAX_MS)) return null
    zones.push({ id: z.id, region, trigger, cover: z.cover, holdMs: z.holdMs, effect })
  }
  return { enabled: value.enabled, zones }
}

export function parseHeroFile(text: string): HeroFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.format !== HERO_FILE_FORMAT || raw.version !== 1) return null
  const zone = parseRegion(raw.zone)
  const colours = parseRules(raw.colours)
  if (zone === undefined || colours === undefined || !HERO_DIRECTIONS.includes(raw.direction as HeroDirection)) return null
  const axisColours: Partial<Record<AxisId, HeroColourRules>> = {}
  if (raw.axisColours !== undefined) {
    if (!isRecord(raw.axisColours)) return null
    for (const [axis, rules] of Object.entries(raw.axisColours)) {
      const parsed = parseRules(rules)
      if (!parsed) return null
      axisColours[axis as AxisId] = parsed
    }
  }
  const music = raw.music === undefined ? undefined : parseHeroMusic(raw.music)
  if (music === null) return null
  const zones = raw.zones === undefined ? undefined : parseZones(raw.zones)
  if (zones === null) return null
  return { format: HERO_FILE_FORMAT, version: 1, zone, direction: raw.direction as HeroDirection, colours, axisColours, ...(music ? { music } : {}), ...(zones ? { zones } : {}) }
}

export const TRACK_AXES = [
  { id: 'L0', component: 'vertical', suffix: '' },
  { id: 'L2', component: 'horizontal', suffix: 'sway' },
  { id: 'L1', component: 'zoom', suffix: 'surge' },
  { id: 'R1', component: 'rotate', suffix: 'roll' },
  { id: 'R2', component: 'tilt', suffix: 'pitch' },
  { id: 'R0', component: 'shear', suffix: 'twist' },
] as const satisfies ReadonlyArray<{ id: AxisId; component: string; suffix: string }>

export type TrackAxisId = (typeof TRACK_AXES)[number]['id']
export const TRACK_AXIS_IDS: readonly TrackAxisId[] = TRACK_AXES.map((a) => a.id)

export const BEAT_SPEEDS = [0.5, 1, 2] as const
export function beatSpeed(intensity: number): (typeof BEAT_SPEEDS)[number] {
  return intensity <= 0.75 ? 0.5 : intensity >= 1.5 ? 2 : 1
}

export function isTrackAxisId(id: string): id is TrackAxisId {
  return TRACK_AXES.some((a) => a.id === id)
}

export interface TrackAxisConfig {
  source: TrackSource
  intensity: number
  min: number
  max: number
  smoothingMs: number
  invert: boolean
}

export type TrackAxesConfig = Record<TrackAxisId, TrackAxisConfig>

export function entitledMusicModel(id: string | null, premium: boolean): string | null {
  return !premium && isSupporterModel(id) ? DEFAULT_MODELS.music : id
}

export const REGION_SOURCES = ['auto', 'centre', 'pick'] as const
export type RegionSourceKind = (typeof REGION_SOURCES)[number]

export const REGION_TARGETS = ['genitals', 'breasts', 'buttocks', 'faces', 'feet'] as const
export type RegionTarget = (typeof REGION_TARGETS)[number]
export const REGION_TARGET_LABEL: Record<RegionTarget, MessageKey> = { genitals: 'regionTarget.genitals', breasts: 'regionTarget.breasts', buttocks: 'regionTarget.buttocks', faces: 'regionTarget.faces', feet: 'regionTarget.feet' }

export interface TrackingSettings {
  axes: TrackAxesConfig
  sensitivity: number
  region: Region | null
  regionSource?: RegionSourceKind
  regionTarget?: RegionTarget
  beatTempoFactor?: number
  pace?: number
  heroMusic?: HeroMusicSettings
  heroZone?: Region | null
  heroDirection?: HeroDirection
  heroColours?: HeroColourRules
  heroAxisColours?: Partial<Record<AxisId, HeroColourRules>>
  zones?: ZoneEffects
  heroFileStamp?: string
}

export interface ModelFileInfo {
  file: string
  url: string
  sha256: string
}

export interface ModelFileStatus {
  path: string
  bytes: number
}

export interface ModelInfo {
  id: string
  label: string
  kind: ModelKind | 'tagger'
  version: string
  files: ModelFileInfo[]
  bundled: boolean
  sizeMb: number
  licence: string
  licenceUrl: string
  sourceUrl: string
  consent: boolean
}

export interface ModelProgress {
  id: string
  done: number
  total: number
}

export const CUT_SENSITIVITIES = ['low', 'normal', 'high'] as const
export type CutSensitivity = (typeof CUT_SENSITIVITIES)[number]
export const CUT_THRESHOLD: Record<CutSensitivity, number> = { low: 26, normal: 18, high: 12 }

export interface TrackingDefaults {
  axes: TrackAxesConfig
  sensitivity: number
  flourishes: boolean
  cutSensitivity: CutSensitivity
  easeMs: number
  clampJumps: boolean
  models: ModelChoice
  defaultPace: number
  motionDefault: boolean
  generateForScripted: boolean
  regionSource: 'auto' | 'centre'
  detectEveryMs: number
  regionPadding: number
  showBox: boolean
  beatStyle: 'strokes'
  beatVolumeDepth: boolean
  beatBounce: boolean
  beatBounceDepth: number
  beatBounceSpeed: number
}

export const EASE_DEFAULT_MS = 250
export const SMOOTHING_DEFAULT_MS = 100
export const SMOOTHING_SIDE_DEFAULT_MS = 300
export const SMOOTHING_MAX_MS = 300
export const INTENSITY_MAX = 2
export const DETECT_EVERY_DEFAULT_MS = 700
export const REGION_PADDING_DEFAULT = 0.4
export const BEAT_BOUNCE_DEPTH = { min: 0.01, max: 1, default: 1 / 6 } as const
export const BEAT_BOUNCE_SPEED = { min: 0.5, max: 6, default: 3 } as const

export function looksLikeMusicVideo(title: string): boolean {
  return /CH/.test(title) || /hero|\b(hmv|pmv|amv|ifl|music)\b|i f(uck|ck)ing love/i.test(title)
}

export function defaultTrackAxes(): TrackAxesConfig {
  const video = (intensity: number, min = 0.25, max = 0.75, smoothingMs = SMOOTHING_SIDE_DEFAULT_MS): TrackAxisConfig => ({ source: 'video', intensity, min, max, smoothingMs, invert: false })
  return { L0: video(1, 0, 1, SMOOTHING_DEFAULT_MS), L2: video(0.6), L1: video(0.4), R1: video(0.6), R2: video(0.4), R0: { source: 'off', intensity: 0.5, min: 0, max: 1, smoothingMs: SMOOTHING_DEFAULT_MS, invert: false } }
}

export function defaultTrackingDefaults(): TrackingDefaults {
  return {
    axes: defaultTrackAxes(),
    sensitivity: 1,
    flourishes: true,
    cutSensitivity: 'normal',
    easeMs: EASE_DEFAULT_MS,
    clampJumps: true,
    models: { ...DEFAULT_MODELS },
    defaultPace: PACE_DEFAULT,
    motionDefault: true,
    generateForScripted: true,
    regionSource: 'auto',
    detectEveryMs: DETECT_EVERY_DEFAULT_MS,
    regionPadding: REGION_PADDING_DEFAULT,
    showBox: true,
    beatStyle: 'strokes',
    beatVolumeDepth: false,
    beatBounce: true,
    beatBounceDepth: BEAT_BOUNCE_DEPTH.default,
    beatBounceSpeed: BEAT_BOUNCE_SPEED.default,
  }
}
