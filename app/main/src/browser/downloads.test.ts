import { EventEmitter } from 'node:events'
import type { DownloadItem, IpcMain, Session, WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ERO_CHANNELS } from '@shared/eroscripts'
import type { BrowserTab } from '@shared/browser'
import type { TransferRequest } from '../downloads/transport'
import { BrowserDownloads, attributedDownload, hostDownloadUrl, publicDownloadUrl } from './downloads'

class Contents extends EventEmitter {
  readonly id = Math.random()
  readonly mainFrame = { send: vi.fn() }
  downloadURL = vi.fn()
  getURL = () => this.url
  isDestroyed = () => false
  isLoading = () => false
  constructor(public url: string) { super() }
}
class Item extends EventEmitter {
  setSavePath = vi.fn()
  received = 0
  total = 100
  paused = false
  getURLChain = () => this.chain
  getReceivedBytes = () => this.received
  getTotalBytes = () => this.total
  getFilename = () => 'test.mp4'
  getMimeType = () => 'video/mp4'
  canResume = () => true
  isPaused = () => this.paused
  pause = vi.fn(() => { this.paused = true })
  resume = vi.fn(() => { this.paused = false })
  cancel = vi.fn(() => this.emit('done', {}, 'cancelled'))
  constructor(public chain: string[]) { super() }
}
function request(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    attemptId: 'attempt-1', fileId: 'file-1', batchId: '00000000-0000-0000-0000-000000000001',
    topic: { tabId: 1, generation: 3, url: 'https://discuss.eroscripts.com/t/test/123' },
    candidate: { id: 'source-1', url: 'https://files.example/test.mp4', label: 'test.mp4', host: 'files.example', kind: 'video', fileName: 'test.mp4', postNumber: 1, controlId: null, mirrorKey: null },
    directUrl: 'https://files.example/test.mp4', stagingPath: '/tmp/.bp-downloads-00000000-0000-0000-0000-000000000001/file-1.part',
    signal: new AbortController().signal, onProgress: vi.fn(), onControl: vi.fn(), ...overrides,
  }
}
function tab(id: number, url: string): BrowserTab {
  return { id, url, title: 'Test', loading: false, canGoBack: false, canGoForward: false, blocked: 0, video: null, capturing: false, audible: false, muted: false, favicon: null, active: true, topic: null, adBlockingExempt: true }
}
function setup() {
  const events = new EventEmitter()
  const ipc = new EventEmitter()
  const origin = new Contents('https://discuss.eroscripts.com/t/test/123')
  const host = new Contents('https://mega.nz/file/handle#key')
  const ordinary = vi.fn()
  const openRelated = vi.fn((_request: TransferRequest) => tab(2, host.url))
  const contents = vi.fn((id: number) => (id === 1 ? origin : host) as unknown as WebContents)
  const activate = vi.fn()
  const manager = new BrowserDownloads(events as unknown as Session, ipc as unknown as IpcMain, {
    topic: () => null,
    contents,
    openRelated, openTransfer: () => tab(2, 'about:blank'), activate, ordinaryDownload: ordinary,
  })
  const download = (item: Item, contents = origin) => events.emit('will-download', {}, item as unknown as DownloadItem, contents as unknown as WebContents)
  const reply = (channel: string, payload: unknown, contents = host) => ipc.emit(channel, { sender: contents, senderFrame: contents.mainFrame }, payload)
  return { manager, events, ipc, origin, host, ordinary, openRelated, contents, activate, download, reply }
}
afterEach(() => vi.useRealTimers())

describe('browser transfer attribution', () => {
  it('requires an exact requested URL in a bounded network chain', () => {
    expect(attributedDownload('https://files.example/test.mp4', ['https://files.example/test.mp4', 'https://cdn.example/test.mp4'], false)).toBe(true)
    expect(attributedDownload('https://files.example/test.mp4', ['https://ad.example/test.mp4'], false)).toBe(false)
    expect(attributedDownload('https://files.example/test.mp4', ['https://files.example/test.mp4', 'file:///private'], false)).toBe(false)
    expect(attributedDownload('https://files.example/test.mp4', ['https://files.example/test.mp4', 'http://127.1/test.mp4'], false)).toBe(false)
    expect(attributedDownload('blob:https://mega.nz/uuid', ['blob:https://mega.nz/uuid'], true)).toBe(true)
    expect(attributedDownload('blob:https://mega.nz/uuid', ['blob:https://mega.nz/other'], true)).toBe(false)
  })
  it('rejects local literal hosts and redirects without adopting them as ordinary downloads', async () => {
    for (const url of ['http://localhost/a', 'http://192.168.1.1/a', 'http://0x7f000001/a', 'http://[::1]/a', 'http://[fd00::1]/a', 'http://[::ffff:192.168.1.1]/a']) expect(publicDownloadUrl(url)).toBe(false)
    expect(publicDownloadUrl('https://[2606:4700:4700::1111]/a')).toBe(true)
    const state = setup()
    const promise = state.manager.start(request())
    const item = new Item(['https://files.example/test.mp4', 'http://10.0.0.1/test.mp4'])
    state.download(item)
    expect(item.cancel).toHaveBeenCalledOnce()
    expect(state.ordinary).not.toHaveBeenCalled()
    await expect(promise).resolves.toMatchObject({ status: 'failed', scope: 'remote' })
    state.manager.destroy()
  })
  it('blocks an associated literal redirect before request dispatch while leaving other browser requests alone', async () => {
    const state = setup()
    const promise = state.manager.start(request())
    expect(state.manager.allowRequest({ id: 10, url: 'https://files.example/test.mp4', webContentsId: state.origin.id })).toBe(true)
    expect(state.manager.allowRequest({ id: 11, url: 'http://localhost/settings', webContentsId: state.origin.id })).toBe(true)
    expect(state.manager.allowRequest({ id: 10, url: 'http://192.168.1.1/test.mp4' })).toBe(false)
    await expect(promise).resolves.toMatchObject({ status: 'failed', scope: 'remote' })
    state.manager.destroy()
  })
  it('arms before downloadURL, tracks actual progress, and keeps ordinary saves separate', async () => {
    const state = setup()
    const transfer = request()
    const promise = state.manager.start(transfer)
    const unrelated = new Item(['https://other.example/test.mp4'])
    state.download(unrelated)
    expect(state.ordinary).toHaveBeenCalledOnce()
    expect(unrelated.setSavePath).not.toHaveBeenCalled()
    const item = new Item([transfer.directUrl!])
    state.download(item)
    expect(item.setSavePath).toHaveBeenCalledWith(transfer.stagingPath)
    const control = vi.mocked(transfer.onControl).mock.calls[0]?.[0]
    control?.pause()
    expect(item.pause).toHaveBeenCalledOnce()
    control?.resume()
    expect(item.resume).toHaveBeenCalledOnce()
    item.received = 40
    item.emit('updated', {}, 'progressing')
    expect(transfer.onProgress).toHaveBeenLastCalledWith({ receivedBytes: 40, totalBytes: 100, canPause: true })
    state.origin.emit('destroyed')
    item.received = 100
    item.emit('done', {}, 'completed')
    await expect(promise).resolves.toEqual({ status: 'complete', fileName: 'test.mp4', totalBytes: 100, mimeType: 'video/mp4' })
    expect(state.ordinary).toHaveBeenCalledOnce()
    state.manager.destroy()
  })
  it('cancels a late event after revoking an attempt rather than adopting it into another job', async () => {
    const state = setup()
    const controller = new AbortController()
    const promise = state.manager.start(request({ signal: controller.signal }))
    controller.abort()
    await expect(promise).resolves.toMatchObject({ status: 'failed', reason: 'Cancelled' })
    const late = new Item(['https://files.example/test.mp4'])
    state.download(late)
    expect(late.cancel).toHaveBeenCalledOnce()
    expect(late.setSavePath).not.toHaveBeenCalled()
    expect(state.ordinary).not.toHaveBeenCalled()
    state.manager.destroy()
  })
  it('keeps an unknown total as null and revokes on cancellation', async () => {
    const state = setup()
    const controller = new AbortController()
    const transfer = request({ signal: controller.signal })
    const promise = state.manager.start(transfer)
    const item = new Item([transfer.directUrl!])
    item.total = 0
    state.download(item)
    expect(transfer.onProgress).toHaveBeenCalledWith({ receivedBytes: 0, totalBytes: null, canPause: true })
    controller.abort()
    await expect(promise).resolves.toMatchObject({ status: 'failed', reason: 'Cancelled' })
    state.manager.destroy()
  })
  it('uses a fresh initiating tab when retrying before a revoked request arrives', async () => {
    const state = setup()
    const controller = new AbortController()
    const first = state.manager.start(request({ signal: controller.signal }))
    controller.abort()
    await first
    const retry = state.manager.start(request({ attemptId: 'attempt-2' }))
    const late = new Item(['https://files.example/test.mp4'])
    state.download(late)
    expect(late.cancel).toHaveBeenCalledOnce()
    const current = new Item(['https://files.example/test.mp4'])
    state.download(current, state.host)
    current.received = 100
    current.emit('done', {}, 'completed')
    await expect(retry).resolves.toMatchObject({ status: 'complete' })
    expect(state.ordinary).not.toHaveBeenCalled()
    state.manager.destroy()
  })
})

describe('ordinary host controls', () => {
  it('follows the verified intermediary file and reports its actual unavailable state', async () => {
    const state = setup()
    const article = 'https://keep2porn.net/205359-scene.html'
    const target = 'https://k2s.cc/file/53a37617478a5'
    state.openRelated.mockImplementation(request => { state.host.url = request.candidate.url; return tab(2, state.host.url) })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number; sourceUrl: string }) => {
      if (channel !== ERO_CHANNELS.hostPrepare) return
      if (payload.sourceUrl === article) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'redirect', url: target })
      else state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'failed', unavailable: true, reason: 'Source is unavailable' })
    })
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: article, host: 'keep2porn.net', fileName: null } })
    await expect(state.manager.start(transfer)).resolves.toMatchObject({ status: 'failed', unavailable: true })
    expect(state.openRelated.mock.calls.map(([request]) => request.candidate.url)).toEqual([article, target])
    expect(state.ordinary).not.toHaveBeenCalled()
    expect(transfer.onProgress).not.toHaveBeenCalled()
    state.manager.destroy()
  })
  it('reuses the resolved provider file on retry after it requests a login step', async () => {
    const state = setup()
    const article = 'https://keep2porn.net/205359-scene.html'
    const target = 'https://k2s.cc/file/53a37617478a5'
    state.openRelated.mockImplementation(request => { state.host.url = request.candidate.url; return tab(2, state.host.url) })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number; sourceUrl: string }) => {
      if (channel !== ERO_CHANNELS.hostPrepare) return
      state.reply(ERO_CHANNELS.hostPrepared, payload.sourceUrl === article
        ? { requestId: payload.requestId, status: 'redirect', url: target }
        : { requestId: payload.requestId, status: 'waiting', reason: 'Sign in to download' })
    })
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: article, host: 'keep2porn.net', fileName: null } })
    await expect(state.manager.start(transfer)).resolves.toMatchObject({ status: 'waiting' })
    await expect(state.manager.start({ ...transfer, attemptId: 'attempt-2' })).resolves.toMatchObject({ status: 'waiting' })
    expect(state.openRelated.mock.calls.map(([request]) => request.candidate.url)).toEqual([article, target, target])
    state.manager.destroy()
  })
  it('continues the earlier waiting source after a later mirror is unavailable', async () => {
    const state = setup()
    const removed = new Contents('https://mega.nz/file/removed#key')
    state.contents.mockImplementation(id => (id === 1 ? state.origin : id === 2 ? state.host : removed) as unknown as WebContents)
    state.openRelated.mockImplementation(request => tab(request.candidate.url === state.host.url ? 2 : 3, request.candidate.url))
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'waiting', reason: 'MEGA needs the file key' })
    })
    removed.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'failed', unavailable: true, reason: 'Source is unavailable' }, removed)
    })
    const first = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'mega.nz' } })
    const later = { ...first, attemptId: 'attempt-2', candidate: { ...first.candidate, id: 'source-2', url: removed.url } }
    await expect(state.manager.start(first)).resolves.toMatchObject({ status: 'waiting', tabId: 2 })
    await expect(state.manager.start(later)).resolves.toMatchObject({ status: 'failed', unavailable: true })
    state.manager.continue(first.fileId, first.attemptId)
    expect(state.activate).toHaveBeenCalledWith(2)
    const retry = { ...first, attemptId: 'attempt-3' }
    await expect(state.manager.start(retry)).resolves.toMatchObject({ status: 'waiting', tabId: 2 })
    state.activate.mockClear()
    state.manager.continue(first.fileId, first.attemptId)
    expect(state.activate).not.toHaveBeenCalled()
    state.manager.continue(retry.fileId, retry.attemptId)
    expect(state.activate).toHaveBeenCalledWith(2)
    state.manager.destroy()
  })
  it('does not follow provider promotions or unrelated origins as intermediary files', async () => {
    const state = setup()
    state.host.url = 'https://keep2porn.net/205359-scene.html'
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel !== ERO_CHANNELS.hostPrepare) return
      for (const url of ['https://k2s.cc/code/promotion', 'http://127.0.0.1/file', 'https://ads.example/file/53a37617478a5']) {
        state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'redirect', url })
      }
      state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'waiting', reason: 'A verified download control was not available' })
    })
    await expect(state.manager.start(request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'keep2porn.net' } }))).resolves.toMatchObject({ status: 'waiting' })
    expect(state.openRelated).toHaveBeenCalledOnce()
    state.manager.destroy()
  })
  it('passes selected script names to the source page for exact video matching', async () => {
    const state = setup()
    state.host.url = 'https://gofile.io/d/Xsfx7tfh'
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'waiting', reason: 'Fixture' })
    })
    const scriptFileNames = ['1641647055994.funscript']
    await state.manager.start(request({ directUrl: null, scriptFileNames, candidate: { ...request().candidate, url: state.host.url, host: 'gofile.io', fileName: null } }))
    expect(state.host.mainFrame.send).toHaveBeenCalledWith(ERO_CHANNELS.hostPrepare, expect.objectContaining({ scriptFileNames }))
    state.manager.destroy()
  })
  it('arms the exact Pixeldrain file before the detached native download click', async () => {
    const state = setup()
    state.host.url = 'https://pixeldrain.com/u/fyGa97Ty'
    const target = 'https://pixeldrain.com/api/file/fyGa97Ty?download'
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'pixeldrain.com' } })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'ready', provider: 'pixeldrain', fileName: 'test.mp4', url: target })
      if (channel === ERO_CHANNELS.hostActivate) {
        const item = new Item([target])
        state.download(item, state.host)
        expect(item.setSavePath).toHaveBeenCalledWith(transfer.stagingPath)
        item.received = 100
        item.emit('done', {}, 'completed')
      }
    })
    await expect(state.manager.start(transfer)).resolves.toMatchObject({ status: 'complete', fileName: 'test.mp4' })
    expect(state.ordinary).not.toHaveBeenCalled()
    state.manager.destroy()
  })
  it('accepts an ordinary native CAPTCHA callback only for the armed Pixeldrain ID and filename', async () => {
    const state = setup()
    state.host.url = 'https://pixeldrain.com/u/fyGa97Ty'
    const target = 'https://pixeldrain.com/api/file/fyGa97Ty?download&recaptcha_response=native-token'
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'pixeldrain.com' } })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'ready', provider: 'pixeldrain', fileName: 'test.mp4', url: 'https://pixeldrain.com/api/file/fyGa97Ty?download' })
      if (channel === ERO_CHANNELS.hostActivate) {
        expect(state.manager.allowRequest({ id: 55, url: target, webContentsId: state.host.id })).toBe(true)
        const item = new Item([target])
        state.download(item, state.host)
        item.received = 100
        item.emit('done', {}, 'completed')
      }
    })
    await expect(state.manager.start(transfer)).resolves.toMatchObject({ status: 'complete' })
    expect(state.ordinary).not.toHaveBeenCalled()
    state.manager.destroy()
  })
  it('rejects unrelated Pixeldrain IDs, duplicate parameters, other origins and a different returned filename', async () => {
    const page = 'https://pixeldrain.com/u/fyGa97Ty'
    for (const target of ['https://pixeldrain.com/api/file/other123?download', 'https://pixeldrain.com/api/file/fyGa97Ty?download&download', 'https://other.example/api/file/fyGa97Ty?download', 'https://pixeldrain.com/api/file/fyGa97Ty?download&extra=1']) expect(hostDownloadUrl('pixeldrain', page, target, 'test.mp4')).toBe(false)
    const state = setup()
    state.host.url = page
    const target = 'https://pixeldrain.com/api/file/fyGa97Ty?download'
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'ready', provider: 'pixeldrain', fileName: 'test.mp4', url: target })
      if (channel === ERO_CHANNELS.hostActivate) {
        const item = new Item([target])
        item.getFilename = () => 'different.mp4'
        state.download(item, state.host)
        expect(item.cancel).toHaveBeenCalledOnce()
      }
    })
    await expect(state.manager.start(request({ directUrl: null, candidate: { ...request().candidate, url: page, host: 'pixeldrain.com' } }))).resolves.toMatchObject({ status: 'failed', reason: 'The host returned a different file' })
    state.manager.destroy()
  })
  it('arms exact MEGA blob attribution before releasing the provider save click', async () => {
    const state = setup()
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'mega.nz' } })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'ready', provider: 'mega', fileName: 'test.mp4', url: null })
      if (channel === ERO_CHANNELS.hostActivate) state.reply(ERO_CHANNELS.hostDownload, { requestId: payload.requestId, fileName: 'test.mp4', url: 'blob:https://mega.nz/uuid' })
      if (channel === ERO_CHANNELS.hostRelease) {
        const item = new Item(['blob:https://mega.nz/uuid'])
        state.download(item, state.host)
        expect(item.setSavePath).toHaveBeenCalledWith(transfer.stagingPath)
        item.received = 100
        item.emit('done', {}, 'completed')
      }
    })
    await expect(state.manager.start(transfer)).resolves.toMatchObject({ status: 'complete', fileName: 'test.mp4' })
    expect(state.ordinary).not.toHaveBeenCalled()
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostDownload)).toBe(0)
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostActivity)).toBe(0)
    state.manager.destroy()
  })
  it('accepts the exact saved MEGA filename after sanitizing its displayed candidate name', async () => {
    const state = setup()
    const fileName = 'Cruel Handjobs- Ariel-.mp4'
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'mega.nz', fileName: 'Cruel Handjobs: Ariel?.mp4' } })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'ready', provider: 'mega', fileName, url: null })
      if (channel === ERO_CHANNELS.hostActivate) state.reply(ERO_CHANNELS.hostDownload, { requestId: payload.requestId, fileName, url: 'blob:https://mega.nz/uuid' })
      if (channel === ERO_CHANNELS.hostRelease) {
        const item = new Item(['blob:https://mega.nz/uuid'])
        item.getFilename = () => fileName
        state.download(item, state.host)
        expect(item.setSavePath).toHaveBeenCalledWith(transfer.stagingPath)
        item.received = 100
        item.emit('done', {}, 'completed')
      }
    })
    await expect(state.manager.start(transfer)).resolves.toMatchObject({ status: 'complete', fileName })
    expect(state.ordinary).not.toHaveBeenCalled()
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostActivity)).toBe(0)
    state.manager.destroy()
  })
  it('rejects a different saved filename even when the selected MEGA name needed sanitizing', async () => {
    const state = setup()
    const fileName = 'Cruel Handjobs- Ariel-.mp4'
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'mega.nz', fileName: 'Cruel Handjobs: Ariel?.mp4' } })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'ready', provider: 'mega', fileName, url: null })
      if (channel === ERO_CHANNELS.hostActivate) state.reply(ERO_CHANNELS.hostDownload, { requestId: payload.requestId, fileName, url: 'blob:https://mega.nz/uuid' })
      if (channel === ERO_CHANNELS.hostRelease) {
        const item = new Item(['blob:https://mega.nz/uuid'])
        item.getFilename = () => 'other.mp4'
        state.download(item, state.host)
        expect(item.cancel).toHaveBeenCalledOnce()
        expect(item.setSavePath).not.toHaveBeenCalled()
      }
    })
    await expect(state.manager.start(transfer)).resolves.toMatchObject({ status: 'failed', reason: 'The host returned a different file' })
    expect(state.ordinary).not.toHaveBeenCalled()
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostActivity)).toBe(0)
    state.manager.destroy()
  })
  it('waits for MEGA preparation beyond the previous nine-second cutoff', async () => {
    vi.useFakeTimers()
    const state = setup()
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'mega.nz' } })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) setTimeout(() => state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'ready', provider: 'mega', fileName: 'test.mp4', url: null }), 12_000)
      if (channel === ERO_CHANNELS.hostActivate) state.reply(ERO_CHANNELS.hostDownload, { requestId: payload.requestId, fileName: 'test.mp4', url: 'blob:https://mega.nz/uuid' })
      if (channel === ERO_CHANNELS.hostRelease) {
        const item = new Item(['blob:https://mega.nz/uuid'])
        state.download(item, state.host)
        item.received = 100
        item.emit('done', {}, 'completed')
      }
    })
    const finished = vi.fn()
    const promise = state.manager.start(transfer)
    void promise.then(finished)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(finished).not.toHaveBeenCalled()
    expect(state.host.mainFrame.send).not.toHaveBeenCalledWith(ERO_CHANNELS.hostActivate, expect.anything())
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostPrepared)).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(promise).resolves.toMatchObject({ status: 'complete', fileName: 'test.mp4' })
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostPrepared)).toBe(0)
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostActivity)).toBe(0)
    state.manager.destroy()
  })
  it('does not prepare MEGA when cancellation follows page readiness before its await resumes', async () => {
    vi.useFakeTimers()
    const state = setup()
    const controller = new AbortController()
    state.host.isLoading = () => true
    const transfer = request({ directUrl: null, signal: controller.signal, candidate: { ...request().candidate, url: state.host.url, host: 'mega.nz' } })
    const promise = state.manager.start(transfer)
    state.host.emit('dom-ready')
    controller.abort()
    await expect(promise).resolves.toEqual({ status: 'waiting', reason: 'Cancelled', tabId: 2 })
    expect(state.host.mainFrame.send).not.toHaveBeenCalledWith(ERO_CHANNELS.hostPrepare, expect.anything())
    expect(state.host.mainFrame.send).not.toHaveBeenCalledWith(ERO_CHANNELS.hostActivate, expect.anything())
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostPrepared)).toBe(0)
    expect(state.host.listenerCount('dom-ready')).toBe(0)
    expect(state.host.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    state.manager.destroy()
  })
  it('extends the MEGA idle deadline on authenticated activity without reporting invented progress', async () => {
    vi.useFakeTimers()
    const state = setup()
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'mega.nz' } })
    let requestId = 0
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) {
        requestId = payload.requestId
        state.reply(ERO_CHANNELS.hostPrepared, { requestId, status: 'ready', provider: 'mega', fileName: 'test.mp4', url: null })
      }
    })
    const finished = vi.fn()
    const promise = state.manager.start(transfer)
    void promise.then(finished)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostActivity)).toBe(1)
    state.reply(ERO_CHANNELS.hostActivity, { requestId, fileName: 'test.mp4' })
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(finished).not.toHaveBeenCalled()
    expect(transfer.onProgress).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(8 * 60_000)
    expect(finished).toHaveBeenCalledWith({ status: 'waiting', reason: 'The source did not start a download. Continue on its page', tabId: 2 })
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostActivity)).toBe(0)
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostDownload)).toBe(0)
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostWaiting)).toBe(0)
    state.manager.destroy()
  })
  it.each(['sender', 'frame', 'filename', 'request ID'] as const)('does not extend MEGA idle timeout for activity with a forged %s', async (forgery) => {
    vi.useFakeTimers()
    const state = setup()
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'mega.nz' } })
    let requestId = 0
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) {
        requestId = payload.requestId
        state.reply(ERO_CHANNELS.hostPrepared, { requestId, status: 'ready', provider: 'mega', fileName: 'test.mp4', url: null })
      }
    })
    const finished = vi.fn()
    const promise = state.manager.start(transfer)
    void promise.then(finished)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    state.ipc.emit(ERO_CHANNELS.hostActivity, {
      sender: forgery === 'sender' ? state.origin : state.host,
      senderFrame: forgery === 'frame' ? {} : state.host.mainFrame,
    }, { requestId: forgery === 'request ID' ? requestId + 1 : requestId, fileName: forgery === 'filename' ? 'other.mp4' : 'test.mp4' })
    await vi.advanceTimersByTimeAsync(60_001)
    expect(finished).toHaveBeenCalledWith({ status: 'waiting', reason: 'The source did not start a download. Continue on its page', tabId: 2 })
    expect(transfer.onProgress).not.toHaveBeenCalled()
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostActivity)).toBe(0)
    state.manager.destroy()
  })
  it('returns an actual host-required step without making up progress', async () => {
    const state = setup()
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'mega.nz' } })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'waiting', reason: 'MEGA needs the file key' })
    })
    await expect(state.manager.start(transfer)).resolves.toEqual({ status: 'waiting', reason: 'MEGA needs the file key', tabId: 2 })
    expect(transfer.onProgress).not.toHaveBeenCalled()
    expect(state.host.mainFrame.send).not.toHaveBeenCalledWith(ERO_CHANNELS.hostActivate, expect.anything())
    state.manager.destroy()
  })
  it('returns a confirmed dead source as a failure so the queue can try its mirror', async () => {
    const state = setup()
    state.host.url = 'https://gofile.io/d/removed'
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'gofile.io' } })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'failed', unavailable: true, reason: 'Source is unavailable' })
    })
    await expect(state.manager.start(transfer)).resolves.toEqual({ status: 'failed', scope: 'remote', unavailable: true, reason: 'Source is unavailable' })
    expect(state.host.mainFrame.send).not.toHaveBeenCalledWith(ERO_CHANNELS.hostActivate, expect.anything())
    expect(transfer.onProgress).not.toHaveBeenCalled()
    state.manager.destroy()
  })
  it('ignores a dead-source report from another frame or after leaving the selected file', async () => {
    const state = setup()
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'mega.nz' } })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel !== ERO_CHANNELS.hostPrepare) return
      const dead = { requestId: payload.requestId, status: 'failed', unavailable: true, reason: 'Source is unavailable' }
      state.reply(ERO_CHANNELS.hostPrepared, dead, state.origin)
      state.ipc.emit(ERO_CHANNELS.hostPrepared, { sender: state.host, senderFrame: {} }, dead)
      state.host.url = 'https://mega.nz/file/other#key'
      state.reply(ERO_CHANNELS.hostPrepared, dead)
      state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'waiting', reason: 'The source page changed. Reopen the original link' })
    })
    await expect(state.manager.start(transfer)).resolves.toMatchObject({ status: 'waiting' })
    state.manager.destroy()
  })
  it('recognizes a dead legacy MEGA link after its provider redirects to the same canonical file', async () => {
    const state = setup()
    state.host.url = 'https://mega.nz/file/handle#key'
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: 'https://mega.co.nz/#!handle!key', host: 'mega.co.nz' } })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'failed', unavailable: true, reason: 'Source is unavailable' })
    })
    await expect(state.manager.start(transfer)).resolves.toMatchObject({ status: 'failed', unavailable: true })
    state.manager.destroy()
  })
  it('validates the scoped provider link, filename and blob origin', () => {
    expect(hostDownloadUrl('gofile', 'https://gofile.io/d/code', 'https://store1.gofile.io/download/web/id/test.mp4', 'test.mp4')).toBe(true)
    expect(hostDownloadUrl('gofile', 'https://gofile.io/d/code', 'https://advert.example/download/test.mp4', 'test.mp4')).toBe(false)
    expect(hostDownloadUrl('gofile', 'https://gofile.io/d/code', 'https://store1.gofile.io/download/web/id/other.mp4', 'test.mp4')).toBe(false)
    expect(hostDownloadUrl('mega', 'https://mega.nz/file/id#key', 'blob:https://mega.nz/uuid', 'test.mp4')).toBe(true)
    expect(hostDownloadUrl('mega', 'https://mega.nz/file/id#key', 'blob:https://other.example/uuid', 'test.mp4')).toBe(false)
  })
  it('ignores other senders and frames, then rejects a different blob origin', async () => {
    const state = setup()
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'mega.nz' } })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      const ready = { requestId: payload.requestId, status: 'ready', provider: 'mega', fileName: 'test.mp4', url: null }
      if (channel === ERO_CHANNELS.hostPrepare) {
        state.reply(ERO_CHANNELS.hostPrepared, ready, state.origin)
        state.ipc.emit(ERO_CHANNELS.hostPrepared, { sender: state.host, senderFrame: {} }, ready)
        expect(state.host.mainFrame.send).not.toHaveBeenCalledWith(ERO_CHANNELS.hostActivate, expect.anything())
        state.reply(ERO_CHANNELS.hostPrepared, ready)
      }
      if (channel === ERO_CHANNELS.hostActivate) state.reply(ERO_CHANNELS.hostDownload, { requestId: payload.requestId, fileName: 'test.mp4', url: 'blob:https://advert.example/uuid' })
    })
    await expect(state.manager.start(transfer)).resolves.toMatchObject({ status: 'waiting', reason: 'The host offered a different file. Check the source page' })
    expect(state.host.mainFrame.send).not.toHaveBeenCalledWith(ERO_CHANNELS.hostRelease, expect.anything())
    state.manager.destroy()
  })
  it('hands off a quota promptly and removes host capture listeners', async () => {
    const state = setup()
    const transfer = request({ directUrl: null, candidate: { ...request().candidate, url: state.host.url, host: 'mega.nz' } })
    state.host.mainFrame.send.mockImplementation((channel: string, payload: { requestId: number }) => {
      if (channel === ERO_CHANNELS.hostPrepare) state.reply(ERO_CHANNELS.hostPrepared, { requestId: payload.requestId, status: 'ready', provider: 'mega', fileName: 'test.mp4', url: null })
      if (channel === ERO_CHANNELS.hostActivate) state.reply(ERO_CHANNELS.hostWaiting, { requestId: payload.requestId, reason: 'MEGA reached its transfer quota' })
    })
    await expect(state.manager.start(transfer)).resolves.toEqual({ status: 'waiting', reason: 'MEGA reached its transfer quota', tabId: 2 })
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostDownload)).toBe(0)
    expect(state.ipc.listenerCount(ERO_CHANNELS.hostWaiting)).toBe(0)
    expect(transfer.onProgress).not.toHaveBeenCalled()
    state.manager.destroy()
  })
})
