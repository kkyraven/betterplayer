import { defaultTheme, type ThemeSettings } from './theme'
import { TCODE_AXES, axisRecord, type AxisId } from './axes'
import { CORE_SECTIONS, type Section } from './library'
import type { Projection } from './projection'
import { defaultTrackingDefaults, type TrackingDefaults, type TrackingSettings } from './tracking'
import { defaultGameSettings, type GameSettings } from './game'
import type { LanguagePreference, MessageKey } from './i18n'

export const SETTINGS_VERSION = 1
export const RECENT_MAX = 20

export const INTERPOLATIONS = ['step', 'linear', 'pchip'] as const
export type Interpolation = (typeof INTERPOLATIONS)[number]

export const PROVIDERS = ['none', 'random', 'sine'] as const
export type Provider = (typeof PROVIDERS)[number]

export const HWDECS = ['auto', 'no'] as const
export type Hwdec = (typeof HWDECS)[number]

export const GAP_SKIPS = ['off', 'key', 'auto'] as const
export type GapSkip = (typeof GAP_SKIPS)[number]
export const GAP_SKIP_LABELS: Record<GapSkip, MessageKey> = { off: 'gapSkip.off', key: 'gapSkip.key', auto: 'gapSkip.auto' }

export const UPSCALERS = ['off', 'sharp', 'fsr', 'rtx', 'apple', 'dlss'] as const
export type Upscaler = (typeof UPSCALERS)[number]
export const UPSCALER_LABELS: Record<Upscaler, MessageKey> = { off: 'upscaler.off', sharp: 'upscaler.sharp', fsr: 'upscaler.fsr', rtx: 'upscaler.rtx', apple: 'upscaler.apple', dlss: 'upscaler.dlss' }

export const DLSS_NR_PRESETS = ['default', '1', '2', '3'] as const
export type DlssNrPreset = (typeof DLSS_NR_PRESETS)[number]
export const DLSS_NR_PRESET_LABELS: Record<DlssNrPreset, MessageKey> = { default: 'dlssNrPreset.default', '1': 'dlssNrPreset.1', '2': 'dlssNrPreset.2', '3': 'dlssNrPreset.3' }

export const DLSS_NR_STYLES = ['default', 'natural', 'cinematic'] as const
export type DlssNrStyle = (typeof DLSS_NR_STYLES)[number]
export const DLSS_NR_STYLE_LABELS: Record<DlssNrStyle, MessageKey> = { default: 'dlssNrStyle.default', natural: 'dlssNrStyle.natural', cinematic: 'dlssNrStyle.cinematic' }

export const DLSS_MODEL_PRESETS = ['default', 'j', 'k', 'l', 'm'] as const
export type DlssModelPreset = (typeof DLSS_MODEL_PRESETS)[number]
export const DLSS_MODEL_PRESET_LABELS: Record<DlssModelPreset, MessageKey> = { default: 'dlssModelPreset.default', j: 'dlssModelPreset.j', k: 'dlssModelPreset.k', l: 'dlssModelPreset.l', m: 'dlssModelPreset.m' }

export const DLSS_FACTORS = [1, 1.5, 1.724, 2, 3] as const
export type DlssFactor = (typeof DLSS_FACTORS)[number]
export const DLSS_FACTOR_LABELS: Record<DlssFactor, MessageKey> = { 1: 'dlssFactor.dlaa', 1.5: 'dlssFactor.quality', 1.724: 'dlssFactor.balanced', 2: 'dlssFactor.performance', 3: 'dlssFactor.ultra' }

export const DLSS_INPUT_HEIGHTS = [0, 480, 720, 1080, 1440, 2160] as const
export type DlssInputHeight = (typeof DLSS_INPUT_HEIGHTS)[number]

export const DLSS_RATES = ['auto', 'source', '60', '30', '24'] as const
export type DlssRate = (typeof DLSS_RATES)[number]
export const DLSS_RATE_LABELS: Record<DlssRate, MessageKey> = { auto: 'dlssRate.auto', source: 'dlssRate.source', '60': 'dlssRate.60', '30': 'dlssRate.30', '24': 'dlssRate.24' }

export const DLSS_GUIDES = ['fast', 'quality'] as const
export type DlssGuide = (typeof DLSS_GUIDES)[number]
export const DLSS_GUIDE_LABELS: Record<DlssGuide, MessageKey> = { fast: 'dlssGuide.fast', quality: 'dlssGuide.quality' }

export const DLSS_STRENGTH_MIN = 0
export const DLSS_STRENGTH_MAX = 2
export const DLSS_SKIN_MIN = -1
export const DLSS_STRENGTH_STEP = 0.05
export const DLSS_BUFFER_MIN = 2
export const DLSS_BUFFER_MAX = 30

export interface DlssSettings {
  nrPreset: DlssNrPreset
  nrStyle: DlssNrStyle
  intensity: number
  localTone: number
  localStructure: number
  skinStructure: number
  autoMask: boolean
  modelPreset: DlssModelPreset
  factor: DlssFactor
  inputHeight: DlssInputHeight
  rate: DlssRate
  guide: DlssGuide
  bufferSeconds: number
}

export function defaultDlss(): DlssSettings {
  return { nrPreset: 'default', nrStyle: 'default', intensity: 1, localTone: 1, localStructure: 1, skinStructure: -1, autoMask: false, modelPreset: 'default', factor: 1.5, inputHeight: 0, rate: 'auto', guide: 'fast', bufferSeconds: 6 }
}

export const FRAME_GEN_TARGETS = ['off', '60', '120', 'display'] as const
export type FrameGenTarget = (typeof FRAME_GEN_TARGETS)[number]
export const FRAME_GEN_LABELS: Record<FrameGenTarget, MessageKey> = { off: 'frameGen.off', '60': 'frameGen.60', '120': 'frameGen.120', display: 'frameGen.display' }

export const FRAME_GEN_OVERRIDES = ['off', 'on'] as const
export type FrameGenOverride = (typeof FRAME_GEN_OVERRIDES)[number]

export interface UpscalingSettings {
  upscaler: Upscaler
  frameGen: FrameGenTarget
  dlss: DlssSettings
}

export function defaultUpscaling(): UpscalingSettings {
  return { upscaler: 'off', frameGen: 'off', dlss: defaultDlss() }
}

export const SUBTITLE_SIZES = ['small', 'medium', 'large'] as const
export type SubtitleSize = (typeof SUBTITLE_SIZES)[number]
export const SUBTITLE_SIZE_LABELS: Record<SubtitleSize, MessageKey> = { small: 'subtitleSize.small', medium: 'subtitleSize.medium', large: 'subtitleSize.large' }

export const SUBTITLE_COLOURS = ['white', 'yellow'] as const
export type SubtitleColour = (typeof SUBTITLE_COLOURS)[number]
export const SUBTITLE_COLOUR_LABELS: Record<SubtitleColour, MessageKey> = { white: 'subtitleColour.white', yellow: 'subtitleColour.yellow' }

export const SUBTITLE_STYLES = ['outline', 'box', 'plain'] as const
export type SubtitleStyle = (typeof SUBTITLE_STYLES)[number]
export const SUBTITLE_STYLE_LABELS: Record<SubtitleStyle, MessageKey> = { outline: 'subtitleStyle.outline', box: 'subtitleStyle.box', plain: 'subtitleStyle.plain' }

export const SUBTITLE_POSITION_MAX = 0.4
export const SUBTITLE_POSITION_DEFAULT = 0.06

export interface SubtitleSettings {
  enabled: boolean
  size: SubtitleSize
  colour: SubtitleColour
  style: SubtitleStyle
  position: number
}

export function defaultSubtitles(): SubtitleSettings {
  return { enabled: true, size: 'medium', colour: 'white', style: 'outline', position: SUBTITLE_POSITION_DEFAULT }
}

export interface AxisSettings {
  enabled: boolean
  offsetMs: number
  min: number
  max: number
  amplitude: number
  invert: boolean
  interpolation: Interpolation
  link?: AxisId
  provider: Provider
  providerSpeed: number
  providerPeriodMs: number
  providerBlend: number
  fillGapsOverMs: number
  autoHomeDelayMs: number
  autoHomeDurationMs: number
  speedLimit: number
  smartLimitInput?: AxisId
  extendRange: boolean
}

export const OUTPUT_KINDS = ['serial', 'udp', 'tcp', 'websocket', 'buttplug', 'ble', 'ossm', 'coyote', 'handy', 'howl', 'toy', 'openshock', 'pishock'] as const
export type OutputKind = (typeof OUTPUT_KINDS)[number]

export interface VibrationSettings {
  source: AxisId
  depth: number
  hz: number
}

export const VIBRATION_SOURCES: readonly AxisId[] = TCODE_AXES.map((a) => a.id).filter((id) => id !== 'L0')
export const VIBRATION_DEPTH_MAX = 0.25
export const OUTPUT_DELAY_MAX = 500

export interface FeatureLevel {
  from: number
  to: number
  floor: number
  cap: number
}

export function defaultFeatureLevel(): FeatureLevel {
  return { from: 0, to: 1, floor: 0, cap: 1 }
}

export function normalizeFeatureLevel(level: Partial<FeatureLevel>): FeatureLevel {
  const unit = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback)
  const d = defaultFeatureLevel()
  const from = unit(level.from, d.from)
  const floor = unit(level.floor, d.floor)
  return { from, to: Math.max(from, unit(level.to, d.to)), floor, cap: Math.max(floor, unit(level.cap, d.cap)) }
}

export function featureLevelOutput(level: FeatureLevel, input: number): number {
  if (input <= level.from || input <= 0) return 0
  const span = level.to - level.from
  const t = span <= 1e-9 ? 1 : Math.max(0, Math.min(1, (input - level.from) / span))
  return Math.max(0, Math.min(1, level.floor + t * (level.cap - level.floor)))
}
export const VIBRATION_HZ_MAX = 20

export function vibrationHzMax(kind: OutputKind): number {
  return kind === 'ossm' ? 8 : kind === 'ble' ? 15 : VIBRATION_HZ_MAX
}

export function defaultVibration(): VibrationSettings {
  return { source: 'V0', depth: 0.05, hz: 8 }
}

export const OPENSHOCK_URL = 'https://api.openshock.app'
export const OPENSHOCK_USER_AGENT = 'BetterPlayer'
export const OPENSHOCK_PULSE_MS = 300

export const OPENSHOCK_CONTROLS = ['vibrate', 'shock', 'sound'] as const
export type OpenShockControl = (typeof OPENSHOCK_CONTROLS)[number]

export interface OpenShockTrigger {
  axis: AxisId
  line: number
  above: boolean
  control: OpenShockControl
  intensity: number
}

export function defaultOpenShockTrigger(): OpenShockTrigger {
  return { axis: 'S0', line: 0.5, above: true, control: 'vibrate', intensity: 25 }
}

export const HANDY_HOSTINGS = ['cloud', 'lan'] as const
export type HandyHosting = (typeof HANDY_HOSTINGS)[number]

export const OUTPUT_PROFILES = ['stroker', 'restim'] as const
export type OutputProfile = (typeof OUTPUT_PROFILES)[number]

export const RESTIM_DEFAULT_VOLUME_FLOOR = 0.75

export interface RampSettings {
  enabled: boolean
  start: number
  max: number
  minutes: number
}

export function defaultRamp(): RampSettings {
  return { enabled: false, start: RESTIM_DEFAULT_VOLUME_FLOOR, max: 1, minutes: 20 }
}

export const ESTIM_BOOST_AXES = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2'] as const satisfies readonly AxisId[]

export interface EstimVolumeBoost {
  enabled: boolean
  axis: (typeof ESTIM_BOOST_AXES)[number]
  amount: number
}

export interface EstimSettings {
  volumeFloor: number
  volumeMax: number
  volumeBoost: EstimVolumeBoost
  contrast: number
  params: boolean
}

export function defaultEstim(): EstimSettings {
  return { contrast: 0, volumeFloor: RESTIM_DEFAULT_VOLUME_FLOOR, volumeMax: 1, volumeBoost: { enabled: false, axis: 'L1', amount: 0.2 }, params: false }
}

export const PARAM_AXES = ['C0', 'P0', 'P1', 'P2', 'P3'] as const satisfies readonly AxisId[]
export type ParamAxisId = (typeof PARAM_AXES)[number]

export const PARAM_SOURCES = ['restim', 'fixed', 'sweep', 'audio', 'detection'] as const
export type ParamSourceKind = (typeof PARAM_SOURCES)[number]

export const DETECT_KINDS = [
  { id: 'genitals', label: 'detectKind.genitals' },
  { id: 'breasts', label: 'detectKind.breasts' },
  { id: 'buttocks', label: 'detectKind.buttocks' },
  { id: 'faces', label: 'detectKind.faces' },
  { id: 'feet', label: 'detectKind.feet' },
  { id: 'skin', label: 'detectKind.skin' },
] as const
export type DetectKindId = (typeof DETECT_KINDS)[number]['id']

export interface ParamSourceSettings {
  source: ParamSourceKind
  value: number
  provider: Exclude<Provider, 'none'>
  providerPeriodMs: number
  providerSpeed: number
  kinds: DetectKindId[]
  bias: number
  holdOnCut: boolean
  holdCoverageOver: number | null
  jump: number
}

export function defaultParamSource(): ParamSourceSettings {
  return { source: 'restim', value: 0.5, provider: 'sine', providerPeriodMs: 4000, providerSpeed: 0.5, kinds: ['genitals'], bias: 0, holdOnCut: false, holdCoverageOver: null, jump: 0.6 }
}

export const GOONER_STYLES = ['pixelate', 'blur'] as const
export type GoonerStyle = (typeof GOONER_STYLES)[number]
export const GOONER_STYLE_LABELS: Record<GoonerStyle, MessageKey> = { pixelate: 'goonerStyle.pixelate', blur: 'goonerStyle.blur' }

export const GOONER_LOCK_MINUTES = [30, 60, 120, 240, 480, 1440] as const

export type GoonerLock = { kind: 'until'; endsAt: number } | { kind: 'chaster' }

export interface GoonerSettings {
  enabled: boolean
  style: GoonerStyle
  strength: number
  kinds: DetectKindId[]
  lock: GoonerLock | null
}

export function defaultGooner(): GoonerSettings {
  return { enabled: false, style: 'pixelate', strength: 0.6, kinds: ['genitals', 'breasts', 'buttocks'], lock: null }
}

export const DETECT_CLOTHED: Record<DetectKindId, string | null> = { genitals: 'genitalsCovered', breasts: 'breastsCovered', buttocks: 'buttocksCovered', faces: 'faces', feet: 'feetCovered', skin: null }

export const CLOTHING = ['exposed', 'clothed', 'either'] as const
export type Clothing = (typeof CLOTHING)[number]
export const CLOTHING_LABELS: Record<Clothing, MessageKey> = { exposed: 'clothing.exposed', clothed: 'clothing.clothed', either: 'clothing.either' }

export const DENIAL_WHENS = ['seen', 'unseen'] as const
export type DenialWhen = (typeof DENIAL_WHENS)[number]
export const DENIAL_WHEN_LABELS: Record<DenialWhen, MessageKey> = { seen: 'denialWhen.seen', unseen: 'denialWhen.unseen' }

export const DENIAL_ACTIONS = ['hold', 'zero', 'slower'] as const
export type DenialAction = (typeof DENIAL_ACTIONS)[number]
export const DENIAL_ACTION_LABELS: Record<DenialAction, MessageKey> = { hold: 'denialAction.hold', zero: 'denialAction.zero', slower: 'denialAction.slower' }

export interface DenialAxis {
  action: DenialAction
  by: number
}

export const DENIAL_HOLD_MAX_MS = 30_000

export interface DenialSettings {
  enabled: boolean
  when: DenialWhen
  kinds: DetectKindId[]
  clothing: Clothing
  axes: Partial<Record<AxisId, DenialAxis>>
  holdMs: number
}

export function defaultDenial(): DenialSettings {
  return { enabled: false, when: 'seen', kinds: ['genitals'], clothing: 'exposed', axes: {}, holdMs: 1500 }
}

export function defaultDenialAxis(): DenialAxis {
  return { action: 'hold', by: 0.5 }
}

export interface AccountSettings {
  sync: boolean
  usageStats: boolean
}

export interface ChasterSettings {
  token: string
}

export interface OutputConfig {
  id?: string
  kind: OutputKind
  profile: OutputProfile
  name?: string
  path?: string
  baud?: number
  host?: string
  port?: number
  url?: string
  device?: string
  address?: string
  featureAxes?: Record<string, AxisId | null>
  featureLevels?: Record<string, FeatureLevel>
  strengthA?: number
  strengthB?: number
  key?: string
  appKey?: string
  hosting?: HandyHosting
  ramp?: RampSettings
  params?: Partial<Record<ParamAxisId, ParamSourceSettings>>
  vibration?: VibrationSettings
  delayMs?: number
  token?: string
  shocker?: string
  username?: string
  userId?: number
  clientId?: number
  trigger?: OpenShockTrigger
}

export const RESTIM_URL = 'ws://localhost:12346/tcode'

export interface PerVideoSettings {
  globalOffsetMs: number
  axes: Partial<Record<AxisId, AxisSettings>>
  variants?: Partial<Record<AxisId, string>>
  position?: number
  projection?: Projection
  tracking?: TrackingSettings
  frameGen?: FrameGenOverride
  params?: Partial<Record<ParamAxisId, ParamSourceSettings>>
}

export type Shortcuts = Record<string, string>

export const CMD = typeof process !== 'undefined' && process.platform === 'darwin' ? 'meta' : 'ctrl'

export function defaultEditorShortcuts(): Shortcuts {
  const keys: Shortcuts = {
    space: 'Editor.Play.Toggle',
    '<': 'Editor.Speed.Down',
    '>': 'Editor.Speed.Up',
    'shift+space': 'Editor.Play.FromSelection',
    arrowleft: 'Editor.Frame.Back',
    arrowright: 'Editor.Frame.Forward',
    'shift+arrowleft': 'Editor.Frame.BackTen',
    'shift+arrowright': 'Editor.Frame.ForwardTen',
    'alt+arrowleft': 'Editor.Frame.BackSecond',
    'alt+arrowright': 'Editor.Frame.ForwardSecond',
    arrowup: 'Editor.Point.Next',
    arrowdown: 'Editor.Point.Previous',
    'shift+arrowup': 'Editor.Cut.Next',
    'shift+arrowdown': 'Editor.Cut.Previous',
    [`${CMD}+arrowup`]: 'Editor.Marker.Next',
    [`${CMD}+arrowdown`]: 'Editor.Marker.Previous',
    '0': 'Editor.Point.At0',
    '1': 'Editor.Point.At10',
    '2': 'Editor.Point.At20',
    '3': 'Editor.Point.At30',
    '4': 'Editor.Point.At40',
    '5': 'Editor.Point.At50',
    '6': 'Editor.Point.At60',
    '7': 'Editor.Point.At70',
    '8': 'Editor.Point.At80',
    '9': 'Editor.Point.At90',
    '/': 'Editor.Point.At100',
    '-': 'Editor.Point.At100',
    enter: 'Editor.Point.Alternate',
    delete: 'Editor.Delete',
    backspace: 'Editor.Delete',
    [`${CMD}+a`]: 'Editor.Select.All',
    [`${CMD}+d`]: 'Editor.Select.None',
    [`${CMD}+alt+arrowleft`]: 'Editor.Select.Left',
    [`${CMD}+alt+arrowright`]: 'Editor.Select.Right',
    w: 'Editor.Move.Up',
    s: 'Editor.Move.Down',
    'shift+w': 'Editor.Move.UpTen',
    'shift+s': 'Editor.Move.DownTen',
    a: 'Editor.Move.Earlier',
    d: 'Editor.Move.Later',
    'shift+a': 'Editor.Move.EarlierTen',
    'shift+d': 'Editor.Move.LaterTen',
    [`${CMD}+z`]: 'Editor.Undo',
    [`${CMD}+shift+z`]: 'Editor.Redo',
    [`${CMD}+y`]: 'Editor.Redo',
    [`${CMD}+x`]: 'Editor.Cut',
    [`${CMD}+c`]: 'Editor.Copy',
    [`${CMD}+v`]: 'Editor.Paste',
    [`${CMD}+shift+v`]: 'Editor.PasteExact',
    f: 'Editor.Fill',
    'shift+f': 'Editor.Fill.Card',
    g: 'Editor.AiFill',
    'shift+g': 'Editor.AiFill.Card',
    r: 'Editor.Refit',
    x: 'Editor.OtherAxes',
    tab: 'Editor.Ghost.Next',
    'shift+tab': 'Editor.Ghost.Previous',
    '[': 'Editor.Ghost.Earlier',
    ']': 'Editor.Ghost.Later',
    '{': 'Editor.Ghost.Shallower',
    '}': 'Editor.Ghost.Deeper',
    escape: 'Editor.Escape',
    i: 'Editor.Loop.In',
    o: 'Editor.Loop.Out',
    l: 'Editor.Loop.Toggle',
    b: 'Editor.Bookmark',
    m: 'Editor.Flag.Toggle',
    ',': 'Editor.Flag.Previous',
    '.': 'Editor.Flag.Next',
    c: 'Editor.Chapter.Start',
    'shift+c': 'Editor.Chapter.End',
    pageup: 'Editor.Lane.Previous',
    pagedown: 'Editor.Lane.Next',
    [`${CMD}+=`]: 'Editor.Zoom.In',
    [`${CMD}+-`]: 'Editor.Zoom.Out',
    z: 'Editor.Zoom.Selection',
    'shift+z': 'Editor.Zoom.Fit',
    [`${CMD}+s`]: 'Editor.Save',
    [`${CMD}+e`]: 'Editor.Export',
    '?': 'Editor.Shortcuts',
    'pad:0': 'Editor.Point.Alternate',
    'pad:4': 'Editor.Frame.Back',
    'pad:5': 'Editor.Frame.Forward',
    'device:ok': 'Editor.Point.Alternate',
  }
  return Object.fromEntries(Object.entries(keys).map(([k, v]) => [`editor:${k}`, v]))
}

export function defaultShortcuts(): Shortcuts {
  return {
    ...defaultEditorShortcuts(),
    space: 'Media.PlayPause.Toggle',
    arrowright: 'Media.Seek.Forward',
    arrowleft: 'Media.Seek.Back',
    'shift+arrowright': 'Media.Seek.ForwardLong',
    'shift+arrowleft': 'Media.Seek.BackLong',
    arrowup: 'Media.Volume.Up',
    arrowdown: 'Media.Volume.Down',
    w: 'Media.PlayPause.Toggle',
    a: 'Media.Seek.Back',
    d: 'Media.Seek.Forward',
    'shift+a': 'Media.Seek.BackLong',
    'shift+d': 'Media.Seek.ForwardLong',
    q: 'Media.Mark.Set',
    e: 'Media.Mark.Go',
    '1': 'Media.Intensity.Down',
    '2': 'Media.Intensity.Reset',
    '3': 'Media.Intensity.Up',
    z: 'Media.Mute.Toggle',
    x: 'Media.Volume.Down',
    c: 'Media.Volume.Up',
    f: 'Window.Fullscreen.Toggle',
    m: 'Media.Mute.Toggle',
    ',': 'Media.Offset.Earlier',
    '.': 'Media.Offset.Later',
    '<': 'Media.Offset.EarlierLong',
    '>': 'Media.Offset.LaterLong',
    t: 'Window.MediaCentre.Toggle',
    n: 'Session.Next',
    p: 'Session.Previous',
    g: 'Media.Gap.Skip',
    'pad:0': 'Media.PlayPause.Toggle',
    'pad:4': 'Media.Seek.Back',
    'pad:5': 'Media.Seek.Forward',
    'pad:9': 'Window.MediaCentre.Toggle',
    'device:ok': 'Media.PlayPause.Toggle',
    'device:left': 'Media.Seek.Back',
    'device:right': 'Media.Seek.Forward',
  }
}

export interface Settings {
  version: typeof SETTINGS_VERSION
  general: {
    recent: string[]
    setupDismissed: boolean
    setupDone: boolean
    language: LanguagePreference
  }
  devices: {
    outputs: OutputConfig[]
    stopOnPause: boolean
  }
  axesDefault: Record<AxisId, AxisSettings>
  estim: EstimSettings
  playback: { hwdec: Hwdec; gapSkip: GapSkip }
  upscaling: UpscalingSettings
  subtitles: SubtitleSettings
  appearance: {
    reduceTransparency: boolean
    startInMediaCentre: boolean
    theme: ThemeSettings
  }
  tv: { hints: boolean; backdrop: boolean }
  shortcuts: Shortcuts
  library: {
    views: Section[]
    viewsOpen: boolean
    pinnedTags: string[]
    playlistOrder: string[]
    hiddenPlaylists: string[]
    pinnedFolders: string[]
    autoTag: boolean
    tagServers: boolean
    matchOtherFolders: boolean
    stashPreviews: boolean
    stashApp: string
    continueRow: boolean
    axisBadges: boolean
  }
  remote: {
    enabled: boolean
    port: number
    source: string
    follow: boolean
    password: string
    sourcePassword: string
  }
  intiface: { alwaysOn: boolean; port: number; faptapHelpSeen: boolean }
  tracking: TrackingDefaults
  game: GameSettings
  chaster: ChasterSettings
  gooner: GoonerSettings
  denial: DenialSettings
  account: AccountSettings
}

export const INTIFACE_PORT_DEFAULT = 12345

export const REMOTE_PORT_DEFAULT = 8420
export const REMOTE_PORT_MIN = 1024
export const REMOTE_PORT_MAX = 65535

export function defaultAxisSettings(id?: AxisId): AxisSettings {
  const holds = id !== undefined && (id === 'EV' || id === 'C0' || id.startsWith('P') || id.startsWith('E'))
  return {
    enabled: true,
    offsetMs: 0,
    min: 0,
    max: 1,
    amplitude: 1,
    invert: false,
    interpolation: 'linear',
    provider: 'none',
    providerSpeed: 1,
    providerPeriodMs: 1000,
    providerBlend: 0,
    fillGapsOverMs: 5000,
    autoHomeDelayMs: holds ? 0 : 5000,
    autoHomeDurationMs: 3000,
    speedLimit: 0,
    extendRange: false,
  }
}

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    general: { recent: [], setupDismissed: false, setupDone: false, language: 'auto' },
    devices: { outputs: [], stopOnPause: true },
    axesDefault: axisRecord((id) => defaultAxisSettings(id)),
    estim: defaultEstim(),
    playback: { hwdec: 'auto', gapSkip: 'off' },
    upscaling: defaultUpscaling(),
    subtitles: defaultSubtitles(),
    appearance: { reduceTransparency: false, startInMediaCentre: false, theme: defaultTheme() },
    tv: { hints: true, backdrop: false },
    shortcuts: defaultShortcuts(),
    library: { views: [...CORE_SECTIONS], viewsOpen: false, pinnedTags: [], playlistOrder: [], hiddenPlaylists: [], pinnedFolders: [], autoTag: true, tagServers: false, matchOtherFolders: true, stashPreviews: true, stashApp: '', continueRow: false, axisBadges: true },
    remote: { enabled: false, port: REMOTE_PORT_DEFAULT, source: '', follow: false, password: '', sourcePassword: '' },
    intiface: { alwaysOn: false, port: INTIFACE_PORT_DEFAULT, faptapHelpSeen: false },
    tracking: defaultTrackingDefaults(),
    game: defaultGameSettings(),
    chaster: { token: '' },
    gooner: defaultGooner(),
    denial: defaultDenial(),
    account: { sync: true, usageStats: true },
  }
}
