import { create } from 'zustand'
import { isAxisId } from '@shared/axes'
import { VR_SCREEN_SIZE_DEFAULT, VR_SCREEN_SIZES, VR_SHORTCUTS, VR_SKIP_SECONDS, VR_TURN_DEGREES, vrError, type VrCommand, type VrError, type VrPlayerState, type VrScreenSize, type VrShortcut } from '@shared/vr'
import { engine, vrAvailable } from '@/engine/client'
import { invoke, on } from '@/ipc'
import { ipcMessage } from '@/lib/errors'
import { platform } from '@/node'
import { outputName, useDevices } from './devices'
import * as live from './live'
import { usePlayer } from './player'
import { useSession } from './session'
import { useUi } from './ui'
import { track } from './usage'

const AVAILABLE_MS = 3000
const WATCH_MS = 250
const SHORTCUT_MS = 50
const VOLUME_STEPS = 20
const TICK_MS = 100
const PUSH_MS = 500
const MOUNT_SETTLE_MS = 1000
const ERROR_MS = 8000
const END_SETTLE_MS = 1500
const SCREEN_SIZE_KEY = 'bp.vr.screenSize'

const preview = process.argv.includes('--bp-vr-preview')

interface VrState {
  available: boolean
  active: boolean
  starting: boolean
  error: VrError | null
  hmdName: string
  start: () => Promise<void>
  stop: () => void
  clearError: () => void
}

let session: (() => void) | null = null
let attempt = 0
let errorTimer = 0
let ownMediaCentre = false
let fullscreenBefore = false

export const useVr = create<VrState>()((set, get) => ({
  available: false,
  active: false,
  starting: false,
  error: null,
  hmdName: '',
  start: async () => {
    if (get().active || get().starting) return
    const mine = ++attempt
    get().clearError()
    set({ starting: true })
    try {
      await invoke('vr:start')
      if (mine !== attempt) return
      if (!preview) {
        await engine.vrStart()
        if (mine !== attempt) return
        engine.vrView(usePlayer.getState().projection)
        engine.vrScreen(VR_SCREEN_SIZES[savedScreenSize()])
        engine.vrRecentre()
      }
    } catch (error) {
      if (mine === attempt) end(ipcMessage(error))
      return
    }
    set({ active: true, starting: false, hmdName: preview ? 'Preview' : (engine.vrState()?.hmdName ?? '') })
    track('action.vr.start')
    ownMediaCentre = !useUi.getState().mediaCentre
    fullscreenBefore = useUi.getState().fullscreen
    if (ownMediaCentre) useUi.getState().setMediaCentre(true, { fullscreen: fullscreenBefore || !preview, auto: true })
    followScreen(false)
    session = run()
    if (!usePlayer.getState().path) void invoke('vr:command', { kind: 'screen', open: true })
  },
  stop: () => leave(null),
  clearError: () => {
    window.clearTimeout(errorTimer)
    set({ error: null })
  },
}))

const isScreenSize = (s: string | null): s is VrScreenSize => s !== null && Object.hasOwn(VR_SCREEN_SIZES, s)

function savedScreenSize(): VrScreenSize {
  const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem(SCREEN_SIZE_KEY)
  return isScreenSize(saved) ? saved : VR_SCREEN_SIZE_DEFAULT
}

function halt() {
  usePlayer.getState().pause()
  if (!preview) engine.haltSensation()
}

function end(reason: string | null) {
  console.warn(`VR ended: ${reason ?? 'quit'}`)
  try {
    halt()
  } finally {
    leave(vrError(reason ?? 'quit'))
  }
}

function leave(error: VrError | null) {
  attempt++
  session?.()
  session = null
  void invoke('vr:stop')
  useVr.setState({ active: false, starting: false })
  if (ownMediaCentre) useUi.getState().setMediaCentre(false, { fullscreen: fullscreenBefore && useUi.getState().fullscreen })
  else followScreen(false)
  ownMediaCentre = false
  if (error) {
    window.clearTimeout(errorTimer)
    useVr.setState({ error })
    errorTimer = window.setTimeout(() => useVr.setState({ error: null }), ERROR_MS)
  }
  if (!preview) void stopEngine()
}

async function stopEngine() {
  try {
    await engine.vrStop()
  } catch (e) {
    console.warn(`vrStop: ${ipcMessage(e)}`)
  }
}

export function startVr() {
  if (preview) useVr.setState({ available: true })
  else if (platform === 'win32') {
    const check = () => {
      if (useVr.getState().active) return
      let available = false
      try {
        const a = vrAvailable()
        available = a.installed && a.hmd
      } catch {
      }
      if (available !== useVr.getState().available) useVr.setState({ available })
    }
    check()
    window.setInterval(check, AVAILABLE_MS)
  }
  on('vr:ended', (reason) => {
    const { active, starting } = useVr.getState()
    if (active || starting) end(reason)
  })
}

function heatAcross(heat: readonly number[], heatMs: number, durationMs: number): number[] {
  if (heat.length === 0 || heatMs <= 0 || durationMs <= 0) return [...heat]
  const n = Math.max(1, Math.round((heat.length * durationMs) / heatMs))
  return n <= heat.length ? heat.slice(0, n) : [...heat, ...new Array<number>(n - heat.length).fill(0)]
}

function followScreen(open: boolean) {
  const ui = useUi.getState()
  if (!ui.mediaCentre) return
  if (open && ui.tvTab === 'nowplaying') useUi.setState({ tvTab: 'library', tvOverlay: 'none' })
  else if (!open && ui.tvTab !== 'nowplaying' && usePlayer.getState().path) ui.setTvTab('nowplaying')
}

function deckState(halted: boolean, screenSize: VrScreenSize): VrPlayerState {
  const { snapshot, title, scripts, projection, projectionSource, volume, muted } = usePlayer.getState()
  const { outputs, states } = useDevices.getState()
  const stroke = scripts.find((s) => s.axis === 'L0' && s.selected) ?? scripts.find((s) => s.selected) ?? scripts[0]
  return {
    title,
    loaded: snapshot.loaded,
    playing: snapshot.loaded && !snapshot.paused,
    timeMs: live.get().timeMs,
    durationMs: snapshot.durationMs,
    rate: snapshot.rate,
    heat: heatAcross(stroke?.heatmap ?? [], stroke?.durationMs ?? 0, snapshot.durationMs),
    axes: live.axisIdsWith(live.FLAG_SCRIPT | live.FLAG_DERIVED).filter(isAxisId),
    devices: outputs.map((o) => ({ name: outputName(o.config), connected: states[o.id]?.status === 'connected' })),
    projection,
    projectionSource,
    volume,
    muted,
    screenSize,
    halted,
    inSession: useSession.getState().stage === 'running',
  }
}

function run(): () => void {
  let halted = false
  let screenSize = savedScreenSize()
  let screen = false
  let endTimer = 0
  const showScreen = (open: boolean) => void invoke('vr:command', { kind: 'screen', open })
  let sent = ''
  let sentAt = 0
  let sentTimeMs = -1
  let seekGeneration = -1
  const push = (force: boolean) => {
    const state = deckState(halted, screenSize)
    const key = JSON.stringify({ ...state, timeMs: 0 })
    if (!force && key === sent) return
    sent = key
    sentAt = performance.now()
    sentTimeMs = state.timeMs
    seekGeneration = live.get().seekGeneration
    void invoke('vr:state', state)
  }
  const tick = () => {
    const l = live.get()
    const { loaded, paused } = usePlayer.getState().snapshot
    const moved = loaded && !paused ? performance.now() - sentAt >= PUSH_MS : l.timeMs !== sentTimeMs
    if (moved || l.seekGeneration !== seekGeneration) push(true)
  }
  const apply = (command: VrCommand) => {
    const player = usePlayer.getState()
    switch (command.kind) {
      case 'toggle':
        player.togglePlay()
        break
      case 'seek':
        player.seek(command.timeMs / 1000)
        break
      case 'skip':
        player.seekBy(command.seconds)
        break
      case 'stop':
        halt()
        halted = true
        break
      case 'recentre':
        if (!preview) engine.vrRecentre(command.keepRecline)
        break
      case 'projection':
        player.setProjection(command.projection)
        break
      case 'screenSize':
        screenSize = command.size
        localStorage.setItem(SCREEN_SIZE_KEY, screenSize)
        if (!preview) engine.vrScreen(VR_SCREEN_SIZES[screenSize])
        break
      case 'step': {
        const clips = useSession.getState()
        if (clips.stage === 'running') (command.direction > 0 ? clips.next : clips.previous)()
        else void player.step(command.direction)
        break
      }
      case 'screen':
        screen = command.open
        followScreen(command.open)
        break
    }
    push(false)
  }
  const shortcut = (name: VrShortcut) => {
    if (name === 'controls' || (name === 'playPause' && halted)) return void invoke('vr:command', { kind: 'wake' })
    const player = usePlayer.getState()
    switch (name) {
      case 'back':
        if (screen) return
        player.pause()
        return showScreen(true)
      case 'turnLeft':
      case 'turnRight':
        if (!preview) engine.vrTurn(name === 'turnLeft' ? -VR_TURN_DEGREES : VR_TURN_DEGREES)
        return
      case 'playPause':
        apply({ kind: 'toggle' })
        break
      case 'seekBack':
      case 'seekForward':
        apply({ kind: 'skip', seconds: name === 'seekBack' ? -VR_SKIP_SECONDS : VR_SKIP_SECONDS })
        break
      case 'volumeUp':
      case 'volumeDown':
        player.setVolume((Math.round(player.volume * VOLUME_STEPS) + (name === 'volumeUp' ? 1 : -1)) / VOLUME_STEPS)
        break
      case 'recentre':
        void invoke('vr:command', { kind: 'recentre' })
        break
      case 'stop':
        apply({ kind: 'stop' })
        break
    }
    void invoke('vr:command', { kind: 'peek', shortcut: name })
  }
  const hasShortcuts = !preview && typeof engine.vrShortcuts === 'function'
  const drain = () => {
    const names = engine.vrShortcuts()
    if (names.length === 0 || !engine.vrState()?.mounted) return
    for (const name of names) {
      const known = VR_SHORTCUTS.find((s) => s === name)
      if (known) shortcut(known)
    }
  }
  let mounted = true
  let settle = 0
  let presses = preview || hasShortcuts ? 0 : (engine.vrState()?.presses ?? 0)
  let focused = preview || engine.vrState()?.focused !== false
  const watch = () => {
    const vr = engine.vrState()
    if (!vr || vr.quit || vr.error) {
      end(vr?.error ?? (vr?.quit ? 'quit' : 'failed'))
      return
    }
    if (mounted && !vr.mounted) {
      window.clearTimeout(settle)
      halt()
      halted = true
      push(false)
    }
    if (!mounted && vr.mounted) {
      const recentre = vr.lostTracking !== true
      settle = window.setTimeout(() => {
        if (recentre) void invoke('vr:command', { kind: 'recentre' })
        void invoke('vr:command', { kind: 'peek' })
      }, MOUNT_SETTLE_MS)
    }
    mounted = vr.mounted
    if (focused && vr.focused === false) usePlayer.getState().pause()
    focused = vr.focused !== false
    if (!hasShortcuts && vr.presses > presses) void invoke('vr:command', { kind: 'wake' })
    presses = vr.presses
  }
  const offPlayer = usePlayer.subscribe((s, prev) => {
    if (prev.snapshot.paused && !s.snapshot.paused) halted = false
    if (s.projection !== prev.projection && !preview) engine.vrView(s.projection)
    if (screen && s.path !== null && s.path !== prev.path) showScreen(false)
    if (s.ended && !prev.ended) {
      window.clearTimeout(endTimer)
      endTimer = window.setTimeout(() => {
        if (!screen && usePlayer.getState().ended) showScreen(true)
      }, END_SETTLE_MS)
    }
    push(false)
  })
  const offSession = useSession.subscribe((s, prev) => {
    if (s.stage === prev.stage) return
    if (!screen && prev.stage === 'running') showScreen(true)
    push(false)
  })
  const offUi = useUi.subscribe((s, prev) => {
    if (prev.mediaCentre && !s.mediaCentre) ownMediaCentre = false
    if (screen && s.mediaCentre && s.tvTab === 'nowplaying' && prev.tvTab !== 'nowplaying') showScreen(false)
  })
  const offDevices = useDevices.subscribe(() => push(false))
  const offCommand = on('vr:command', apply)
  const ticker = window.setInterval(tick, TICK_MS)
  const watcher = preview ? 0 : window.setInterval(watch, WATCH_MS)
  const shortcuts = hasShortcuts ? window.setInterval(drain, SHORTCUT_MS) : 0
  push(true)
  return () => {
    offPlayer()
    offSession()
    offUi()
    offDevices()
    offCommand()
    window.clearInterval(ticker)
    window.clearInterval(watcher)
    window.clearInterval(shortcuts)
    window.clearTimeout(settle)
    window.clearTimeout(endTimer)
  }
}
