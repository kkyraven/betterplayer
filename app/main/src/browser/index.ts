import { app, safeStorage, session, webFrameMain, WebContentsView, type BrowserWindow, type IpcMain, type IpcMainEvent } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ElectronBlocker, fromElectronDetails } from '@ghostery/adblocker-electron'
import { type BrowserHandoff, type BrowserFrame, type BrowserStartData, type BrowserTab, type BrowserVideo, type Rect, type Region, type RegionBox, REVEAL_ZONE_PX, TAB_CHANNELS, type TabFrame } from '@shared/browser'
import type { IpcEvent, IpcEvents } from '@shared/ipc'
import { handoffHeaders, handoffState, mediaUrl } from './handoff'
import { isBlockedHost } from './blocklist'
import { showContextMenu } from './context-menu'
import { mostVisited, readSession, writeSession, webUrl, type SavedTab } from './storage'
import { ERO_CHANNELS, EROSCRIPTS_HOME, isEroScriptsUrl, isEroTopicUrl, sourceUrl, type EroTopic } from '@shared/eroscripts'
import { topicReport } from './topic'
import { BrowserDownloads, type OrdinaryBrowserDownload } from './downloads'
import type { TransferRequest, TransferResult } from '../downloads/transport'

export type Emit = <E extends IpcEvent>(event: E, payload: IpcEvents[E]) => void

const PARTITION = 'persist:browser'
const ADBLOCK_PRELOAD = createRequire(import.meta.url).resolve('@ghostery/adblocker-electron-preload')
const SNAPSHOT_TIMEOUT_MS = 500

const HOST = /^[^\s/@]+\.[^\s/@]{2,}(:\d+)?([/?#].*)?$/
const LOCALHOST = /^localhost(:\d+)?([/?#].*)?$/

export function toUrl(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  if (HOST.test(trimmed) || LOCALHOST.test(trimmed)) return `https://${trimmed}`
  return `https://www.bing.com/videos/search?q=${encodeURIComponent(trimmed)}&adlt=off`
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null
  } catch {
    return null
  }
}

interface FrameRef {
  processId: number
  frameId: number
}

interface Tab {
  id: number
  initial: SavedTab
  view: WebContentsView
  blocked: number
  video: BrowserVideo | null
  capturing: boolean
  region: RegionBox | null
  zone: Region | null
  videoFrame: FrameRef | null
  snapshot: { resolve: (frame: BrowserFrame | null) => void; timer: NodeJS.Timeout } | null
  favicon: string | null
  attached: boolean
  pending: (() => void) | null
  generation: number
  topic: EroTopic | null
  related: { attemptId: string; fileId: string; sourceUrl: string; topic: EroTopic; approvedUrl: string | null; approvedUntil: number } | null
  topLevelUrl: string
}

function sameFrame(ref: FrameRef | null, event: IpcMainEvent): boolean {
  return ref !== null && ref.processId === event.processId && ref.frameId === event.frameId
}

export class BrowserTabs {
  private readonly tabList: Tab[] = []
  private readonly byContents = new Map<number, Tab>()
  private activeId: number | null = null
  private bounds: Rect | null = null
  private blocker: ElectronBlocker | null = null
  private lastAdBlocking: boolean
  private nextId = 1
  private nextHandoffId = 1
  private readonly sessionPath = join(app.getPath('userData'), 'browser-session.json')
  private readonly saved = readSession(this.sessionPath)
  private readonly cookiesPath = join(app.getPath('userData'), 'browser-session-cookies.bin')
  private readonly sessionCookies = new Map<string, Electron.CookiesSetDetails>()
  private cookiesLoaded = false
  private cookiesReady: Promise<void> = Promise.resolve()
  private saveTimer: NodeJS.Timeout | null = null
  private destroying = false
  private restoring = true
  private cosmeticPreload: string | null = null
  private pushTimer: NodeJS.Timeout | null = null
  private readonly downloads: BrowserDownloads
  private ordinaryDownloadHandler: ((download: OrdinaryBrowserDownload) => void) | null = null

  constructor(
    private readonly win: BrowserWindow,
    private readonly preload: string,
    private readonly emit: Emit,
    private readonly ipc: IpcMain,
    private readonly premium: () => boolean,
    private readonly toggleFullscreen: () => void,
  ) {
    this.lastAdBlocking = this.adBlocking
    this.cookiesReady = this.restoreCookies()
    this.downloads = new BrowserDownloads(session.fromPartition(PARTITION), ipc, {
      topic: (id) => this.getTopic(id),
      contents: (id) => this.find(id)?.view.webContents ?? null,
      openRelated: (request) => this.openRelatedDownload(request),
      openTransfer: (request) => this.openRelatedDownload(request, true),
      activate: (id) => this.activate(id),
      ordinaryDownload: (item, contents) => {
        const tab = this.byContents.get(contents.id)
        if (tab) this.ordinaryDownloadHandler?.({ item, tabId: tab.id, pageUrl: contents.getURL() })
      },
      approveNavigation: (contents, url) => {
        const related = this.byContents.get(contents.id)?.related
        if (related) { related.approvedUrl = url; related.approvedUntil = Date.now() + 20_000 }
      },
      finishNavigation: (contents) => {
        const tab = this.byContents.get(contents.id)
        if (!tab?.related) return
        tab.related.approvedUrl = null
        tab.related.approvedUntil = 0
        if (!this.relatedNavigation(tab.related.sourceUrl, contents.getURL())) tab.related = null
        this.push()
      },
    })
    this.blockAds()
    for (const tab of this.saved.tabs) this.open(tab.url, tab)
    const active = this.tabList[this.saved.activeIndex]
    if (active) this.activeId = active.id
    this.restoring = false
    win.on('close', () => { this.persist(); session.fromPartition(PARTITION).flushStorageData() })
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.setBounds(null)
    })
    win.webContents.on('render-process-gone', () => this.setBounds(null))
    ipc.on(TAB_CHANNELS.video, (event: IpcMainEvent, video: BrowserVideo) => this.onVideo(event, video))
    ipc.on(TAB_CHANNELS.frame, (event: IpcMainEvent, frame: TabFrame) => this.onFrame(event, frame))
    ipc.on(ERO_CHANNELS.topic, (event: IpcMainEvent, payload: unknown) => {
      const tab = this.byContents.get(event.sender.id)
      if (!tab || event.senderFrame !== tab.view.webContents.mainFrame) return
      const report = topicReport(payload, tab.id, tab.generation, tab.view.webContents.getURL())
      if (!report) return
      tab.topic = report
      this.push()
    })
    ipc.on(TAB_CHANNELS.regionEdit, (event: IpcMainEvent, region: Region) => {
      const tab = this.byContents.get(event.sender.id)
      if (!tab) return
      tab.region = { region, auto: false, label: null }
      this.emit('browser:region', { id: tab.id, region })
    })
    ipc.on(TAB_CHANNELS.zoneEdit, (event: IpcMainEvent, region: Region) => {
      const tab = this.byContents.get(event.sender.id)
      if (!tab) return
      tab.zone = region
      this.emit('browser:zone', { id: tab.id, region })
    })
    ipc.on(TAB_CHANNELS.error, (event: IpcMainEvent, error: string) => {
      const tab = this.byContents.get(event.sender.id)
      if (!tab) return
      tab.capturing = false
      this.settleSnapshot(tab, null)
      this.push()
      this.emit('browser:error', { id: tab.id, error })
    })
  }

  private blockAds() {
    const browser = session.fromPartition(PARTITION)
    browser.webRequest.onBeforeRequest((details, callback) => {
      if (!this.downloads.allowRequest(details)) return callback({ cancel: true })
      if (!this.adBlocking || details.resourceType === 'mainFrame' || this.requestAdExempt(details.webContentsId)) return callback({})
      const host = hostOf(details.url)
      if (!host) return callback({})
      let redirectURL: string | undefined
      let blocked = isBlockedHost(host)
      if (!blocked && this.blocker) {
        const { match, redirect } = this.blocker.match(fromElectronDetails(details))
        blocked = match
        redirectURL = redirect?.dataUrl
      }
      if (!blocked) return callback({})
      const tab = details.webContentsId === undefined ? undefined : this.byContents.get(details.webContentsId)
      if (tab) {
        tab.blocked += 1
        this.push()
      }
      callback(redirectURL ? { redirectURL } : { cancel: true })
    })
    void this.loadFilterLists(browser)
  }

  private async loadFilterLists(browser: Electron.Session) {
    const dir = join(app.getPath('userData'), 'adblock')
    try {
      await mkdir(dir, { recursive: true })
      const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking((url) => fetch(url, { signal: AbortSignal.timeout(15_000) }), {
        path: join(dir, 'engine.bin'),
        read: (path) => readFile(path).then((b) => new Uint8Array(b)),
        write: (path, buffer) => writeFile(path, buffer),
      })
      if (this.destroying || this.win.isDestroyed()) return
      this.blocker = blocker
      this.cosmeticPreload = browser.registerPreloadScript({ type: 'frame', filePath: ADBLOCK_PRELOAD })
      this.ipc.handle('@ghostery/adblocker/inject-cosmetic-filters', (...args: Parameters<typeof blocker.onInjectCosmeticFilters>) => {
        if (this.adBlocking && !this.requestAdExempt(args[0].sender.id)) return blocker.onInjectCosmeticFilters(...args)
      })
      this.ipc.handle('@ghostery/adblocker/is-mutation-observer-enabled', (event) => this.adBlocking && !this.requestAdExempt(event.sender.id) && blocker.onIsMutationObserverEnabled(event))
      browser.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
        if (this.adBlocking && !this.requestAdExempt(details.webContentsId)) blocker.onHeadersReceived(details, callback)
        else callback({})
      })
    } catch (e) {
      console.warn('adblock: filter lists unavailable, using the static blocklist', e)
    }
  }

  private requestAdExempt(contentsId: number | undefined): boolean {
    const tab = contentsId === undefined ? undefined : this.byContents.get(contentsId)
    return !!tab && this.tabAdExempt(tab)
  }

  private tabAdExempt(tab: Tab): boolean {
    return isEroScriptsUrl(tab.topLevelUrl) || tab.related !== null
  }

  private async restoreCookies() {
    const browser = session.fromPartition(PARTITION)
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const stored: unknown = JSON.parse(safeStorage.decryptString(readFileSync(this.cookiesPath)))
        if (Array.isArray(stored)) await Promise.all(stored.map(async (cookie: unknown) => {
          if (typeof cookie !== 'object' || cookie === null || !('url' in cookie) || !webUrl(cookie.url)
            || !('name' in cookie) || typeof cookie.name !== 'string' || !('value' in cookie) || typeof cookie.value !== 'string') return
          const details: Electron.CookiesSetDetails = { url: cookie.url, name: cookie.name, value: cookie.value }
          if ('domain' in cookie && typeof cookie.domain === 'string') details.domain = cookie.domain
          if ('path' in cookie && typeof cookie.path === 'string') details.path = cookie.path
          if ('secure' in cookie && typeof cookie.secure === 'boolean') details.secure = cookie.secure
          if ('httpOnly' in cookie && typeof cookie.httpOnly === 'boolean') details.httpOnly = cookie.httpOnly
          if ('sameSite' in cookie && (cookie.sameSite === 'no_restriction' || cookie.sameSite === 'lax' || cookie.sameSite === 'strict' || cookie.sameSite === 'unspecified')) details.sameSite = cookie.sameSite
          await browser.cookies.set(details).catch(() => {})
        }))
      } catch { }
    }
    for (const cookie of await browser.cookies.get({}).catch(() => [])) this.rememberCookie(cookie, false)
    this.cookiesLoaded = true
    if (!this.destroying) browser.cookies.on('changed', this.onCookieChanged)
  }

  private readonly onCookieChanged = (_event: Electron.Event, cookie: Electron.Cookie, _cause: string, removed: boolean) => {
    this.rememberCookie(cookie, removed)
    this.scheduleSave()
  }

  private rememberCookie(cookie: Electron.Cookie, removed: boolean) {
    const key = `${cookie.domain ?? ''}\n${cookie.path ?? '/'}\n${cookie.name}`
    if (removed || !cookie.session) { this.sessionCookies.delete(key); return }
    const host = cookie.domain?.replace(/^\./, '')
    if (!host) return
    this.sessionCookies.set(key, {
      url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`,
      name: cookie.name, value: cookie.value, path: cookie.path,
      ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
      secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
    })
  }

  startData(): BrowserStartData {
    return {
      bookmarks: [...this.saved.bookmarks].sort((a, b) => new URL(a.url).hostname.localeCompare(new URL(b.url).hostname) || a.title.localeCompare(b.title)),
      mostVisited: mostVisited(this.saved.history),
      icons: this.saved.icons,
      adBlockEnabled: this.adBlocking,
    }
  }

  private get adBlocking(): boolean {
    return this.saved.adBlockEnabled && this.premium()
  }

  setAdBlockEnabled(enabled: boolean): BrowserStartData {
    if (this.premium() && this.saved.adBlockEnabled !== enabled) {
      this.saved.adBlockEnabled = enabled
      this.persist()
      this.adBlockingChanged()
    }
    return this.startData()
  }

  accountChanged() {
    if (this.adBlocking !== this.lastAdBlocking) this.adBlockingChanged()
  }

  private adBlockingChanged() {
    this.lastAdBlocking = this.adBlocking
    for (const tab of this.tabList) tab.view.webContents.reload()
    this.emit('browser:startData', this.startData())
  }

  toggleBookmark(url: string, title?: string): BrowserStartData {
    if (!webUrl(url)) return this.startData()
    const index = this.saved.bookmarks.findIndex((bookmark) => bookmark.url === url)
    if (index >= 0) this.saved.bookmarks.splice(index, 1)
    else this.saved.bookmarks.push({ url, title: title?.trim() || url })
    this.persist()
    const data = this.startData()
    this.emit('browser:startData', data)
    return data
  }

  reorder(id: number, toIndex: number) {
    const from = this.tabList.findIndex((tab) => tab.id === id)
    if (from < 0 || !Number.isInteger(toIndex)) return
    const [tab] = this.tabList.splice(from, 1)
    if (tab) this.tabList.splice(Math.max(0, Math.min(toIndex, this.tabList.length)), 0, tab)
    this.push()
  }

  private recordVisit(url: string, title: string) {
    if (!webUrl(url)) return
    const existing = this.saved.history.find((visit) => visit.url === url)
    if (existing) {
      existing.visits += 1
      existing.lastVisited = Date.now()
      existing.title = title || url
    } else this.saved.history.push({ url, title: title || url, visits: 1, lastVisited: Date.now() })
    this.saved.history.sort((a, b) => a.lastVisited - b.lastVisited)
    this.saved.history = this.saved.history.slice(-2000)
    this.emit('browser:startData', this.startData())
  }

  private scheduleSave() {
    if (this.restoring || this.destroying || this.saveTimer) return
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.persist() }, 250)
  }

  private persist() {
    if (this.restoring || this.destroying) return
    this.saved.tabs = this.tabList.filter((tab) => !tab.view.webContents.isDestroyed()).map((tab) => {
      if (tab.pending) return tab.initial
      const contents = tab.view.webContents
      if (!contents.getURL()) return tab.initial
      return { url: contents.getURL(), title: contents.getTitle(), entries: contents.navigationHistory.getAllEntries(), index: contents.navigationHistory.getActiveIndex() }
    })
    this.saved.activeIndex = Math.max(0, this.tabList.findIndex((tab) => tab.id === this.activeId))
    try {
      writeSession(this.sessionPath, this.saved)
      if (this.cookiesLoaded && safeStorage.isEncryptionAvailable()) {
        writeFileSync(`${this.cookiesPath}.tmp`, safeStorage.encryptString(JSON.stringify([...this.sessionCookies.values()])), { mode: 0o600 })
        renameSync(`${this.cookiesPath}.tmp`, this.cookiesPath)
      }
    } catch (error) { console.warn('browser: could not save session', error) }
  }

  tabs(): BrowserTab[] {
    return this.tabList.map((tab) => this.toTab(tab))
  }

  private toTab(tab: Tab): BrowserTab {
    const { webContents } = tab.view
    return {
      id: tab.id,
      url: webContents.getURL() || tab.initial.url,
      title: webContents.getTitle() || tab.initial.title,
      loading: webContents.isLoading(),
      canGoBack: webContents.navigationHistory.canGoBack(),
      canGoForward: webContents.navigationHistory.canGoForward(),
      blocked: tab.blocked,
      video: tab.video,
      capturing: tab.capturing,
      audible: webContents.isCurrentlyAudible(),
      muted: webContents.isAudioMuted(),
      favicon: tab.favicon,
      active: tab.id === this.activeId,
      topic: tab.topic,
      adBlockingExempt: this.tabAdExempt(tab),
      relatedTopic: tab.related?.topic ?? null,
    }
  }

  private push() {
    this.scheduleSave()
    if (this.pushTimer || this.destroying) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      if (!this.win.isDestroyed()) this.emit('browser:tabs', this.tabs())
    }, 50)
  }

  private find(id: number): Tab | undefined {
    return this.tabList.find((tab) => tab.id === id)
  }

  private active(): Tab | undefined {
    return this.activeId === null ? undefined : this.find(this.activeId)
  }

  open(url?: string, restored?: SavedTab, background = false): BrowserTab {
    const view = new WebContentsView({
      webPreferences: {
        preload: this.preload,
        partition: PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    view.setBackgroundColor('#0a0c10')
    const initial = restored ?? { url: toUrl(url ?? 'about:blank'), title: '', entries: [], index: 0 }
    const tab: Tab = { id: this.nextId++, initial, view, blocked: 0, video: null, capturing: false, region: null, zone: null, videoFrame: null, snapshot: null, favicon: null, attached: false, pending: null, generation: 0, topic: null, related: null, topLevelUrl: initial.url }
    this.tabList.push(tab)
    this.byContents.set(view.webContents.id, tab)
    this.wire(tab)
    const load = () => void this.cookiesReady.then(async () => {
      if (view.webContents.isDestroyed()) return
      if (restored?.entries.length) {
        await view.webContents.navigationHistory.restore({ entries: restored.entries, index: restored.index }).catch(() => {
          if (!view.webContents.isDestroyed()) return view.webContents.loadURL(restored.url).catch(() => {})
        })
      } else await view.webContents.loadURL(toUrl(url ?? 'about:blank')).catch(() => {})
    })
    if (restored) tab.pending = load
    else load()
    if (!background || this.activeId === null) {
      this.leave(this.active())
      this.activeId = tab.id
    }
    this.layout()
    this.push()
    return this.toTab(tab)
  }

  private wire(tab: Tab) {
    const { webContents } = tab.view
    const push = () => this.push()
    let pointerAtTop: boolean | null = null
    webContents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseLeave') { pointerAtTop = null; return }
      if ((mouse.type !== 'mouseMove' && mouse.type !== 'mouseEnter') || !this.win.isFullScreen()) return
      const y = mouse.y + (this.bounds?.y ?? 0)
      const atTop = y <= REVEAL_ZONE_PX
      if (mouse.type !== 'mouseEnter' && atTop === pointerAtTop) return
      pointerAtTop = atTop
      this.emit('browser:pointer', { y })
    })
    webContents.on('context-menu', (_event, params) => {
      showContextMenu(this.win, webContents, params, (url) => this.open(url, undefined, true))
    })
    webContents.on('did-start-loading', push)
    webContents.on('did-stop-loading', push)
    webContents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return
      tab.generation += 1
      tab.topic = null
      tab.topLevelUrl = url
      if (tab.related && !(tab.related.approvedUrl === url && tab.related.approvedUntil > Date.now()) && !this.relatedNavigation(tab.related.sourceUrl, url)) tab.related = null
      this.push()
    })
    webContents.on('dom-ready', () => this.observeTopic(tab))
    webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) {
        this.recordVisit(url, webContents.getTitle())
        this.observeTopic(tab)
      }
      this.push()
    })
    webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F11' && input.type === 'keyDown' && !input.isAutoRepeat) {
        event.preventDefault()
        this.toggleFullscreen()
      }
    })
    webContents.on('did-fail-load', push)
    webContents.on('audio-state-changed', push)
    webContents.on('page-title-updated', (_event, title) => {
      const visit = this.saved.history.find((entry) => entry.url === webContents.getURL())
      if (visit) {
        visit.title = title
        this.emit('browser:startData', this.startData())
      }
      this.push()
    })
    webContents.on('page-favicon-updated', (_event, favicons) => {
      const favicon = favicons[0] ?? null
      if (favicon === tab.favicon) return
      tab.favicon = favicon
      this.push()
      const page = webUrl(webContents.getURL()) ? new URL(webContents.getURL()) : null
      if (!favicon || page?.protocol !== 'https:' || this.saved.icons[page.hostname] === favicon) return
      this.saved.icons[page.hostname] = favicon
      this.emit('browser:startData', this.startData())
    })
    webContents.on('render-process-gone', push)
    webContents.on('did-navigate', (_event, url) => {
      this.layout()
      tab.favicon = null
      this.recordVisit(url, webContents.getTitle())
      tab.blocked = 0
      tab.video = null
      tab.videoFrame = null
      this.settleSnapshot(tab, null)
      this.push()
    })
    webContents.setWindowOpenHandler(({ url, disposition }) => {
      const host = hostOf(url)
      const wanted = disposition === 'foreground-tab' || disposition === 'background-tab'
      if (wanted && host && (!this.adBlocking || this.tabAdExempt(tab) || !isBlockedHost(host))) this.open(url)
      return { action: 'deny' }
    })
  }

  private observeTopic(tab: Tab) {
    const contents = tab.view.webContents
    if (!contents.isDestroyed()) contents.mainFrame.send(ERO_CHANNELS.observe, { generation: tab.generation, url: contents.getURL() })
  }

  private relatedNavigation(source: string, target: string): boolean {
    try {
      const original = new URL(source)
      const next = new URL(target)
      if (next.protocol !== 'https:' && next.protocol !== 'http:') return false
      const mega = /^(?:www\.)?mega\.(?:nz|co\.nz|io)$/
      if (mega.test(original.hostname) && mega.test(next.hostname)) {
        const handle = /\/file\/([\w-]+)/.exec(original.pathname)?.[1] ?? /^#!([\w-]+)!/.exec(original.hash)?.[1]
        if (handle) return next.pathname === `/file/${handle}` || next.hash.startsWith(`#!${handle}!`)
        return original.pathname === next.pathname && original.hash === next.hash
      }
      const gofile = /^(?:www\.)?gofile\.io$/
      const pixeldrain = /^(?:www\.)?pixeldrain\.com$/
      if (pixeldrain.test(original.hostname) && pixeldrain.test(next.hostname)) return original.pathname === next.pathname && original.search === next.search
      return next.pathname === original.pathname && (next.origin === original.origin || gofile.test(original.hostname) && gofile.test(next.hostname))
    } catch { return false }
  }

  getTopic(id: number): EroTopic | null {
    const tab = this.find(id)
    return tab && isEroTopicUrl(tab.view.webContents.getURL()) ? tab.topic : null
  }

  openEroScripts(): BrowserTab {
    const existing = this.tabList.find((tab) => isEroScriptsUrl(tab.view.webContents.getURL() || tab.initial.url))
    if (existing) { this.activate(existing.id); return this.toTab(existing) }
    return this.open(EROSCRIPTS_HOME)
  }

  openSource(url: string): BrowserTab {
    const safe = sourceUrl(url)
    if (!safe) throw new Error('Invalid source URL')
    return this.open(safe)
  }

  private openRelatedDownload(request: TransferRequest, transferOnly = false): BrowserTab | null {
    const liveTopic = this.getTopic(request.topic.tabId)
    const topic: EroTopic = liveTopic?.generation === request.topic.generation && liveTopic.url === request.topic.url ? liveTopic : {
      ...request.topic, title: request.candidate.label, sources: [request.candidate], scope: 'loaded-posts',
    }
    const existing = !transferOnly && this.tabList.find((tab) => tab.related?.fileId === request.fileId && tab.related.sourceUrl === request.candidate.url)
    if (existing) {
      existing.related = { attemptId: request.attemptId, fileId: request.fileId, sourceUrl: request.candidate.url, topic, approvedUrl: null, approvedUntil: 0 }
      this.sizeBackgroundDownload(existing)
      if (existing.view.webContents.getURL() === 'about:blank') this.navigate(existing.id, request.candidate.url)
      return this.toTab(existing)
    }
    const opened = this.open(transferOnly ? 'about:blank' : request.candidate.url, undefined, true)
    const tab = this.find(opened.id)
    if (!tab) return null
    this.sizeBackgroundDownload(tab)
    tab.related = { attemptId: request.attemptId, fileId: request.fileId, sourceUrl: request.candidate.url, topic, approvedUrl: null, approvedUntil: 0 }
    this.push()
    return this.toTab(tab)
  }

  private sizeBackgroundDownload(tab: Tab) {
    if (tab.attached || this.win.isDestroyed()) return
    const page = this.bounds
    const viewport = page && Number.isFinite(page.w) && Number.isFinite(page.h) && page.w > 0 && page.h > 0
      ? { width: page.w, height: page.h } : this.win.getContentBounds()
    tab.view.setBounds({ x: 0, y: 0, width: Math.max(1, Math.round(viewport.width)), height: Math.max(1, Math.round(viewport.height)) })
  }

  startDownload(request: TransferRequest): Promise<TransferResult> {
    return this.downloads.start(request)
  }

  continueDownload(fileId: string, attemptId: string): void {
    this.downloads.continue(fileId, attemptId)
  }

  cancelDownload(attemptId: string): void {
    this.downloads.cancel(attemptId)
  }

  setOrdinaryDownloadHandler(handler: (download: OrdinaryBrowserDownload) => void): void {
    this.ordinaryDownloadHandler = handler
  }

  close(id: number) {
    const index = this.tabList.findIndex((tab) => tab.id === id)
    const tab = this.tabList[index]
    if (!tab) return
    this.tabList.splice(index, 1)
    if (!tab.view.webContents.isDestroyed()) this.byContents.delete(tab.view.webContents.id)
    tab.capturing = false
    this.settleSnapshot(tab, null)
    if (tab.attached && !this.win.isDestroyed()) this.win.contentView.removeChildView(tab.view)
    tab.attached = false
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    if (this.activeId === id) this.activeId = this.tabList[Math.min(index, this.tabList.length - 1)]?.id ?? null
    this.layout()
    this.push()
  }

  activate(id: number) {
    if (!this.find(id) || id === this.activeId) return
    this.leave(this.active())
    this.activeId = id
    this.layout()
    this.push()
  }

  private leave(tab: Tab | undefined) {
    if (tab?.capturing) this.capture(tab.id, false)
  }

  private load(tab: Tab) {
    const pending = tab.pending
    if (!pending) return
    tab.pending = null
    pending()
  }

  navigate(id: number, url: string) {
    const tab = this.find(id)
    if (!tab) return
    tab.pending = null
    void tab.view.webContents.loadURL(toUrl(url)).catch(() => {})
  }

  back(id: number) {
    this.find(id)?.view.webContents.navigationHistory.goBack()
  }

  forward(id: number) {
    this.find(id)?.view.webContents.navigationHistory.goForward()
  }

  reload(id: number) {
    const tab = this.find(id)
    if (!tab) return
    if (tab.pending) this.load(tab)
    else tab.view.webContents.reload()
  }

  stop(id: number) {
    this.find(id)?.view.webContents.stop()
  }

  async preview(): Promise<string | null> {
    const contents = this.active()?.view.webContents
    if (!contents || contents.isDestroyed()) return null
    try {
      const image = await contents.capturePage()
      return image.isEmpty() ? null : image.toDataURL()
    } catch {
      return null
    }
  }

  setBounds(rect: Rect | null) {
    this.bounds = rect
    this.layout()
  }

  private layout() {
    if (this.win.isDestroyed()) return
    const active = this.active()
    const showPage = active && (active.view.webContents.getURL() || active.initial.url) !== 'about:blank'
    for (const tab of this.tabList) {
      if (tab.attached && (tab !== active || !this.bounds || !showPage)) {
        this.win.contentView.removeChildView(tab.view)
        tab.attached = false
      }
    }
    if (!active || !this.bounds || !showPage) return
    if (!active.attached) {
      this.win.contentView.addChildView(active.view)
      active.attached = true
    }
    this.load(active)
    active.view.setBounds({
      x: Math.round(this.bounds.x),
      y: Math.round(this.bounds.y),
      width: Math.max(0, Math.round(this.bounds.w)),
      height: Math.max(0, Math.round(this.bounds.h)),
    })
  }

  capture(id: number, on: boolean) {
    const tab = this.find(id)
    if (!tab || tab.capturing === on) return
    tab.capturing = on
    this.toVideoFrame(tab, TAB_CHANNELS.capture, on)
    this.push()
  }

  snapshot(id: number, width?: number): Promise<BrowserFrame | null> {
    const tab = this.find(id)
    if (!tab?.videoFrame) return Promise.resolve(null)
    this.settleSnapshot(tab, null)
    return new Promise((resolve) => {
      tab.snapshot = { resolve, timer: setTimeout(() => this.settleSnapshot(tab, null), SNAPSHOT_TIMEOUT_MS) }
      this.toVideoFrame(tab, TAB_CHANNELS.snapshot, width)
    })
  }

  private settleSnapshot(tab: Tab, frame: BrowserFrame | null) {
    const waiting = tab.snapshot
    if (!waiting) return
    tab.snapshot = null
    clearTimeout(waiting.timer)
    waiting.resolve(frame)
  }

  setMuted(id: number, muted: boolean) {
    const tab = this.find(id)
    if (!tab || tab.view.webContents.isDestroyed()) return
    tab.view.webContents.setAudioMuted(muted)
    this.push()
  }

  async handoff(id: number): Promise<BrowserHandoff | null> {
    const tab = this.find(id)
    if (!tab || tab.view.webContents.isDestroyed()) return null
    const contents = tab.view.webContents
    const pageUrl = contents.getURL()
    const ref = tab.videoFrame
    const mediaTime = tab.video?.mediaTime ?? 0
    const fallback: BrowserHandoff = {
      pageUrl, url: null, headers: '',
      position: Math.max(0, Number.isFinite(mediaTime) ? mediaTime : 0),
      rate: tab.video?.rate && Number.isFinite(tab.video.rate) && tab.video.rate > 0 ? tab.video.rate : 1,
    }
    if (!ref) return fallback
    const requestId = this.nextHandoffId++
    const selected = () => this.find(id) === tab && !contents.isDestroyed() && contents.getURL() === pageUrl && tab.videoFrame === ref
    const response = await new Promise<{ state: NonNullable<ReturnType<typeof handoffState>>; referer: string } | null>((resolve) => {
      const finish = (result: { state: NonNullable<ReturnType<typeof handoffState>>; referer: string } | null) => {
        clearTimeout(timer)
        this.ipc.removeListener(TAB_CHANNELS.handoff, receive)
        resolve(result)
      }
      const receive = (event: IpcMainEvent, payload: unknown) => {
        if (event.sender !== contents || !sameFrame(ref, event)) return
        const state = handoffState(payload)
        if (!state || state.requestId !== requestId) return
        finish(selected() ? { state, referer: event.senderFrame?.url ?? '' } : null)
      }
      const timer = setTimeout(() => finish(null), SNAPSHOT_TIMEOUT_MS)
      this.ipc.on(TAB_CHANNELS.handoff, receive)
      try {
        const frame = webFrameMain.fromId(ref.processId, ref.frameId)
        if (frame) frame.send(TAB_CHANNELS.handoff, requestId)
        else finish(null)
      } catch {
        finish(null)
      }
    })
    if (!selected()) return null
    if (!response) return fallback
    const { state, referer } = response
    const result: BrowserHandoff = { ...fallback, position: state.position, rate: state.rate }
    if (!state.url || !mediaUrl(referer)) return result
    return { ...result, url: state.url, headers: handoffHeaders(referer, contents.getUserAgent()) }
  }

  pause(id: number) {
    const tab = this.find(id)
    if (tab) this.toVideoFrame(tab, TAB_CHANNELS.pause)
  }

  play(id: number) {
    const tab = this.find(id)
    if (tab) this.toVideoFrame(tab, TAB_CHANNELS.play)
  }

  setRegion(id: number, box: RegionBox | null) {
    const tab = this.find(id)
    if (!tab) return
    tab.region = box
    this.toVideoFrame(tab, TAB_CHANNELS.region, box)
  }

  setZone(id: number, zone: Region | null) {
    const tab = this.find(id)
    if (!tab) return
    tab.zone = zone
    this.toVideoFrame(tab, TAB_CHANNELS.zone, zone)
  }

  private toVideoFrame(tab: Tab, channel: string, payload?: boolean | number | RegionBox | Region | null) {
    const ref = tab.videoFrame
    if (!ref || tab.view.webContents.isDestroyed()) return
    try {
      webFrameMain.fromId(ref.processId, ref.frameId)?.send(channel, payload)
    } catch {
    }
  }

  private onVideo(event: IpcMainEvent, video: BrowserVideo) {
    const tab = this.byContents.get(event.sender.id)
    if (!tab) return
    const same = sameFrame(tab.videoFrame, event)
    if (!video.present && !same) return
    const prev = tab.video
    tab.videoFrame = video.present ? (same ? tab.videoFrame : { processId: event.processId, frameId: event.frameId }) : null
    tab.video = video
    if (!prev || prev.present !== video.present || prev.playing !== video.playing || prev.rate !== video.rate || tab.capturing) this.push()
    if (same || !video.present) return
    const frame = event.senderFrame
    if (!frame) return
    try {
      frame.send(TAB_CHANNELS.region, tab.region)
      frame.send(TAB_CHANNELS.zone, tab.zone)
      if (tab.capturing) frame.send(TAB_CHANNELS.capture, true)
    } catch {
    }
  }

  private onFrame(event: IpcMainEvent, frame: TabFrame) {
    const tab = this.byContents.get(event.sender.id)
    if (!tab || !sameFrame(tab.videoFrame, event)) return
    const payload: BrowserFrame = Object.assign(frame, { id: tab.id })
    if (frame.channels === 3) return this.settleSnapshot(tab, payload)
    if (tab.capturing && !this.win.isDestroyed()) this.emit('browser:frame', payload)
  }

  destroy() {
    if (!this.win.isDestroyed()) this.persist()
    this.destroying = true
    this.downloads.destroy()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.pushTimer) clearTimeout(this.pushTimer)
    const browser = session.fromPartition(PARTITION)
    browser.cookies.removeListener('changed', this.onCookieChanged)
    browser.flushStorageData()
    void browser.cookies.flushStore().catch(() => {})
    browser.webRequest.onBeforeRequest(null)
    browser.webRequest.onHeadersReceived(null)
    if (this.cosmeticPreload) browser.unregisterPreloadScript(this.cosmeticPreload)
    this.ipc.removeHandler('@ghostery/adblocker/inject-cosmetic-filters')
    this.ipc.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled')
    for (const tab of [...this.tabList]) this.close(tab.id)
    this.byContents.clear()
    for (const channel of [TAB_CHANNELS.video, TAB_CHANNELS.frame, TAB_CHANNELS.regionEdit, TAB_CHANNELS.zoneEdit, TAB_CHANNELS.error, ERO_CHANNELS.topic]) this.ipc.removeAllListeners(channel)
  }
}
