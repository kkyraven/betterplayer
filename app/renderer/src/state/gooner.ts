import { create } from 'zustand'
import { goonerLocked, restrictGooner } from '@shared/gooner'
import { defaultDenial, defaultGooner, type GoonerSettings, type GoonerStyle } from '@shared/settings'
import { engine } from '@/engine/client'
import { isPremium, useAccount } from './account'
import { chasterState, useChaster } from './chaster'
import { useSettings } from './settings'
import { useTracking } from './tracking'

interface GoonerStore {
  gooner: GoonerSettings
  locked: boolean
  set: (patch: Partial<GoonerSettings>) => Promise<void>
}

const LINGER_MS = 350
const PADDING = 0.15
export const MAX_BOXES = 24
const POLL_MS = 1000 / 30
const LOCK_TICK_MS = 10_000

const locked = (g: GoonerSettings) => goonerLocked(g, Date.now(), chasterState(useChaster.getState().status))

export const useGooner = create<GoonerStore>()((_set, get) => ({
  gooner: defaultGooner(),
  locked: false,
  set: async (patch) => {
    const current = get().gooner
    const next = restrictGooner(current, { ...current, ...patch }, get().locked)
    await useSettings.getState().update((s) => ({ ...s, gooner: next }))
  },
}))

export interface GoonerMask {
  style: GoonerStyle
  strength: number
  boxes: Float32Array
  count: number
  version: number
}

interface Recent {
  x: number
  y: number
  w: number
  h: number
  until: number
}

const mask: GoonerMask = { style: 'pixelate', strength: 0.6, boxes: new Float32Array(MAX_BOXES * 4), count: 0, version: 0 }
let recent: Recent[] = []
let lastRuns = 0
let lastPoll = 0

export function goonerMask(now: number): GoonerMask | null {
  const { gooner } = useGooner.getState()
  if (!gooner.enabled) return null
  if (now - lastPoll >= POLL_MS) {
    lastPoll = now
    const run = engine.detectBoxes(gooner.kinds)
    let moved = false
    if (run.runs !== lastRuns) {
      lastRuns = run.runs
      for (const b of run.boxes) {
        const dx = Math.max(b.w * PADDING, 0.01)
        const dy = Math.max(b.h * PADDING, 0.01)
        recent.push({ x: b.x - dx, y: b.y - dy, w: b.w + 2 * dx, h: b.h + 2 * dy, until: now + LINGER_MS })
      }
      moved = true
    }
    const kept = recent.filter((r) => r.until > now)
    if (kept.length !== recent.length) moved = true
    recent = kept
    if (moved || gooner.style !== mask.style || gooner.strength !== mask.strength) {
      mask.style = gooner.style
      mask.strength = gooner.strength
      const shown = recent.slice(-MAX_BOXES)
      shown.forEach((r, i) => mask.boxes.set([r.x, r.y, r.w, r.h], i * 4))
      mask.count = shown.length
      mask.version++
    }
  }
  return mask
}

let started = false

export function startGooner() {
  if (started) return
  started = true
  let maskOn = false
  let boxesWanted = false
  const sync = () => {
    const settings = useSettings.getState().settings
    const gooner = settings?.gooner ?? defaultGooner()
    const denial = settings?.denial ?? defaultDenial()
    const isLocked = locked(gooner)
    const prev = useGooner.getState()
    if (prev.gooner !== gooner || prev.locked !== isLocked) useGooner.setState({ gooner, locked: isLocked })
    if (gooner.lock && !isLocked) void useSettings.getState().update((s) => ({ ...s, gooner: { ...s.gooner, lock: null } }))
    if (gooner.enabled !== maskOn) {
      maskOn = gooner.enabled
      if (!maskOn) {
        recent = []
        lastRuns = 0
      }
    }
    const wanted = gooner.enabled || (denial.enabled && isPremium(useAccount.getState()))
    if (wanted !== boxesWanted) {
      boxesWanted = wanted
      engine.setDetectBoxes(wanted)
      if (wanted) void useTracking.getState().refreshModels()
    }
  }
  useSettings.subscribe(sync)
  useChaster.subscribe(sync)
  useAccount.subscribe(sync)
  window.setInterval(sync, LOCK_TICK_MS)
  sync()
}
