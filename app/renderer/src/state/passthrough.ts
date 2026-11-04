import { passthroughModelId, type PassthroughSettings } from '@shared/passthrough'
import type { Projection } from '@shared/projection'
import { isUrl } from '@shared/remote'
import type { MatteSetup } from 'bp-engine'
import { engine, modelFiles } from '@/engine/client'
import { invoke } from '@/ipc'
import { ipcMessage } from '@/lib/errors'
import { isPremium, useAccount } from './account'
import { useFollow } from './follow'
import { kinkyravenCatalog, useModels } from './models'
import { usePlayer } from './player'
import { useSettings } from './settings'
import { useVr } from './vr'

const QUEST_POLL_MS = 3000

export interface Watched {
  path: string
  saved: PassthroughSettings | null
  projection: Projection
}

export function watchedPath(): string | null {
  const player = usePlayer.getState()
  if (useVr.getState().active) return player.snapshot.loaded ? player.path : null
  const follow = useFollow.getState()
  return follow.kind === 'quest' && follow.state ? (follow.matched?.path ?? null) : null
}

export async function watched(path: string): Promise<Watched> {
  const player = usePlayer.getState()
  if (useVr.getState().active) return { path, saved: player.video.passthrough ?? null, projection: player.projection }
  const [video, resolved] = await Promise.all([invoke('video:get', path), invoke('library:projection', path)])
  return { path, saved: video?.passthrough ?? null, projection: resolved.projection }
}

function segmenterId(): string {
  const settings = useSettings.getState().settings
  return passthroughModelId(settings?.tracking.models.detector, settings?.vr.passthroughModel)
}

const failed = new Set<string>()

async function segmenter(): Promise<MatteSetup['files'] | null> {
  const model = (await kinkyravenCatalog()).find((m) => m.id === segmenterId())
  if (!model) return null
  const status = await invoke('models:status', model.files.map((f) => f.file))
  const paths = model.files.map((f) => status[f.file]?.path ?? null)
  if (paths.every((p): p is string => p !== null)) return modelFiles(model, paths)
  const missing = model.files.filter((f) => !status[f.file])
  const download = useModels.getState().downloads[model.id]
  if (download?.status === 'error') failed.add(model.id)
  if (download?.status !== 'running' && !failed.has(model.id) && isPremium(useAccount.getState())) void useModels.getState().download({ ...model, files: missing })
  return null
}

let modelsDir: string | null = null
let running = ''
let runningPath: string | null = null

function stop() {
  if (!running) return
  engine.matteStop()
  running = ''
  runningPath = null
}

async function syncOnce() {
  const path = watchedPath()
  if (path !== runningPath) stop()
  if (!path) return
  const w = await watched(path)
  const resolved = await invoke('passthrough:resolve', w.path, w.saved)
  const files = resolved.on && !isUrl(w.path) ? await segmenter() : null
  if (watchedPath() !== path) return
  if (!files || resolved.mode !== 'ai' || !resolved.maskDir) return stop()
  modelsDir ??= await invoke('models:dir')
  const setup: MatteSetup = { path, dir: resolved.maskDir, files, cacheDir: `${modelsDir}/coreml-cache`, layout: w.projection.layout, swapEyes: w.projection.swapEyes }
  const key = JSON.stringify(setup)
  if (key === running) return
  engine.matteStart(setup)
  running = key
  runningPath = path
}

let syncing: Promise<void> | null = null
let again = false

function sync() {
  if (syncing) {
    again = true
    return
  }
  syncing = (async () => {
    do {
      again = false
      await syncOnce().catch((error: unknown) => console.warn(`mask track: ${ipcMessage(error)}`))
    } while (again)
  })().finally(() => (syncing = null))
}

let started = false

export function startPassthrough() {
  if (started || typeof engine.matteStart !== 'function') return
  started = true
  usePlayer.subscribe((s, prev) => {
    if (s.path !== prev.path || s.snapshot.loaded !== prev.snapshot.loaded || s.video.passthrough !== prev.video.passthrough || s.projection !== prev.projection) sync()
  })
  useVr.subscribe((s, prev) => {
    if (s.active !== prev.active) sync()
  })
  useFollow.subscribe((s, prev) => {
    if (s.kind !== prev.kind || (s.state === null) !== (prev.state === null) || s.matched?.path !== prev.matched?.path) sync()
  })
  useSettings.subscribe((s, prev) => {
    if (s.settings?.tracking.models.detector !== prev.settings?.tracking.models.detector || s.settings?.vr.passthroughModel !== prev.settings?.vr.passthroughModel) sync()
  })
  useModels.subscribe((s, prev) => {
    const id = segmenterId()
    if (s.downloads[id]?.status !== prev.downloads[id]?.status && s.downloads[id]?.status !== 'running') sync()
  })
  window.setInterval(() => {
    const follow = useFollow.getState()
    if (follow.kind === 'quest' && follow.matched) sync()
  }, QUEST_POLL_MS)
}
