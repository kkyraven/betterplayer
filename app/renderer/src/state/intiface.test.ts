import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { IntifaceState } from 'bp-engine'
import type { BrowserTab } from '@shared/browser'
import type { Settings } from '@shared/settings'
import { defaultSettings } from '@shared/settings'
import type { IntifaceStatus } from './intiface'

const native = vi.hoisted(() => ({ available: true, startIntiface: vi.fn(), stopIntiface: vi.fn(), intifaceState: vi.fn<() => IntifaceState | null>() }))
vi.mock('@/engine/client', () => ({ get engine() { return native.available ? native : undefined } }))
vi.mock('@/state/i18n', () => ({ t: (key: string) => key }))
vi.mock('./settings', async () => {
  const { create } = await import('zustand')
  return { useSettings: create<{ settings: Settings | null }>(() => ({ settings: null })) }
})
vi.mock('./browser', async () => {
  const { create } = await import('zustand')
  return { useBrowser: create<{ tabs: BrowserTab[] }>(() => ({ tabs: [] })) }
})

let settings: typeof import('./settings')['useSettings']
let browser: typeof import('./browser')['useBrowser']
let intiface: typeof import('./intiface')
let unload: () => void

function tab(id: number, url = 'https://faptap.net/watch/1'): BrowserTab {
  return { id, url, title: 'Page', active: false, loading: false, canGoBack: false, canGoForward: false,
    blocked: 0, video: null, capturing: false, audible: false, muted: false, favicon: null, topic: null, adBlockingExempt: false }
}

function configure(change: Partial<Settings['intiface']>) {
  settings.setState((s) => {
    const current = s.settings ?? defaultSettings()
    return { settings: { ...current, intiface: { ...current.intiface, ...change } } }
  })
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  native.available = true
  native.intifaceState.mockReturnValue(null)
  vi.stubGlobal('window', {
    setTimeout, clearTimeout,
    addEventListener: (event: string, listener: () => void) => { if (event === 'beforeunload') unload = listener },
  })
  settings = (await import('./settings')).useSettings
  browser = (await import('./browser')).useBrowser
  intiface = await import('./intiface')
  browser.setState({ tabs: [] })
  settings.setState({ settings: defaultSettings() })
  native.startIntiface.mockClear()
  native.stopIntiface.mockClear()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Intiface activation', () => {
  it.each([
    { alwaysOn: true, faptap: false },
    { alwaysOn: false, faptap: true },
    { alwaysOn: false, faptap: false },
  ])('waits for the engine before reading or applying configuration: %o', ({ alwaysOn, faptap }) => {
    native.available = false
    configure({ alwaysOn, port: 23456 })
    browser.setState({ tabs: [tab(1, faptap ? 'https://faptap.net/watch/1' : 'https://example.com')] })
    const observed: IntifaceStatus[] = []
    function Status() {
      observed.push(intiface.useIntifaceStatus())
      return null
    }
    expect(() => renderToString(createElement(Status))).not.toThrow()
    expect(observed[0]).toEqual({ running: false, state: null, error: null })
    unload()
    vi.advanceTimersByTime(15000)
    expect(native.intifaceState).not.toHaveBeenCalled()
    expect(native.startIntiface).not.toHaveBeenCalled()
    expect(native.stopIntiface).not.toHaveBeenCalled()

    native.available = true
    const state = alwaysOn || faptap ? { port: 23456, clients: 1, client: 'Fixture' } : null
    native.intifaceState.mockReturnValue(state)
    intiface.applyIntiface(settings.getState().settings!.intiface)
    if (alwaysOn || faptap) expect(native.startIntiface).toHaveBeenCalledExactlyOnceWith(23456)
    else expect(native.stopIntiface).toHaveBeenCalledOnce()
    renderToString(createElement(Status))
    expect(native.intifaceState).toHaveBeenCalledOnce()
    expect(observed[1]).toEqual({ running: state !== null, state, error: null })
  })

  it('leaves the port free at startup and for unrelated or invalid URLs', () => {
    browser.setState({ tabs: [tab(1, 'https://example.com'), tab(2, 'https://faptap.net.example.com'), tab(3, 'invalid'), tab(4, 'file://faptap.net/page')] })
    vi.advanceTimersByTime(15000)
    expect(native.startIntiface).not.toHaveBeenCalled()
  })

  it('borrows the port for all open FapTap tabs without persisting activation', () => {
    browser.setState({ tabs: [tab(1), tab(2, 'https://www.faptap.net/watch/2')] })
    expect(native.startIntiface).toHaveBeenCalledExactlyOnceWith(12345)
    expect(settings.getState().settings?.intiface.alwaysOn).toBe(false)
    browser.setState({ tabs: [tab(2, 'https://www.faptap.net/watch/2')] })
    expect(native.stopIntiface).not.toHaveBeenCalled()
    expect(native.startIntiface).toHaveBeenCalledTimes(1)
    browser.setState({ tabs: [] })
    expect(native.stopIntiface).toHaveBeenCalledOnce()
  })

  it('releases the port when the last FapTap tab navigates away', () => {
    browser.setState({ tabs: [tab(1)] })
    browser.setState({ tabs: [tab(1, 'https://example.com')] })
    expect(native.stopIntiface).toHaveBeenCalledOnce()
  })

  it('keeps explicit activation until switched off, including after FapTap closes', () => {
    configure({ alwaysOn: true, port: 23456 })
    expect(native.startIntiface).toHaveBeenCalledExactlyOnceWith(23456)
    browser.setState({ tabs: [tab(1)] })
    browser.setState({ tabs: [] })
    expect(native.stopIntiface).not.toHaveBeenCalled()
    configure({ alwaysOn: false })
    expect(native.stopIntiface).toHaveBeenCalledOnce()
  })

  it('keeps temporary activation when the switch is turned off while FapTap is open', () => {
    configure({ alwaysOn: true })
    browser.setState({ tabs: [tab(1)] })
    configure({ alwaysOn: false })
    expect(native.stopIntiface).not.toHaveBeenCalled()
    browser.setState({ tabs: [] })
    expect(native.stopIntiface).toHaveBeenCalledOnce()
  })

  it('cancels bind retries when the last tab closes', () => {
    native.startIntiface.mockImplementation(() => { throw new Error('port in use') })
    browser.setState({ tabs: [tab(1)] })
    vi.advanceTimersByTime(5000)
    expect(native.startIntiface).toHaveBeenCalledTimes(2)
    browser.setState({ tabs: [] })
    vi.advanceTimersByTime(15000)
    expect(native.startIntiface).toHaveBeenCalledTimes(2)
    expect(native.stopIntiface).toHaveBeenCalledOnce()
  })

  it('uses the latest setting on retry when explicit activation replaces a FapTap tab', () => {
    native.startIntiface.mockImplementationOnce(() => { throw new Error('port in use') })
    browser.setState({ tabs: [tab(1)] })
    configure({ alwaysOn: true })
    browser.setState({ tabs: [] })
    vi.advanceTimersByTime(5000)
    expect(native.startIntiface).toHaveBeenCalledTimes(2)
    expect(native.stopIntiface).not.toHaveBeenCalled()
  })

  it('retries a changed port and cancels pending retries on unload', () => {
    native.startIntiface.mockImplementation(() => { throw new Error('port in use') })
    configure({ alwaysOn: true })
    configure({ port: 23456 })
    vi.advanceTimersByTime(5000)
    expect(native.startIntiface.mock.calls).toEqual([[12345], [23456], [23456]])
    unload()
    vi.advanceTimersByTime(15000)
    expect(native.startIntiface).toHaveBeenCalledTimes(3)
    expect(native.stopIntiface).toHaveBeenCalledOnce()
  })
})
