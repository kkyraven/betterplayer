import { create } from 'zustand'
import type { MediaRow } from '@shared/library'
import { passthroughModelId, type AlphaFile } from '@shared/passthrough'
import type { ProjectionKind } from '@shared/projection'
import { engine, modelFiles } from '@/engine/client'
import { invoke } from '@/ipc'
import { ipcMessage } from '@/lib/errors'
import { isPremium, useAccount } from './account'
import { useFollow } from './follow'
import { kinkyravenCatalog, useModels } from './models'
import { refreshPassthrough } from './passthrough'
import { useSettings } from './settings'
import { useVr } from './vr'

export type JobState = 'queued' | 'making' | 'saving' | 'ready' | 'error'

export interface Job {
  path: string
  title: string
  thumb: string | null
  durationMs: number
  projection: ProjectionKind
  height: number
  keyed?: boolean
  state: JobState
  paused: boolean
  seconds: number
  total: number
  rate: number | null
  error?: string
  alpha?: AlphaFile
}

interface CreatorState {
  jobs: Job[]
  beside: boolean
  add(rows: readonly MediaRow[]): Promise<void>
  pause(path: string, paused: boolean): void
  remove(path: string): void
  retry(path: string): void
  setBeside(beside: boolean): void
}

const STORAGE_KEY = 'bp.passthroughCreator'
const TICK_MS = 1000

interface Stored {
  jobs: Job[]
  beside: boolean
}

function load(): Stored {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (typeof raw !== 'object' || raw === null) return { jobs: [], beside: true }
    const r = raw as Partial<Stored>
    const jobs = (Array.isArray(r.jobs) ? r.jobs : []).map((j): Job => (j.state === 'making' || j.state === 'saving' ? { ...j, state: 'queued', rate: null } : j))
    return { jobs, beside: r.beside !== false }
  } catch {
    return { jobs: [], beside: true }
  }
}

function save(s: Stored) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ jobs: s.jobs, beside: s.beside }))
  } catch {
  }
}

export const useCreator = create<CreatorState>()((set, get) => ({
  ...load(),
  async add(rows) {
    const have = new Set(get().jobs.map((j) => j.path))
    const fresh = rows.filter((r) => !have.has(r.path))
    const alphas = await Promise.all(fresh.map((r) => invoke('passthrough:alpha', r.path).catch(() => null)))
    const added = fresh.map((r, i): Job => {
      const alpha = alphas[i] ?? undefined
      return { path: r.path, title: r.title, thumb: r.thumb, durationMs: r.durationMs, projection: r.projection, height: r.height, keyed: r.keyed, state: alpha ? 'ready' : 'queued', paused: false, seconds: 0, total: Math.ceil(r.durationMs / 1000), rate: null, alpha }
    })
    const now = new Set(get().jobs.map((j) => j.path))
    set({ jobs: [...get().jobs, ...added.filter((j) => !now.has(j.path))] })
    tick()
  },
  pause(path, paused) {
    if (paused && running === path) stopMake()
    update(path, { paused, rate: null })
    tick()
  },
  remove(path) {
    const job = get().jobs.find((j) => j.path === path)
    if (running === path) stopMake()
    set({ jobs: get().jobs.filter((j) => j.path !== path) })
    if (job?.state === 'ready') void invoke('passthrough:delete', path).then(refreshPassthrough, (e: unknown) => console.warn(`passthrough delete: ${ipcMessage(e)}`))
    tick()
  },
  retry(path) {
    update(path, { state: 'queued', error: undefined, rate: null })
    tick()
  },
  setBeside(beside) {
    set({ beside })
  },
}))

useCreator.subscribe((s) => save(s))

function update(path: string, patch: Partial<Job>) {
  useCreator.setState((s) => ({ jobs: s.jobs.map((j) => (j.path === path ? { ...j, ...patch } : j)) }))
}

export function secondsLeft(job: Job): number | null {
  if (!job.rate || job.total <= 0) return null
  return Math.max(1, Math.ceil((job.total - job.seconds) / job.rate))
}

const headsetBusy = () => useVr.getState().active || (useFollow.getState().kind === 'quest' && useFollow.getState().state !== null)

let running: string | null = null
let since: { seconds: number; at: number } | null = null
let saving = false

function stopMake() {
  if (running === null) return
  engine.matteMakeStop()
  running = null
  since = null
}

async function segmenter() {
  const settings = useSettings.getState().settings
  const id = passthroughModelId(settings?.tracking.models.detector, settings?.vr.passthroughModel)
  const model = (await kinkyravenCatalog()).find((m) => m.id === id)
  if (!model) return null
  const status = await invoke('models:status', model.files.map((f) => f.file))
  const paths = model.files.map((f) => status[f.file]?.path ?? null)
  if (paths.every((p): p is string => p !== null)) return modelFiles(model, paths)
  const download = useModels.getState().downloads[model.id]
  if (download?.status !== 'running' && download?.status !== 'error') void useModels.getState().download({ ...model, files: model.files.filter((f) => !status[f.file]) })
  return null
}

let modelsDir: string | null = null

async function startNext(job: Job) {
  const files = await segmenter()
  if (!files || running !== null || headsetBusy()) return
  const [dir, projection] = await Promise.all([invoke('passthrough:makeDir', job.path), invoke('library:projection', job.path)])
  modelsDir ??= await invoke('models:dir')
  if (running !== null || !useCreator.getState().jobs.some((j) => j.path === job.path && (j.state === 'queued' || j.state === 'making') && !j.paused)) return
  engine.matteMake({ path: job.path, dir, files, cacheDir: `${modelsDir}/coreml-cache`, layout: projection.projection.layout })
  running = job.path
  since = null
  update(job.path, { state: 'making', error: undefined, rate: null })
}

async function follow(path: string) {
  const status = engine.matteMakeStatus()
  if (!status) return
  if (status.status === 'error') {
    stopMake()
    return update(path, { state: 'error', error: status.error ?? '' })
  }
  const now = Date.now()
  since ??= { seconds: status.seconds, at: now }
  const elapsed = (now - since.at) / 1000
  const rate = elapsed >= 5 && status.seconds > since.seconds ? (status.seconds - since.seconds) / elapsed : null
  update(path, { seconds: status.seconds, total: status.total || useCreator.getState().jobs.find((j) => j.path === path)?.total || 0, rate })
  if (status.status !== 'done') return
  stopMake()
  update(path, { state: 'saving' })
  saving = true
  try {
    await invoke('passthrough:export', path, useCreator.getState().beside)
    const alpha = await invoke('passthrough:alpha', path)
    update(path, { state: 'ready', alpha: alpha ?? undefined })
    refreshPassthrough()
  } catch (e) {
    update(path, { state: 'error', error: ipcMessage(e) })
  } finally {
    saving = false
  }
}

let ticking = false

async function step() {
  const { jobs } = useCreator.getState()
  if (running !== null) {
    if (headsetBusy()) {
      const path = running
      stopMake()
      return update(path, { state: 'queued', rate: null })
    }
    return follow(running)
  }
  if (saving || !isPremium(useAccount.getState()) || headsetBusy()) return
  const making = jobs.find((j) => j.state === 'making')
  if (making?.paused) return
  const next = making ?? jobs.find((j) => j.state === 'queued' && !j.paused)
  if (next) await startNext(next)
}

function tick() {
  if (ticking) return
  ticking = true
  void step()
    .catch((e: unknown) => console.warn(`passthrough creator: ${ipcMessage(e)}`))
    .finally(() => (ticking = false))
}

let started = false

export function startCreator() {
  if (started || typeof engine.matteMake !== 'function') return
  started = true
  window.setInterval(tick, TICK_MS)
  for (const job of useCreator.getState().jobs.filter((j) => j.state === 'ready')) {
    void invoke('passthrough:alpha', job.path).then((alpha) => (alpha ? update(job.path, { alpha }) : useCreator.setState((s) => ({ jobs: s.jobs.filter((j) => j.path !== job.path) }))))
  }
}
