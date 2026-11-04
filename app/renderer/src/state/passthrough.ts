import type { PassthroughSettings, ResolvedPassthrough } from '@shared/passthrough'
import type { Projection } from '@shared/projection'
import { isUrl } from '@shared/remote'
import type { MatteSetup } from 'bp-engine'
import { setStageKeying, type StageKeying } from '@/components/player/stage'
import { engine } from '@/engine/client'
import { invoke } from '@/ipc'
import { ipcMessage } from '@/lib/errors'
import { useFollow } from './follow'
import { usePlayer } from './player'
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
  if (path === player.path) return { path, saved: player.video.passthrough ?? null, projection: player.projection }
  const [video, resolved] = await Promise.all([invoke('video:get', path), invoke('library:projection', path)])
  return { path, saved: video?.passthrough ?? null, projection: resolved.projection }
}

function playerPath(): string | null {
  const player = usePlayer.getState()
  return player.snapshot.loaded ? player.path : null
}

function keyingOf(r: ResolvedPassthrough, tracked: boolean): StageKeying | null {
  if (!r.on) return null
  if (r.mode === 'ai') return tracked ? { kind: 'mask', featherPx: r.featherPx } : null
  return { kind: 'colour', key: r.key, feather: r.feather, featherPx: r.featherPx }
}

let running = ''
let runningPath: string | null = null

function stop() {
  if (!running) return
  engine.matteStop()
  running = ''
  runningPath = null
}

async function syncOnce() {
  const local = playerPath()
  const path = watchedPath() ?? local
  if (path !== runningPath) stop()
  if (!path) return setStageKeying(null)
  const w = await watched(path)
  const resolved = await invoke('passthrough:resolve', w.path, w.saved)
  if ((watchedPath() ?? playerPath()) !== path) return
  const tracked = resolved.on && resolved.mode === 'ai' && !isUrl(path) && !!resolved.alpha && !!resolved.maskDir
  if (tracked && resolved.alpha && resolved.maskDir) {
    const setup: MatteSetup = { path, alpha: resolved.alpha, dir: resolved.maskDir, layout: w.projection.layout }
    const key = JSON.stringify(setup)
    if (key !== running) {
      engine.matteStart(setup)
      running = key
      runningPath = path
    }
  } else stop()
  if (local !== path) return setStageKeying(local ? keyingOf(await localResolved(local), false) : null)
  setStageKeying(keyingOf(resolved, tracked))
}

async function localResolved(path: string): Promise<ResolvedPassthrough> {
  const w = await watched(path)
  return invoke('passthrough:resolve', w.path, w.saved)
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
  window.setInterval(() => {
    const follow = useFollow.getState()
    if (follow.kind === 'quest' && follow.matched) sync()
  }, QUEST_POLL_MS)
}

export const refreshPassthrough = () => sync()
