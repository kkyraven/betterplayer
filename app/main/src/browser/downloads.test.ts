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
  const manager = new BrowserDownloads(events as unknown as Session, ipc as unknown as IpcMain, {
    topic: () => null,
    contents: (id) => (id === 1 ? origin : host) as unknown as WebContents,
    openRelated: () => tab(2, host.url), openTransfer: () => tab(2, 'about:blank'), activate: vi.fn(), ordinaryDownload: ordinary,
  })
  const download = (item: Item, contents = origin) => events.emit('will-download', {}, item as unknown as DownloadItem, contents as unknown as WebContents)
  const reply = (channel: string, payload: unknown, contents = host) => ipc.emit(channel, { sender: contents, senderFrame: contents.mainFrame }, payload)
  return { manager, events, ipc, origin, host, ordinary, download, reply }
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
