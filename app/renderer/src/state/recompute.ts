import { create } from 'zustand'
import type { OutputConfig } from '@shared/settings'
import { engine } from '@/engine/client'
import { invoke } from '@/ipc'
import { outputName, useDevices, type ConfiguredOutput } from './devices'
import { t } from './i18n'
import { currentSetup, runGeneration, savedResult, toRows, waitForAudio, type RunSetup } from './generated'
import { usePlayer } from './player'
import { useSettings } from './settings'
import { trackingSettings, useTracking } from './tracking'

const HOSTED: ReadonlyArray<OutputConfig['kind']> = ['howl', 'handy']
const EDIT_SETTLE_MS = 1500

interface RecomputeStore {
  busy: boolean
  devices: string
  percent: number | null
  cancel: () => void
  check: () => Promise<void>
}

const same = (a: RunSetup | null, b: RunSetup) => a !== null && a.key === b.key && a.hash === b.hash

function hosted(): ConfiguredOutput[] {
  const d = useDevices.getState()
  return d.outputs.filter((o) => HOSTED.includes(o.config.kind) && d.states[o.id]?.status === 'connected')
}

function label(outputs: ConfiguredOutput[]): string {
  const names = outputs.map((o) => outputName(o.config))
  return names.length <= 1 ? (names[0] ?? '') : t('player.recompute.pair', { first: names.slice(0, -1).join(', '), second: names[names.length - 1] ?? '' })
}

export const useRecompute = create<RecomputeStore>()((set, get) => {
  let installed: RunSetup | null = null
  let declined: RunSetup | null = null
  let running: RunSetup | null = null

  const clear = () => {
    if (!installed) return
    engine.setGenerated([])
    installed = null
  }
  const stale = (s: RunSetup) => usePlayer.getState().path !== s.key || useTracking.getState().key !== s.key

  const run = async (s: RunSetup, outputs: ConfiguredOutput[]) => {
    running = s
    const saved = await savedResult(s)
    if (saved && !stale(s)) {
      engine.setGenerated(saved)
      installed = s
      running = null
      return
    }
    set({ busy: true, devices: label(outputs), percent: null })
    const player = usePlayer.getState()
    const wasPlaying = !player.snapshot.paused
    if (wasPlaying) player.pause()
    let scripts: Awaited<ReturnType<typeof runGeneration>> | null = null
    try {
      if (s.sources.has('beat') || s.sources.has('ai-music')) await waitForAudio(s.key).catch(() => undefined)
      scripts = await runGeneration((p) => {
        const percent = p.status === 'running' && p.durationMs > 0 ? Math.round((100 * p.timeMs) / p.durationMs) : null
        if (percent !== get().percent) set({ percent })
      })
    } catch (e) {
      if (engine.generateState().status !== 'cancelled') console.warn('recompute', e)
      declined = s
      clear()
    }
    running = null
    if (scripts && !stale(s)) {
      const rows = toRows(scripts)
      engine.setGenerated(rows)
      installed = s
      void invoke('generated:put', s.key, s.hash, rows)
    }
    set({ busy: false, percent: null })
    if (wasPlaying && usePlayer.getState().path === s.key) usePlayer.getState().play()
    void get().check()
  }

  return {
    busy: false,
    devices: '',
    percent: null,
    cancel: () => {
      if (running) engine.generateCancel()
    },
    check: async () => {
      const s = currentSetup()
      if (!s || ![...s.sources].some((src) => src !== 'off')) {
        if (running) engine.generateCancel()
        else clear()
        return
      }
      if (running) {
        if (!same(running, s)) engine.generateCancel()
        return
      }
      if (same(installed, s) || same(declined, s)) return
      const outputs = hosted()
      if (outputs.length === 0) {
        clear()
        return
      }
      await run(s, outputs)
    },
  }
})

let timer: ReturnType<typeof setTimeout> | undefined
const schedule = (ms: number) => {
  clearTimeout(timer)
  timer = setTimeout(() => void useRecompute.getState().check(), ms)
}

usePlayer.subscribe((s, prev) => {
  if (s.path !== prev.path || s.snapshot.loaded !== prev.snapshot.loaded) schedule(0)
})
useDevices.subscribe((s, prev) => {
  const connected = (d: typeof s) => d.outputs.filter((o) => HOSTED.includes(o.config.kind) && d.states[o.id]?.status === 'connected').map((o) => o.id).join()
  if (connected(s) !== connected(prev)) schedule(0)
})
useTracking.subscribe((s, prev) => {
  if (s.source !== prev.source || s.key !== prev.key) schedule(0)
  else {
    const a = trackingSettings(s)
    const b = trackingSettings(prev)
    if (s.present !== prev.present || (Object.keys(a) as (keyof typeof a)[]).some((k) => a[k] !== b[k])) schedule(EDIT_SETTLE_MS)
  }
})
useSettings.subscribe((s, prev) => {
  if (s.settings?.tracking !== prev.settings?.tracking) schedule(EDIT_SETTLE_MS)
})
