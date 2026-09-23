import { create } from 'zustand'
import { syncRate, SYNC_SEEK_MS } from '@shared/peer'
import type { Upscaler } from '@shared/settings'
import { applyEnhance, engine } from '@/engine/client'
import { Side, setSide, side } from '@/engine/side'
import * as live from './live'
import { isUrl, onPlayback, usePlayer } from './player'
import { useSettings } from './settings'
import { useUi } from './ui'

const SYNC_INTERVAL_MS = 250

interface CompareState {
  left: Upscaler
  right: Upscaler
  on: boolean
  setLeft: (left: Upscaler) => void
  start: () => void
  stop: () => void
}

export function canCompare(): boolean {
  const p = usePlayer.getState()
  return p.path !== null && !isUrl(p.path) && p.audio === null && p.snapshot.loaded && !p.snapshot.error
}

export const useCompare = create<CompareState>()((set, get) => {
  let unlisten: (() => void) | null = null
  let syncTimer = 0

  const sync = () => {
    const p = usePlayer.getState()
    if (!side || p.snapshot.paused) return
    const driftMs = side.timePos() * 1000 - live.get().timeMs
    if (Math.abs(driftMs) > SYNC_SEEK_MS) side.seek(live.get().timeMs / 1000)
    else side.setRate(syncRate(p.snapshot.rate, driftMs))
  }

  return {
    left: 'off',
    right: 'sharp',
    on: false,
    setLeft: (left) => {
      set({ left })
      if (get().on) engine.setEnhance({ upscaler: left })
    },
    start: () => {
      const p = usePlayer.getState()
      const settings = useSettings.getState().settings
      if (get().on || !p.path || !settings || !canCompare()) return
      const { left } = get()
      const right = settings.upscaling.upscaler
      const s = new Side(p.path, live.get().timeMs / 1000)
      setSide(s)
      s.setUpscaler(right)
      s.setRate(p.snapshot.rate)
      if (!p.snapshot.paused) s.play()
      engine.setEnhance({ upscaler: left })
      unlisten = onPlayback((c) => {
        if (c.kind === 'play') s.play()
        else if (c.kind === 'pause') s.pause()
        else if (c.kind === 'seek') s.seek(c.timeMs / 1000)
        else if (c.kind === 'rate') s.setRate(c.rate)
      })
      syncTimer = window.setInterval(sync, SYNC_INTERVAL_MS)
      set({ on: true, right })
      const ui = useUi.getState()
      ui.setScreen('player')
      void ui.toggleFullscreen(true)
    },
    stop: () => {
      if (!get().on) return
      unlisten?.()
      unlisten = null
      window.clearInterval(syncTimer)
      side?.close()
      setSide(null)
      set({ on: false })
      const settings = useSettings.getState().settings
      if (settings) applyEnhance(settings.upscaling, usePlayer.getState().video.frameGen)
      const ui = useUi.getState()
      if (ui.fullscreen) void ui.toggleFullscreen(false)
      if (ui.screen === 'player') ui.setScreen(ui.previous)
    },
  }
})

usePlayer.subscribe((s, prev) => {
  if (s.path !== prev.path) useCompare.getState().stop()
})
useUi.subscribe((s, prev) => {
  if (prev.fullscreen && !s.fullscreen) useCompare.getState().stop()
})
