import type { MessageKey } from '@shared/i18n'
declare global {
  interface Window {
    require: NodeRequire
  }
}

export const electron: typeof import('electron') = window.require('electron')

export const platform = (window.require('process') as NodeJS.Process).platform
export const osRelease = (window.require('node:os') as typeof import('node:os')).release()
export const REVEAL_LABEL: MessageKey = platform === 'darwin' ? 'reveal.darwin' : platform === 'win32' ? 'reveal.win32' : 'reveal.other'
