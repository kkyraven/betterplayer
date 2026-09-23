import { app, BrowserWindow, crashReporter, nativeTheme, protocol } from 'electron'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { isMediaPath } from '@shared/ipc'
import { Account } from './account'
import { syncLanguage } from './i18n'
import { registerIpc, send } from './ipc'
import { Library } from './library'
import { logEvent } from './log'
import { RemoteClient } from './remote/client'
import { RemoteServer } from './remote/server'
import { ACCOUNT_URL_DEFAULT } from '@shared/account'
import { SettingsStore } from './settings/store'
import { startStashApp } from './stash-app'
import { Updater } from './update'
import { syncNativeTheme, watchNativeTheme } from './theme'

if (process.platform === 'darwin' && !app.isPackaged) {
  app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare')
}

const devEngine = process.platform === 'linux' ? resolve(app.getAppPath(), 'resources', 'engine', 'index.js') : resolve(app.getAppPath(), '..', 'engine', 'index.js')
const enginePath = app.isPackaged ? join(process.resourcesPath, 'engine', 'index.js') : devEngine
if (app.isPackaged) {
  process.env.PATH = [join(process.resourcesPath, 'engine', 'bin'), process.env.PATH].filter(Boolean).join(delimiter)
}
const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png')

const win32 = process.platform === 'win32'
function findYtdlp(): string | null {
  const home = app.getPath('home')
  const extra = win32
    ? [join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'), join(home, 'scoop', 'shims'), join(process.env.ProgramData ?? 'C:\ProgramData', 'chocolatey', 'bin')]
    : [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...extra]
  for (const d of dirs) {
    const p = join(d, win32 ? 'yt-dlp.exe' : 'yt-dlp')
    if (d && existsSync(p)) return p
  }
  return null
}
const ytdlp = findYtdlp()

const argv = process.argv.slice(app.isPackaged ? 1 : 2)
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const mediaArg = (args: string[], cwd: string) => {
  const found = args.find((a) => !a.startsWith('--') && isMediaPath(a) && existsSync(resolve(cwd, a)) && statSync(resolve(cwd, a)).isFile())
  return found ? resolve(cwd, found) : null
}
let launchFile = mediaArg(argv, process.cwd())
const screenshot = flag('screenshot')
const dataDir = flag('data')
if (dataDir) app.setPath('userData', resolve(dataDir))

crashReporter.start({ uploadToServer: false })
function logProcessExit(processType: string, details: { reason: string; exitCode: number }) {
  if (details.reason === 'clean-exit') return
  logEvent({ processType, ...details })
}
app.on('child-process-gone', (_event, details) => logProcessExit(details.type, details))

const RELOAD_WINDOW_MS = 30_000

function createWindow(store: SettingsStore, library: Library, remote: RemoteServer, client: RemoteClient, account: Account, updater: Updater) {
  const [sizeW, sizeH] = (flag('size') ?? '1440x900').split('x').map(Number)
  const colours = syncNativeTheme(store)
  const win = new BrowserWindow({
    width: sizeW || 1440,
    height: sizeH || 900,
    ...(argv.includes('--fullscreen') ? { fullscreen: true } : {}),
    minWidth: 960,
    minHeight: 600,
    show: false,
    icon: iconPath,
    backgroundColor: colours.background,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 12 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: colours.background, symbolColor: colours.text, height: 40 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: [`--bp-engine=${enginePath}`, `--bp-languages=${app.getPreferredSystemLanguages().join(',')}`, `--bp-language=${store.get().general.language}`, ...(store.get().general.setupDone ? [] : ['--bp-first-start']), ...(ytdlp ? [`--bp-ytdlp=${ytdlp}`] : []), ...(launchFile ? [`--bp-file=${launchFile}`] : []), ...(flag('start') ? [`--bp-start=${flag('start')}`] : [])],
    },
  })

  watchNativeTheme(store, win)
  registerIpc(win, store, library, remote, client, account, updater, ytdlp)
  let reloadedAt = 0
  win.webContents.on('render-process-gone', (_event, details) => {
    logProcessExit('renderer', details)
    if (details.reason === 'clean-exit' || win.isDestroyed() || Date.now() - reloadedAt < RELOAD_WINDOW_MS) return
    reloadedAt = Date.now()
    win.webContents.reload()
  })
  win.once('ready-to-show', () => win.show())
  if (!app.isPackaged) {
    win.webContents.on('console-message', (e) => {
      process.stderr.write(`renderer ${e.level}: ${e.message} (${e.sourceId}:${e.lineNumber})\n`)
    })
  }
  if (screenshot) {
    setTimeout(async () => {
      const [mx, my] = (flag('mouse') ?? '700,400').split(',').map(Number)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: mx ?? 700, y: my ?? 400 })
      for (const sel of (flag('click') ?? '').split(';;').filter(Boolean)) {
        await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.click()`)
        await new Promise((r) => setTimeout(r, 300))
      }
      const js = flag('js')
      if (js) await win.webContents.executeJavaScript(js).catch((e: unknown) => process.stderr.write(`js: ${String(e)}\n`))
      if (flag('settle')) await new Promise((r) => setTimeout(r, Number(flag('settle'))))
      for (const key of flag('keys') ?? '') {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
        win.webContents.sendInputEvent({ type: 'char', keyCode: key })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
        await new Promise((r) => setTimeout(r, 300))
      }
      await new Promise((r) => setTimeout(r, 200))
      writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG())
      app.quit()
    }, Number(flag('seconds') ?? 4) * 1000)
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

protocol.registerSchemesAsPrivileged([{ scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

if (win32) app.setAppUserModelId('com.kinkyraven.betterplayer')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let win: BrowserWindow | null = null
  let library: Library | null = null
  let remote: RemoteServer | null = null
  let account: Account | null = null
  let client: RemoteClient | null = null
  let settings: SettingsStore | null = null
  let updater: Updater | null = null

  const openFile = (path: string) => {
    if (!win) {
      launchFile = path
      return
    }
    if (win.isMinimized()) win.restore()
    win.focus()
    send(win, 'app:openFile', path)
  }
  app.on('open-file', (e, path) => {
    e.preventDefault()
    openFile(path)
  })
  app.on('second-instance', (_e, args, cwd) => {
    const path = mediaArg(args, cwd)
    if (path) openFile(path)
    else if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  nativeTheme.themeSource = 'dark'
  void app.whenReady().then(() => {
    if (!app.isPackaged) app.dock?.setIcon(iconPath)
    const userData = app.getPath('userData')
    const store = new SettingsStore(join(userData, 'settings.json'))
    settings = store
    void syncLanguage(store)
    const lib = new Library({ dataDir: userData, enginePath, modelsDir: join(userData, 'models') })
    library = lib
    const source = new RemoteClient(join(userData, 'remote-scripts'))
    client = source
    protocol.handle('thumb', (request) => (source.active ? source.thumb(request.url, request.headers.get('range'), request.signal) : lib.serveThumb(request.url, request.headers.get('range'), request.signal)))
    const libraryArg = flag('library')
    if (libraryArg && !lib.roots().some((r) => r.path === libraryArg)) lib.addRoot(libraryArg)
    const remotePort = Number(flag('remote'))
    const server = new RemoteServer(lib, Number.isInteger(remotePort) ? remotePort : undefined)
    remote = server
    const acct = new Account((flag('account') ?? process.env.BP_ACCOUNT_URL ?? ACCOUNT_URL_DEFAULT).replace(/\/$/, ''), userData, lib, {
      os: process.platform === 'darwin' ? 'darwin' : win32 ? 'win32' : 'linux',
      arch: process.arch,
      version: app.getVersion(),
    })
    account = acct
    const upd = new Updater((state) => {
      if (win) send(win, 'update:state', state)
    })
    updater = upd
    win = createWindow(store, lib, server, source, acct, upd)
    upd.start()
    acct.start(store.get())
    server.apply(store.get())
    source.apply(store.get())
    lib.setMatchOtherFolders(store.get().library.matchOtherFolders)
    lib.setAutoTag(store.get().library.autoTag)
    lib.setTagServers(store.get().library.tagServers)
    lib.start()
    void startStashApp(store.get().library.stashApp, lib)
    win.on('closed', () => {
      win = null
    })
  })

  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => {
    updater?.stop()
    remote?.stop()
    account?.stop()
    client?.stop()
    settings?.flush()
    library?.close()
  })
}
