import type { AxisId } from './axes'
import type { ProjectionKind } from './projection'
import type { RootKind } from './remote'
import type { Performer, SearchInfo, SearchMatch } from './search'

export interface DropResult {
  play: string | null
  ask: string | null
}

export interface LibraryRoot {
  id: number
  path: string
  kind: RootKind
  name: string
  sessions: boolean
  lastScan: number | null
  error: string
}

export interface MediaRow {
  id: number
  rootId: number
  path: string
  title: string
  titleSet?: boolean
  folder: string
  size: number
  mtime: number
  addedAt: number
  durationMs: number
  width: number
  height: number
  codec: string
  projection: ProjectionKind
  thumb: string | null
  strip: string | null
  axes: AxisId[]
  averageSpeed: number
  heat: number[]
  rating: number
  favourite: boolean
  watchedMs: number | null
  playCount: number
  lastPlayed: number | null
  tags: string[]
  performers?: Performer[]
  searchMatch?: SearchMatch | null
  playlistPosition?: number
  pinned: boolean
  hidden: boolean
}

export interface MediaScript {
  axis: AxisId
  source: string
  container: string
  actions: number
  averageSpeed: number
  maxSpeed: number
  heatmap: number[]
  durationMs: number
}

export interface MediaDetail extends MediaRow {
  scripts: MediaScript[]
  description?: string
  studio?: string
}

export const CORE_SECTIONS = ['all', 'continue', 'favourites', 'unscripted'] as const
export const EXTRA_SECTIONS = [
  'newest',
  'mostWatched',
  'multiAxis',
  'singleAxis',
  'sr6',
  'osr2',
  'twist',
  'estim',
  'focstim',
  'restim',
  'vr',
  '2d',
  'res1080',
  'res1440',
  'res4k',
  'len0to2',
  'len2to5',
  'len5to15',
  'len15to30',
  'len30plus',
] as const
export const SECTIONS = [...CORE_SECTIONS, ...EXTRA_SECTIONS] as const
export type Section = (typeof SECTIONS)[number]

export const SORTS = ['recommended', 'added', 'name', 'modified', 'duration', 'speed', 'rating', 'lastPlayed', 'plays'] as const
export type Sort = (typeof SORTS)[number]

export interface MediaFilters {
  script?: 'any' | 'stroke' | 'multi' | 'estim' | 'missing'
  axes?: AxisId[]
  type?: '2d' | 'vr'
  watched?: 'yes' | 'no'
  minRating?: number
  tag?: string
  hidden?: 'yes'
}

export interface MediaQuery {
  section: Section
  folder?: { rootId: number; folder: string }
  playlistId?: number
  search?: string
  sort: Sort
  desc: boolean
  filters: MediaFilters
  limit: number
  offset: number
  continueRow?: boolean
}

export interface MediaPage {
  rows: GridEntry[]
  search?: SearchInfo
  total: number | null
  rev?: number
}

export interface PlaylistEntry {
  playlist: true
  id: number
  name: string
  count: number
  thumbs: string[]
}

export type GridEntry = MediaRow | PlaylistEntry
export const isPlaylist = (e: GridEntry): e is PlaylistEntry => 'playlist' in e

export interface MediaIndexRow {
  id: number
  title: string
  durationMs: number
}

export type LibraryChange =
  | { kind: 'thumbs'; ids: number[] }
  | { kind: 'tags'; ids: number[] }
  | { kind: 'scan' }
  | { kind: 'meta' }

export interface FolderNode {
  rootId: number
  folder: string
  name: string
  count: number
  children: FolderNode[]
  excluded: boolean
}

export interface Playlist {
  id: number
  name: string
  count: number
}

export interface Tag {
  name: string
  count: number
}

export type LibraryCounts = Record<Section, number>

export function titleStartsWith(title: string, prefix: string): boolean {
  return title.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '').startsWith(prefix)
}

export interface ScanProgress {
  scanning: boolean
  done: number
  total: number
  thumbsPending: number
  tagsPending: number
}
