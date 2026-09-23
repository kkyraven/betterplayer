import './styles/tokens.css'
import './styles/base.css'
import './styles/motion.css'
import './components/ui/Sheet.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { App } from './app/App'
import { Recover } from './app/Recover'
import { applyEnhance, createEngine, engine, setDisplayHz } from './engine/client'
import { startEngineEvents } from './engine/events'
import { startAccount } from './state/account'
import { startChaster } from './state/chaster'
import { startDenial } from './state/denial'
import { startGooner } from './state/gooner'
import { applyIntiface } from './state/intiface'
import { invoke, on } from './ipc'
import { startBroadcast } from './state/broadcast'
import { useBrowser } from './state/browser'
import { pushStopOnPause, useDevices } from './state/devices'
import { useEditor } from './state/editor'
import { pushEstim } from './state/estim'
import { useFollow } from './state/follow'
import { startI18n } from './state/i18n'
import { useLibrary } from './state/library'
import { usePlayer } from './state/player'
import { useSession } from './state/session'
import { useRemote } from './state/remote'
import { useSettings } from './state/settings'
import { useTracking } from './state/tracking'
import { useUi } from './state/ui'

document.documentElement.dataset.platform = process.platform

Object.assign(window, { __bp: { get engine() { return engine }, usePlayer, useSession, useDevices, useSettings, useUi, useFollow, useTracking, useBrowser, useRemote, useEditor } })

async function boot() {
  const root = document.getElementById('root')
  if (!root) throw new Error('Missing #root')
  window.addEventListener('error', (e) => void invoke('app:reportError', `uncaught: ${e.error instanceof Error ? (e.error.stack ?? e.error.message) : e.message}`))
  window.addEventListener('unhandledrejection', (e) => void invoke('app:reportError', `unhandled rejection: ${e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)}`))
  await startI18n()
  flushSync(() =>
    createRoot(root).render(
      <StrictMode>
        <Recover>
          <App />
        </Recover>
      </StrictMode>,
    ),
  )
  await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve)))
  performance.mark('shell-painted')
  useLibrary.getState().init()
  createEngine()
  performance.mark('engine-created')

  const settings = await useSettings.getState().load()
  engine.setHwdec(settings.playback.hwdec)
  pushEstim(settings.estim)
  setDisplayHz(await invoke('window:displayHz'))
  applyEnhance(settings.upscaling)
  useDevices.getState().connectSaved(settings.devices.outputs)
  pushStopOnPause(settings.devices.stopOnPause)
  applyIntiface(settings.intiface)
  useUi.getState().setFullscreen(await invoke('window:isFullscreen'))
  on('window:fullscreen', (fullscreen) => useUi.getState().setFullscreen(fullscreen))
  if (settings.appearance.startInMediaCentre) useUi.getState().setMediaCentre(true)
  startEngineEvents()
  startChaster()
  startGooner()
  startDenial()
  startAccount()
  void useRemote.getState().init()
  void startBroadcast()
  useBrowser.getState().init()
  useUi.subscribe((ui, prev) => {
    if (ui.screen !== 'browser' || prev.screen === 'browser') return
    const player = usePlayer.getState()
    if (player.snapshot.loaded && !player.snapshot.paused) player.pause()
  })
  const fileArg = process.argv.find((a) => a.startsWith('--bp-file='))
  const startArg = process.argv.find((a) => a.startsWith('--bp-start='))
  if (fileArg) void usePlayer.getState().open(fileArg.slice('--bp-file='.length), startArg ? Number(startArg.slice('--bp-start='.length)) : undefined)
  on('app:openFile', (path) => void usePlayer.getState().open(path))
}

void boot()
