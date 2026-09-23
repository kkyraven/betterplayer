import { nativeTheme, type BrowserWindow } from 'electron'
import { resolveMode, windowColours } from '@shared/theme'
import type { SettingsStore } from './settings/store'

type ThemeWindow = Pick<BrowserWindow, 'setTitleBarOverlay' | 'setBackgroundColor' | 'isDestroyed'> & {
  once(event: 'closed', listener: () => void): unknown
}

export function syncNativeTheme(store: Pick<SettingsStore, 'get'>, win?: ThemeWindow | null) {
  const { mode } = store.get().appearance.theme
  const source = mode === 'system' ? 'system' : mode === 'light' ? 'light' : 'dark'
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source
  const colours = windowColours(resolveMode(mode, nativeTheme.shouldUseDarkColors))
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(colours.background)
    if (process.platform === 'win32') win.setTitleBarOverlay({ color: colours.background, symbolColor: colours.text })
  }
  return colours
}

export function watchNativeTheme(store: Pick<SettingsStore, 'get'>, win: ThemeWindow) {
  const update = () => syncNativeTheme(store, win)
  nativeTheme.on('updated', update)
  win.once('closed', () => nativeTheme.removeListener('updated', update))
}
