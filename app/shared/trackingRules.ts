import type { OutputKind } from './settings'
import {
  BROWSER_STROKE_SOURCES,
  PLAYER_ONLY_SOURCES,
  TRACK_AXIS_IDS,
  defaultTrackAxes,
  type OwnAxes,
  type TrackAxesConfig,
  type TrackAxisConfig,
  type TrackAxisId,
  type TrackFill,
  type TrackingDefaults,
  type TrackingSettings,
  type TrackSource,
} from './tracking'

export type TrackSide = 'player' | 'browser' | 'game' | 'headset'

export type RuleSource = TrackFill | 'ai-music'

export type Rules = Pick<TrackingDefaults, 'axes' | 'fill' | 'musicFill' | 'fillScripted'>

export type RulePatch = Partial<Rules>

const SHIPPED_FILL_AXES: readonly TrackAxisId[] = TRACK_AXIS_IDS.filter((id) => defaultTrackAxes()[id].source !== 'off')

const GAME_FOREIGN_SOURCES: readonly TrackSource[] = ['faptap', 'hero', 'ai-music']
const HEADSET_FOREIGN_SOURCES: readonly TrackSource[] = [...PLAYER_ONLY_SOURCES, ...BROWSER_STROKE_SOURCES, 'hero']

const record = <T>(value: (id: TrackAxisId) => T) => Object.fromEntries(TRACK_AXIS_IDS.map((id) => [id, value(id)])) as Record<TrackAxisId, T>

export function musicSource(rules: Pick<TrackingDefaults, 'fill' | 'musicFill'>): RuleSource {
  if (rules.musicFill === 'auto') return rules.fill === 'ai-motion' ? 'ai-music' : rules.fill
  return rules.musicFill === 'same' ? rules.fill : rules.musicFill
}

export function musicMatters(rules: Pick<TrackingDefaults, 'fill' | 'musicFill'>, on: boolean | undefined): boolean {
  return rules.musicFill !== 'same' && (on === true || musicSource(rules) !== rules.fill)
}

export function usableSource(side: TrackSide, id: TrackAxisId, source: TrackSource): TrackSource {
  if (side === 'game') return GAME_FOREIGN_SOURCES.includes(source) ? 'video' : source
  if (side === 'headset') return HEADSET_FOREIGN_SOURCES.includes(source) ? 'ai-motion' : source
  if (side === 'browser') return PLAYER_ONLY_SOURCES.includes(source) || (source === 'faptap' && id !== 'L0') ? 'ai-motion' : source
  return BROWSER_STROKE_SOURCES.includes(source) ? 'ai-motion' : source
}

export type MusicSignal = { kind: 'hero-file' } | { kind: 'tag' | 'folder' | 'title'; text: string }

export interface MusicInput {
  notMusic?: boolean
  heroFile: boolean
  tags: readonly string[]
  folders: readonly string[]
  title: string
}

const MUSIC_TAGS: readonly string[] = ['pmv', 'hmv', 'amv', 'ch', 'cock hero', 'cockhero', 'fap hero', 'faphero', 'music video']

export function musicWords(name: string): string | null {
  const words = name.normalize('NFKC').split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean)
  for (const [i, word] of words.entries()) {
    const lower = word.toLowerCase()
    if (/^[pha]mvs?$/.test(lower) || word === 'CH' || lower === 'cockhero' || lower === 'faphero') return word
    const next = words[i + 1]
    if ((lower === 'cock' || lower === 'fap') && next?.toLowerCase() === 'hero') return `${word} ${next}`
  }
  return null
}

export function musicSignal(input: MusicInput): MusicSignal | null {
  if (input.notMusic) return null
  if (input.heroFile) return { kind: 'hero-file' }
  const tag = input.tags.find((t) => MUSIC_TAGS.includes(t.trim().toLowerCase()))
  if (tag !== undefined) return { kind: 'tag', text: tag }
  const folder = input.folders.find((f) => musicWords(f) !== null)
  if (folder !== undefined) return { kind: 'folder', text: folder }
  const words = musicWords(input.title)
  return words === null ? null : { kind: 'title', text: words }
}

export function musicFolders(path: string, libraryFolder: string | null | undefined): string[] {
  if (libraryFolder != null) return libraryFolder.split(/[\\/]/).filter(Boolean)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return []
  return path.split(/[\\/]/).filter(Boolean).slice(0, -1).slice(-2)
}

export interface VideoResolveInput {
  side: 'player' | 'browser' | 'headset'
  rules: Rules
  video: Pick<TrackingSettings, 'own' | 'on' | 'zones'> | undefined
  scripted: ReadonlySet<TrackAxisId>
  music: MusicSignal | null
  manual: boolean
  hold: boolean
  faptapPage?: boolean
}

export interface GameResolveInput {
  side: 'game'
  game: TrackAxesConfig
}

export type ResolveInput = VideoResolveInput | GameResolveInput

export interface Resolved {
  axes: TrackAxesConfig
  auto: Record<TrackAxisId, TrackSource>
  picked: TrackAxisId[]
  start: boolean
  byRule: boolean
  musicChanged: boolean
}

type Table = Pick<Resolved, 'axes' | 'auto' | 'picked' | 'start'>

const anyOn = (axes: Record<TrackAxisId, { source: TrackSource }>) => TRACK_AXIS_IDS.some((id) => axes[id].source !== 'off')

const classified = (input: VideoResolveInput) => (input.side !== 'browser' && input.rules.musicFill !== 'same' ? input.music : null)

function table(input: VideoResolveInput): Table {
  const { side, rules, scripted, manual, hold, faptapPage } = input
  const own: OwnAxes = input.video?.own ?? {}
  const music = classified(input)
  const picked = TRACK_AXIS_IDS.filter((id) => own[id]?.source !== undefined)
  const tuned = (id: TrackAxisId, source: TrackSource): TrackAxisConfig => ({ ...rules.axes[id], ...own[id], source })
  const on = manual ? true : input.video?.on
  if ((hold && !manual) || on === false) return { axes: record((id) => tuned(id, 'off')), auto: record(() => 'off'), picked, start: false }
  let want: RuleSource = music ? musicSource(rules) : rules.fill
  if (want === 'off' && on === true) want = music ? 'ai-music' : 'ai-motion'
  const fill = on === true || scripted.size === 0 || rules.fillScripted
  const ruled = (id: TrackAxisId): TrackSource =>
    scripted.has(id) ? 'off' : faptapPage && id === 'L0' ? 'faptap' : !fill || rules.axes[id].source === 'off' ? 'off' : want
  const auto = record((id) => usableSource(side, id, ruled(id)))
  const axes = record((id) => {
    const pick = own[id]?.source
    return tuned(id, pick === undefined ? auto[id] : usableSource(side, id, pick))
  })
  if (on === true && TRACK_AXIS_IDS.every((id) => id === 'L0' || axes[id].source === 'off')) {
    const pressed = usableSource(side, 'L0', want)
    if (auto.L0 === 'off') auto.L0 = pressed
    if (axes.L0.source === 'off') axes.L0 = { ...axes.L0, source: pressed }
  }
  const zoned = side === 'player' && input.video?.zones?.enabled === true && input.video.zones.zones.length > 0
  return { axes, auto, picked, start: anyOn(axes) || zoned }
}

export function resolve(input: ResolveInput): Resolved {
  if (input.side === 'game') {
    const axes = record((id) => ({ ...input.game[id], source: usableSource('game', id, input.game[id].source) }))
    return { axes, auto: record((id) => axes[id].source), picked: [], start: anyOn(axes), byRule: anyOn(axes), musicChanged: false }
  }
  const run = table(input)
  const byRule = table({ ...input, video: undefined, manual: false, hold: false }).start
  const unclassified = input.music === null ? run : table({ ...input, music: null })
  const musicChanged = TRACK_AXIS_IDS.some((id) => run.axes[id].source !== unclassified.axes[id].source)
  return { ...run, byRule, musicChanged }
}

export function changeRules<R extends Rules>(rules: R, patch: Omit<RulePatch, 'axes'>): R {
  const next = { ...rules, ...patch }
  const fills = (patch.fill !== undefined && patch.fill !== 'off') || (patch.musicFill !== undefined && musicSource(next) !== 'off') || patch.fillScripted === true
  if (!fills || anyOn(next.axes)) return next
  return { ...next, axes: record((id) => ({ ...next.axes[id], source: SHIPPED_FILL_AXES.includes(id) ? 'video' : next.axes[id].source })) }
}

export interface AllVideosChange {
  rules: RulePatch
  on: boolean | undefined
  undo: { rules: RulePatch; on: boolean | undefined }
}

export function allVideosChange(input: VideoResolveInput, started: boolean): AllVideosChange {
  const { rules } = input
  const scripted = input.scripted.size > 0
  const music = classified(input) !== null
  const want = music ? musicSource(rules) : rules.fill
  const patch: Omit<RulePatch, 'axes'> = !started
    ? scripted
      ? { fillScripted: false }
      : { fill: 'off', ...(music && (rules.musicFill === 'beat' || rules.musicFill === 'ai-music') ? { musicFill: 'auto' as const } : {}) }
    : {
        ...(scripted ? { fillScripted: true } : {}),
        ...(want === 'off' ? { fill: 'ai-motion' as const } : scripted ? {} : music ? { musicFill: rules.musicFill } : { fill: rules.fill }),
      }
  const next = changeRules(rules, patch)
  const changed: RulePatch = { ...patch, ...(next.axes !== rules.axes ? { axes: next.axes } : {}) }
  const undo: RulePatch = {
    ...('fill' in changed ? { fill: rules.fill } : {}),
    ...('musicFill' in changed ? { musicFill: rules.musicFill } : {}),
    ...('fillScripted' in changed ? { fillScripted: rules.fillScripted } : {}),
    ...('axes' in changed ? { axes: rules.axes } : {}),
  }
  const alone = table({ ...input, rules: next, video: input.video && { own: input.video.own, zones: input.video.zones }, manual: false, hold: false }).start
  return { rules: changed, on: alone === started ? undefined : started, undo: { rules: undo, on: input.video?.on } }
}

export function hostedNeedsRun(kind: OutputKind, axes: Record<TrackAxisId, Pick<TrackAxisConfig, 'source'>>): boolean {
  if (kind === 'handy') return axes.L0.source !== 'off'
  return kind === 'howl' && anyOn(axes)
}

export function hasOverrides(tracking: TrackingSettings | undefined): boolean {
  if (!tracking) return false
  const { own, axes, on, notMusic, sensitivity } = tracking
  return (axes !== undefined && own === undefined) || Object.keys(own ?? {}).length > 0 || on !== undefined || notMusic !== undefined || sensitivity !== undefined
}

export function withoutOverrides(tracking: TrackingSettings): TrackingSettings | undefined {
  const { own: _own, on: _on, notMusic: _notMusic, axes, sensitivity: _sensitivity, ...rest } = tracking
  const left = Object.entries(rest).some(([key, value]) => value !== undefined && !(key === 'region' && value === null))
  return left ? { ...rest, ...(axes ? { axes } : {}), own: {} } : undefined
}

export interface LegacyInput {
  side: 'player' | 'browser'
  rules: Pick<TrackingDefaults, 'axes' | 'sensitivity' | 'defaultPace' | 'regionSource' | 'models' | 'motionDefault'>
  scripted: ReadonlySet<TrackAxisId>
  title: string
  faptapPage?: boolean
}

function legacyLooksLikeMusicVideo(title: string): boolean {
  return /CH/.test(title) || /hero|\b(hmv|pmv|amv|ifl|music)\b|i f(uck|ck)ing love/i.test(title)
}

function legacyFreshAxes(input: LegacyInput): TrackAxesConfig {
  const { side, rules, scripted } = input
  const musicVideo = legacyLooksLikeMusicVideo(input.title)
  const autoMusic = musicVideo && side === 'player' && Boolean(rules.models.music)
  const autoHero = musicVideo && !autoMusic && !scripted.has('L0')
  const motion = rules.motionDefault && Boolean(rules.models.motion)
  const faptap = side === 'browser' && input.faptapPage === true
  return record((id) => {
    const a = rules.axes[id]
    const pick: TrackSource = scripted.has(id) || a.source === 'off' ? 'off'
      : faptap && id === 'L0' ? 'faptap'
      : autoMusic ? 'ai-music'
      : autoHero ? (id === 'L0' ? 'hero' : 'video')
      : a.source === 'video' || a.source === 'ai-motion' ? (motion ? 'ai-motion' : 'video')
      : a.source
    return { ...a, source: legacyUsable(side, pick) }
  })
}

function legacyUsable(side: 'player' | 'browser', source: TrackSource): TrackSource {
  return (side === 'player' ? BROWSER_STROKE_SOURCES : PLAYER_ONLY_SOURCES).includes(source) ? 'video' : source
}

const TUNING = ['intensity', 'min', 'max', 'smoothingMs', 'invert'] as const satisfies readonly (keyof TrackAxisConfig)[]
const isMotion = (s: TrackSource) => s === 'video' || s === 'ai-motion'

export function convertLegacy(saved: TrackingSettings | undefined, input: LegacyInput): TrackingSettings | undefined {
  if (!saved || saved.own) return saved
  const { axes, sensitivity, pace, regionSource, beatTempoFactor, ...kept } = saved
  const { rules } = input
  const fresh = legacyFreshAxes(input)
  const own: OwnAxes = {}
  for (const id of TRACK_AXIS_IDS) {
    const row = axes?.[id]
    if (!row) continue
    const global = rules.axes[id]
    const auto = fresh[id].source
    const entry: Partial<TrackAxisConfig> = {}
    if (row.source !== auto && row.source !== legacyUsable(input.side, global.source) && !(isMotion(row.source) && isMotion(auto))) entry.source = row.source
    for (const field of TUNING) if (row[field] !== global[field]) Object.assign(entry, { [field]: row[field] })
    if (Object.keys(entry).length > 0) own[id] = entry
  }
  const startRegion = rules.models.detector ? rules.regionSource : 'centre'
  return {
    ...kept,
    own,
    ...(sensitivity !== undefined && sensitivity !== rules.sensitivity ? { sensitivity } : {}),
    ...(pace !== undefined && pace !== rules.defaultPace ? { pace } : {}),
    ...(regionSource !== undefined && regionSource !== startRegion ? { regionSource } : {}),
    ...(beatTempoFactor !== undefined && beatTempoFactor !== 1 ? { beatTempoFactor } : {}),
  }
}
