import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/settings'
import type { ThemeMode } from '@shared/theme'
import { syncNativeTheme, watchNativeTheme } from './theme'

const nativeTheme = vi.hoisted(() => ({ themeSource: 'system', shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ nativeTheme }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function setup(mode: ThemeMode) {
  const settings = defaultSettings()
  settings.appearance.theme.mode = mode
  const store = { get: () => settings }
  const events = new EventEmitter()
  const win = Object.assign(events, { setTitleBarOverlay: vi.fn(), setBackgroundColor: vi.fn(), isDestroyed: vi.fn(() => false) })
  return { store, win }
}

describe('native theme', () => {
  it('updates Windows captions and background when the OS changes in System mode', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    const { store, win } = setup('system')
    nativeTheme.shouldUseDarkColors = false
    syncNativeTheme(store, win)
    expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: '#f3f3f7', symbolColor: '#16181d' })
    watchNativeTheme(store, win)
    nativeTheme.shouldUseDarkColors = true
    nativeTheme.on.mock.calls[0]![1]()
    expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: '#0a0c10', symbolColor: '#eef0f4' })
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#0a0c10')
  })

  it.each(['light', 'dark', 'black'] as const)('keeps %s fixed when the OS changes', (mode) => {
    const { store, win } = setup(mode)
    nativeTheme.shouldUseDarkColors = false
    const before = syncNativeTheme(store, win)
    nativeTheme.shouldUseDarkColors = true
    expect(syncNativeTheme(store, win)).toEqual(before)
    expect(nativeTheme.themeSource).toBe(mode === 'light' ? 'light' : 'dark')
  })

  it('removes its listener when the window closes and ignores destroyed windows', () => {
    const { store, win } = setup('dark')
    watchNativeTheme(store, win)
    const update = nativeTheme.on.mock.calls[0]![1]
    win.emit('closed')
    expect(nativeTheme.removeListener).toHaveBeenCalledWith('updated', update)
    win.isDestroyed.mockReturnValue(true)
    update()
    expect(win.setBackgroundColor).not.toHaveBeenCalled()
  })
})
