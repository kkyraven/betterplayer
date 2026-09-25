import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/update'
import { portableDataDir } from './portable'

const CHECK_EVERY = 6 * 60 * 60 * 1000
const PORTABLE = portableDataDir() !== null

export class Updater {
  private state: UpdateState = app.isPackaged && !PORTABLE ? { status: 'idle' } : { status: 'off', portable: PORTABLE }
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly push: (state: UpdateState) => void) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }))
    autoUpdater.on('update-not-available', () => this.set({ status: 'upToDate' }))
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, percent: 0 }))
    autoUpdater.on('download-progress', (p) => {
      if (this.state.status === 'downloading') this.set({ ...this.state, percent: Math.round(p.percent) })
    })
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ status: 'ready', version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '', bytes: info.files[0]?.size ?? null }),
    )
    autoUpdater.on('error', (e) => this.set({ status: 'error', message: e.message }))
  }

  get(): UpdateState {
    return this.state
  }

  start() {
    if (this.state.status === 'off' || this.timer) return
    this.check()
    this.timer = setInterval(() => this.check(), CHECK_EVERY)
  }

  check() {
    if (this.state.status === 'off' || this.state.status === 'downloading' || this.state.status === 'ready') return
    autoUpdater.checkForUpdates().catch(() => {})
  }

  install() {
    if (this.state.status !== 'ready') return
    autoUpdater.quitAndInstall(true, true)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private set(state: UpdateState) {
    this.state = state
    this.push(state)
  }
}
