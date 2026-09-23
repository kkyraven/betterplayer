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
    canGoBack: false, canGoForward: false, blocked: 0, video: null, capturing: false, audible: false, muted: false, favicon: null }
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
