import { app, BrowserWindow, screen as displays, type NativeImage, type Rectangle, type Size } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { VrOverlays } from 'bp-engine'
import { VR_PANELS, VR_SCREEN, VR_SCREEN_MAX_WIDTH, type VrCommand, type VrDeckState, type VrPanelId, type VrPlayerState } from '@shared/vr'
import { send } from '../ipc'
import { logEvent } from '../log'
import type { SettingsStore } from '../settings/store'
import { DeckIdle } from './idle'
import { PanelPointer } from './input'

const POLL_MS = 16
const PANEL_RELOAD_WINDOW_MS = 30_000

interface Surface {
  overlay: number
  window: BrowserWindow
  pointer: PanelPointer
  shown: boolean
  interactive: boolean
}

interface Panel extends Surface {
  id: VrPanelId
  reloadedAt: number
}

interface Screen extends Surface {
  frame: Size
  scale: number
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const screenTexture = ({ width, height }: Size): Size =>
  width <= VR_SCREEN_MAX_WIDTH ? { width, height } : { width: VR_SCREEN_MAX_WIDTH, height: Math.max(1, Math.round((height * VR_SCREEN_MAX_WIDTH) / width)) }

export class VrHost {
  private overlays: VrOverlays | null = null
  private deck: Panel | null = null
  private screen: Screen | null = null
  private latest: NativeImage | null = null
  private painting: ReturnType<typeof setTimeout> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private idle = new DeckIdle(0)
  private deckShown = ''
  private player: VrPlayerState | null = null
  private playerAt = 0

  constructor(
    private readonly win: BrowserWindow,
    private readonly enginePath: string,
    private readonly store: SettingsStore,
    private readonly preview = false,
  ) {
    win.on('closed', () => this.stop())
    win.webContents.on('render-process-gone', () => this.stop())
    win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.stop()
    })
  }

  get state(): VrDeckState | null {
    const player = this.player
    if (!player) return null
    const now = Date.now()
    const timeMs = player.playing ? Math.min(player.durationMs, player.timeMs + (now - this.playerAt) * player.rate) : player.timeMs
    return { ...player, timeMs, screen: this.screen?.shown ?? false, mode: this.idle.mode(now), peek: this.idle.peeked(now) }
  }

  get deckWindow(): BrowserWindow | null {
    return this.deck?.window ?? null
  }

  start() {
    if (this.deck) return
    try {
      if (!this.preview) {
        const addon: Pick<typeof import('bp-engine'), 'VrOverlays'> = createRequire(__filename)(this.enginePath)
        this.overlays = new addon.VrOverlays()
      }
      this.screen = this.openScreen()
      this.deck = this.open('deck')
      this.recentre()
      this.overlays?.follow(this.screen.overlay, true)
      this.overlays?.follow(this.deck.overlay, true)
    } catch (error) {
      this.stop()
      throw error
    }
    const now = Date.now()
    this.idle = new DeckIdle(now)
    this.showDeck(now)
    if (this.overlays) this.timer = setInterval(() => this.poll(), POLL_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.screen?.shown) this.subscribe(false)
    this.screen = null
    if (this.deck && !this.deck.window.isDestroyed()) this.deck.window.destroy()
    this.deck = null
    try {
      this.overlays?.close()
    } catch (error) {
      logEvent({ processType: 'main', reason: 'error', message: `vr overlays: ${message(error)}` })
    }
    this.overlays = null
    this.player = null
  }

  setState(state: VrPlayerState) {
    this.player = state
    this.playerAt = Date.now()
    this.idle.setLoaded(state.loaded, this.playerAt)
    this.showDeck(this.playerAt, true)
  }

  command(command: VrCommand) {
    if (command.kind === 'screen') return this.setScreen(command.open)
    if (command.kind === 'wake' || command.kind === 'peek') {
      const now = Date.now()
      if (command.kind === 'wake') this.idle.open(now)
      else this.idle.peek(now, command.shortcut)
      return this.showDeck(now)
    }
    if (command.kind === 'recentre') this.recentre(command.keepRecline)
    send(this.win, 'vr:command', command)
  }

  private open(id: VrPanelId): Panel {
    const spec = VR_PANELS[id]
    const overlay = this.overlays ? this.overlays.create(`com.kinkyraven.betterplayer.${id}.${process.pid}`, `Better Player ${id}`, spec.width, spec.height, spec.metres, spec.curvature) : -1
    const window = new BrowserWindow({
      width: spec.width,
      height: spec.height,
      useContentSize: true,
      resizable: false,
      show: this.preview,
      ...(this.preview ? { title: `Better Player ${id}`, backgroundColor: '#07080b', autoHideMenuBar: true } : { frame: false, transparent: true }),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
        offscreen: this.preview ? false : { deviceScaleFactor: 1 },
        additionalArguments: [`--bp-languages=${app.getPreferredSystemLanguages().join(',')}`, `--bp-language=${this.store.get().general.language}`],
      },
    })
    const panel: Panel = { id, overlay, window, pointer: new PanelPointer(spec.width, spec.height), shown: false, interactive: false, reloadedAt: 0 }
    const contents = window.webContents
    if (this.overlays) {
      contents.setFrameRate(60)
      contents.on('paint', (_event, dirty, image) => this.paint(panel, dirty, image))
    }
    contents.on('did-finish-load', () => contents.setZoomFactor(1))
    contents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit' || window.isDestroyed() || this.deck !== panel) return
      logEvent({ processType: `vr-${id}`, ...details })
      if (Date.now() - panel.reloadedAt < PANEL_RELOAD_WINDOW_MS) return this.end(`failed: the ${id} panel stopped (${details.reason})`)
      panel.reloadedAt = Date.now()
      contents.reload()
    })
    contents.on('console-message', (e) => {
      if (e.level !== 'warning' && e.level !== 'error') return
      logEvent({ processType: `vr-${id}`, reason: 'console', level: e.level, message: e.message, source: `${e.sourceId}:${e.lineNumber}` })
    })
    const devUrl = process.env.ELECTRON_RENDERER_URL
    const load = !app.isPackaged && devUrl ? window.loadURL(`${devUrl}/vr.html`) : window.loadFile(join(__dirname, '../renderer/vr.html'))
    load.catch((error: unknown) => {
      if (!window.isDestroyed()) logEvent({ processType: `vr-${id}`, reason: 'load-failed', message: message(error) })
    })
    return panel
  }

  private openScreen(): Screen {
    const [width = 0, height = 0] = this.win.getContentSize()
    const scale = displays.getDisplayMatching(this.win.getBounds()).scaleFactor
    const texture = screenTexture(width > 0 && height > 0 ? { width: Math.round(width * scale), height: Math.round(height * scale) } : { width: 1920, height: 1080 })
    const overlay = this.overlays ? this.overlays.create(`com.kinkyraven.betterplayer.screen.${process.pid}`, 'Better Player', texture.width, texture.height, VR_SCREEN.metres, VR_SCREEN.curvature) : -1
    return { overlay, window: this.win, pointer: new PanelPointer(texture.width, texture.height), shown: false, interactive: false, frame: { width: 0, height: 0 }, scale: 0 }
  }

  private paint(panel: Panel, dirty: Rectangle, image: NativeImage) {
    const overlays = this.overlays
    if (!overlays) return
    const { width, height } = VR_PANELS[panel.id]
    try {
      const size = image.getSize()
      if (size.width !== width || size.height !== height) {
        overlays.paint(panel.overlay, image.resize({ width, height }).toBitmap(), 0, 0, width, height)
        return
      }
      const x = Math.max(0, dirty.x)
      const y = Math.max(0, dirty.y)
      const w = Math.min(width, dirty.x + dirty.width) - x
      const h = Math.min(height, dirty.y + dirty.height) - y
      if (w > 0 && h > 0) overlays.paint(panel.overlay, image.crop({ x, y, width: w, height: h }).toBitmap(), x, y, w, h)
    } catch (error) {
      this.end(message(error))
    }
  }

  private frame(image: NativeImage) {
    this.latest = image
    this.painting ??= setTimeout(() => {
      this.painting = null
      const latest = this.latest
      this.latest = null
      if (latest) this.paintFrame(latest)
    }, 0)
  }

  private paintFrame(image: NativeImage) {
    const overlays = this.overlays
    const screen = this.screen
    if (!overlays || !screen?.shown || image.isEmpty()) return
    try {
      const frame = image.getSize()
      const texture = screenTexture(frame)
      const scale = displays.getDisplayMatching(this.win.getBounds()).scaleFactor
      if (frame.width !== screen.frame.width || frame.height !== screen.frame.height || scale !== screen.scale) {
        screen.frame = frame
        screen.scale = scale
        overlays.resize(screen.overlay, texture.width, texture.height)
        screen.pointer.fit(Math.round(frame.width / scale), Math.round(frame.height / scale), texture.width)
      }
      const scaled = texture.width < frame.width ? image.resize({ ...texture, quality: 'better' }) : image
      overlays.paint(screen.overlay, scaled.toBitmap(), 0, 0, texture.width, texture.height)
    } catch (error) {
      this.end(message(error))
    }
  }

  private poll() {
    const overlays = this.overlays
    if (!overlays) return
    try {
      const now = Date.now()
      for (const e of overlays.poll()) {
        if (e.kind === 'quit') return this.end(null)
        if (e.kind === 'recentre') this.recentre()
        const surface = e.overlay === this.deck?.overlay ? this.deck : e.overlay === this.screen?.overlay ? this.screen : null
        if (!surface) continue
        if (surface === this.deck && surface.pointer.used(e)) this.idle.use(now)
        const input = surface.pointer.input(e)
        if (input && !surface.window.isDestroyed()) surface.window.webContents.sendInputEvent(input)
      }
      if (this.deck?.pointer.holding) this.idle.use(now)
      this.showDeck(now)
    } catch (error) {
      this.end(message(error))
    }
  }

  private setScreen(open: boolean) {
    const screen = this.screen
    if (!screen || screen.shown === open) return
    const now = Date.now()
    this.idle.setScreen(open, now)
    this.show(screen, open)
    this.subscribe(open)
    this.showDeck(now, true)
    send(this.win, 'vr:command', { kind: 'screen', open })
  }

  private subscribe(on: boolean) {
    if (!this.overlays || this.win.isDestroyed() || this.win.webContents.isDestroyed()) return
    if (on) this.win.webContents.beginFrameSubscription(false, (image) => this.frame(image))
    else this.win.webContents.endFrameSubscription()
  }

  private sendState() {
    const state = this.state
    if (state && this.deck) send(this.deck.window, 'vr:state', state)
  }

  private recentre(keepRecline?: boolean) {
    const overlays = this.overlays
    if (!overlays) return
    overlays.recentre(keepRecline)
    if (this.screen) overlays.place(this.screen.overlay, VR_SCREEN.distance, VR_SCREEN.drop, VR_SCREEN.pitch)
    const spec = VR_PANELS.deck
    if (this.deck) overlays.place(this.deck.overlay, spec.distance, spec.drop, spec.pitch)
  }

  private show(surface: Surface | null, on: boolean, interactive = true) {
    if (!surface || (surface.shown === on && (!on || surface.interactive === interactive))) return
    if (surface.interactive && !(on && interactive) && !surface.window.isDestroyed()) {
      for (const input of surface.pointer.release()) surface.window.webContents.sendInputEvent(input)
    }
    surface.shown = on
    surface.interactive = on && interactive
    if (on) this.overlays?.show(surface.overlay, interactive)
    else this.overlays?.hide(surface.overlay)
  }

  private showDeck(now: number, force = false) {
    const mode = this.idle.mode(now)
    this.show(this.deck, mode !== 'hidden', mode === 'open')
    const peek = this.idle.peeked(now)
    const shown = `${mode} ${peek?.shortcut ?? ''} ${peek?.count ?? 0}`
    if (!force && shown === this.deckShown) return
    this.deckShown = shown
    this.sendState()
  }

  private end(reason: string | null) {
    this.stop()
    send(this.win, 'vr:ended', reason)
  }
}
