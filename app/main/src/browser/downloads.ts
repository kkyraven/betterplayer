import type { DownloadItem, IpcMain, IpcMainEvent, Session, WebContents } from 'electron'
import { isAbsolute, basename, dirname } from 'node:path'
import { ERO_CHANNELS, isEroScriptsUrl, sourceUrl, type EroTopic } from '@shared/eroscripts'
import type { BrowserTab } from '@shared/browser'
import type { TransferRequest, TransferResult } from '../downloads/transport'
export type { OrdinaryBrowserDownload } from '../downloads/transport'

interface BrowserDownloadAccess {
  topic: (id: number) => EroTopic | null
  contents: (id: number) => WebContents | null
  openRelated: (request: TransferRequest) => BrowserTab | null
  openTransfer: (request: TransferRequest) => BrowserTab | null
  activate: (id: number) => void
  ordinaryDownload?: (item: DownloadItem, contents: WebContents) => void
  approveNavigation?: (contents: WebContents, url: string) => void
  finishNavigation?: (contents: WebContents) => void
}


interface Intent {
  request: TransferRequest
  contents: WebContents
  expectedUrl: string | null
  generated: boolean
  item: DownloadItem | null
  finish: (result: TransferResult) => void
  triggered: boolean
  hostControl: HostControl | null
}

interface RelatedAttempt { fileId: string; attemptId: string; tabId: number; sourceUrl: string }
interface HostControl { requestId: number; fileName: string; provider: 'mega' | 'gofile' | 'pixeldrain' | 'anchor'; url: string | null }

export function publicDownloadUrl(value: string): boolean {
  const safe = sourceUrl(value)
  if (!safe) return false
  const host = new URL(safe).hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  if (host.startsWith('[')) {
    const address = host.slice(1, -1)
    return !/^(?:::(?:1)?$|::ffff:|f[cd]|fe[89abcdef])/i.test(address)
  }
  const octets = host.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [first = 0, second = 0] = octets
  return first !== 0 && first !== 10 && first !== 127 && first < 224
    && !(first === 100 && second >= 64 && second <= 127)
    && !(first === 169 && second === 254) && !(first === 192 && second === 168)
    && !(first === 172 && second >= 16 && second <= 31) && !(first === 198 && (second === 18 || second === 19))
}

export function attributedDownload(expectedUrl: string, chain: readonly string[], generated: boolean): boolean {
  if (!chain.length || chain.length > 12 || !chain.includes(expectedUrl)) return false
  if (generated) return chain.length === 1 && expectedUrl.startsWith('blob:https://') && sourceUrl(expectedUrl.slice(5)) !== null
  return chain.every(publicDownloadUrl)
}

function safeStaging(path: string): boolean {
  return isAbsolute(path) && /^\.bp-downloads-[a-f0-9-]{36}$/i.test(basename(dirname(path)))
    && basename(path).length > 0 && !path.includes('\0')
}

export class BrowserDownloads {
  private readonly intents = new Map<string, Intent>()
  private readonly related = new Map<string, RelatedAttempt>()
  private nextRequestId = 1
  private readonly networkRequests = new Map<number, string>()
  private readonly revoked: Array<{ contents: WebContents; url: string; generated: boolean; expires: number }> = []

  constructor(private readonly session: Session, private readonly ipc: IpcMain, private readonly browser: BrowserDownloadAccess) {
    session.on('will-download', this.onDownload)
  }

  async start(request: TransferRequest): Promise<TransferResult> {
    this.pruneRevoked()
    if (request.signal.aborted) return { status: 'failed', reason: 'Cancelled', scope: 'remote' }
    if (!safeStaging(request.stagingPath)) return { status: 'failed', reason: 'Invalid staging destination', scope: 'local' }
    if (!publicDownloadUrl(request.candidate.url)) return { status: 'failed', reason: 'Invalid source URL', scope: 'remote' }
    if (this.intents.has(request.attemptId)) return { status: 'waiting', reason: 'This source is already downloading' }
    const direct = request.directUrl !== null ? sourceUrl(request.directUrl) : null
    if (request.directUrl !== null && (!direct || !publicDownloadUrl(direct))) return { status: 'failed', reason: 'Invalid download URL', scope: 'remote' }
    let contents = this.browser.contents(request.topic.tabId)
    let tabId = request.topic.tabId
    let generated = false
    let expectedUrl = direct
    let trigger: (() => void) | null = null
    let hostControl: HostControl | null = null

    if (request.candidate.controlId !== null) {
      const topic = this.browser.topic(request.topic.tabId)
      if (!contents || contents.isDestroyed() || !topic || topic.generation !== request.topic.generation
        || topic.url !== request.topic.url || !topic.sources.some((source) => source.id === request.candidate.id && source.controlId === request.candidate.controlId)) {
        return { status: 'waiting', reason: 'Reopen the topic to refresh this generated file', tabId: request.topic.tabId }
      }
      const prepared = await this.prepareControl(contents, request)
      if (!prepared) return { status: 'waiting', reason: 'The generated file changed. Refresh the topic', tabId }
      expectedUrl = prepared.url
      generated = true
      trigger = () => contents?.mainFrame.send(ERO_CHANNELS.activate, { requestId: prepared.requestId, generation: request.topic.generation })
    } else if (!direct) {
      const tab = this.browser.openRelated(request)
      if (!tab) return { status: 'failed', reason: 'Could not open the source', scope: 'remote' }
      tabId = tab.id
      contents = this.browser.contents(tabId)
      this.related.set(request.fileId, { fileId: request.fileId, attemptId: request.attemptId, tabId, sourceUrl: request.candidate.url })
      if (!contents || !await this.documentReady(contents, request.signal)) return { status: 'waiting', reason: 'The source page did not load. Continue to try again', tabId }
      const prepared = await this.prepareHost(contents, request)
      if (prepared.status === 'waiting') return { ...prepared, tabId }
      hostControl = prepared.control
      expectedUrl = hostControl.url
      generated = hostControl.provider === 'mega'
      trigger = () => contents?.mainFrame.send(ERO_CHANNELS.hostActivate, { requestId: hostControl?.requestId })
    }

    if (!contents || contents.isDestroyed()) {
      const tab = this.browser.openTransfer(request)
      if (!tab) return { status: 'failed', reason: 'Could not open the source', scope: 'remote' }
      tabId = tab.id
      contents = this.browser.contents(tabId)
    }
    if (!contents || !expectedUrl && !hostControl) return { status: 'failed', reason: 'Source is unavailable', scope: 'remote' }
    if (request.signal.aborted) return { status: 'failed', reason: 'Cancelled', scope: 'remote' }
    if (expectedUrl && this.revoked.some((revoked) => revoked.contents === contents && revoked.url === expectedUrl && revoked.expires > Date.now())) {
      const tab = this.browser.openTransfer(request)
      if (!tab) return { status: 'waiting', reason: 'The previous source attempt is still closing', tabId }
      tabId = tab.id
      contents = this.browser.contents(tabId)
      if (!contents) return { status: 'failed', reason: 'Could not open the source', scope: 'remote' }
    }
    const initiating = contents
    const expected = expectedUrl
    if ([...this.intents.values()].some((intent) => intent.contents === initiating && intent.expectedUrl === expected)) {
      return { status: 'waiting', reason: 'Another transfer is using this source', tabId }
    }
    return new Promise<TransferResult>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (result: TransferResult) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        request.signal.removeEventListener('abort', abort)
        initiating.removeListener('destroyed', destroyed)
        this.ipc.removeListener(ERO_CHANNELS.hostDownload, hostDownload)
        this.ipc.removeListener(ERO_CHANNELS.hostWaiting, hostWaiting)
        if (hostControl && !initiating.isDestroyed()) {
          try { initiating.mainFrame.send(ERO_CHANNELS.hostCancel, { requestId: hostControl.requestId }) } catch { }
        }
        this.browser.finishNavigation?.(initiating)
        if (intent.triggered && !intent.item && intent.expectedUrl !== null) {
          this.revoked.push({ contents: initiating, url: intent.expectedUrl, generated: intent.generated, expires: Date.now() + 30_000 })
        }
        this.intents.delete(request.attemptId)
        for (const [id, attemptId] of this.networkRequests) if (attemptId === request.attemptId) this.networkRequests.delete(id)
        resolve(result)
      }
      const abort = () => {
        const intent = this.intents.get(request.attemptId)
        intent?.item?.cancel()
        finish({ status: 'failed', reason: 'Cancelled', scope: 'remote' })
      }
      const destroyed = () => {
        const intent = this.intents.get(request.attemptId)
        if (!intent?.item) finish({ status: 'waiting', reason: 'The source tab closed. Continue to reopen it', tabId })
      }
      const intent: Intent = { request, contents: initiating, expectedUrl: expected, generated, item: null, finish, triggered: false, hostControl }
      const hostDownload = (event: IpcMainEvent, payload: unknown) => {
        if (!hostControl || this.intents.get(request.attemptId) !== intent || intent.item || request.signal.aborted
          || event.sender !== initiating || event.senderFrame !== initiating.mainFrame || !payload || typeof payload !== 'object') return
        if (!('requestId' in payload) || payload.requestId !== hostControl.requestId || !('fileName' in payload) || payload.fileName !== hostControl.fileName) return
        const url = 'url' in payload ? payload.url : null
        if (typeof url !== 'string' || url.length > 8192 || !hostDownloadUrl(hostControl.provider, initiating.getURL(), url, hostControl.fileName)) {
          finish({ status: 'waiting', reason: 'The host offered a different file. Check the source page', tabId })
          return
        }
        intent.expectedUrl = url
        intent.generated = hostControl.provider === 'mega'
        this.browser.approveNavigation?.(initiating, url)
        try { initiating.mainFrame.send(ERO_CHANNELS.hostRelease, { requestId: hostControl.requestId }) }
        catch { finish({ status: 'waiting', reason: 'The source page changed. Continue to refresh it', tabId }) }
      }
      const hostWaiting = (event: IpcMainEvent, payload: unknown) => {
        if (!hostControl || this.intents.get(request.attemptId) !== intent || intent.item || event.sender !== initiating
          || event.senderFrame !== initiating.mainFrame || !payload || typeof payload !== 'object') return
        if ('requestId' in payload && payload.requestId === hostControl.requestId && 'reason' in payload
          && typeof payload.reason === 'string' && payload.reason.length <= 300) finish({ status: 'waiting', reason: payload.reason, tabId })
      }
      this.intents.set(request.attemptId, intent)
      if (hostControl) this.ipc.on(ERO_CHANNELS.hostDownload, hostDownload)
      if (hostControl) this.ipc.on(ERO_CHANNELS.hostWaiting, hostWaiting)
      request.signal.addEventListener('abort', abort, { once: true })
      initiating.once('destroyed', destroyed)
      timer = setTimeout(() => {
        if (!intent.item) finish({ status: 'waiting', reason: 'The source did not start a download. Continue on its page', tabId })
      }, hostControl?.provider === 'mega' ? 10 * 60_000 : 20_000)
      try {
        intent.triggered = true
        if (hostControl?.url) this.browser.approveNavigation?.(initiating, hostControl.url)
        if (trigger) trigger()
        else if (expected) initiating.downloadURL(expected, { headers: { Referer: request.topic.url } })
      } catch {
        finish({ status: 'failed', reason: 'Could not start the download', scope: 'remote' })
      }
    })
  }

  allowRequest(details: { id: number; url: string; webContentsId?: number }): boolean {
    let intent = this.intents.get(this.networkRequests.get(details.id) ?? '')
    if (!intent && details.webContentsId !== undefined) {
      intent = [...this.intents.values()].find((candidate) => candidate.contents.id === details.webContentsId
        && !candidate.generated && (candidate.expectedUrl === details.url || candidate.hostControl?.provider === 'pixeldrain'
          && candidate.hostControl.url !== null && hostDownloadUrl('pixeldrain', candidate.contents.getURL(), details.url, candidate.hostControl.fileName)
          && new URL(details.url).pathname === new URL(candidate.hostControl.url).pathname))
      if (intent) this.networkRequests.set(details.id, intent.request.attemptId)
    }
    if (intent?.hostControl?.provider === 'pixeldrain' && intent.hostControl.url !== null
      && hostDownloadUrl('pixeldrain', intent.contents.getURL(), details.url, intent.hostControl.fileName)
      && new URL(details.url).pathname === new URL(intent.hostControl.url).pathname) intent.expectedUrl = details.url
    if (!intent || publicDownloadUrl(details.url)) return true
    intent.item?.cancel()
    intent.finish({ status: 'failed', reason: 'The source redirected to a local network address', scope: 'remote' })
    return false
  }

  private readonly onDownload = (_event: Electron.Event, item: DownloadItem, contents: WebContents) => {
    this.pruneRevoked()
    const superseded = this.revoked.findIndex((revoked) => revoked.contents === contents && item.getURLChain().includes(revoked.url))
    if (superseded >= 0) {
      this.revoked.splice(superseded, 1)
      item.cancel()
      return
    }
    const chain = item.getURLChain()
    const unsafe = [...this.intents.values()].find((intent) => intent.contents === contents && !intent.item
      && intent.expectedUrl !== null && chain.includes(intent.expectedUrl) && !attributedDownload(intent.expectedUrl, chain, intent.generated))
    if (unsafe) {
      item.cancel()
      unsafe.finish({ status: 'failed', reason: 'The source offered an unsafe download redirect', scope: 'remote' })
      return
    }
    const matches = [...this.intents.values()].filter((intent) => intent.contents === contents && !intent.item
      && !intent.request.signal.aborted && intent.expectedUrl !== null && attributedDownload(intent.expectedUrl, item.getURLChain(), intent.generated))
    if (matches.length !== 1) {
      if (matches.length === 0) this.browser.ordinaryDownload?.(item, contents)
      return
    }
    const intent = matches[0]
    if (!intent) return
    if (intent.hostControl && item.getFilename() !== intent.hostControl.fileName) {
      item.cancel()
      intent.finish({ status: 'failed', reason: 'The host returned a different file', scope: 'remote' })
      return
    }
    intent.item = item
    try { item.setSavePath(intent.request.stagingPath) } catch {
      item.cancel()
      intent.finish({ status: 'failed', reason: 'Could not write to the destination', scope: 'local' })
      return
    }
    intent.request.onControl({ pause: () => item.pause(), resume: () => item.resume(), cancel: () => item.cancel() })
    const report = () => {
      if (this.intents.get(intent.request.attemptId) !== intent || intent.request.signal.aborted) return
      intent.request.onProgress({ receivedBytes: Math.max(0, item.getReceivedBytes()), totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : null, canPause: true })
    }
    report()
    item.on('updated', (_event, state) => {
      report()
      if (state === 'interrupted' && item.canResume() && !item.isPaused()) {
        item.pause()
        item.cancel()
        intent.finish({ status: 'failed', reason: 'The transfer was interrupted', scope: 'remote' })
      }
    })
    item.once('done', (_event, state) => {
      if (state === 'completed') intent.finish({ status: 'complete', fileName: item.getFilename(), totalBytes: item.getReceivedBytes(), mimeType: item.getMimeType() })
      else intent.finish({ status: 'failed', reason: state === 'cancelled' ? 'Cancelled' : 'The transfer was interrupted', scope: 'remote' })
    })
  }

  private pruneRevoked() {
    for (let index = this.revoked.length - 1; index >= 0; index--) {
      const revoked = this.revoked[index]
      if (revoked && revoked.expires <= Date.now()) this.revoked.splice(index, 1)
    }
  }

  private documentReady(contents: WebContents, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || contents.isDestroyed()) return Promise.resolve(false)
    if (contents.getURL() && !contents.isLoading()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const finish = (result: boolean) => {
        clearTimeout(timer)
        contents.removeListener('dom-ready', ready)
        contents.removeListener('destroyed', closed)
        signal.removeEventListener('abort', closed)
        resolve(result)
      }
      const ready = () => finish(true)
      const closed = () => finish(false)
      const timer = setTimeout(closed, 15_000)
      contents.once('dom-ready', ready)
      contents.once('destroyed', closed)
      signal.addEventListener('abort', closed, { once: true })
    })
  }

  private prepareHost(contents: WebContents, request: TransferRequest): Promise<{ status: 'ready'; control: HostControl } | { status: 'waiting'; reason: string }> {
    const requestId = this.nextRequestId++
    return new Promise((resolve) => {
      const finish = (result: { status: 'ready'; control: HostControl } | { status: 'waiting'; reason: string }) => {
        clearTimeout(timer)
        this.ipc.removeListener(ERO_CHANNELS.hostPrepared, receive)
        request.signal.removeEventListener('abort', abort)
        if (result.status === 'waiting' && !contents.isDestroyed()) contents.mainFrame.send(ERO_CHANNELS.hostCancel, { requestId })
        resolve(result)
      }
      const abort = () => finish({ status: 'waiting', reason: 'Cancelled' })
      const receive = (event: IpcMainEvent, payload: unknown) => {
        if (event.sender !== contents || event.senderFrame !== contents.mainFrame || !payload || typeof payload !== 'object'
          || !('requestId' in payload) || payload.requestId !== requestId || !('status' in payload)) return
        if (request.signal.aborted) return abort()
        if (payload.status === 'waiting') {
          const reason = 'reason' in payload && typeof payload.reason === 'string' && payload.reason.length <= 300 ? payload.reason : hostStep(request.candidate.host)
          finish({ status: 'waiting', reason })
          return
        }
        if (payload.status !== 'ready' || !('fileName' in payload) || typeof payload.fileName !== 'string' || payload.fileName.length > 256
          || /[/\\\x00-\x1f]/.test(payload.fileName) || request.candidate.fileName !== null && request.candidate.fileName !== payload.fileName
          || !('provider' in payload) || payload.provider !== 'mega' && payload.provider !== 'gofile' && payload.provider !== 'pixeldrain' && payload.provider !== 'anchor'
          || !('url' in payload) || payload.url !== null && typeof payload.url !== 'string') return
        if (payload.provider === 'anchor' && (payload.url === null || !sourceUrl(payload.url))) return
        const source = new URL(request.candidate.url)
        let current: URL
        try { current = new URL(contents.getURL()) } catch { return finish({ status: 'waiting', reason: 'The source page changed. Reopen the original link' }) }
        const family = payload.provider === 'mega' ? /^(?:www\.)?mega\.(?:nz|co\.nz|io)$/ : payload.provider === 'pixeldrain' ? /^(?:www\.)?pixeldrain\.com$/ : /^(?:www\.)?gofile\.io$/
        if (current.origin !== source.origin && (payload.provider === 'anchor' || !family.test(source.hostname) || !family.test(current.hostname))) return finish({ status: 'waiting', reason: 'The source page changed. Reopen the original link' })
        if (payload.provider === 'mega' && !/^(?:www\.)?mega\.(?:nz|co\.nz|io)$/.test(source.hostname)
          || payload.provider === 'gofile' && !/^(?:www\.)?gofile\.io$/.test(source.hostname)
          || payload.provider === 'pixeldrain' && (!/^(?:www\.)?pixeldrain\.com$/.test(source.hostname)
            || source.pathname !== current.pathname || source.search !== current.search
            || payload.url === null || !hostDownloadUrl('pixeldrain', contents.getURL(), payload.url, payload.fileName))) return
        finish({ status: 'ready', control: { requestId, fileName: payload.fileName, provider: payload.provider, url: payload.url } })
      }
      const timer = setTimeout(() => finish({ status: 'waiting', reason: hostStep(request.candidate.host) }), 9_000)
      this.ipc.on(ERO_CHANNELS.hostPrepared, receive)
      request.signal.addEventListener('abort', abort, { once: true })
      try { contents.mainFrame.send(ERO_CHANNELS.hostPrepare, { requestId, sourceUrl: request.candidate.url, fileName: request.candidate.fileName }) }
      catch { finish({ status: 'waiting', reason: 'The source tab closed. Continue to reopen it' }) }
    })
  }

  private prepareControl(contents: WebContents, request: TransferRequest): Promise<{ requestId: number; url: string } | null> {
    const requestId = this.nextRequestId++
    return new Promise((resolve) => {
      const finish = (result: { requestId: number; url: string } | null) => {
        clearTimeout(timer)
        this.ipc.removeListener(ERO_CHANNELS.prepared, receive)
        request.signal.removeEventListener('abort', abort)
        resolve(result)
      }
      const abort = () => finish(null)
      const receive = (event: IpcMainEvent, payload: unknown) => {
        if (event.sender !== contents || event.senderFrame !== contents.mainFrame || !payload || typeof payload !== 'object') return
        if (!('requestId' in payload) || payload.requestId !== requestId || !('generation' in payload) || payload.generation !== request.topic.generation) return
        const current = this.browser.topic(request.topic.tabId)
        if (request.signal.aborted || !current || current.generation !== request.topic.generation || current.url !== request.topic.url) return finish(null)
        const url = 'url' in payload ? payload.url : null
        if (typeof url !== 'string' || url.length > 8192 || !url.startsWith('blob:https://discuss.eroscripts.com/')) return finish(null)
        finish({ requestId, url })
      }
      const timer = setTimeout(() => finish(null), 1_000)
      this.ipc.on(ERO_CHANNELS.prepared, receive)
      request.signal.addEventListener('abort', abort, { once: true })
      try { contents.mainFrame.send(ERO_CHANNELS.prepare, { requestId, generation: request.topic.generation, controlId: request.candidate.controlId }) }
      catch { finish(null) }
    })
  }

  continue(fileId: string, attemptId: string): void {
    const related = this.related.get(fileId)
    if (related?.attemptId === attemptId && this.browser.contents(related.tabId)) this.browser.activate(related.tabId)
  }

  cancel(attemptId: string): void {
    const intent = this.intents.get(attemptId)
    intent?.item?.cancel()
    intent?.finish({ status: 'failed', reason: 'Cancelled', scope: 'remote' })
  }

  destroy(): void {
    this.session.removeListener('will-download', this.onDownload)
    for (const attemptId of [...this.intents.keys()]) this.cancel(attemptId)
    this.related.clear()
    this.revoked.length = 0
  }
}

export function hostDownloadUrl(provider: HostControl['provider'], source: string, target: string, fileName: string): boolean {
  try {
    const original = new URL(source)
    if (provider === 'mega') return /^(?:www\.)?mega\.(?:nz|co\.nz|io)$/.test(original.hostname) && target.startsWith(`blob:${original.origin}/`)
    const url = new URL(target)
    if (provider === 'pixeldrain') {
      const id = /^\/u\/([A-Za-z0-9]{8})$/.exec(original.pathname)?.[1]
      const keys = Array.from(url.searchParams.keys())
      return !!id && original.protocol === 'https:' && /^(?:www\.)?pixeldrain\.com$/.test(original.hostname)
        && url.origin === original.origin && url.pathname === `/api/file/${id}` && !url.hash && !url.username && !url.password
        && keys.length >= 1 && keys.length <= 2 && keys.every((key) => key === 'download' || key === 'recaptcha_response')
        && url.searchParams.getAll('download').length === 1 && url.searchParams.get('download') === ''
        && (url.searchParams.getAll('recaptcha_response').length === 0 || url.searchParams.getAll('recaptcha_response').length === 1 && !!url.searchParams.get('recaptcha_response'))
    }
    return provider === 'gofile' && url.protocol === 'https:' && /^(?:[a-z0-9-]+\.)?gofile\.io$/.test(url.hostname)
      && url.pathname.startsWith('/download/') && decodeURIComponent(url.pathname.split('/').at(-1) ?? '') === fileName
  } catch { return false }
}

function hostStep(host: string): string {
  if (/^(?:www\.)?mega\.(?:nz|co\.nz)$/.test(host)) return 'Continue on MEGA to choose the file and download. Keys or quota may require your input'
  if (/^(?:www\.)?gofile\.io$/.test(host)) return 'Continue on GoFile to choose the file and download'
  if (host === 'drive.google.com') return 'Continue on Google Drive to download. Sign-in or permission may be required'
  if (isEroScriptsUrl(`https://${host}/`)) return 'Continue on EroScripts to download the attachment'
  return 'Continue on the source page to complete its download step'
}
