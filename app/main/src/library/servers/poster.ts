import { WebContentsView, ipcMain, type IpcMainEvent } from 'electron'
import { join } from 'node:path'
import { t } from '../../i18n'

interface Reply { id: number; bytes?: Uint8Array; error?: boolean }

export class PosterDecoder {
  private window: WebContentsView | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<number, { resolve: (bytes: Buffer) => void; reject: (error: Error) => void }>()
  private nextId = 0
  private closed = false

  constructor() { ipcMain.on('poster:decoded', this.reply) }

  private reply = (event: IpcMainEvent, message: Reply) => {
    if (event.sender !== this.window?.webContents) return
    const request = this.pending.get(message.id)
    if (!request) return
    this.pending.delete(message.id)
    if (message.bytes instanceof Uint8Array) request.resolve(Buffer.from(message.bytes))
    else request.reject(new Error(t('library.error.invalidThumbnail')))
  }

  async decode(bytes: Buffer, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted()
    if (this.closed) throw new Error('Poster decoder closed')
    if (!this.window) {
      const window = new WebContentsView({ webPreferences: {
        preload: join(__dirname, '../preload/poster.js'), sandbox: false, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false,
      } })
      this.window = window
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event) => event.preventDefault())
      window.webContents.on('render-process-gone', () => this.reset())
      this.ready = window.webContents.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27">')
    }
    const abort = () => this.reset()
    signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, 30_000)
    try {
      await this.ready
      signal?.throwIfAborted()
      if (!this.window) throw new Error('Poster decoder stopped')
      return await new Promise<Buffer>((resolve, reject) => {
        const id = ++this.nextId
        this.pending.set(id, { resolve, reject })
        this.window!.webContents.send('poster:decode', id, bytes)
      })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }

  private reset() {
    const window = this.window
    this.window = null
    this.ready = null
    for (const request of this.pending.values()) request.reject(new Error('Poster decoder stopped'))
    this.pending.clear()
    if (window && !window.webContents.isDestroyed()) window.webContents.close({ waitForBeforeUnload: false })
  }

  close() {
    this.closed = true
    ipcMain.removeListener('poster:decoded', this.reply)
    this.reset()
  }
}
