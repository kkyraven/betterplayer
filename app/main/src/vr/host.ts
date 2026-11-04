import type { BrowserWindow } from 'electron'

export class VrHost {
  readonly state = null
  readonly deckWindow: BrowserWindow | null = null
  readonly libraryWindow: BrowserWindow | null = null
  constructor(..._args: unknown[]) {}
  start(): Promise<void> {
    return Promise.reject(new Error('not-installed: This build has no VR'))
  }
  stop(): void {}
  setState(_state: unknown): void {}
  aim(_rays: unknown): void {}
  command(_command: unknown): void {}
  portalUp(_message: unknown): void {}
  libraryChanged(): void {}
  dev(_op: unknown): Promise<unknown> {
    return Promise.resolve(null)
  }
}
