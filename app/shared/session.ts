import type { MessageKey, Translate } from './i18n'
import type { AxisId } from './axes'
import type { MediaRow, Section } from './library'

export type SourceRef =
  | { kind: 'folder'; rootId: number; folder: string; name: string }
  | { kind: 'tag'; name: string }
  | { kind: 'section'; section: Section }
  | { kind: 'playlist'; id: number; name: string }
  | { kind: 'video'; id: number; title: string }

export const ENTRY_ROLES = ['include', 'modify', 'exclude'] as const
export type EntryRole = (typeof ENTRY_ROLES)[number]

export interface ChanceRule {
  percent: number
  from: number
  to: number
}

export interface SessionEntry {
  ref: SourceRef
  role: EntryRole
  clipMinS?: number
  clipMaxS?: number
  axesOff?: AxisId[]
  chance?: ChanceRule
}

export type Range = [number, number]

export const PACING_KINDS = ['random', 'busy', 'rlgl', 'ramp', 'waves', 'custom'] as const
export type PacingKind = (typeof PACING_KINDS)[number]

export interface PacingStep {
  lengthS: Range
  intensity: number
}

export interface PacingSettings {
  kind: PacingKind
  rlgl: { fastS: Range; slowS: Range; fast: number; slow: number }
  ramp: { from: number; to: number }
  waves: { periodS: Range; low: number; high: number }
  custom: { steps: PacingStep[]; repeat: boolean }
}

export interface SessionPeriod {
  from: number
  to: number
}

export interface SessionTimeRule extends SessionPeriod {
  id: string
  mode: 'prefer' | 'require'
  match: 'any' | 'all'
  refs: SourceRef[]
}

export interface SessionToyRule {
  outputId: string
  name: string
  low: number
  middle: number
  high: number
}

export interface SessionToyPeriod extends SessionPeriod {
  id: string
  outputId: string
  name: string
  scale: number
}

export interface SessionToySettings {
  enabled: boolean
  low: number
  high: number
  rules: SessionToyRule[]
  periods: SessionToyPeriod[]
}

export interface SessionSetup {
  entries: SessionEntry[]
  totalMin: number
  totalMax: number
  clipMinS: number
  clipMaxS: number
  pacing: PacingSettings
  matchVideos: boolean
  timeRules: SessionTimeRule[]
  toys: SessionToySettings
  tracking: boolean
  showTimes: boolean
  scriptedOnly: boolean
  requireAxes: AxisId[]
  skipLastSessions: number
  skipLastWatched: number
}

export const SESSION_TOTALS = [15, 30, 45, 60, 90] as const
export const TOTAL_MIN_MINUTES = 1
export const TOTAL_MAX_MINUTES = 600
export const CLIP_MIN_S = 1
export const CLIP_MAX_S = 900
export const SESSION_HISTORY_MAX = 50

export function defaultPacing(): PacingSettings {
  return {
    kind: 'busy',
    rlgl: { fastS: [30, 90], slowS: [20, 60], fast: 1, slow: 0.15 },
    ramp: { from: 0.1, to: 1 },
    waves: { periodS: [120, 300], low: 0.15, high: 1 },
    custom: { steps: [{ lengthS: [60, 120], intensity: 0.3 }, { lengthS: [30, 60], intensity: 1 }], repeat: true },
  }
}

export function defaultSessionSetup(): SessionSetup {
  return {
    entries: [{ ref: { kind: 'section', section: 'all' }, role: 'include' }],
    totalMin: 45,
    totalMax: 45,
    clipMinS: 60,
    clipMaxS: 240,
    pacing: defaultPacing(),
    matchVideos: true,
    timeRules: [],
    toys: { enabled: false, low: 0.35, high: 0.7, rules: [], periods: [] },
    tracking: true,
    showTimes: true,
    scriptedOnly: true,
    requireAxes: [],
    skipLastSessions: 0,
    skipLastWatched: 0,
  }
}

export function refKey(ref: SourceRef): string {
  switch (ref.kind) {
    case 'folder':
      return `folder:${ref.rootId}:${ref.folder}`
    case 'tag':
      return `tag:${ref.name}`
    case 'section':
      return `section:${ref.section}`
    case 'playlist':
      return `playlist:${ref.id}`
    case 'video':
      return `video:${ref.id}`
  }
}

export function refName(ref: SourceRef, t: Translate): string {
  switch (ref.kind) {
    case 'folder':
      return ref.name
    case 'tag':
      return ref.name
    case 'section':
      return t(SECTION_NAME[ref.section])
    case 'playlist':
      return ref.name
    case 'video':
      return ref.title
  }
}

export const SECTION_NAME: Record<Section, MessageKey> = {
  all: 'library.section.all',
  continue: 'section.continue',
  favourites: 'library.section.favourites',
  unscripted: 'library.section.unscripted',
  newest: 'library.section.newest',
  mostWatched: 'section.mostWatched',
  multiAxis: 'section.multiAxis',
  singleAxis: 'section.singleAxis',
  sr6: 'section.sr6',
  osr2: 'section.osr2',
  twist: 'library.section.twist',
  estim: 'library.section.estim',
  focstim: 'section.focstim',
  restim: 'section.restim',
  vr: 'library.section.vr',
  '2d': 'library.section.2d',
  res1080: 'section.res1080',
  res1440: 'section.res1440',
  res4k: 'section.res4k',
  len0to2: 'section.len0to2',
  len2to5: 'section.len2to5',
  len5to15: 'section.len5to15',
  len15to30: 'section.len15to30',
  len30plus: 'section.len30plus',
}

const hasAny = (row: MediaRow, axes: AxisId[]) => axes.some((a) => row.axes.includes(a))

export function rowInSection(row: MediaRow, section: Section): boolean {
  switch (section) {
    case 'all':
    case 'newest':
      return true
    case 'continue':
      return row.watchedMs !== null && row.watchedMs > 0 && row.watchedMs < row.durationMs - 5000
    case 'favourites':
      return row.favourite
    case 'unscripted':
      return row.axes.length === 0
    case 'mostWatched':
      return row.playCount > 0
    case 'multiAxis':
      return row.axes.length >= 2
    case 'singleAxis':
      return row.axes.length === 1
    case 'sr6':
      return hasAny(row, ['L1', 'L2'])
    case 'osr2':
      return hasAny(row, ['R1', 'R2'])
    case 'twist':
      return hasAny(row, ['R0'])
    case 'estim':
      return hasAny(row, ['EA', 'EB', 'EV'])
    case 'focstim':
      return hasAny(row, ['E1', 'E2', 'E3', 'E4'])
    case 'restim':
      return hasAny(row, ['EA', 'EB'])
    case 'vr':
      return row.projection !== 'flat'
    case '2d':
      return row.projection === 'flat'
    case 'res1080':
      return row.height >= 1080
    case 'res1440':
      return row.height >= 1440
    case 'res4k':
      return row.height >= 2160
    case 'len0to2':
      return row.durationMs < 120_000
    case 'len2to5':
      return row.durationMs >= 120_000 && row.durationMs < 300_000
    case 'len5to15':
      return row.durationMs >= 300_000 && row.durationMs < 900_000
    case 'len15to30':
      return row.durationMs >= 900_000 && row.durationMs < 1_800_000
    case 'len30plus':
      return row.durationMs >= 1_800_000
  }
}

export function rowMatches(row: MediaRow, ref: SourceRef, playlistMembers: ReadonlyMap<number, ReadonlySet<number>>): boolean {
  switch (ref.kind) {
    case 'folder':
      return row.rootId === ref.rootId && (ref.folder === '' || row.folder === ref.folder || row.folder.startsWith(`${ref.folder}/`))
    case 'tag':
      return row.tags.includes(ref.name)
    case 'section':
      return rowInSection(row, ref.section)
    case 'playlist':
      return playlistMembers.get(ref.id)?.has(row.id) ?? false
    case 'video':
      return row.id === ref.id
  }
}

export interface SessionClip {
  row: MediaRow
  startMs: number
  endMs: number
  intensity: number | null
  axesOff: AxisId[]
  phase: number
}

export interface SessionPhase {
  startMs: number
  endMs: number
  from: number | null
  to: number | null
  hard: boolean
  label: string
}

export interface SessionStoredClip {
  mediaId: number
  title: string
  startMs: number
  endMs: number
  intensity: number | null
  axesOff: AxisId[]
  phase: number
}

export interface SessionRun {
  setup: SessionSetup
  clips: SessionStoredClip[]
  phases: SessionPhase[]
  totalMs: number
}

export interface SavedSession {
  id: number
  name: string
  favourite: boolean
  updatedAt: number
  setup: SessionSetup
}

export interface SessionHistory {
  id: number
  name: string
  favourite: boolean
  startedAt: number
  endedAt: number | null
  status: 'completed' | 'interrupted' | 'running' | 'legacy'
  totalMs: number
  clipCount: number
  run: SessionRun | null
}
