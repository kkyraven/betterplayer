import { create } from 'zustand'
import type { AxisId } from '@shared/axes'
import { AXIS_IDS, isAxisId } from '@shared/axes'
import type { Region } from '@shared/browser'
import { AXIS_SUFFIX, type EditorBookmark, type EditorChapter, type EditorDocument, type EditorLane, type EditorPoint, type Pattern } from '@shared/editor'
import type { MessageKey } from '@shared/i18n'
import type { AudioPeaks, ScriptFile } from '@shared/ipc'
import { BEAT_BOUNCE_DEPTH, BEAT_BOUNCE_SPEED, beatSpeed } from '@shared/tracking'
import type { BeatTrackInfo, EditorScript } from 'bp-engine'
import { beatAnalyseAsync, beatGenerate, engine, funscriptBundle, funscriptJson, readScripts, simplifyIndices } from '@/engine/client'
import { invoke } from '@/ipc'
import { t } from '@/state/i18n'
import { AnalysisCache } from '@/editor/analysis'
import {
  applyChange,
  around,
  diffLane,
  flatten as flattenOp,
  indexAt,
  insertPoint,
  invert as invertOp,
  kinds,
  limitSpeed as limitSpeedOp,
  loopStroke,
  move as moveOp,
  nearest,
  normalise,
  quantise as quantiseOp,
  rangeExtend as rangeExtendOp,
  refit as refitOp,
  replaceRange,
  reverse as reverseOp,
  revertChange,
  scaleDepth as scaleDepthOp,
  scaleTime as scaleTimeOp,
  selectedIndices,
  selectionSpan,
  timesByDepth,
  timesBySpeed,
  valueAt,
  type LaneChange,
  type Turn,
} from '@/editor/ops'
import { adjustStrokes, cycles, fillEnd, findTurns, patternFromPoints, placeAtPeriod, placePattern, type HeightMode } from '@/editor/patterns'
import { OTHER_AXES, OTHER_AXIS_PRESETS, PATTERN_PRESETS, otherAxis, patternName } from '@/editor/presets'
import { defaultView, fitAll, pan, windowStart, zoomAboutPlayhead, zoomToRange, ZOOM_STEP, type View } from '@/editor/view'
import { fmtTimecode } from '@/lib/format'
import * as live from './live'
import { isUrl, usePlayer } from './player'
import { useSettings } from './settings'
import { useTracking } from './tracking'
import { useUi } from './ui'

export type Tool = 'select' | 'place'
export type CardKind = 'pattern' | 'fill' | 'record' | 'simplify' | 'scaleDepth' | 'scaleTime' | 'rangeExtend' | 'loop' | 'quantise' | 'limitSpeed' | 'selectBy'
export type SheetKind = 'shortcuts' | 'metadata' | 'export' | null
export type FillTo = 'cut' | 'selection' | 'chapter' | 'end'
export type AiSource = 'ai-motion' | 'video' | 'beat' | 'hero'
export type RecordInput = 'mouse' | 'gamepad' | 'device'
export type SelectBy = 'speed' | 'depth'
export type QuantiseTo = 'frames' | 'beats' | 'turns'
export type ExportKind = 'sibling' | 'bundle'

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const
export const AI_SOURCE_LABEL: Record<AiSource, MessageKey> = { 'ai-motion': 'editor.fill.source.aiMotion', video: 'editor.fill.source.video', beat: 'editor.fill.source.beat', hero: 'editor.fill.source.hero' }
export const FILL_TO_LABEL: Record<FillTo, MessageKey> = { cut: 'editor.pattern.to.cut', selection: 'editor.pattern.to.selection', chapter: 'editor.pattern.to.chapter', end: 'editor.pattern.to.end' }

const SNAP_MS = 120
const DRAFT_PUSH_MS = 100
const DRAFT_SAVE_AFTER_MS = 2000
const DRAFT_SAVE_EVERY_MS = 10_000
const UNDO_LEVELS = 200
const ANALYSE_CHUNK_MS = 20_000
const ANALYSE_AHEAD_MS = 10_000
const ANALYSE_BEHIND_MS = 2000
const THUMB_EVERY_MS = 1000
const RECORD_HZ = 60
const RECORD_EPS = 0.02
const FILL_EPS = 0.01
const DEFAULT_PERIOD_MS = 800

export interface Edit {
  lanes: Array<{ axis: AxisId; change: LaneChange }>
  chapters?: [EditorChapter[], EditorChapter[]]
  bookmarks?: [EditorBookmark[], EditorBookmark[]]
  flags?: [number[], number[]]
}

export interface Ghost {
  label: string
  kind?: 'recording' | 'refit'
  axis: AxisId
  base: EditorPoint[][]
  walk: number
  phaseMs: number
  depth: number
  startMs: number
  endMs: number
  replace: boolean
  note: string | null
  extra?: Array<{ axis: AxisId; points: EditorPoint[] }>
}

export interface FillOptions {
  to: FillTo
  height: HeightMode
  min: number
  max: number
  replace: boolean
}

export interface AiOptions {
  source: AiSource
  min: number
  max: number
  region: Region | null
  picking: boolean
}

export interface CardParams {
  simplifyEps: number
  depthFactor: number
  timeFactor: number
  rangeMin: number
  rangeMax: number
  loopTimes: number
  quantiseTo: QuantiseTo
  speedLimit: number
  selectBy: SelectBy
  selectMin: number
  selectMax: number
}

interface EditorState {
  open: boolean
  openingFile: string | null
  key: string | null
  title: string
  durationMs: number
  fps: number
  lanes: EditorLane[]
  hidden: AxisId[]
  chapters: EditorChapter[]
  bookmarks: EditorBookmark[]
  flags: number[]
  focused: AxisId
  linked: boolean
  selection: ReadonlySet<number>
  undoStack: Edit[]
  redoStack: Edit[]
  dirty: boolean
  savedAt: number | null
  exportedAt: number | null
  fileScript: boolean
  rev: number
  exportedRev: number
  draftOffer: { doc: EditorDocument; at: number } | null
  view: View
  tool: Tool
  card: CardKind | null
  cardParams: CardParams
  ghost: Ghost | null
  loop: { inMs: number | null; outMs: number | null; on: boolean }
  snap: boolean
  trace: boolean
  filmstrip: boolean
  waveform: boolean
  beatGrid: boolean
  patterns: Pattern[]
  pattern: Pattern
  patternPicker: boolean
  patternEditing: boolean
  fill: FillOptions
  ai: AiOptions
  recordInput: RecordInput
  recording: boolean
  recordPosNow: number
  analysisVersion: number
  analysing: boolean
  beatTrack: BeatTrackInfo | null
  beats: number[] | null
  peaks: AudioPeaks | null
  sheet: SheetKind
  message: string | null
  clipboard: EditorPoint[] | null

  openEditor: (path?: string) => Promise<void>
  sync: () => Promise<void>
  openWithScripts: (path: string, scripts: Array<{ axis: AxisId; json: string }>) => Promise<void>
  close: () => void
  restoreDraft: () => void
  discardDraft: () => void
  save: () => Promise<void>
  exportScripts: (kind: ExportKind) => Promise<void>

  setFocused: (axis: AxisId) => void
  stepLane: (dir: 1 | -1) => void
  addLane: (axis: AxisId) => void
  hideLane: (axis: AxisId) => void
  toggleLinked: () => void
  setTool: (tool: Tool) => void
  setCard: (card: CardKind | null) => void
  setCardParams: (patch: Partial<CardParams>) => void
  setSheet: (sheet: SheetKind) => void
  setMessage: (message: string | null) => void
  setView: (view: View) => void
  setOption: (key: 'snap' | 'trace' | 'filmstrip' | 'waveform' | 'beatGrid' | 'centre', on: boolean) => void

  select: (times: Iterable<number>, mode?: 'set' | 'add' | 'toggle') => void
  selectAll: () => void
  selectNone: () => void
  selectSide: (side: 'left' | 'right') => void
  selectKind: (kind: 'top' | 'bottom' | 'mid') => void
  selectBetweenCuts: () => void
  selectChapter: () => void
  invertSelection: () => void
  selectBox: (startMs: number, endMs: number, minPos: number, maxPos: number, add: boolean) => void
  openSelectBy: () => void
  applySelectBy: () => void

  placeAt: (pos: number, exact: boolean, atMs?: number) => void
  alternate: () => void
  removePoint: (atMs: number) => void
  deleteSelection: () => void
  moveSelection: (dPos: number, dMs: number) => void
  beginDrag: () => void
  dragLane: (points: EditorPoint[]) => void
  endDrag: () => void
  applyEdit: (fn: (points: EditorPoint[], axis: AxisId) => EditorPoint[]) => void
  invert: () => void
  reverse: () => void
  flatten: () => void
  cut: () => void
  copy: () => void
  paste: (exact: boolean) => void
  undo: () => void
  redo: () => void

  previewOp: (card: CardKind) => void
  fillPattern: () => void
  aiFill: () => Promise<void>
  refit: () => void
  otherAxes: () => void
  ghostWalk: (dir: 1 | -1) => void
  ghostAdjust: (phaseMs: number, depth: number) => void
  acceptGhost: () => void
  dropGhost: () => void
  ghostStrokes: () => EditorPoint[][]

  setPattern: (pattern: Pattern) => void
  savePattern: (name: string, points: Array<[number, number]>, id?: string) => Promise<void>
  deletePattern: (id: string) => Promise<void>
  takePatternFromSelection: () => Array<[number, number]> | null
  setFill: (patch: Partial<FillOptions>) => void
  setAi: (patch: Partial<AiOptions>) => void
  setPatternUi: (patch: { picker?: boolean; editing?: boolean }) => void
  fillSpan: () => { startMs: number; endMs: number } | null

  setRecordInput: (input: RecordInput) => void
  startRecord: () => void
  recordValue: (pos: number) => void
  stopRecord: () => void

  addBookmark: () => void
  chapterStart: () => void
  chapterEnd: () => void
  toggleFlag: () => void
  stepFlag: (dir: 1 | -1) => void
  renameMarker: (kind: 'chapter' | 'bookmark', index: number, name: string) => void
  deleteMarker: (kind: 'chapter' | 'bookmark', index: number) => void
  setMetadata: (metadata: Record<string, unknown>) => void

  togglePlay: () => void
  playFromSelection: () => void
  seekTo: (ms: number) => void
  frameStep: (frames: number) => void
  stepSeconds: (seconds: number) => void
  stepPoint: (dir: 1 | -1) => void
  stepCut: (dir: 1 | -1) => void
  stepMarker: (dir: 1 | -1) => void
  stepSpeed: (dir: 1 | -1) => void
  setSpeed: (rate: number) => void
  loopIn: () => void
  loopOut: () => void
  toggleLoop: () => void
  zoom: (factor: number) => void
  zoomSelection: () => void
  zoomFit: () => void
  panBy: (ms: number) => void
  escape: () => void

  wantAnalysis: (startMs: number, endMs: number) => void
  ensureBeats: () => Promise<void>
  ensurePeaks: () => Promise<void>
}

export const analysis = new AnalysisCache()

const round = (v: number) => Math.round(v)
const clampPos = (v: number) => Math.min(100, Math.max(0, v))
const laneOf = (lanes: EditorLane[], axis: AxisId) => lanes.find((l) => l.axis === axis)
const isTrackAxis = (axis: AxisId) => axis === 'L0' || axis === 'L1' || axis === 'L2' || axis === 'R0' || axis === 'R1' || axis === 'R2'

function simplify(points: EditorPoint[], eps: number): EditorPoint[] {
  if (points.length < 3) return points
  const kept = simplifyIndices(new Float64Array(points.map((p) => p.at)), new Float64Array(points.map((p) => p.pos / 100)), eps)
  const out: EditorPoint[] = []
  for (const i of kept) {
    const p = points[i]
    if (p) out.push(p)
  }
  return out
}

function docKey(doc: EditorDocument): string {
  return JSON.stringify([doc.lanes.map((l) => [l.axis, l.points.map((p) => [p.at, p.pos]), l.metadata]), doc.chapters, doc.bookmarks])
}

function lanesFromFiles(files: EditorScript[]): EditorDocument {
  const lanes: EditorLane[] = []
  let chapters: EditorChapter[] = []
  let bookmarks: EditorBookmark[] = []
  for (const axis of AXIS_IDS) {
    const script = files.find((f) => f.axis === axis && !f.variant) ?? files.find((f) => f.axis === axis)
    if (!script) continue
    const points: EditorPoint[] = []
    for (let i = 0; i < script.at.length; i++) points.push({ at: round(script.at[i] ?? 0), pos: (script.pos[i] ?? 0.5) * 100 })
    let metadata: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(script.metadata)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>
    } catch {
      metadata = {}
    }
    lanes.push({ axis, points: normalise(points), metadata })
    if (chapters.length === 0 && script.chapters.length > 0) chapters = script.chapters.map((c) => ({ name: c.name, startMs: c.startMs, endMs: c.endMs }))
    if (bookmarks.length === 0 && script.bookmarks.length > 0) bookmarks = script.bookmarks.map((b) => ({ name: b.name, atMs: b.atMs }))
  }
  return { lanes, chapters, bookmarks, flags: [] }
}

const nowMs = () => live.get().timeMs

export const useEditor = create<EditorState>()((set, get) => {
  const pushTimers = new Map<AxisId, number>()
  let draftTimer = 0
  let draftInterval = 0
  let drag: { axis: AxisId; before: EditorPoint[] } | null = null
  let recordSamples: EditorPoint[] = []
  let recordHandle = 0
  let recordLast = 0
  let recordPos = 50
  let analysing = false
  let wanted: [number, number] | null = null
  let analyseFailedAt = 0
  let opening = 0
  let beatAnalysis: { stamp: number; promise: Promise<void> } | null = null
  let openController: AbortController | null = null

  const document = (): EditorDocument => {
    const s = get()
    return { lanes: s.lanes, chapters: s.chapters, bookmarks: s.bookmarks, flags: s.flags }
  }

  const pushDraft = (axis: AxisId) => {
    window.clearTimeout(pushTimers.get(axis))
    pushTimers.set(
      axis,
      window.setTimeout(() => {
        const lane = laneOf(get().lanes, axis)
        if (!get().open) return
        if (!lane) engine.setDraft(axis)
        else engine.setDraft(axis, new Float64Array(lane.points.map((p) => p.at)), new Float64Array(lane.points.map((p) => p.pos / 100)))
      }, DRAFT_PUSH_MS),
    )
  }

  const writeDraft = () => {
    const { key, dirty, open } = get()
    if (!key || !dirty || !open) return
    void invoke('editor:saveDraft', key, document())
  }

  const markDirty = () => {
    set({ dirty: true, rev: get().rev + 1 })
    window.clearTimeout(draftTimer)
    draftTimer = window.setTimeout(writeDraft, DRAFT_SAVE_AFTER_MS)
    if (!draftInterval) draftInterval = window.setInterval(writeDraft, DRAFT_SAVE_EVERY_MS)
  }

  const commit = (edit: Edit) => {
    if (edit.lanes.length === 0 && !edit.chapters && !edit.bookmarks && !edit.flags) return
    const lanes = get().lanes.map((l) => {
      const change = edit.lanes.find((c) => c.axis === l.axis)?.change
      return change ? { ...l, points: applyChange(l.points, change) } : l
    })
    const patch: Partial<EditorState> = { lanes, undoStack: [...get().undoStack.slice(-(UNDO_LEVELS - 1)), edit], redoStack: [] }
    if (edit.chapters) patch.chapters = edit.chapters[1]
    if (edit.bookmarks) patch.bookmarks = edit.bookmarks[1]
    if (edit.flags) patch.flags = edit.flags[1]
    set(patch)
    for (const c of edit.lanes) pushDraft(c.axis)
    markDirty()
  }

  const targets = (): AxisId[] => {
    const s = get()
    return s.linked ? s.lanes.filter((l) => !s.hidden.includes(l.axis)).map((l) => l.axis) : [s.focused]
  }

  const editLanes = (axes: AxisId[], fn: (points: EditorPoint[], axis: AxisId) => EditorPoint[]) => {
    const changes: Edit['lanes'] = []
    for (const axis of axes) {
      const lane = laneOf(get().lanes, axis)
      if (!lane) continue
      const change = diffLane(lane.points, normalise(fn(lane.points, axis)))
      if (change) changes.push({ axis, change })
    }
    commit({ lanes: changes })
  }

  const focusedLane = () => laneOf(get().lanes, get().focused)

  const turnsIn = (startMs: number, endMs: number): Turn[] => findTurns(analysis.samples(startMs, endMs))

  const snapTime = (atMs: number): number => {
    if (!get().snap) return atMs
    const turns = turnsIn(atMs - SNAP_MS * 2, atMs + SNAP_MS * 2)
    let best = atMs
    let dist = SNAP_MS + 1
    for (const t of turns) {
      const d = Math.abs(t.t - atMs)
      if (d < dist) {
        dist = d
        best = t.t
      }
    }
    return round(best)
  }

  const frameMs = () => 1000 / Math.max(1, get().fps)

  const fillRange = (startMs: number): { endMs: number; note: string | null } => {
    const s = get()
    const lane = focusedLane()
    const span = lane ? selectionSpan(lane.points, s.selection) : null
    switch (s.fill.to) {
      case 'selection':
        return span && span.endMs > startMs ? { endMs: span.endMs, note: t('editor.message.stoppedAtSelectionEnd') } : { endMs: Math.min(s.durationMs, startMs + 10_000), note: null }
      case 'chapter': {
        const chapter = s.chapters.find((c) => c.startMs <= startMs && c.endMs > startMs)
        return chapter ? { endMs: chapter.endMs, note: t('editor.message.stoppedAtChapterEnd', { time: fmtTimecode(chapter.endMs) }) } : { endMs: s.durationMs, note: null }
      }
      case 'end':
        return { endMs: s.durationMs, note: null }
      case 'cut': {
        const cut = analysis.cutsAround(startMs).after
        return cut !== null ? { endMs: cut, note: t('editor.message.stoppedAtCut', { time: fmtTimecode(cut) }) } : { endMs: Math.min(s.durationMs, startMs + 30_000), note: null }
      }
    }
  }

  const showGhost = (ghost: Ghost) => {
    set({ ghost, card: get().card === 'record' ? null : get().card })
    set({ view: zoomToRange(get().view, ghost.startMs, ghost.endMs, get().durationMs) })
  }

  const stopRecordLoop = () => {
    cancelAnimationFrame(recordHandle)
    recordHandle = 0
  }

  const pump = () => {
    const s = get()
    if (analysing || !wanted || !s.open || !s.key || isUrl(s.key) || !s.trace) return
    if (performance.now() - analyseFailedAt < 3000) return
    const [ws, we] = wanted
    const gap = analysis.missing(Math.max(0, ws), Math.min(s.durationMs || we, we))[0]
    if (!gap) return
    const [gs, ge] = gap
    const endMs = Math.min(ge, gs + ANALYSE_CHUNK_MS)
    analysing = true
    set({ analysing: true })
    engine
      .analyseRange({ startMs: gs, endMs, thumbsEveryMs: THUMB_EVERY_MS, thumbWidth: 96 })
      .then((r) => {
        analysis.add(r)
        set({ analysisVersion: get().analysisVersion + 1 })
      })
      .catch((e: unknown) => {
        analyseFailedAt = performance.now()
        console.debug(`analyse: ${String(e)}`)
      })
      .finally(() => {
        analysing = false
        set({ analysing: false })
        pump()
      })
  }

  const clearTimers = () => {
    for (const t of pushTimers.values()) window.clearTimeout(t)
    pushTimers.clear()
    window.clearTimeout(draftTimer)
    window.clearInterval(draftInterval)
    draftInterval = 0
    stopRecordLoop()
  }

  return {
    open: false,
    openingFile: null,
    key: null,
    title: '',
    durationMs: 0,
    fps: 60,
    lanes: [],
    hidden: [],
    chapters: [],
    bookmarks: [],
    flags: [],
    focused: 'L0',
    linked: false,
    selection: new Set(),
    undoStack: [],
    redoStack: [],
    dirty: false,
    savedAt: null,
    exportedAt: null,
    fileScript: false,
    rev: 0,
    exportedRev: 0,
    draftOffer: null,
    view: defaultView(),
    tool: 'select',
    card: null,
    cardParams: { simplifyEps: 0.02, depthFactor: 1, timeFactor: 1, rangeMin: 0, rangeMax: 100, loopTimes: 4, quantiseTo: 'turns', speedLimit: 400, selectBy: 'speed', selectMin: 300, selectMax: 1000 },
    ghost: null,
    loop: { inMs: null, outMs: null, on: false },
    snap: true,
    trace: true,
    filmstrip: false,
    waveform: false,
    beatGrid: false,
    patterns: [],
    pattern: PATTERN_PRESETS[0] ?? { id: 'full', name: 'editor.presets.full', points: [[0, 0], [0.5, 100], [1, 0]], builtin: true },
    patternPicker: false,
    patternEditing: false,
    fill: { to: 'cut', height: 'pattern', min: 10, max: 90, replace: false },
    ai: { source: 'ai-motion', min: 0, max: 100, region: null, picking: false },
    recordInput: 'mouse',
    recording: false,
    recordPosNow: 50,
    analysisVersion: 0,
    analysing: false,
    beatTrack: null,
    beats: null,
    peaks: null,
    sheet: null,
    message: null,
    clipboard: null,

    openEditor: async (path) => {
      get().close()
      useUi.getState().setScreen('editor')
      if (!path) return
      const stamp = opening
      const controller = new AbortController()
      openController = controller
      set({ openingFile: path, message: null })
      try {
        const player = usePlayer.getState()
        if (path !== player.path || !player.snapshot.loaded || player.snapshot.error) await player.open(path, undefined, undefined, false, controller.signal)
        if (stamp !== opening || usePlayer.getState().path !== path) return
        usePlayer.getState().pause()
        await get().sync()
      } catch {
        if (stamp === opening) set({ message: t('editor.start.openFailed') })
      } finally {
        if (stamp === opening) {
          openController = null
          set({ openingFile: null })
        }
      }
    },

    sync: async () => {
      const player = usePlayer.getState()
      const key = get().openingFile
      const s = get()
      if (key === s.key && s.open) return
      const stamp = opening
      if (!key || player.path !== key) return
      const [stored, files, patterns] = await Promise.all([invoke('editor:load', key), isUrl(key) ? Promise.resolve([] as EditorScript[]) : readScripts(key), invoke('editor:patterns')])
      if (stamp !== opening || usePlayer.getState().path !== key) return
      const fromFiles = lanesFromFiles(files)
      const base = stored.saved ?? fromFiles
      const lanes = base.lanes.length > 0 ? base.lanes : [{ axis: 'L0' as const, points: [], metadata: {} }]
      const focused = lanes.some((l) => l.axis === 'L0') ? 'L0' : (lanes[0]?.axis ?? 'L0')
      const fps = engine.videoFps() || 60
      set({
        open: true,
        key,
        title: usePlayer.getState().title,
        durationMs: player.snapshot.durationMs,
        fps,
        lanes,
        hidden: [],
        chapters: base.chapters,
        bookmarks: base.bookmarks,
        flags: base.flags,
        focused,
        linked: false,
        selection: new Set(),
        undoStack: [],
        redoStack: [],
        dirty: false,
        savedAt: stored.savedAt,
        exportedAt: stored.exportedAt,
        fileScript: fromFiles.lanes.some((l) => l.points.length > 0),
        rev: 0,
        exportedRev: stored.exported ? (docKey(stored.exported) === docKey(base) ? 0 : -1) : stored.saved ? -1 : 0,
        draftOffer: stored.draft && stored.draftAt !== null ? { doc: stored.draft, at: stored.draftAt } : null,
        view: defaultView(),
        ghost: null,
        card: null,
        recording: false,
        patterns,
        analysisVersion: 0,
        beatTrack: null,
        beats: null,
        peaks: null,
        message: null,
      })
      analysis.clear()
      if (stored.saved) for (const lane of lanes) pushDraft(lane.axis)
    },

    openWithScripts: async (path, scripts) => {
      await get().openEditor(path)
      if (get().key !== path) return
      const lanes: EditorLane[] = []
      for (const s of scripts) {
        try {
          const parsed: unknown = JSON.parse(s.json)
          const actions = typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { actions?: unknown }).actions) ? ((parsed as { actions: unknown[] }).actions as Array<{ at?: unknown; pos?: unknown }>) : []
          const points = actions.flatMap((a) => (typeof a.at === 'number' && typeof a.pos === 'number' ? [{ at: a.at, pos: a.pos }] : []))
          lanes.push({ axis: s.axis, points: normalise(points), metadata: {} })
        } catch {
          continue
        }
      }
      if (lanes.length === 0) return
      const kept = get().lanes.filter((l) => !lanes.some((n) => n.axis === l.axis))
      set({ lanes: [...lanes, ...kept], focused: lanes.some((l) => l.axis === 'L0') ? 'L0' : (lanes[0]?.axis ?? 'L0'), selection: new Set(), undoStack: [], redoStack: [] })
      for (const lane of lanes) pushDraft(lane.axis)
      markDirty()
    },

    close: () => {
      opening++
      openController?.abort()
      openController = null
      beatAnalysis = null
      const wasOpen = get().open
      clearTimers()
      writeDraft()
      if (wasOpen) {
        engine.analyseCancel()
        engine.clearDraft()
        engine.analyseClose()
      }
      analysis.clear()
      wanted = null
      set({ open: false, openingFile: null, message: null, key: null, beatTrack: null, beats: null, analysing: false, lanes: [], chapters: [], bookmarks: [], flags: [], selection: new Set(), undoStack: [], redoStack: [], ghost: null, card: null, recording: false, dirty: false, exportedAt: null, fileScript: false, rev: 0, exportedRev: 0, draftOffer: null, sheet: null })
    },

    restoreDraft: () => {
      const offer = get().draftOffer
      if (!offer) return
      set({ lanes: offer.doc.lanes, chapters: offer.doc.chapters, bookmarks: offer.doc.bookmarks, flags: offer.doc.flags, draftOffer: null, undoStack: [], redoStack: [], selection: new Set() })
      for (const lane of offer.doc.lanes) pushDraft(lane.axis)
      markDirty()
    },

    discardDraft: () => {
      const { key } = get()
      set({ draftOffer: null })
      if (key) void invoke('editor:discardDraft', key)
    },

    save: async () => {
      const { key, open } = get()
      if (!key || !open) return
      window.clearTimeout(draftTimer)
      const savedAt = await invoke('editor:save', key, document())
      set({ savedAt, dirty: false, message: t('editor.message.savedToLibrary') })
    },

    exportScripts: async (kind) => {
      const s = get()
      const player = usePlayer.getState()
      if (!s.key || !player.path) return
      const durationSeconds = s.durationMs / 1000
      const input = (lane: EditorLane) => ({
        at: new Float64Array(lane.points.map((p) => p.at)),
        pos: new Float64Array(lane.points.map((p) => p.pos / 100)),
        chapters: s.chapters,
        bookmarks: s.bookmarks,
        metadata: JSON.stringify(lane.metadata),
        durationSeconds,
      })
      const lanes = s.lanes.filter((l) => l.points.length > 0)
      const doc = document()
      const rev = s.rev
      let files: ScriptFile[]
      if (kind === 'bundle') {
        const root = lanes.find((l) => l.axis === 'L0') ?? lanes[0]
        if (!root) return
        const axes = lanes.filter((l) => l !== root).map((l) => ({ axis: l.axis, at: new Float64Array(l.points.map((p) => p.at)), pos: new Float64Array(l.points.map((p) => p.pos / 100)) }))
        files = [{ suffix: AXIS_SUFFIX[root.axis], json: funscriptBundle(input(root), axes) }]
      } else {
        files = lanes.map((l) => ({ suffix: AXIS_SUFFIX[l.axis], json: funscriptJson(input(l)) }))
      }
      if (files.length === 0) return
      try {
        const paths = await invoke('editor:export', player.path, player.title, files)
        if (paths) {
          const exportedAt = await invoke('editor:markExported', s.key, doc)
          set({ exportedAt, exportedRev: rev, message: t('editor.message.exported', { count: paths.length }), sheet: null })
        }
      } catch (e) {
        set({ message: t('editor.message.exportFailed', { error: String(e) }) })
      }
    },

    setFocused: (axis) => {
      if (axis !== get().focused) set({ focused: axis, selection: new Set(), ghost: null })
    },
    stepLane: (dir) => {
      const s = get()
      const shown = s.lanes.filter((l) => !s.hidden.includes(l.axis))
      const i = shown.findIndex((l) => l.axis === s.focused)
      const next = shown[(i + dir + shown.length) % shown.length]
      if (next) get().setFocused(next.axis)
    },
    addLane: (axis) => {
      const s = get()
      if (laneOf(s.lanes, axis)) {
        set({ hidden: s.hidden.filter((a) => a !== axis), focused: axis })
        return
      }
      set({ lanes: [...s.lanes, { axis, points: [], metadata: {} }], focused: axis, selection: new Set() })
      markDirty()
    },
    hideLane: (axis) => {
      const s = get()
      const shown = s.lanes.filter((l) => !s.hidden.includes(l.axis) && l.axis !== axis)
      if (shown.length === 0) return
      set({ hidden: [...s.hidden, axis], focused: s.focused === axis ? (shown[0]?.axis ?? s.focused) : s.focused })
    },
    toggleLinked: () => set({ linked: !get().linked }),
    setTool: (tool) => set({ tool }),
    setCard: (card) => {
      if (card === null && get().recording) get().stopRecord()
      set({ card, ai: { ...get().ai, picking: false }, patternPicker: false, patternEditing: false })
      if (card === 'record') set({ ghost: null })
    },
    setCardParams: (patch) => {
      set({ cardParams: { ...get().cardParams, ...patch } })
      const card = get().card
      if (card === 'selectBy') get().applySelectBy()
      else if (card && card !== 'pattern' && card !== 'fill' && card !== 'record') get().previewOp(card)
    },
    setSheet: (sheet) => {
      set({ sheet })
    },
    setMessage: (message) => set({ message }),
    setView: (view) => set({ view }),
    setOption: (key, on) => {
      if (key === 'centre') set({ view: { ...get().view, centre: on } })
      else set({ [key]: on } as Partial<EditorState>)
      if (key === 'trace' && on) pump()
      if (key === 'beatGrid' && on) void get().ensureBeats()
      if (key === 'waveform' && on) void get().ensurePeaks()
    },

    select: (times, mode = 'set') => {
      const next = new Set(mode === 'set' ? [] : get().selection)
      for (const t of times) {
        if (mode === 'toggle' && next.has(t)) next.delete(t)
        else next.add(t)
      }
      set({ selection: next })
    },
    selectAll: () => {
      const lane = focusedLane()
      set({ selection: new Set(lane?.points.map((p) => p.at) ?? []) })
    },
    selectNone: () => set({ selection: new Set() }),
    selectSide: (side) => {
      const lane = focusedLane()
      const t = nowMs()
      set({ selection: new Set(lane?.points.filter((p) => (side === 'left' ? p.at <= t : p.at >= t)).map((p) => p.at) ?? []) })
    },
    selectKind: (kind) => {
      const lane = focusedLane()
      if (!lane) return
      const k = kinds(lane.points)
      set({ selection: new Set(lane.points.filter((_, i) => k[i] === kind).map((p) => p.at)) })
    },
    selectBetweenCuts: () => {
      const lane = focusedLane()
      if (!lane) return
      const t = nowMs()
      const { before, after } = analysis.cutsAround(t)
      const from = before ?? 0
      const to = after ?? get().durationMs
      set({ selection: new Set(lane.points.filter((p) => p.at >= from && p.at <= to).map((p) => p.at)) })
    },
    selectChapter: () => {
      const lane = focusedLane()
      const t = nowMs()
      const chapter = get().chapters.find((c) => c.startMs <= t && c.endMs >= t)
      if (!lane || !chapter) return
      set({ selection: new Set(lane.points.filter((p) => p.at >= chapter.startMs && p.at <= chapter.endMs).map((p) => p.at)) })
    },
    invertSelection: () => {
      const lane = focusedLane()
      const sel = get().selection
      set({ selection: new Set(lane?.points.filter((p) => !sel.has(p.at)).map((p) => p.at) ?? []) })
    },
    selectBox: (startMs, endMs, minPos, maxPos, add) => {
      const lane = focusedLane()
      if (!lane) return
      const hit = lane.points.filter((p) => p.at >= startMs && p.at <= endMs && p.pos >= minPos && p.pos <= maxPos).map((p) => p.at)
      get().select(hit, add ? 'add' : 'set')
    },
    openSelectBy: () => {
      set({ card: 'selectBy', ghost: null })
      get().applySelectBy()
    },
    applySelectBy: () => {
      const lane = focusedLane()
      const p = get().cardParams
      if (!lane) return
      const times = p.selectBy === 'speed' ? timesBySpeed(lane.points, p.selectMin, p.selectMax) : timesByDepth(lane.points, p.selectMin, p.selectMax)
      set({ selection: new Set(times) })
    },

    placeAt: (pos, exact, atMs) => {
      const at = round(exact ? (atMs ?? nowMs()) : snapTime(atMs ?? nowMs()))
      editLanes([get().focused], (points) => insertPoint(points, { at, pos: clampPos(pos) }))
      set({ selection: new Set([at]) })
    },
    alternate: () => {
      const s = get()
      if (s.ghost) {
        get().acceptGhost()
        return
      }
      const lane = focusedLane()
      const t = nowMs()
      const { before } = around(lane?.points ?? [], t)
      let pos: number
      if (s.fill.height === 'range') {
        const half = (s.fill.min + s.fill.max) / 2
        pos = before && before.pos > half ? s.fill.min : s.fill.max
      } else {
        const prev = lane ? lane.points[indexAt(lane.points, t) - 2] : undefined
        const k = before ? (prev ? (before.pos >= prev.pos ? 'top' : 'bottom') : before.pos >= 50 ? 'top' : 'bottom') : 'bottom'
        pos = k === 'top' ? (prev?.pos ?? 0) : (prev?.pos ?? 100)
      }
      get().placeAt(pos, false)
    },
    removePoint: (atMs) => {
      editLanes([get().focused], (points) => points.filter((p) => p.at !== atMs))
      const sel = new Set(get().selection)
      sel.delete(atMs)
      set({ selection: sel })
    },
    deleteSelection: () => {
      const s = get()
      if (s.selection.size === 0) {
        const lane = focusedLane()
        const t = nowMs()
        const hit = lane?.points.find((p) => Math.abs(p.at - t) <= frameMs() / 2)
        if (hit) get().removePoint(hit.at)
        return
      }
      const sel = s.selection
      editLanes(targets(), (points) => points.filter((p) => !sel.has(p.at)))
      set({ selection: new Set() })
    },
    moveSelection: (dPos, dMs) => {
      const sel = get().selection
      if (sel.size === 0) return
      const shift = round(dMs)
      editLanes(targets(), (points) => moveOp(points, sel, dPos, shift))
      const lane = focusedLane()
      if (lane) {
        const moved = new Set<number>()
        for (const t of sel) {
          const candidate = lane.points.find((p) => p.at === t + shift)
          moved.add(candidate ? candidate.at : t)
        }
        if (shift !== 0) set({ selection: new Set([...moved].filter((t) => lane.points.some((p) => p.at === t))) })
      }
    },
    beginDrag: () => {
      const lane = focusedLane()
      if (lane) drag = { axis: lane.axis, before: lane.points }
    },
    dragLane: (points) => {
      if (!drag) return
      const axis = drag.axis
      set({ lanes: get().lanes.map((l) => (l.axis === axis ? { ...l, points } : l)) })
      pushDraft(axis)
    },
    endDrag: () => {
      if (!drag) return
      const { axis, before } = drag
      drag = null
      const lane = laneOf(get().lanes, axis)
      if (!lane) return
      const after = normalise(lane.points)
      const change = diffLane(before, after)
      if (!change) return
      set({ lanes: get().lanes.map((l) => (l.axis === axis ? { ...l, points: before } : l)) })
      commit({ lanes: [{ axis, change }] })
    },
    applyEdit: (fn) => editLanes(targets(), fn),
    invert: () => {
      const sel = get().selection
      editLanes(targets(), (points) => invertOp(points, sel))
    },
    reverse: () => {
      const sel = get().selection
      editLanes(targets(), (points) => reverseOp(points, sel))
    },
    flatten: () => {
      const sel = get().selection
      editLanes(targets(), (points) => flattenOp(points, sel))
    },
    copy: () => {
      const lane = focusedLane()
      const sel = get().selection
      const points = lane?.points.filter((p) => sel.has(p.at)) ?? []
      if (points.length > 0) set({ clipboard: points, message: t('editor.message.copied', { count: points.length }) })
    },
    cut: () => {
      get().copy()
      get().deleteSelection()
    },
    paste: (exact) => {
      const { clipboard } = get()
      const first = clipboard?.[0]
      if (!clipboard || !first) return
      const offset = exact ? 0 : round(nowMs()) - first.at
      const pasted = clipboard.map((p) => ({ at: p.at + offset, pos: p.pos }))
      const from = pasted[0]?.at ?? 0
      const to = pasted[pasted.length - 1]?.at ?? 0
      editLanes([get().focused], (points) => replaceRange(points, from, to, pasted))
      set({ selection: new Set(pasted.map((p) => p.at)) })
    },
    undo: () => {
      const s = get()
      const edit = s.undoStack[s.undoStack.length - 1]
      if (!edit) return
      const lanes = s.lanes.map((l) => {
        const change = edit.lanes.find((c) => c.axis === l.axis)?.change
        return change ? { ...l, points: revertChange(l.points, change) } : l
      })
      const patch: Partial<EditorState> = { lanes, undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, edit], ghost: null }
      if (edit.chapters) patch.chapters = edit.chapters[0]
      if (edit.bookmarks) patch.bookmarks = edit.bookmarks[0]
      if (edit.flags) patch.flags = edit.flags[0]
      set(patch)
      for (const c of edit.lanes) pushDraft(c.axis)
      markDirty()
    },
    redo: () => {
      const s = get()
      const edit = s.redoStack[s.redoStack.length - 1]
      if (!edit) return
      set({ redoStack: s.redoStack.slice(0, -1) })
      const lanes = get().lanes.map((l) => {
        const change = edit.lanes.find((c) => c.axis === l.axis)?.change
        return change ? { ...l, points: applyChange(l.points, change) } : l
      })
      const patch: Partial<EditorState> = { lanes, undoStack: [...get().undoStack, edit], ghost: null }
      if (edit.chapters) patch.chapters = edit.chapters[1]
      if (edit.bookmarks) patch.bookmarks = edit.bookmarks[1]
      if (edit.flags) patch.flags = edit.flags[1]
      set(patch)
      for (const c of edit.lanes) pushDraft(c.axis)
      markDirty()
    },

    previewOp: (card) => {
      const s = get()
      const lane = focusedLane()
      if (!lane) return
      const span = selectionSpan(lane.points, s.selection)
      if (!span) {
        set({ card, message: t('editor.message.selectPointsFirst') })
        return
      }
      const inSpan = new Set(lane.points.filter((p) => p.at >= span.startMs && p.at <= span.endMs).map((p) => p.at))
      const p = s.cardParams
      let out: EditorPoint[]
      let label: MessageKey
      switch (card) {
        case 'simplify':
          out = simplify(
            lane.points.filter((x) => inSpan.has(x.at)),
            p.simplifyEps,
          )
          label = 'editor.ghost.simplify'
          break
        case 'scaleDepth':
          out = scaleDepthOp(lane.points, inSpan, p.depthFactor).filter((x) => inSpan.has(x.at))
          label = 'editor.ghost.scaleDepth'
          break
        case 'scaleTime': {
          const scaled = scaleTimeOp(lane.points, inSpan, p.timeFactor)
          const end = span.startMs + (span.endMs - span.startMs) * p.timeFactor
          out = scaled.filter((x) => x.at >= span.startMs && x.at <= end)
          label = 'editor.ghost.scaleTime'
          break
        }
        case 'rangeExtend':
          out = rangeExtendOp(lane.points, inSpan, p.rangeMin, p.rangeMax).filter((x) => inSpan.has(x.at))
          label = 'editor.ghost.rangeExtend'
          break
        case 'loop': {
          const looped = loopStroke(lane.points, inSpan, p.loopTimes)
          const end = span.endMs + (span.endMs - span.startMs) * p.loopTimes
          out = looped.filter((x) => x.at >= span.startMs && x.at <= end)
          label = 'editor.ghost.loop'
          break
        }
        case 'limitSpeed':
          out = limitSpeedOp(lane.points, inSpan, p.speedLimit).filter((x) => inSpan.has(x.at))
          label = 'editor.ghost.limitSpeed'
          break
        case 'quantise': {
          const grid =
            p.quantiseTo === 'frames'
              ? Array.from({ length: Math.ceil((span.endMs - span.startMs) / frameMs()) + 2 }, (_, i) => round(Math.floor(span.startMs / frameMs()) * frameMs() + i * frameMs()))
              : p.quantiseTo === 'beats'
                ? (s.beats ?? [])
                : turnsIn(span.startMs - 500, span.endMs + 500).map((t) => t.t)
          out = quantiseOp(lane.points, inSpan, grid).filter((x) => x.at >= span.startMs - 500 && x.at <= span.endMs + 500)
          label = 'editor.ghost.quantise'
          break
        }
        default:
          return
      }
      const start = Math.min(span.startMs, out[0]?.at ?? span.startMs)
      const end = Math.max(span.endMs, out[out.length - 1]?.at ?? span.endMs)
      set({ card, ghost: { label: t(label), axis: lane.axis, base: [out], walk: -1, phaseMs: 0, depth: 1, startMs: start, endMs: end, replace: true, note: null } })
    },

    fillPattern: () => {
      const s = get()
      const lane = focusedLane()
      if (!lane) return
      const span = selectionSpan(lane.points, s.selection)
      const startMs = round(span ? span.startMs : nowMs())
      const range = fillRange(startMs)
      const stop = fillEnd(lane.points, startMs, range.endMs, s.fill.replace)
      const endMs = stop.endMs
      if (endMs - startMs < 50) {
        set({ message: t('editor.message.nothingToFill') })
        return
      }
      const found = cycles(turnsIn(startMs, endMs)).filter((c) => c.start >= startMs && c.end <= endMs)
      const options = { mode: s.fill.height, min: s.fill.min, max: s.fill.max }
      let strokes = found.length > 0 ? placePattern(s.pattern, found, options) : placeAtPeriod(s.pattern, startMs, endMs, DEFAULT_PERIOD_MS, options)
      strokes = strokes.map((stroke) => simplify(stroke, FILL_EPS))
      if (strokes.length === 0) {
        set({ message: t('editor.message.noCycles') })
        return
      }
      const lastCycleEnd = found[found.length - 1]?.end ?? endMs
      const note =
        stop.stoppedBy === 'point'
          ? t('editor.message.stoppedAtPoint', { time: fmtTimecode(endMs) })
          : found.length === 0
            ? t('editor.message.noMotionRepeated')
            : lastCycleEnd < endMs - 1000
              ? t('editor.message.noCyclesAfter', { time: fmtTimecode(lastCycleEnd) })
              : range.note
      showGhost({ label: patternName(s.pattern, t), axis: lane.axis, base: strokes, walk: -1, phaseMs: 0, depth: 1, startMs, endMs: Math.min(endMs, lastCycleEnd), replace: s.fill.replace, note })
    },

    aiFill: async () => {
      const s = get()
      const stamp = opening
      const lane = focusedLane()
      if (!lane || !s.key) return
      const span = selectionSpan(lane.points, s.selection)
      const startMs = round(span ? span.startMs : nowMs())
      const endMs = span ? span.endMs : fillRange(startMs).endMs
      if (endMs - startMs < 50) return
      const mapPos = (v: number) => s.ai.min + clampPos(v * 100) * ((s.ai.max - s.ai.min) / 100)
      let points: EditorPoint[] = []
      try {
        if (s.ai.source === 'ai-motion') {
          if (engine.modelState('motion').status !== 'ready') {
            set({ message: t('editor.message.motionNotLoaded') })
            return
          }
          set({ analysing: true })
          const r = await engine.analyseRange({ startMs, endMs, region: s.ai.region ?? undefined, model: true })
          const axis = r.model.find((m) => m.axis === lane.axis)
          if (axis) for (let i = 0; i < axis.at.length; i++) points.push({ at: round(axis.at[i] ?? 0), pos: mapPos(axis.pos[i] ?? 0.5) })
        } else if (s.ai.source === 'video') {
          let samples = analysis.samples(startMs, endMs)
          if (samples.length === 0 || analysis.missing(startMs, endMs, 200).length > 0) {
            set({ analysing: true })
            const r = await engine.analyseRange({ startMs, endMs, region: s.ai.region ?? undefined, thumbsEveryMs: THUMB_EVERY_MS, thumbWidth: 96 })
            analysis.add(r)
            set({ analysisVersion: get().analysisVersion + 1 })
            samples = analysis.samples(startMs, endMs)
          }
          points = simplify(
            samples.map((x) => ({ at: round(x.t), pos: mapPos(x.v / 100) })),
            FILL_EPS,
          )
        } else if (s.ai.source === 'hero') {
          const tracking = useTracking.getState()
          if (!tracking.heroZone) {
            set({ message: t('editor.message.heroZone') })
            return
          }
          engine.setHeroOptions(tracking.heroZone, tracking.heroDirection)
          set({ analysing: true })
          const r = await engine.analyseRange({ startMs, endMs, hero: true })
          const axis = r.hero.find((h) => h.axis === lane.axis)
          if (axis) for (let i = 0; i < axis.at.length; i++) points.push({ at: round(axis.at[i] ?? 0), pos: mapPos(axis.pos[i] ?? 0.5) })
        } else {
          set({ analysing: true })
          await get().ensureBeats()
          if (opening !== stamp || get().key !== s.key || get().focused !== lane.axis) return
          const track = get().beatTrack
          const defaults = useSettings.getState().settings?.tracking
          const tracking = useTracking.getState()
          const twistSpeed = lane.axis === 'R0' ? beatSpeed(tracking.axes.R0.intensity) : 1
          if (track) points = beatGenerate(track, {
            style: 'strokes',
            volumeDepth: defaults?.beatVolumeDepth ?? false,
            flourishes: (defaults?.flourishes ?? true) && (defaults?.beatBounce ?? true),
            bounceDepth: defaults?.beatBounceDepth ?? BEAT_BOUNCE_DEPTH.default,
            bounceSpeed: defaults?.beatBounceSpeed ?? BEAT_BOUNCE_SPEED.default,
            tempoFactor: (tracking.beatTempoFactor ?? 1) * twistSpeed,
            fps: s.fps,
            min: s.ai.min,
            max: s.ai.max,
            alternate: ['R0', 'R1', 'R2', 'L1', 'L2'].includes(lane.axis),
          }).filter((p) => p.at >= startMs && p.at <= endMs)
        }
      } catch (e) {
        if (opening === stamp) set({ message: t('editor.message.fillFailed', { error: String(e) }) })
        return
      } finally {
        if (opening === stamp) set({ analysing: false })
      }
      if (opening !== stamp || get().focused !== lane.axis) return
      points = normalise(points).filter((p) => p.at >= startMs && p.at <= endMs)
      if (points.length < 2) {
        if (s.ai.source === 'beat') return
        set({ message: t('editor.message.nothingFound') })
        return
      }
      showGhost({ label: t(AI_SOURCE_LABEL[s.ai.source]), axis: lane.axis, base: [points], walk: -1, phaseMs: 0, depth: 1, startMs, endMs, replace: true, note: null })
    },

    refit: () => {
      const s = get()
      const lane = focusedLane()
      if (!lane) return
      const span = selectionSpan(lane.points, s.selection)
      if (!span) {
        set({ message: t('editor.message.selectPointsFirst') })
        return
      }
      const turns = turnsIn(span.startMs - 500, span.endMs + 500)
      if (turns.length === 0) {
        set({ message: t('editor.message.noMotionAnalysed') })
        return
      }
      const out = refitOp(lane.points, s.selection, turns).filter((p) => p.at >= span.startMs - 260 && p.at <= span.endMs + 260)
      const start = Math.min(span.startMs, out[0]?.at ?? span.startMs)
      const end = Math.max(span.endMs, out[out.length - 1]?.at ?? span.endMs)
      set({ ghost: { label: t('editor.ghost.refitTiming'), kind: 'refit', axis: lane.axis, base: [out], walk: -1, phaseMs: 0, depth: 1, startMs: start, endMs: end, replace: true, note: null } })
    },

    otherAxes: () => {
      const s = get()
      const stroke = laneOf(s.lanes, 'L0')
      if (!stroke) return
      const span = selectionSpan(stroke.points, s.selection)
      const source = span ? stroke.points.filter((p) => p.at >= span.startMs && p.at <= span.endMs) : stroke.points
      if (source.length < 3) {
        set({ message: t('editor.message.selectStrokeFirst') })
        return
      }
      const extra = OTHER_AXES.map((axis) => ({ axis, points: otherAxis(source, OTHER_AXIS_PRESETS[axis]) })).filter((e) => e.points.length > 0)
      const first = extra[0]
      if (!first) return
      const startMs = Math.min(...extra.map((e) => e.points[0]?.at ?? Infinity))
      const endMs = Math.max(...extra.map((e) => e.points[e.points.length - 1]?.at ?? 0))
      set({ ghost: { label: t('editor.ghost.otherAxes'), axis: first.axis, base: [first.points], walk: -1, phaseMs: 0, depth: 1, startMs, endMs, replace: true, note: t('editor.ghost.otherAxesNote'), extra } })
    },

    ghostWalk: (dir) => {
      const g = get().ghost
      if (!g) return
      const n = g.base.length
      const next = g.walk + dir
      set({ ghost: { ...g, walk: next < -1 ? n - 1 : next >= n ? -1 : next } })
    },
    ghostAdjust: (phaseMs, depth) => {
      const g = get().ghost
      if (!g) return
      set({ ghost: { ...g, phaseMs: g.phaseMs + phaseMs, depth: Math.max(0.1, Math.min(2, g.depth * depth)) } })
    },
    ghostStrokes: () => {
      const g = get().ghost
      return g ? adjustStrokes(g.base, g.phaseMs, g.depth) : []
    },
    acceptGhost: () => {
      const s = get()
      const g = s.ghost
      if (!g) return
      const strokes = get().ghostStrokes()
      const chosen = g.walk === -1 ? strokes : [strokes[g.walk]].filter((x): x is EditorPoint[] => x !== undefined)
      const points = normalise(chosen.flat())
      const first = points[0]
      const last = points[points.length - 1]
      if (!first || !last) return
      const changes: AxisId[] = [g.axis]
      const edits = new Map<AxisId, (p: EditorPoint[]) => EditorPoint[]>()
      edits.set(g.axis, (existing) => (g.replace ? replaceRange(existing, first.at, last.at, points) : normalise([...existing, ...points])))
      if (g.walk === -1 && g.extra) {
        for (const e of g.extra) {
          if (!laneOf(get().lanes, e.axis)) set({ lanes: [...get().lanes, { axis: e.axis, points: [], metadata: {} }] })
          const ef = e.points[0]
          const el = e.points[e.points.length - 1]
          if (!ef || !el) continue
          edits.set(e.axis, (existing) => replaceRange(existing, ef.at, el.at, e.points))
          changes.push(e.axis)
        }
      }
      editLanes(changes, (existing, axis) => edits.get(axis)?.(existing) ?? existing)
      if (g.walk === -1 || g.base.length <= 1) {
        set({ ghost: null, selection: new Set(points.map((p) => p.at)), message: g.kind === 'refit' ? t('editor.message.timingRefitted') : null })
      } else {
        const base = g.base.filter((_, i) => i !== g.walk)
        set({ ghost: { ...g, base, walk: g.walk >= base.length ? -1 : g.walk } })
      }
    },
    dropGhost: () => set({ ghost: null }),

    setPattern: (pattern) => set({ pattern }),
    savePattern: async (name, points, id) => {
      const patterns = await invoke('editor:savePattern', { id: id ?? '', name, points })
      const saved = patterns.find((p) => p.name === name) ?? get().pattern
      set({ patterns, pattern: saved })
    },
    deletePattern: async (id) => {
      const patterns = await invoke('editor:deletePattern', id)
      set({ patterns, pattern: get().pattern.id === id ? (PATTERN_PRESETS[0] ?? get().pattern) : get().pattern })
    },
    takePatternFromSelection: () => {
      const lane = focusedLane()
      const sel = get().selection
      return patternFromPoints(lane?.points.filter((p) => sel.has(p.at)) ?? [])
    },
    setFill: (patch) => set({ fill: { ...get().fill, ...patch } }),
    setAi: (patch) => set({ ai: { ...get().ai, ...patch } }),
    setPatternUi: (patch) => set({ patternPicker: patch.picker ?? get().patternPicker, patternEditing: patch.editing ?? get().patternEditing }),
    fillSpan: () => {
      const s = get()
      const lane = focusedLane()
      if (!lane) return null
      const span = selectionSpan(lane.points, s.selection)
      const startMs = round(span ? span.startMs : nowMs())
      const endMs = fillEnd(lane.points, startMs, fillRange(startMs).endMs, s.fill.replace).endMs
      return endMs > startMs ? { startMs, endMs } : null
    },

    setRecordInput: (input) => set({ recordInput: input }),
    startRecord: () => {
      const s = get()
      if (s.recording || !s.open) return
      recordSamples = []
      recordLast = -1
      recordPos = valueAt(focusedLane()?.points ?? [], nowMs())
      set({ recording: true, card: 'record', ghost: null })
      usePlayer.getState().play()
      let published = 0
      const tick = () => {
        const now = performance.now()
        const input = get().recordInput
        if (input === 'gamepad') {
          const pad = navigator.getGamepads().find((g) => g?.connected)
          if (pad) recordPos = 50 - (pad.axes[1] ?? 0) * 50
        } else if (input === 'device') {
          const v = engine.deviceSlider()
          if (v !== null) recordPos = v * 100
        }
        if (now - recordLast >= 1000 / RECORD_HZ) {
          recordLast = now
          const at = round(nowMs())
          if (recordSamples[recordSamples.length - 1]?.at !== at) recordSamples.push({ at, pos: clampPos(recordPos) })
        }
        if (now - published > 100) {
          published = now
          set({ recordPosNow: Math.round(clampPos(recordPos)) })
        }
        recordHandle = requestAnimationFrame(tick)
      }
      recordHandle = requestAnimationFrame(tick)
    },
    recordValue: (pos) => {
      recordPos = pos
    },
    stopRecord: () => {
      if (!get().recording) return
      stopRecordLoop()
      usePlayer.getState().pause()
      const points = simplify(normalise(recordSamples), RECORD_EPS)
      const first = points[0]
      const last = points[points.length - 1]
      set({ recording: false, card: null })
      if (!first || !last || points.length < 2) return
      set({ ghost: { label: t('editor.ghost.recording'), kind: 'recording', axis: get().focused, base: [points], walk: -1, phaseMs: 0, depth: 1, startMs: first.at, endMs: last.at, replace: true, note: t('editor.ghost.recordingStopped', { time: fmtTimecode(last.at) }) } })
    },

    addBookmark: () => {
      const s = get()
      const atMs = round(nowMs())
      const bookmarks = [...s.bookmarks, { name: t('editor.names.bookmark', { n: s.bookmarks.length + 1 }), atMs }].sort((a, b) => a.atMs - b.atMs)
      commit({ lanes: [], bookmarks: [s.bookmarks, bookmarks] })
    },
    chapterStart: () => {
      const s = get()
      const startMs = round(nowMs())
      const chapters = [...s.chapters, { name: t('editor.names.chapter', { n: s.chapters.length + 1 }), startMs, endMs: startMs }].sort((a, b) => a.startMs - b.startMs)
      commit({ lanes: [], chapters: [s.chapters, chapters] })
    },
    chapterEnd: () => {
      const s = get()
      const t = round(nowMs())
      const open = [...s.chapters].reverse().find((c) => c.startMs <= t && c.endMs <= c.startMs)
      const target = open ?? [...s.chapters].reverse().find((c) => c.startMs <= t)
      if (!target) return
      const chapters = s.chapters.map((c) => (c === target ? { ...c, endMs: Math.max(c.startMs, t) } : c))
      commit({ lanes: [], chapters: [s.chapters, chapters] })
    },
    toggleFlag: () => {
      const s = get()
      const t = round(nowMs())
      const near = s.flags.find((f) => Math.abs(f - t) <= frameMs())
      const flags = near !== undefined ? s.flags.filter((f) => f !== near) : [...s.flags, t].sort((a, b) => a - b)
      commit({ lanes: [], flags: [s.flags, flags] })
    },
    stepFlag: (dir) => {
      const t = nowMs()
      const flags = get().flags
      const target = dir > 0 ? flags.find((f) => f > t + 1) : [...flags].reverse().find((f) => f < t - 1)
      if (target !== undefined) get().seekTo(target)
    },
    renameMarker: (kind, index, name) => {
      const s = get()
      if (kind === 'chapter') commit({ lanes: [], chapters: [s.chapters, s.chapters.map((c, i) => (i === index ? { ...c, name } : c))] })
      else commit({ lanes: [], bookmarks: [s.bookmarks, s.bookmarks.map((b, i) => (i === index ? { ...b, name } : b))] })
    },
    deleteMarker: (kind, index) => {
      const s = get()
      if (kind === 'chapter') commit({ lanes: [], chapters: [s.chapters, s.chapters.filter((_, i) => i !== index)] })
      else commit({ lanes: [], bookmarks: [s.bookmarks, s.bookmarks.filter((_, i) => i !== index)] })
    },
    setMetadata: (metadata) => {
      const s = get()
      set({ lanes: s.lanes.map((l) => (l.axis === s.focused ? { ...l, metadata } : l)) })
      markDirty()
    },

    togglePlay: () => {
      if (get().recording) {
        get().stopRecord()
        return
      }
      usePlayer.getState().togglePlay()
    },
    playFromSelection: () => {
      const lane = focusedLane()
      const span = lane ? selectionSpan(lane.points, get().selection) : null
      if (span) get().seekTo(span.startMs)
      usePlayer.getState().play()
    },
    seekTo: (ms) => {
      if (!usePlayer.getState().snapshot.loaded) return
      try {
        engine.seekExact(Math.max(0, ms) / 1000)
      } catch (e) {
        console.debug(`seek: ${String(e)}`)
      }
    },
    frameStep: (frames) => {
      if (!usePlayer.getState().snapshot.loaded) return
      if (Math.abs(frames) === 1) {
        if (!usePlayer.getState().snapshot.paused) usePlayer.getState().pause()
        try {
          engine.frameStep(frames > 0)
        } catch (e) {
          console.debug(`frame step: ${String(e)}`)
        }
      } else {
        get().seekTo(nowMs() + frames * frameMs())
      }
    },
    stepSeconds: (seconds) => get().seekTo(nowMs() + seconds * 1000),
    stepPoint: (dir) => {
      const lane = focusedLane()
      if (!lane) return
      const t = nowMs()
      const target = dir > 0 ? lane.points.find((p) => p.at > t + 1) : [...lane.points].reverse().find((p) => p.at < t - 1)
      if (target) get().seekTo(target.at)
    },
    stepCut: (dir) => {
      const { before, after } = analysis.cutsAround(nowMs() - (dir > 0 ? 0 : 50))
      const target = dir > 0 ? after : before
      if (target !== null) get().seekTo(target)
    },
    stepMarker: (dir) => {
      const s = get()
      const t = nowMs()
      const marks = [...s.chapters.map((c) => c.startMs), ...s.bookmarks.map((b) => b.atMs)].sort((a, b) => a - b)
      const target = dir > 0 ? marks.find((m) => m > t + 1) : [...marks].reverse().find((m) => m < t - 1)
      if (target !== undefined) get().seekTo(target)
    },
    stepSpeed: (dir) => {
      const rate = usePlayer.getState().snapshot.rate
      const i = SPEEDS.findIndex((r) => r >= rate - 0.001)
      const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? SPEEDS.indexOf(1) : i) + dir))]
      if (next !== undefined) usePlayer.getState().setRate(next)
    },
    setSpeed: (rate) => usePlayer.getState().setRate(rate),
    loopIn: () => set({ loop: { ...get().loop, inMs: round(nowMs()) } }),
    loopOut: () => set({ loop: { ...get().loop, outMs: round(nowMs()) } }),
    toggleLoop: () => {
      const s = get()
      const lane = focusedLane()
      const span = lane ? selectionSpan(lane.points, s.selection) : null
      const inMs = s.loop.inMs ?? span?.startMs ?? null
      const outMs = s.loop.outMs ?? span?.endMs ?? null
      if (inMs === null || outMs === null || outMs <= inMs) {
        set({ message: t('editor.message.setLoopFirst') })
        return
      }
      set({ loop: { inMs, outMs, on: !s.loop.on } })
    },
    zoom: (factor) => set({ view: zoomAboutPlayhead(get().view, factor, nowMs(), get().durationMs) }),
    zoomSelection: () => {
      const lane = focusedLane()
      const span = lane ? selectionSpan(lane.points, get().selection) : null
      if (span) set({ view: zoomToRange(get().view, span.startMs, span.endMs, get().durationMs) })
    },
    zoomFit: () => set({ view: fitAll(get().view, get().durationMs) }),
    panBy: (ms) => set({ view: pan(get().view, ms, nowMs(), get().durationMs) }),
    escape: () => {
      const s = get()
      if (s.recording) get().stopRecord()
      else if (s.ghost) set({ ghost: null })
      else if (s.patternPicker) set({ patternPicker: false })
      else if (s.patternEditing) set({ patternEditing: false })
      else if (s.ai.picking) set({ ai: { ...s.ai, picking: false } })
      else if (s.card) set({ card: null })
      else if (s.selection.size > 0) set({ selection: new Set() })
      else {
        const ui = useUi.getState()
        ui.setScreen(ui.previous === 'editor' ? 'player' : ui.previous)
      }
    },

    wantAnalysis: (startMs, endMs) => {
      const next: [number, number] = [Math.max(0, startMs - ANALYSE_BEHIND_MS), endMs + ANALYSE_AHEAD_MS]
      if (wanted && Math.abs(wanted[0] - next[0]) < 500 && Math.abs(wanted[1] - next[1]) < 500) return
      wanted = next
      pump()
    },
    ensureBeats: async () => {
      const { key, beatTrack } = get()
      if (!key || beatTrack) return
      const stamp = opening
      if (beatAnalysis?.stamp === stamp) return beatAnalysis.promise
      const promise = (async () => {
        try {
          const path = await invoke('audio:decode', key)
          if (opening !== stamp) return
          const track = await beatAnalyseAsync(path)
          if (opening === stamp && get().key === key) set({ beats: track.beats, beatTrack: track })
        } catch (e) {
          if (opening === stamp) set({ message: t('editor.message.noBeats', { error: String(e) }) })
        } finally {
          if (beatAnalysis?.stamp === stamp) beatAnalysis = null
        }
      })()
      beatAnalysis = { stamp, promise }
      await promise
    },
    ensurePeaks: async () => {
      const { key, peaks } = get()
      if (!key || peaks) return
      try {
        const result = await invoke('audio:peaks', key)
        if (get().key === key) set({ peaks: result })
      } catch (e) {
        set({ message: t('editor.message.noAudio', { error: String(e) }) })
      }
    },
  }
})

usePlayer.subscribe((s, prev) => {
  const e = useEditor.getState()
  if (!e.open) return
  if (s.path !== prev.path) {
    e.close()
    return
  }
  if (s.path === e.key && s.title !== prev.title) useEditor.setState({ title: s.title })
  if (s.snapshot.paused && !prev.snapshot.paused && e.dirty) engine.pushDraftHosted()
  if (s.snapshot.durationMs !== prev.snapshot.durationMs) useEditor.setState({ durationMs: s.snapshot.durationMs })
})
useUi.subscribe((s, prev) => {
  if (prev.screen === 'editor' && s.screen !== 'editor') useEditor.getState().close()
})
live.subscribe((l) => {
  const e = useEditor.getState()
  if (!e.open || !e.loop.on || e.loop.inMs === null || e.loop.outMs === null) return
  if (l.timeMs >= e.loop.outMs && !usePlayer.getState().snapshot.paused) e.seekTo(e.loop.inMs)
})

export const shownLanes = (s: Pick<EditorState, 'lanes' | 'hidden'>) => s.lanes.filter((l) => !s.hidden.includes(l.axis))

export const addableAxes = (s: Pick<EditorState, 'lanes'>): AxisId[] => AXIS_IDS.filter((a) => !s.lanes.some((l) => l.axis === a))

export const currentWindowStart = (s: Pick<EditorState, 'view' | 'durationMs'>) => windowStart(s.view, live.get().timeMs, s.durationMs)

export const isKnownAxis = (id: string): id is AxisId => isAxisId(id)
export const isTrackAxisId = isTrackAxis
export const zoomStep = ZOOM_STEP
export const nearestOf = nearest
export const selectedOf = selectedIndices
