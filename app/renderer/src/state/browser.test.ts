import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserTab } from '@shared/browser'
import type { IpcEvents } from '@shared/ipc'

const ipc = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}))
vi.mock('@/ipc', () => ({
  invoke: ipc.invoke,
  on: (event: string, listener: (payload: unknown) => void) => {
    ipc.listeners.set(event, listener)
    return () => { ipc.listeners.delete(event) }
  },
}))
vi.mock('@/engine/client', () => ({ engine: {} }))

import { useBrowser } from './browser'
import { useUi } from './ui'

function push<E extends keyof IpcEvents>(event: E, value: IpcEvents[E]) {
  ipc.listeners.get(event)?.(value)
}

function tab(id: number): BrowserTab {
  return { id, title: 'Example', url: 'https://example.com', active: true, loading: false,
    canGoBack: false, canGoForward: false, blocked: 0, video: null, capturing: false, audible: false, muted: false, favicon: null, topic: null, adBlockingExempt: false }
}

let dispose: (() => void) | undefined
beforeEach(() => {
  ipc.invoke.mockReset().mockResolvedValue(undefined)
  ipc.listeners.clear()
  useUi.setState({ screen: 'browser', mediaCentre: false })
  useBrowser.setState({ tabs: [], activeId: null, initialized: false, startData: null })
})
afterEach(() => { dispose?.(); dispose = undefined })

function initialize() {
  ipc.invoke.mockImplementation((channel) => {
    if (channel === 'browser:tabs') return Promise.resolve([])
    if (channel === 'browser:startData') return Promise.resolve({ bookmarks: [], mostVisited: [], adBlockEnabled: true })
    return Promise.resolve(undefined)
  })
  dispose = useBrowser.getState().init()
}

describe('browser view ownership', () => {
  it('detaches as soon as the app section changes and rejects stale bounds', async () => {
    initialize()
    const bounds = { x: 70, y: 140, w: 900, h: 600 }
    await useBrowser.getState().setBounds(bounds)
    expect(ipc.invoke).toHaveBeenLastCalledWith('browser:bounds', bounds)
    useUi.getState().setScreen('library')
    expect(ipc.invoke).toHaveBeenLastCalledWith('browser:bounds', null)
    await useBrowser.getState().setBounds(bounds)
    expect(ipc.invoke).toHaveBeenLastCalledWith('browser:bounds', null)
  })

  it('detaches when the media centre replaces the browser', () => {
    initialize()
    useUi.setState({ mediaCentre: true })
    expect(ipc.invoke).toHaveBeenLastCalledWith('browser:bounds', null)
  })
})

describe('browser hydration', () => {
  it('hydrates a cold topic open before switching screens so the empty browser cannot steal it', async () => {
    useUi.setState({ screen: 'utilities' })
    useBrowser.setState({ initialized: true })
    const topic = { ...tab(7), url: 'https://discuss.eroscripts.com/t/123' }
    ipc.invoke.mockImplementation((channel) => Promise.resolve(channel === 'browser:open' ? topic : channel === 'browser:tabs' ? [topic] : undefined))
    const off = useUi.subscribe((state) => {
      const browser = useBrowser.getState()
      if (state.screen === 'browser' && browser.initialized && browser.tabs.length === 0) void browser.open()
    })
    try {
      await useBrowser.getState().open(topic.url)
      useUi.getState().setScreen('browser')
      expect(useBrowser.getState()).toMatchObject({ initialized: true, activeId: 7, tabs: [topic] })
      expect(ipc.invoke.mock.calls.map((call) => call[0]).filter((channel) => channel.startsWith('browser:'))).toEqual(['browser:open', 'browser:tabs'])
      expect(ipc.invoke).toHaveBeenCalledWith('browser:open', topic.url)
    } finally { off() }
  })

  it('hydrates the first EroScripts tab before the browser screen can open a blank tab', async () => {
    useUi.setState({ screen: 'library' })
    const eroTab = { ...tab(9), url: 'https://discuss.eroscripts.com/' }
    ipc.invoke.mockImplementation((channel) => Promise.resolve(channel === 'browser:openEroScripts' ? eroTab : channel === 'browser:tabs' ? [eroTab] : undefined))
    const off = useUi.subscribe((state) => {
      const browser = useBrowser.getState()
      if (state.screen === 'browser' && browser.initialized && browser.tabs.length === 0) void browser.open()
    })
    try {
      await useBrowser.getState().openEroScripts()
      expect(useBrowser.getState()).toMatchObject({ initialized: true, activeId: 9, tabs: [eroTab] })
      useUi.getState().setScreen('browser')
      expect(ipc.invoke.mock.calls.map((call) => call[0]).filter((channel) => channel.startsWith('browser:'))).toEqual(['browser:openEroScripts', 'browser:tabs'])
    } finally { off() }
  })

  it('keeps a newer tab push over a delayed EroScripts refresh', async () => {
    initialize()
    await Promise.resolve()
    let resolveTabs: (tabs: BrowserTab[]) => void = () => {}
    ipc.invoke.mockImplementation((channel) => channel === 'browser:tabs' ? new Promise<BrowserTab[]>((resolve) => { resolveTabs = resolve }) : Promise.resolve(tab(9)))
    const opening = useBrowser.getState().openEroScripts()
    await Promise.resolve()
    push('browser:tabs', [tab(10)])
    resolveTabs([tab(9)])
    await opening
    expect(useBrowser.getState().activeId).toBe(10)
  })

  it('does not let initial empty hydration erase an explicitly opened EroScripts tab', async () => {
    let resolveInitial: (tabs: BrowserTab[]) => void = () => {}
    let requested = false
    ipc.invoke.mockImplementation((channel) => {
      if (channel !== 'browser:tabs') return Promise.resolve(tab(9))
      if (requested) return Promise.resolve([tab(9)])
      requested = true
      return new Promise<BrowserTab[]>((resolve) => { resolveInitial = resolve })
    })
    dispose = useBrowser.getState().init()
    await useBrowser.getState().openEroScripts()
    resolveInitial([])
    await Promise.resolve()
    expect(useBrowser.getState().activeId).toBe(9)
    expect(useBrowser.getState().tabs).toHaveLength(1)
  })

  it('does not overwrite a newer tab push with an older initial reply', async () => {
    let resolveTabs: (tabs: BrowserTab[]) => void = () => {}
    ipc.invoke.mockImplementation((channel) => channel === 'browser:tabs'
      ? new Promise<BrowserTab[]>((resolve) => { resolveTabs = resolve })
      : Promise.resolve({ bookmarks: [], mostVisited: [], adBlockEnabled: true }))
    dispose = useBrowser.getState().init()
    expect(useBrowser.getState().initialized).toBe(false)
    push('browser:tabs', [tab(2)])
    resolveTabs([tab(1)])
    await Promise.resolve()
    expect(useBrowser.getState().activeId).toBe(2)
    expect(useBrowser.getState().initialized).toBe(true)
  })

  it('ignores initial replies after the subscription is disposed', async () => {
    initialize()
    dispose?.()
    await Promise.resolve()
    expect(useBrowser.getState().initialized).toBe(false)
  })

  it('clears video selection when main switches active tabs', () => {
    initialize()
    push('browser:tabs', [tab(1)])
    useBrowser.setState({ region: { x: 0, y: 0, w: 1, h: 1 }, zone: { x: 0, y: 0, w: 1, h: 1 }, error: 'drm' })
    push('browser:tabs', [tab(2)])
    expect(useBrowser.getState()).toMatchObject({ activeId: 2, region: null, zone: null, error: null })
  })
})
