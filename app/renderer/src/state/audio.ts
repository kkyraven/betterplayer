import { beatAnalyseAsync, engine } from '@/engine/client'
import { invoke } from '@/ipc'
import * as live from './live'
import { usePlayer } from './player'

const WINDOW_MS = 24_000
const CONTEXT_MS = 12_000
const AHEAD_MS = 6_000

interface Bounds { startMs: number; endMs: number }
interface Request extends Bounds {
  id: string
  reset: boolean
  promise: Promise<void>
}

let key: string | null = null
let mediaKey: string | null = null
type Consumer = 'beat' | 'parameters'
const consumers = new Set<Consumer>()
let ready: Bounds | null = null
let pending: Request | null = null
let full: { key: string; promise: Promise<void>; decoding: boolean } | null = null
let epoch = 0
let serial = 0
let retryAfter = 0
let failedStart: number | null = null
let timer: ReturnType<typeof setInterval> | null = null
let watching = false

function watchMedia() {
  if (watching) return
  watching = true
  usePlayer.subscribe((state, previous) => {
    if (state.path !== previous.path && mediaKey !== state.path) forgetAudio()
  })
}

function selectMedia(source: string): boolean {
  watchMedia()
  if (usePlayer.getState().path !== source) return false
  if (mediaKey !== source) {
    forgetAudio()
    mediaKey = source
  }
  return true
}

function cancelPending() {
  if (!pending) return
  void invoke('audio:cancelWindow', pending.id).catch(() => {})
  pending = null
}

function covers(bounds: Bounds | null, time: number): boolean {
  return bounds !== null && time >= bounds.startMs && time <= bounds.endMs
}

function updateWindow(): Promise<void> {
  if (!key || usePlayer.getState().path !== key) return Promise.resolve()
  if (engine.beatState().status === 'none') {
    cancelPending()
    ready = null
  }
  const time = Math.max(0, live.get().timeMs)
  const duration = usePlayer.getState().snapshot.durationMs
  const startMs = Math.floor(Math.max(0, time - CONTEXT_MS) / AHEAD_MS) * AHEAD_MS
  const reset = !covers(ready, time)
  if (pending) {
    if (covers(pending, time) && (!reset || pending.reset)) return pending.promise
    cancelPending()
  }
  if (!reset && ready && (ready.endMs - time > AHEAD_MS || (duration > 0 && ready.endMs >= duration - 100))) return Promise.resolve()
  if (failedStart === startMs && Date.now() < retryAfter) {
    if (reset && ready) {
      engine.beatWindowBegin(true)
      ready = null
    }
    return Promise.resolve()
  }
  if (!reset && ready?.startMs === startMs) return Promise.resolve()
  const source = key
  const token = engine.beatWindowBegin(reset)
  const request: Request = { id: `beat-${++serial}`, startMs, endMs: startMs + WINDOW_MS, reset, promise: Promise.resolve() }
  if (reset) ready = null
  pending = request
  const current = () => pending === request && key === source && usePlayer.getState().path === source
  request.promise = (async () => {
    try {
      const audio = await invoke('audio:window', source, startMs, WINDOW_MS, request.id)
      if (!current()) return
      const track = await beatAnalyseAsync(audio.path)
      if (!current() || !covers(request, live.get().timeMs)) return
      if (engine.beatSetWindow(track, audio.startMs, token, !reset)) {
        ready = { startMs: audio.startMs, endMs: request.endMs }
        failedStart = null
      }
    } catch (error) {
      if (!current()) return
      retryAfter = Date.now() + 5000
      failedStart = startMs
      engine.beatWindowError(token, error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      if (pending === request) pending = null
    }
  })()
  return request.promise
}

export function ensureAudio(source: string, consumer: Consumer = 'beat'): Promise<void> {
  if (!selectMedia(source)) return Promise.resolve()
  consumers.add(consumer)
  if (key !== source || engine.beatState().status === 'none') {
    cancelPending()
    key = source
    ready = null
    retryAfter = 0
  }
  timer ??= setInterval(() => { void updateWindow().catch(() => {}) }, 250)
  return updateWindow()
}

export function ensureFullAudio(source: string): Promise<void> {
  if (!selectMedia(source)) return Promise.resolve()
  const status = engine.beatState().fullStatus
  if (full?.key === source && (full.decoding || status === 'analysing' || status === 'ready')) return full.promise
  const generation = epoch
  const request = { key: source, promise: Promise.resolve(), decoding: true }
  full = request
  request.promise = (async () => {
    try {
      const path = await invoke('audio:decode', source)
      if (generation !== epoch || usePlayer.getState().path !== source) return
      engine.beatLoad(path)
    } catch (error) {
      if (full === request) full = null
      throw error
    } finally {
      request.decoding = false
    }
  })()
  return request.promise
}

export function releaseAudio(consumer: Consumer = 'beat') {
  consumers.delete(consumer)
  if (consumers.size) return
  cancelPending()
  if (timer) clearInterval(timer)
  timer = null
  key = null
  ready = null
}

export function forgetAudio() {
  epoch++
  cancelPending()
  if (timer) clearInterval(timer)
  timer = null
  key = null
  mediaKey = null
  consumers.clear()
  ready = null
  full = null
  retryAfter = 0
  failedStart = null
}
