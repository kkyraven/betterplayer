import { create } from 'zustand'
import { DEFAULT_MODEL_SIZE, censorLocked, detectorId, restrictCensor, sizeOf, skinId, type ModelSize } from '@shared/censor'
import { defaultCensor, defaultDenial, type CensorSettings, type CensorStyle } from '@shared/settings'
import type { ModelInfo } from '@shared/tracking'
import type { CensorSetup } from 'bp-engine'
import { detectorFiles, engine, modelFiles } from '@/engine/client'
import { invoke } from '@/ipc'
import { isFree, isPremium, useAccount } from './account'
import { chasterState, useChaster } from './chaster'
import { kinkyravenCatalog, useModels } from './models'
import { useSettings } from './settings'
import { useTracking } from './tracking'

export type Install = 'installed' | 'downloading' | 'missing'

interface CensorStore {
  censor: CensorSettings
  locked: boolean
  size: ModelSize | null
  detector: Install
  skin: Install | null
  synced: boolean
  running: { status: string; error: string | null; runMs: number } | null
  engineSetup: { setup: CensorSetup; kinds: CensorSettings['kinds'] } | null
  set: (patch: Partial<CensorSettings>) => Promise<void>
  setSize: (size: ModelSize) => Promise<void>
  downloadAndEnable: (tool: 'censor' | 'denial') => Promise<void>
  cancelDownload: () => Promise<void>
  uninstall: () => Promise<void>
}

const PADDING = 0.15
export const MAX_BOXES = 24
const LOCK_TICK_MS = 10_000

const locked = (g: CensorSettings) => censorLocked(g, Date.now(), chasterState(useChaster.getState().status))

const pickedSize = () => sizeOf(useSettings.getState().settings?.tracking.models.detector)

const setDetector = (detector: string | null) => useSettings.getState().update((s) => ({ ...s, tracking: { ...s.tracking, models: { ...s.tracking.models, detector } } }))

export const useCensor = create<CensorStore>()((_set, get) => ({
  censor: defaultCensor(),
  locked: false,
  size: null,
  detector: 'missing',
  skin: null,
  synced: false,
  running: null,
  engineSetup: null,
  set: async (patch) => {
    const current = get().censor
    const next = restrictCensor(current, { ...current, ...patch }, get().locked)
    await useSettings.getState().update((s) => ({ ...s, censor: next }))
  },
  setSize: async (size) => {
    failed.clear()
    for (const id of [detectorId(size), skinId(size)]) if (useModels.getState().downloads[id]?.status === 'error') useModels.getState().clear(id)
    await setDetector(detectorId(size))
  },
  downloadAndEnable: async (tool) => {
    await get().setSize(pickedSize() ?? DEFAULT_MODEL_SIZE)
    await useSettings.getState().update((s) => (tool === 'censor' ? { ...s, censor: { ...s.censor, enabled: true } } : { ...s, denial: { ...s.denial, enabled: true } }))
  },
  cancelDownload: async () => {
    if (get().locked) return
    const size = pickedSize()
    await useSettings.getState().update((s) => ({ ...s, censor: { ...s.censor, enabled: false }, denial: { ...s.denial, enabled: false }, tracking: { ...s.tracking, models: { ...s.tracking.models, detector: null } } }))
    if (size) for (const id of [detectorId(size), skinId(size)]) await useModels.getState().cancel(id)
  },
  uninstall: async () => {
    if (get().locked) return
    await useSettings.getState().update((s) => ({ ...s, censor: { ...s.censor, enabled: false }, denial: { ...s.denial, enabled: false }, tracking: { ...s.tracking, models: { ...s.tracking.models, detector: null } } }))
    await sync()
    await useTracking.getState().refreshModels()
    for (const m of await kinkyravenCatalog()) {
      await useModels.getState().cancel(m.id)
      for (const f of m.files) await invoke('models:remove', f.file)
    }
    void sync()
  },
}))

export interface CensorMask {
  style: CensorStyle
  strength: number
  boxes: Float32Array
  count: number
  skin: { data: Uint8Array; width: number; height: number } | null
  version: number
  serial: number
  ready: boolean
}

const mask: CensorMask = { style: 'pixelate', strength: 0.6, boxes: new Float32Array(MAX_BOXES * 4), count: 0, skin: null, version: 0, serial: 0, ready: false }
let lastRuns = -1
let maskVersion = 0
let engineOn = false

export function censorMask(): CensorMask | null {
  if (!engineOn) return null
  const { censor } = useCensor.getState()
  const run = engine.censorRun(maskVersion)
  if (!run) return null
  mask.ready = run.status === 'ready'
  let moved = censor.style !== mask.style || censor.strength !== mask.strength
  mask.style = censor.style
  mask.strength = censor.strength
  if (run.runs !== lastRuns) {
    lastRuns = run.runs
    mask.serial = run.serial
    const n = Math.min(MAX_BOXES, run.boxes.length / 4)
    for (let i = 0; i < n; i++) {
      const [x = 0, y = 0, w = 0, h = 0] = run.boxes.slice(i * 4, i * 4 + 4)
      const dx = Math.max(w * PADDING, 0.01)
      const dy = Math.max(h * PADDING, 0.01)
      mask.boxes.set([x - dx, y - dy, w + 2 * dx, h + 2 * dy], i * 4)
    }
    moved ||= n !== mask.count || n > 0
    mask.count = n
  }
  if (run.maskVersion !== maskVersion) {
    maskVersion = run.maskVersion
    mask.skin = run.mask ? { data: new Uint8Array(run.mask.buffer, run.mask.byteOffset, run.mask.byteLength), width: run.maskWidth, height: run.maskHeight } : null
    moved = true
  }
  if (moved) mask.version++
  return mask
}

const failed = new Set<string>()

async function onDisk(model: ModelInfo): Promise<{ missing: ModelInfo['files']; paths: string[] }> {
  const status = await invoke('models:status', model.files.map((f) => f.file))
  return { missing: model.files.filter((f) => !status[f.file]), paths: model.files.map((f) => status[f.file]?.path ?? '') }
}

function fetchMissing(model: ModelInfo, missing: ModelInfo['files']): Install {
  const download = useModels.getState().downloads[model.id]
  if (download?.status === 'running') return 'downloading'
  if (download?.status === 'error') failed.add(model.id)
  if (failed.has(model.id) || !isPremium(useAccount.getState())) return 'missing'
  void useModels.getState().download({ ...model, files: missing })
  return 'downloading'
}

let modelsDir: string | null = null
let setupKey = ''
let runningSetup: CensorSetup | null = null
let syncing: Promise<void> | null = null
let again = false

async function sync(): Promise<void> {
  if (syncing) {
    again = true
    return syncing
  }
  syncing = (async () => {
    do {
      again = false
      await syncOnce()
    } while (again)
  })().finally(() => (syncing = null))
  return syncing
}

async function syncOnce() {
  const settings = useSettings.getState().settings
  if (!settings) return
  const { censor, denial } = settings
  const allowed = !isFree(useAccount.getState())
  let size = pickedSize()
  if (!size && allowed && isPremium(useAccount.getState()) && (censor.enabled || denial.enabled)) {
    await setDetector(detectorId(DEFAULT_MODEL_SIZE))
    size = DEFAULT_MODEL_SIZE
  }
  const catalog = await kinkyravenCatalog()
  const detector = size ? catalog.find((m) => m.id === detectorId(size)) : undefined
  const skin = size ? catalog.find((m) => m.id === skinId(size)) : undefined
  const skinWanted = censor.enabled && censor.kinds.includes('skin')
  let detectorState: Install = 'missing'
  let skinState: Install | null = null
  let detectorPaths: string[] | null = null
  let skinPaths: string[] | null = null
  if (detector) {
    const d = await onDisk(detector)
    if (pickedSize() !== size) return
    detectorState = d.missing.length === 0 ? 'installed' : fetchMissing(detector, d.missing)
    if (d.missing.length === 0) detectorPaths = d.paths
  }
  if (skin && skinWanted) {
    const s = await onDisk(skin)
    skinState = s.missing.length === 0 ? 'installed' : fetchMissing(skin, s.missing)
    if (s.missing.length === 0) skinPaths = s.paths
  }
  useCensor.setState({ size, detector: detectorState, skin: skinState, synced: true })

  modelsDir ??= await invoke('models:dir')
  let setup: CensorSetup | null = censor.enabled && allowed && detector && detectorPaths ? { detector: detectorFiles(detector, detectorPaths), skin: skin && skinPaths ? modelFiles(skin, skinPaths) : undefined, cacheDir: `${modelsDir}/coreml-cache` } : null
  if (!setup && censor.enabled && allowed && detectorState === 'downloading') setup = runningSetup
  runningSetup = setup
  const key = JSON.stringify([setup, censor.kinds])
  if (key === setupKey) return
  setupKey = key
  engine.setCensor(setup, setup ? censor.kinds : [])
  useCensor.setState({ engineSetup: setup ? { setup, kinds: censor.kinds } : null })
  engineOn = setup !== null
  if (!engineOn) {
    lastRuns = -1
    maskVersion = 0
    mask.skin = null
    mask.count = 0
    useCensor.setState({ running: null })
  }
}

let started = false

export function startCensor() {
  if (started) return
  started = true
  let boxesWanted = false
  const follow = () => {
    const settings = useSettings.getState().settings
    const censor = settings?.censor ?? defaultCensor()
    const denial = settings?.denial ?? defaultDenial()
    const isLocked = locked(censor)
    const prev = useCensor.getState()
    if (prev.censor !== censor || prev.locked !== isLocked) useCensor.setState({ censor, locked: isLocked })
    if (censor.lock && !isLocked) void useSettings.getState().update((s) => ({ ...s, censor: { ...s.censor, lock: null } }))
    const wanted = denial.enabled && isPremium(useAccount.getState())
    if (wanted !== boxesWanted) {
      boxesWanted = wanted
      engine.setDetectBoxes(wanted)
      if (wanted) void useTracking.getState().refreshModels()
    }
    void sync()
  }
  useSettings.subscribe(follow)
  useChaster.subscribe(follow)
  useAccount.subscribe(follow)
  useModels.subscribe((s, prev) => {
    if (Object.entries(s.downloads).some(([id, d]) => d.status !== prev.downloads[id]?.status)) {
      void sync()
      void useTracking.getState().refreshModels()
    }
  })
  let errorPolls = 0
  window.setInterval(() => {
    if (!engineOn) return
    const run = engine.censorRun(maskVersion)
    errorPolls = run?.status === 'error' ? errorPolls + 1 : 0
    if (errorPolls === 1) return
    const next = run ? { status: run.status, error: run.error ?? null, runMs: Math.round(run.runMs) } : null
    const cur = useCensor.getState().running
    if (next?.status !== cur?.status || next?.error !== cur?.error || next?.runMs !== cur?.runMs) useCensor.setState({ running: next })
  }, 1000)
  window.setInterval(follow, LOCK_TICK_MS)
  follow()
}
