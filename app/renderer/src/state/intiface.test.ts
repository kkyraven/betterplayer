import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserTab } from '@shared/browser'
import type { Settings } from '@shared/settings'
import { defaultSettings } from '@shared/settings'

const native = vi.hoisted(() => ({ startIntiface: vi.fn(), stopIntiface: vi.fn(), intifaceState: vi.fn() }))
vi.mock('@/engine/client', () => ({ engine: native }))
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
let unload: () => void

function tab(id: number, url = 'https://faptap.net/watch/1'): BrowserTab {
  return { id, url, title: 'Page', active: false, loading: false, canGoBack: false, canGoForward: false,
    blocked: 0, video: null, capturing: false, audible: false, muted: false, favicon: null }
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
  vi.stubGlobal('window', {
    setTimeout, clearTimeout,
    addEventListener: (event: string, listener: () => void) => { if (event === 'beforeunload') unload = listener },
  })
  settings = (await import('./settings')).useSettings
  browser = (await import('./browser')).useBrowser
  await import('./intiface')
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
