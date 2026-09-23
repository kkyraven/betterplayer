import { t } from './i18n'
import { CHASTER_API, CHASTER_POLL_MS, readLock, type ChasterLockJson, type ChasterStatus } from '@shared/chaster'
import type { Settings } from '@shared/settings'

interface Profile {
  username: string
}

export class Chaster {
  private token = ''
  private timer: NodeJS.Timeout | null = null
  private status: ChasterStatus = { state: 'off', lock: null }
  private polling: Promise<void> | null = null

  constructor(private readonly onChange: (status: ChasterStatus) => void) {}

  get(): ChasterStatus {
    return this.status
  }

  apply(settings: Settings) {
    const token = settings.chaster.token.trim()
    if (token === this.token) return
    this.token = token
    this.stop()
    if (!token) {
      this.set({ state: 'off', lock: null })
      return
    }
    this.set({ state: 'connecting', lock: null })
    void this.poll()
    this.timer = setInterval(() => void this.poll(), CHASTER_POLL_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private set(status: ChasterStatus) {
    this.status = status
    this.onChange(status)
  }

  private poll(): Promise<void> {
    this.polling ??= this.fetchStatus().finally(() => {
      this.polling = null
    })
    return this.polling
  }

  private async fetchStatus() {
    const token = this.token
    try {
      const [profile, locks] = await Promise.all([this.request<Profile>('/auth/profile'), this.request<ChasterLockJson[]>('/locks?status=active')])
      if (token !== this.token) return
      this.set({ state: 'ok', username: profile.username, lock: readLock(locks) })
    } catch (e) {
      if (token !== this.token) return
      const { username, lock } = this.status
      this.set({ state: 'error', error: e instanceof Error ? e.message : String(e), username, lock })
    }
  }

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`${CHASTER_API}${path}`, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', 'User-Agent': 'BetterPlayer' } })
    if (res.status === 401 || res.status === 403) throw new Error(t('settings.chaster.tokenRejected'))
    if (!res.ok) throw new Error(t('settings.chaster.serverStatus', { status: res.status }))
    return (await res.json()) as T
  }
}
