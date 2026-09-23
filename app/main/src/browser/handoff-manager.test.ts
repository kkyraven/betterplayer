import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TAB_CHANNELS } from '@shared/browser'
import { BrowserTabs } from './index'

const frames = vi.hoisted(() => ({ fromId: vi.fn() }))
vi.mock('electron', () => ({ app: {}, safeStorage: {}, session: {}, webFrameMain: frames, WebContentsView: class {} }))
vi.mock('@ghostery/adblocker-electron', () => ({ ElectronBlocker: {}, fromElectronDetails: vi.fn() }))

function setup() {
  const ipc = new EventEmitter()
  const send = vi.fn()
  frames.fromId.mockReturnValue({ send })
  const contents = {
    isDestroyed: vi.fn(() => false), getURL: vi.fn(() => 'https://page.example/watch'),
    getUserAgent: () => 'Browser/1', session: { cookies: { get: vi.fn(async () => [] as Array<{ name: string; value: string }>) } },
  }
  const tab = { id: 9, view: { webContents: contents }, videoFrame: { processId: 10, frameId: 20 }, video: { mediaTime: 5, rate: 1 } }
  const manager: BrowserTabs = Object.assign(Object.create(BrowserTabs.prototype), { tabList: [tab], nextHandoffId: 1, ipc })
  const reply = (overrides: Record<string, unknown> = {}, state = { requestId: 1, url: 'https://cdn.example/video.mp4', position: 42.25, rate: 1.5 }) => {
    ipc.emit(TAB_CHANNELS.handoff, { sender: contents, processId: 10, frameId: 20, senderFrame: { url: 'https://embed.example/player' }, ...overrides }, state)
  }
  return { manager, ipc, send, contents, tab, reply }
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
afterEach(() => vi.useRealTimers())

describe('browser handoff requests', () => {
  it('accepts fresh playback state only from the selected sender and frame', async () => {
    const { manager, ipc, send, reply, contents } = setup()
    const pending = manager.handoff(9)
    expect(send).toHaveBeenCalledWith(TAB_CHANNELS.handoff, 1)
    reply({ sender: {} })
    reply({ frameId: 99 })
    reply({}, { requestId: 99, url: 'https://ad.example/ad.mp4', position: 0, rate: 1 })
    expect(contents.session.cookies.get).not.toHaveBeenCalled()
    reply()
    await expect(pending).resolves.toEqual({
      pageUrl: 'https://page.example/watch', url: 'https://cdn.example/video.mp4',
      position: 42.25, rate: 1.5, headers: 'Referer: https://embed.example/player,User-Agent: Browser/1',
    })
    expect(contents.session.cookies.get).not.toHaveBeenCalled()
    expect(ipc.listenerCount(TAB_CHANNELS.handoff)).toBe(0)
  })

  it('falls back promptly when the frame does not respond', async () => {
    const { manager, ipc } = setup()
    const pending = manager.handoff(9)
    await vi.advanceTimersByTimeAsync(500)
    await expect(pending).resolves.toEqual({ pageUrl: 'https://page.example/watch', url: null, headers: '', position: 5, rate: 1 })
    expect(ipc.listenerCount(TAB_CHANNELS.handoff)).toBe(0)
  })

  it('rejects a response after the tab navigates', async () => {
    const { manager, contents, reply } = setup()
    const pending = manager.handoff(9)
    contents.getURL.mockReturnValue('https://page.example/other')
    reply()
    await expect(pending).resolves.toBeNull()
  })

  it('tries direct playback without reading or forwarding browser cookies', async () => {
    const { manager, contents, reply } = setup()
    contents.session.cookies.get.mockResolvedValue([{ name: 'session', value: 'private-token' }])
    const pending = manager.handoff(9)
    reply()
    await expect(pending).resolves.toEqual({
      pageUrl: 'https://page.example/watch', url: 'https://cdn.example/video.mp4', position: 42.25, rate: 1.5,
      headers: 'Referer: https://embed.example/player,User-Agent: Browser/1',
    })
    expect(contents.session.cookies.get).not.toHaveBeenCalled()
  })

  it('keeps fresh position for blob sources without querying cookies', async () => {
    const { manager, contents, reply } = setup()
    const pending = manager.handoff(9)
    reply({}, { requestId: 1, url: 'blob:https://page.example/id', position: 18, rate: 2 })
    await expect(pending).resolves.toEqual({ pageUrl: 'https://page.example/watch', url: null, headers: '', position: 18, rate: 2 })
    expect(contents.session.cookies.get).not.toHaveBeenCalled()
  })
})
