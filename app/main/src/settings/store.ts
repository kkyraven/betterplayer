import { ACCENTS, defaultTheme, THEME_MODES, TINTS, type ThemeSettings } from '@shared/theme'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AXIS_IDS, axisRecord, isAxisId, type AxisId } from '@shared/axes'
import { CORE_SECTIONS, SECTIONS, type Section } from '@shared/library'
import { readProjection } from '@shared/projection'
import { normaliseSource } from '@shared/peer'
import type { Region } from '@shared/browser'
import { LANGUAGE_PREFERENCES } from '@shared/i18n'
import { GAME_KINDS } from '@shared/game'
import { BEAT_BOUNCE_DEPTH, BEAT_BOUNCE_SPEED, CUT_SENSITIVITIES, DEFAULT_MODELS, DETECT_EVERY_DEFAULT_MS, HERO_DIRECTIONS, HERO_FLOURISHES, EASE_DEFAULT_MS, INTENSITY_MAX, MODEL_KINDS, PACE_DEFAULT, REGION_PADDING_DEFAULT, REGION_SOURCES, REGION_TARGETS, TRACK_AXIS_IDS, TRACK_SOURCES, defaultTrackAxes, normalizeHeroMusic, type HeroColourRules, type ModelChoice, type TrackAxesConfig, type TrackingSettings } from '@shared/tracking'
import {
  DLSS_BUFFER_MAX,
  DLSS_BUFFER_MIN,
  DLSS_FACTORS,
  DLSS_GUIDES,
  DLSS_INPUT_HEIGHTS,
  DLSS_MODEL_PRESETS,
  DLSS_NR_PRESETS,
  DLSS_NR_STYLES,
  DLSS_RATES,
  DLSS_SKIN_MIN,
  DLSS_STRENGTH_MAX,
  DLSS_STRENGTH_MIN,
  FRAME_GEN_OVERRIDES,
  FRAME_GEN_TARGETS,
  GAP_SKIPS,
  HWDECS,
  INTERPOLATIONS,
  UPSCALERS,
  HANDY_HOSTINGS,
  OUTPUT_KINDS,
  OUTPUT_PROFILES,
  OPENSHOCK_CONTROLS,
  defaultOpenShockTrigger,
  type OpenShockTrigger,
  VIBRATION_DEPTH_MAX,
  OUTPUT_DELAY_MAX,
  VIBRATION_HZ_MAX,
  VIBRATION_SOURCES,
  defaultVibration,
  type VibrationSettings,
  defaultFeatureLevel,
  normalizeFeatureLevel,
  type FeatureLevel,
  CLOTHING,
  DENIAL_ACTIONS,
  DENIAL_HOLD_MAX_MS,
  DENIAL_WHENS,
  DETECT_KINDS,
  GOONER_STYLES,
  defaultDenial,
  defaultGooner,
  PARAM_AXES,
  PARAM_SOURCES,
  PROVIDERS,
  RECENT_MAX,
  INTIFACE_PORT_DEFAULT,
  REMOTE_PORT_DEFAULT,
  REMOTE_PORT_MAX,
  REMOTE_PORT_MIN,
  SETTINGS_VERSION,
  SUBTITLE_COLOURS,
  SUBTITLE_POSITION_MAX,
  SUBTITLE_SIZES,
  SUBTITLE_STYLES,
  defaultAxisSettings,
  defaultDlss,
  defaultEstim,
  ESTIM_BOOST_AXES,
  defaultSubtitles,
  defaultParamSource,
  defaultRamp,
  defaultSettings,
  defaultShortcuts,
  type AxisSettings,
  type EstimSettings,
  type DlssSettings,
  type DenialSettings,
  type DetectKindId,
  type GoonerLock,
  type GoonerSettings,
  type OutputConfig,
  type ParamAxisId,
  type ParamSourceSettings,
  type RampSettings,
  type PerVideoSettings,
  type Settings,
} from '@shared/settings'

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T) => options.find((o) => o === v) ?? fallback
const axisRef = (v: unknown) => (typeof v === 'string' && isAxisId(v) ? v : undefined)
const isSection = (v: unknown): v is Section => typeof v === 'string' && (SECTIONS as readonly string[]).includes(v)

function readDlss(raw: unknown): DlssSettings {
  const d = defaultDlss()
  const r = isObject(raw) ? raw : {}
  const clamp = (v: unknown, lo: number, hi: number, fallback: number) => Math.max(lo, Math.min(hi, num(v, fallback)))
  const factor = DLSS_FACTORS.find((f) => f === r.factor) ?? d.factor
  const inputHeight = DLSS_INPUT_HEIGHTS.find((h) => h === r.inputHeight) ?? d.inputHeight
  return {
    nrPreset: oneOf(r.nrPreset, DLSS_NR_PRESETS, d.nrPreset),
    nrStyle: oneOf(r.nrStyle, DLSS_NR_STYLES, d.nrStyle),
    intensity: clamp(r.intensity, DLSS_STRENGTH_MIN, DLSS_STRENGTH_MAX, d.intensity),
    localTone: clamp(r.localTone, DLSS_STRENGTH_MIN, DLSS_STRENGTH_MAX, d.localTone),
    localStructure: clamp(r.localStructure, DLSS_STRENGTH_MIN, DLSS_STRENGTH_MAX, d.localStructure),
    skinStructure: clamp(r.skinStructure, DLSS_SKIN_MIN, DLSS_STRENGTH_MAX, d.skinStructure),
    autoMask: bool(r.autoMask, d.autoMask),
    modelPreset: oneOf(r.modelPreset, DLSS_MODEL_PRESETS, d.modelPreset),
    factor,
    inputHeight,
    rate: oneOf(r.rate, DLSS_RATES, d.rate),
    guide: oneOf(r.guide, DLSS_GUIDES, d.guide),
    bufferSeconds: Math.round(clamp(r.bufferSeconds, DLSS_BUFFER_MIN, DLSS_BUFFER_MAX, d.bufferSeconds)),
  }
}

function readViews(raw: unknown): Section[] {
  if (!Array.isArray(raw)) return [...CORE_SECTIONS]
  const out: Section[] = []
  for (const v of raw) if (isSection(v) && !out.includes(v)) out.push(v)
  return out
}

function readPinnedTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) if (typeof v === 'string' && v && !out.includes(v)) out.push(v)
  return out
}

function readAxisSettings(raw: unknown, base: AxisSettings): AxisSettings {
  const r = isObject(raw) ? raw : {}
  return {
    enabled: bool(r.enabled, base.enabled),
    offsetMs: num(r.offsetMs, base.offsetMs),
    min: num(r.min, base.min),
    max: num(r.max, base.max),
    amplitude: num(r.amplitude, base.amplitude),
    invert: bool(r.invert, base.invert),
    interpolation: oneOf(r.interpolation, INTERPOLATIONS, base.interpolation),
    link: axisRef(r.link) ?? base.link,
    provider: oneOf(r.provider, PROVIDERS, base.provider),
    providerSpeed: num(r.providerSpeed, base.providerSpeed),
    providerPeriodMs: num(r.providerPeriodMs, base.providerPeriodMs),
    providerBlend: num(r.providerBlend, base.providerBlend),
    fillGapsOverMs: num(r.fillGapsOverMs, base.fillGapsOverMs),
    autoHomeDelayMs: num(r.autoHomeDelayMs, base.autoHomeDelayMs),
    autoHomeDurationMs: num(r.autoHomeDurationMs, base.autoHomeDurationMs),
    speedLimit: num(r.speedLimit, base.speedLimit),
    smartLimitInput: axisRef(r.smartLimitInput) ?? base.smartLimitInput,
    extendRange: bool(r.extendRange, base.extendRange),
  }
}

function readTrackAxes(raw: unknown, base: TrackAxesConfig): TrackAxesConfig {
  const r = isObject(raw) ? raw : {}
  const axes = { ...base }
  for (const id of TRACK_AXIS_IDS) {
    const row = isObject(r[id]) ? r[id] : {}
    const min = Math.max(0, Math.min(1, num(row.min, base[id].min)))
    axes[id] = {
      source: oneOf(row.source, TRACK_SOURCES, base[id].source),
      intensity: Math.max(0, Math.min(INTENSITY_MAX, num(row.intensity, base[id].intensity))),
      min,
      max: Math.max(min, Math.min(1, num(row.max, base[id].max))),
      smoothingMs: Math.max(0, num(row.smoothingMs, base[id].smoothingMs)),
      invert: bool(row.invert, base[id].invert),
    }
  }
  return axes
}

function readModels(raw: unknown, legacyDetector: string | undefined): ModelChoice {
  const r = isObject(raw) ? raw : {}
  const out: ModelChoice = { ...DEFAULT_MODELS, detector: legacyDetector ?? null }
  for (const kind of MODEL_KINDS) {
    if (kind in r) out[kind] = str(r[kind]) ?? null
  }
  return out
}

function readRegion(raw: unknown): Region | null {
  if (!isObject(raw)) return null
  const [x, y, w, h] = [raw.x, raw.y, raw.w, raw.h].map((v) => num(v, -1))
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 || y + h > 1) return null
  return { x, y, w, h }
}

function readTracking(raw: unknown): TrackingSettings | undefined {
  if (!isObject(raw)) return undefined
  const regionSource = REGION_SOURCES.find((k) => k === raw.regionSource)
  const regionTarget = REGION_TARGETS.find((k) => k === raw.regionTarget)
  const beatTempoFactor = typeof raw.beatTempoFactor === 'number' && raw.beatTempoFactor > 0 ? raw.beatTempoFactor : undefined
  const pace = typeof raw.pace === 'number' && Number.isFinite(raw.pace) ? Math.max(0, Math.min(1, raw.pace)) : undefined
  const heroZone = readRegion(raw.heroZone)
  const heroDirection = HERO_DIRECTIONS.find((d) => d === raw.heroDirection)
  const heroColours = readHeroColours(raw.heroColours)
  const heroAxisColours: Partial<Record<AxisId, HeroColourRules>> = {}
  if (isObject(raw.heroAxisColours)) {
    for (const [k, v] of Object.entries(raw.heroAxisColours)) {
      if (isAxisId(k)) heroAxisColours[k] = readHeroColours(v)
    }
  }
  return {
    axes: readTrackAxes(raw.axes, defaultTrackAxes()),
    sensitivity: num(raw.sensitivity, 1),
    region: readRegion(raw.region),
    ...(regionSource ? { regionSource } : {}),
    ...(regionTarget ? { regionTarget } : {}),
    ...(beatTempoFactor ? { beatTempoFactor } : {}),
    ...(pace !== undefined ? { pace } : {}),
    ...(heroZone ? { heroZone } : {}),
    ...(isObject(raw.heroMusic) ? { heroMusic: normalizeHeroMusic(raw.heroMusic) } : {}),
    ...(heroDirection ? { heroDirection } : {}),
    ...(Object.keys(heroColours).length ? { heroColours } : {}),
    ...(Object.keys(heroAxisColours).length ? { heroAxisColours } : {}),
  }
}

function readHeroColours(raw: unknown): HeroColourRules {
  const rules: HeroColourRules = {}
  if (!isObject(raw)) return rules
  for (const [k, v] of Object.entries(raw)) {
    const bucket = Number(k)
    if (!Number.isInteger(bucket) || bucket < 0 || !isObject(v)) continue
    rules[bucket] = {
      intensity: Math.max(0, Math.min(2, num(v.intensity, 0.6))),
      flourish: oneOf(v.flourish, HERO_FLOURISHES, 'none'),
      smooth: Math.max(0, Math.min(1, num(v.smooth, 0))),
      ignore: v.ignore === true,
    }
  }
  return rules
}

function readEstim(raw: unknown): EstimSettings {
  const d = defaultEstim()
  const r = isObject(raw) ? raw : {}
  const boost = isObject(r.volumeBoost) ? r.volumeBoost : {}
  const unit = (v: unknown, fallback: number) => Math.max(0, Math.min(1, num(v, fallback)))
  const min = unit(r.volumeFloor, d.volumeFloor)
  const axis = ESTIM_BOOST_AXES.find((a) => a === boost.axis)
  return {
    contrast: unit(r.contrast, d.contrast),
    params: bool(r.params, d.params),
    volumeFloor: min,
    volumeMax: Math.max(min, unit(r.volumeMax, d.volumeMax)),
    volumeBoost: {
      enabled: bool(boost.enabled, d.volumeBoost.enabled) && (boost.axis === undefined || axis !== undefined),
      axis: axis ?? d.volumeBoost.axis,
      amount: unit(boost.amount, d.volumeBoost.amount),
    },
  }
}

function readRamp(raw: unknown): RampSettings | undefined {
  if (!isObject(raw)) return undefined
  const d = defaultRamp()
  const unit = (v: unknown, fallback: number) => Math.max(0, Math.min(1, num(v, fallback)))
  const start = unit(raw.start, d.start)
  return { enabled: bool(raw.enabled, d.enabled), start, max: Math.max(start, unit(raw.max, d.max)), minutes: Math.max(0, num(raw.minutes, d.minutes)) }
}

function readFeatureLevels(raw: unknown): Record<string, FeatureLevel> | undefined {
  if (!isObject(raw)) return undefined
  const out: Record<string, FeatureLevel> = {}
  const identity = defaultFeatureLevel()
  for (const [feature, level] of Object.entries(raw)) {
    if (!/^\d+$/.test(feature) || !isObject(level)) continue
    const normal = normalizeFeatureLevel(level as Partial<FeatureLevel>)
    if (normal.from !== identity.from || normal.to !== identity.to || normal.floor !== identity.floor || normal.cap !== identity.cap) out[feature] = normal
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function readFeatureAxes(raw: unknown): Record<string, AxisId | null> | undefined {
  if (!isObject(raw)) return undefined
  const out: Record<string, AxisId | null> = {}
  for (const [feature, axis] of Object.entries(raw)) {
    if (!/^\d+$/.test(feature)) continue
    if (axis === null) out[feature] = null
    else if (typeof axis === 'string' && isAxisId(axis)) out[feature] = axis
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function readParams(raw: unknown): Partial<Record<ParamAxisId, ParamSourceSettings>> | undefined {
  if (!isObject(raw)) return undefined
  const out: Partial<Record<ParamAxisId, ParamSourceSettings>> = {}
  for (const id of PARAM_AXES) {
    const r = raw[id]
    if (!isObject(r)) continue
    const d = defaultParamSource()
    const provider = oneOf(r.provider, PROVIDERS, d.provider)
    const rawKinds: unknown = r.kinds
    const kinds = Array.isArray(rawKinds) ? DETECT_KINDS.map((k) => k.id).filter((k) => rawKinds.includes(k)) : d.kinds
    out[id] = {
      source: oneOf(r.source, PARAM_SOURCES, d.source),
      value: Math.max(0, Math.min(1, num(r.value, d.value))),
      provider: provider === 'none' ? d.provider : provider,
      providerPeriodMs: Math.max(1, num(r.providerPeriodMs, d.providerPeriodMs)),
      providerSpeed: Math.max(0.01, num(r.providerSpeed, d.providerSpeed)),
      kinds,
      bias: Math.max(-1, Math.min(1, num(r.bias, d.bias))),
      holdOnCut: bool(r.holdOnCut, d.holdOnCut),
      holdCoverageOver: typeof r.holdCoverageOver === 'number' && Number.isFinite(r.holdCoverageOver) ? Math.max(0, Math.min(1, r.holdCoverageOver)) : null,
      jump: Math.max(0, Math.min(1, num(r.jump, d.jump))),
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function readOutput(raw: unknown): OutputConfig | null {
  if (!isObject(raw)) return null
  const kind = OUTPUT_KINDS.find((k) => k === raw.kind)
  if (!kind) return null
  const guessed = kind === 'websocket' && str(raw.url)?.includes(':12346') ? 'restim' : 'stroker'
  return {
    kind,
    id: str(raw.id),
    profile: oneOf(raw.profile, OUTPUT_PROFILES, guessed),
    name: str(raw.name),
    path: str(raw.path),
    baud: typeof raw.baud === 'number' ? raw.baud : undefined,
    host: str(raw.host),
    port: typeof raw.port === 'number' ? raw.port : undefined,
    url: str(raw.url),
    device: str(raw.device),
    address: str(raw.address),
    featureAxes: readFeatureAxes(raw.featureAxes),
    featureLevels: readFeatureLevels(raw.featureLevels),
    strengthA: typeof raw.strengthA === 'number' ? Math.max(0, Math.min(200, Math.round(raw.strengthA))) : undefined,
    strengthB: typeof raw.strengthB === 'number' ? Math.max(0, Math.min(200, Math.round(raw.strengthB))) : undefined,
    key: str(raw.key),
    appKey: str(raw.appKey),
    hosting: raw.hosting === undefined ? undefined : oneOf(raw.hosting, HANDY_HOSTINGS, 'cloud'),
    ramp: readRamp(raw.ramp),
    params: readParams(raw.params),
    vibration: readVibration(raw.vibration),
    delayMs: typeof raw.delayMs === 'number' && raw.delayMs !== 0 ? Math.max(-OUTPUT_DELAY_MAX, Math.min(OUTPUT_DELAY_MAX, Math.round(raw.delayMs))) : undefined,
    token: str(raw.token),
    shocker: str(raw.shocker),
    username: str(raw.username),
    userId: typeof raw.userId === 'number' && Number.isSafeInteger(raw.userId) && raw.userId > 0 ? raw.userId : undefined,
    clientId: typeof raw.clientId === 'number' && Number.isSafeInteger(raw.clientId) && raw.clientId > 0 ? raw.clientId : undefined,
    trigger: readTrigger(raw.trigger),
  }
}

function readVibration(raw: unknown): VibrationSettings | undefined {
  if (!isObject(raw)) return undefined
  const d = defaultVibration()
  return {
    source: oneOf(raw.source, VIBRATION_SOURCES, d.source),
    depth: Math.max(0, Math.min(VIBRATION_DEPTH_MAX, num(raw.depth, d.depth))),
    hz: Math.max(0, Math.min(VIBRATION_HZ_MAX, num(raw.hz, d.hz))),
  }
}

function readTrigger(raw: unknown): OpenShockTrigger | undefined {
  if (!isObject(raw)) return undefined
  const d = defaultOpenShockTrigger()
  return {
    axis: oneOf(raw.axis, AXIS_IDS, d.axis),
    line: Math.max(0, Math.min(1, num(raw.line, d.line))),
    above: bool(raw.above, d.above),
    control: oneOf(raw.control, OPENSHOCK_CONTROLS, d.control),
    intensity: Math.max(0, Math.min(100, Math.round(num(raw.intensity, d.intensity)))),
  }
}

export function readPerVideo(raw: unknown): PerVideoSettings {
  const r = isObject(raw) ? raw : {}
  const rawAxes = isObject(r.axes) ? r.axes : {}
  const axes: Partial<Record<AxisId, AxisSettings>> = {}
  for (const id of AXIS_IDS) {
    if (isObject(rawAxes[id])) axes[id] = readAxisSettings(rawAxes[id], defaultAxisSettings(id))
  }
  const rawVariants = isObject(r.variants) ? r.variants : {}
  const variants: Partial<Record<AxisId, string>> = {}
  for (const id of AXIS_IDS) {
    const v = rawVariants[id]
    if (typeof v === 'string' && v) variants[id] = v
  }
  return {
    globalOffsetMs: num(r.globalOffsetMs, 0),
    axes,
    variants: Object.keys(variants).length > 0 ? variants : undefined,
    position: typeof r.position === 'number' ? r.position : undefined,
    projection: readProjection(r.projection),
    tracking: readTracking(r.tracking),
    frameGen: FRAME_GEN_OVERRIDES.find((o) => o === r.frameGen),
    params: readParams(r.params),
  }
}

function readGoonerLock(raw: unknown): GoonerLock | null {
  if (!isObject(raw)) return null
  if (raw.kind === 'chaster') return { kind: 'chaster' }
  if (raw.kind === 'until' && typeof raw.endsAt === 'number' && Number.isFinite(raw.endsAt)) return { kind: 'until', endsAt: raw.endsAt }
  return null
}

function readGooner(raw: unknown): GoonerSettings {
  const d = defaultGooner()
  const g = isObject(raw) ? raw : {}
  return {
    enabled: bool(g.enabled, d.enabled),
    style: oneOf(g.style, GOONER_STYLES, d.style),
    strength: Math.max(0, Math.min(1, num(g.strength, d.strength))),
    kinds: readDetectKinds(g.kinds, d.kinds),
    lock: readGoonerLock(g.lock),
  }
}

function readDetectKinds(raw: unknown, fallback: DetectKindId[]): DetectKindId[] {
  const kinds = Array.isArray(raw) ? DETECT_KINDS.map((k) => k.id).filter((k) => raw.includes(k)) : fallback
  return kinds.length > 0 ? kinds : fallback
}

function readDenial(raw: unknown): DenialSettings {
  const d = defaultDenial()
  const g = isObject(raw) ? raw : {}
  const axes: DenialSettings['axes'] = {}
  if (isObject(g.axes)) {
    for (const [id, rule] of Object.entries(g.axes)) {
      if (isAxisId(id) && isObject(rule)) axes[id] = { action: oneOf(rule.action, DENIAL_ACTIONS, 'hold'), by: Math.max(0, Math.min(1, num(rule.by, 0.5))) }
    }
  }
  return {
    enabled: bool(g.enabled, d.enabled),
    when: oneOf(g.when, DENIAL_WHENS, d.when),
    kinds: readDetectKinds(g.kinds, d.kinds),
    clothing: oneOf(g.clothing, CLOTHING, d.clothing),
    axes,
    holdMs: Math.max(0, Math.min(DENIAL_HOLD_MAX_MS, num(g.holdMs, d.holdMs))),
  }
}

function readTheme(raw: unknown): ThemeSettings {
  const t = isObject(raw) ? raw : {}
  const d = defaultTheme()
  return { mode: oneOf(t.mode, THEME_MODES, d.mode), accent: oneOf(t.accent, ACCENTS, d.accent), tint: oneOf(t.tint, TINTS, d.tint) }
}

function readCurrent(data: Json): Settings {
  const general = isObject(data.general) ? data.general : {}
  const devices = isObject(data.devices) ? data.devices : {}
  const axesDefault = isObject(data.axesDefault) ? data.axesDefault : {}
  const playback = isObject(data.playback) ? data.playback : {}
  const upscaling = isObject(data.upscaling) ? data.upscaling : {}
  const subtitles = isObject(data.subtitles) ? data.subtitles : {}
  const subtitleDefaults = defaultSubtitles()
  const appearance = isObject(data.appearance) ? data.appearance : {}
  const tv = isObject(data.tv) ? data.tv : {}
  const shortcuts = isObject(data.shortcuts) ? Object.fromEntries(Object.entries(data.shortcuts).filter((e): e is [string, string] => typeof e[1] === 'string')) : defaultShortcuts()
  for (const [key, id] of Object.entries(defaultShortcuts())) if (!(key in shortcuts)) shortcuts[key] = id
  const remote = isObject(data.remote) ? data.remote : {}
  const intiface = isObject(data.intiface) ? data.intiface : {}
  const library = isObject(data.library) ? data.library : {}
  const tracking = isObject(data.tracking) ? data.tracking : {}
  const game = isObject(data.game) ? data.game : {}
  const chaster = isObject(data.chaster) ? data.chaster : {}
  const account = isObject(data.account) ? data.account : {}
  const port = Math.round(num(remote.port, REMOTE_PORT_DEFAULT))
  const intifacePort = Math.round(num(intiface.port, INTIFACE_PORT_DEFAULT))
  const recent = Array.isArray(general.recent) ? general.recent.filter((p): p is string => typeof p === 'string') : []
  const outputs = Array.isArray(devices.outputs) ? devices.outputs.map(readOutput).filter((o) => o !== null) : []
  return {
    version: SETTINGS_VERSION,
    general: { recent: recent.slice(0, RECENT_MAX), setupDismissed: general.setupDismissed === true, setupDone: bool(general.setupDone, true), language: oneOf(general.language, LANGUAGE_PREFERENCES, 'auto') },
    devices: { outputs, stopOnPause: bool(devices.stopOnPause, true) },
    axesDefault: axisRecord((id) => {
      const s = readAxisSettings(axesDefault[id], defaultAxisSettings(id))
      const param = id === 'C0' || id.startsWith('P')
      return param && s.speedLimit === 10 ? { ...s, speedLimit: 0 } : s
    }),
    estim: readEstim(data.estim),
    playback: { hwdec: oneOf(playback.hwdec, HWDECS, 'auto'), gapSkip: oneOf(playback.gapSkip, GAP_SKIPS, 'off') },
    upscaling: { upscaler: oneOf(upscaling.upscaler, UPSCALERS, 'off'), frameGen: oneOf(upscaling.frameGen, FRAME_GEN_TARGETS, 'off'), dlss: readDlss(upscaling.dlss) },
    subtitles: {
      enabled: bool(subtitles.enabled, subtitleDefaults.enabled),
      size: oneOf(subtitles.size, SUBTITLE_SIZES, subtitleDefaults.size),
      colour: oneOf(subtitles.colour, SUBTITLE_COLOURS, subtitleDefaults.colour),
      style: oneOf(subtitles.style, SUBTITLE_STYLES, subtitleDefaults.style),
      position: Math.max(0, Math.min(SUBTITLE_POSITION_MAX, num(subtitles.position, subtitleDefaults.position))),
    },
    appearance: { reduceTransparency: bool(appearance.reduceTransparency, false), startInMediaCentre: bool(appearance.startInMediaCentre, false), theme: readTheme(appearance.theme) },
    tv: { hints: bool(tv.hints, true), backdrop: bool(tv.backdrop, false) },
    shortcuts,
    library: { views: readViews(library.views), viewsOpen: bool(library.viewsOpen, false), pinnedTags: readPinnedTags(library.pinnedTags), playlistOrder: readPinnedTags(library.playlistOrder), hiddenPlaylists: readPinnedTags(library.hiddenPlaylists), pinnedFolders: readPinnedTags(library.pinnedFolders), autoTag: bool(library.autoTag, true), tagServers: bool(library.tagServers, false), matchOtherFolders: bool(library.matchOtherFolders, true), stashPreviews: bool(library.stashPreviews, true), stashApp: str(library.stashApp) ?? '', continueRow: bool(library.continueRow, false), axisBadges: bool(library.axisBadges, true) },
    remote: {
      enabled: bool(remote.enabled, false),
      port: port >= REMOTE_PORT_MIN && port <= REMOTE_PORT_MAX ? port : REMOTE_PORT_DEFAULT,
      source: normaliseSource(str(remote.source) ?? ''),
      follow: bool(remote.follow, false),
      password: str(remote.password) ?? '',
      sourcePassword: str(remote.sourcePassword) ?? '',
    },
    intiface: {
      alwaysOn: bool(intiface.alwaysOn, false),
      port: intifacePort >= REMOTE_PORT_MIN && intifacePort <= REMOTE_PORT_MAX ? intifacePort : INTIFACE_PORT_DEFAULT,
      faptapHelpSeen: bool(intiface.faptapHelpSeen, false),
    },
    tracking: {
      axes: readTrackAxes(tracking.axes, defaultTrackAxes()),
      sensitivity: num(tracking.sensitivity, 1),
      flourishes: bool(tracking.flourishes, true),
      cutSensitivity: oneOf(tracking.cutSensitivity, CUT_SENSITIVITIES, 'normal'),
      easeMs: Math.max(0, num(tracking.easeMs, EASE_DEFAULT_MS)),
      clampJumps: bool(tracking.clampJumps, true),
      models: readModels(tracking.models, str(tracking.model)),
      defaultPace: Math.max(0, Math.min(1, num(tracking.defaultPace, PACE_DEFAULT))),
      motionDefault: bool(tracking.motionDefault, true),
      generateForScripted: bool(tracking.generateForScripted, true),
      regionSource: oneOf(tracking.regionSource, ['auto', 'centre'] as const, 'auto'),
      detectEveryMs: Math.max(100, num(tracking.detectEveryMs, DETECT_EVERY_DEFAULT_MS)),
      regionPadding: Math.max(0, Math.min(2, num(tracking.regionPadding, REGION_PADDING_DEFAULT))),
      showBox: bool(tracking.showBox, true),
      beatStyle: 'strokes',
      beatVolumeDepth: bool(tracking.beatVolumeDepth, false),
      beatBounce: bool(tracking.beatBounce, true),
      beatBounceDepth: Math.max(BEAT_BOUNCE_DEPTH.min, Math.min(BEAT_BOUNCE_DEPTH.max, num(tracking.beatBounceDepth, BEAT_BOUNCE_DEPTH.default))),
      beatBounceSpeed: Math.max(BEAT_BOUNCE_SPEED.min, Math.min(BEAT_BOUNCE_SPEED.max, num(tracking.beatBounceSpeed, BEAT_BOUNCE_SPEED.default))),
    },
    game: { kind: oneOf(game.kind, GAME_KINDS, 'rhythm'), ai: bool(game.ai, true) },
    chaster: { token: str(chaster.token) ?? '' },
    gooner: readGooner(data.gooner),
    denial: readDenial(data.denial),
    account: { sync: bool(account.sync, true), usageStats: bool(account.usageStats, true) },
  }
}

export function migrate(raw: unknown): Settings {
  const data: Json = isObject(raw) ? { ...raw } : {}
  const version = typeof data.version === 'number' ? data.version : 0
  switch (version) {
    case 0:
      return defaultSettings()
    case 1:
      break
    default:
      break
  }
  return readCurrent(data)
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return null
  try {
    const text = readFileSync(file, 'utf8')
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return null
  }
}

export function isEmptyPerVideo(v: PerVideoSettings): boolean {
  return v.globalOffsetMs === 0 && Object.keys(v.axes).length === 0 && v.variants === undefined && v.position === undefined && v.projection === undefined && v.tracking === undefined && v.frameGen === undefined && v.params === undefined
}

function writeAtomicSync(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.flush.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

async function writeAtomic(file: string, text: string, superseded: () => boolean) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, text)
  if (superseded()) return unlink(tmp)
  await rename(tmp, file)
}

const WRITE_DELAY_MS = 1000

export class SettingsStore {
  private data: Settings
  private dirty = false
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> | null = null
  private generation = 0

  constructor(private readonly file: string) {
    this.data = migrate(readJson(file))
  }

  get(): Settings {
    return this.data
  }

  set(next: Settings) {
    this.data = migrate(next)
    this.schedule()
  }

  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.dirty) return
    this.dirty = false
    this.generation++
    try {
      writeAtomicSync(this.file, JSON.stringify(this.data))
    } catch (e) {
      console.error(`settings: flush failed: ${String(e)}`)
    }
  }

  private schedule() {
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.write()
    }, WRITE_DELAY_MS)
  }

  private write() {
    if (this.writing || !this.dirty) return
    this.dirty = false
    const generation = ++this.generation
    this.writing = writeAtomic(this.file, JSON.stringify(this.data), () => generation !== this.generation)
      .catch((e: unknown) => console.error(`settings: write failed: ${String(e)}`))
      .then(() => {
        this.writing = null
        if (!this.timer) this.write()
      })
  }
}
