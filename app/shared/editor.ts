import type { MessageKey } from './i18n'
import type { AxisId } from './axes'
import type { FolderNode } from './library'

export interface EditorFile {
  path: string
  title: string
  folder: string
  durationMs: number | null
  axes: AxisId[]
  editedAt: number | null
  saved: boolean
  draft: boolean
}

export interface EditorFileQuery {
  source: 'recent' | 'library'
  folder?: Pick<FolderNode, 'rootId' | 'folder'>
  search: string
  offset: number
}

export interface EditorFilePage {
  files: EditorFile[]
  hasMore: boolean
}

export interface EditorPoint {
  at: number
  pos: number
}

export interface EditorChapter {
  name: string
  startMs: number
  endMs: number
}

export interface EditorBookmark {
  name: string
  atMs: number
}

export interface EditorLane {
  axis: AxisId
  points: EditorPoint[]
  metadata: Record<string, unknown>
}

export interface EditorDocument {
  lanes: EditorLane[]
  chapters: EditorChapter[]
  bookmarks: EditorBookmark[]
  flags: number[]
}

export interface EditorStored {
  saved: EditorDocument | null
  savedAt: number | null
  draft: EditorDocument | null
  draftAt: number | null
  exported: EditorDocument | null
  exportedAt: number | null
}

export interface Pattern {
  id: string
  name: string
  points: Array<[number, number]>
  builtin?: boolean
}

export const PATTERN_NAME_MAX = 40

export const OFS_FIELDS = [
  { key: 'title', label: 'ofsField.title' },
  { key: 'creator', label: 'ofsField.creator' },
  { key: 'script_url', label: 'ofsField.script_url' },
  { key: 'video_url', label: 'ofsField.video_url' },
  { key: 'tags', label: 'ofsField.tags', list: true },
  { key: 'performers', label: 'ofsField.performers', list: true },
  { key: 'description', label: 'ofsField.description', long: true },
  { key: 'license', label: 'ofsField.license' },
  { key: 'notes', label: 'ofsField.notes', long: true },
] as const satisfies ReadonlyArray<{ key: string; label: MessageKey; list?: true; long?: true }>

export type OfsField = (typeof OFS_FIELDS)[number]['key']

export const AXIS_SUFFIX: Record<AxisId, string> = {
  L0: '',
  L1: 'surge',
  L2: 'sway',
  R0: 'twist',
  R1: 'roll',
  R2: 'pitch',
  V0: 'vib',
  V1: 'pump',
  A0: 'valve',
  A1: 'suck',
  A2: 'lube',
  EA: 'alpha',
  EB: 'beta',
  EV: 'volume',
  C0: 'frequency',
  P0: 'pulse_frequency',
  P1: 'pulse_width',
  P2: 'pulse_interval_random',
  P3: 'pulse_rise_time',
  E1: 'e1',
  E2: 'e2',
  E3: 'e3',
  E4: 'e4',
  S0: 'shock',
}
