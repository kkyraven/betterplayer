import type { QuestCensor } from '@shared/quest'
import { isUrl } from '@shared/remote'
import type { CensorSetup, CensorTrackSetup } from 'bp-engine'
import { engine } from '@/engine/client'
import { invoke } from '@/ipc'
import { ipcMessage } from '@/lib/errors'
import { isFree, useAccount } from './account'
import { useCensor } from './censor'
import { useFollow } from './follow'
import { watched, watchedPath } from './passthrough'
import { usePlayer } from './player'
import { useVr } from './vr'

const QUEST_POLL_MS = 3000

function trackKey(setup: CensorSetup, kinds: readonly string[]): string {
  const files = [...setup.detector.files, ...(setup.skin ?? [])].map((f) => f.path.split(/[\\/]/).pop() ?? f.path)
  return `${files.join(',')};${kinds.join(',')}`
}

function currentLook(): QuestCensor | null {
  const { censor, engineSetup, running } = useCensor.getState()
  if (!censor.enabled || !engineSetup || running?.status === 'error' || isFree(useAccount.getState())) return null
  return { style: censor.style, strength: censor.strength, track: trackKey(engineSetup.setup, engineSetup.kinds) }
}

let running: string | null = null
let runningPath: string | null = null
let sentLook = ''

async function syncOnce() {
  const look = currentLook()
  const lookKey = JSON.stringify(look)
  if (lookKey !== sentLook) {
    sentLook = lookKey
    void invoke('remote:censor', look)
  }
  const { engineSetup } = useCensor.getState()
  const path = watchedPath()
  let setup: CensorTrackSetup | null = null
  if (look && engineSetup && path && !isUrl(path)) {
    if (path !== runningPath) apply(null, look)
    const [w, dir] = await Promise.all([watched(path), invoke('censor:trackDir', path)])
    if (watchedPath() !== path || JSON.stringify(currentLook()) !== lookKey) return
    setup = { path, dir, models: engineSetup.setup, kinds: engineSetup.kinds, key: look.track ?? '', layout: w.projection.layout }
  }
  apply(setup, path && isUrl(path) ? null : look)
}

function apply(setup: CensorTrackSetup | null, look: QuestCensor | null) {
  const key = JSON.stringify([setup, look])
  if (key === running) return
  running = key
  runningPath = setup?.path ?? null
  engine.censorTrack(setup, look && { style: look.style, strength: look.strength })
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
      await syncOnce().catch((error: unknown) => {
        console.warn(`censor track: ${ipcMessage(error)}`)
        apply(null, null)
      })
    } while (again)
  })().finally(() => (syncing = null))
}

let started = false

export function startHeadsetCensor() {
  if (started || typeof engine.censorTrack !== 'function') return
  started = true
  usePlayer.subscribe((s, prev) => {
    if (s.path !== prev.path || s.snapshot.loaded !== prev.snapshot.loaded || s.projection !== prev.projection) sync()
  })
  useVr.subscribe((s, prev) => {
    if (s.active !== prev.active) sync()
  })
  useFollow.subscribe((s, prev) => {
    if (s.kind !== prev.kind || (s.state === null) !== (prev.state === null) || s.matched?.path !== prev.matched?.path) sync()
  })
  useCensor.subscribe((s, prev) => {
    if (s.engineSetup !== prev.engineSetup || s.censor !== prev.censor || (s.running?.status === 'error') !== (prev.running?.status === 'error')) sync()
  })
  useAccount.subscribe(sync)
  window.setInterval(() => {
    const follow = useFollow.getState()
    if (follow.kind === 'quest' && follow.matched) sync()
  }, QUEST_POLL_MS)
  sync()
}
