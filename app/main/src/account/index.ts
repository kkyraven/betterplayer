import { t } from '../i18n'
import { shell } from 'electron'
import { join } from 'node:path'
import {
  ACCOUNT_REFRESH_MS,
  LOGIN_POLL_MS,
  LOGIN_TIMEOUT_MS,
  SIGNED_OUT,
  isContentHash,
  mergeSynced,
  syncPayload,
  type AccountStatus,
  type FriendLists,
  type Me,
  type SyncRow,
} from '@shared/account'
import type { PerVideoSettings, Settings } from '@shared/settings'
import { isFeatureName, type AdminStats, type UsagePing } from '@shared/usage'
import { randomUUID } from 'node:crypto'
import type { Library } from '../library'
import { contentHash, fileStamp } from './hash'
import { AccountDb } from './store'

const isUrl = (path: string) => /^https?:\/\//i.test(path)

const PUSH_DELAY_MS = 15_000
const HASH_PACE_MS = 150
const HASH_BATCH = 500
const PUSH_BYTES = 200_000
const USAGE_FIRST_MS = 20_000
const USAGE_EVERY_MS = 6 * 60 * 60_000

export interface ClientInfo {
  os: UsagePing['os']
  arch: string
  version: string
}

interface MeJson extends Me {
  stun: string[]
}

interface Poll {
  status: string
  token?: string
}

export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export class Account {
  private readonly db: AccountDb
  private token: string | null
  private status: AccountStatus = SIGNED_OUT
  private sync = true
  private usageStats = true
  private refreshTimer: NodeJS.Timeout | null = null
  private usageTimer: NodeJS.Timeout | null = null
  private usageRun = 0
  private pushTimer: NodeJS.Timeout | null = null
  private hashTimer: NodeJS.Timeout | null = null
  private hashRun = 0
  private hashed = false
  private loginRun = 0
  private pulling: Promise<void> | null = null
  private stopped = false
  private avatarRevision = 0

  private emit: (status: AccountStatus) => void = () => {}

  constructor(
    private readonly baseUrl: string,
    dataDir: string,
    private readonly library: Library,
    private readonly client: ClientInfo,
  ) {
    this.db = new AccountDb(join(dataDir, 'account.sqlite'))
    this.token = this.db.meta('token')
    if (this.token) this.status = { ...SIGNED_OUT, state: 'in', syncedAt: Number(this.db.meta('syncedAt')) || null }
  }

  get(): AccountStatus {
    return this.status
  }

  setEmitter(emit: (status: AccountStatus) => void) {
    this.emit = emit
  }

  sessionToken(): string | null {
    return this.token
  }

  get url(): string {
    return this.baseUrl
  }

  apply(settings: Settings) {
    this.setUsageStats(settings.account.usageStats)
    const sync = settings.account.sync
    if (sync === this.sync) return
    this.sync = sync
    this.hashed = false
    if (sync) void this.pull()
    else this.stopHashing()
  }

  start(settings: Settings) {
    this.sync = settings.account.sync
    this.usageStats = settings.account.usageStats
    if (this.token) void this.refresh()
    this.refreshTimer = setInterval(() => {
      if (this.token) void this.refresh()
    }, ACCOUNT_REFRESH_MS)
    if (this.usageStats) this.schedulePing(USAGE_FIRST_MS)
  }

  stop() {
    this.stopped = true
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.usageTimer) clearTimeout(this.usageTimer)
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.stopHashing()
    this.db.close()
  }

  private set(status: AccountStatus) {
    this.status = status
    this.emit(status)
  }

  async login(): Promise<void> {
    if (this.status.state === 'signingIn') return
    const run = ++this.loginRun
    this.set({ ...SIGNED_OUT, state: 'signingIn' })
    try {
      const start = await this.request<{ attempt: string; secret: string; url: string }>('POST', '/auth/start', undefined, 'none')
      await shell.openExternal(start.url)
      const until = Date.now() + LOGIN_TIMEOUT_MS
      while (Date.now() < until && run === this.loginRun) {
        await new Promise((r) => setTimeout(r, LOGIN_POLL_MS))
        if (run !== this.loginRun) return
        const poll = await this.request<Poll>('POST', '/auth/poll', { attempt: start.attempt, secret: start.secret }, 'none').catch((e: unknown): Poll => {
          if (e instanceof ServerError && e.status === 429) return { status: 'pending' }
          throw e
        })
        if (poll.status === 'pending') continue
        if (poll.status === 'done' && poll.token) {
          this.setToken(poll.token)
          this.set({ ...SIGNED_OUT, state: 'in' })
          await this.refresh()
          return
        }
        this.set({ ...SIGNED_OUT, state: 'error', error: poll.status === 'cancelled' ? t('account.error.cancelled') : t('account.error.signInFailed') })
        return
      }
      if (run === this.loginRun) this.set({ ...SIGNED_OUT, state: 'error', error: t('account.error.timedOut') })
    } catch (e) {
      if (run === this.loginRun) this.set({ ...SIGNED_OUT, state: 'error', error: describe(e) })
    }
  }

  cancelLogin() {
    if (this.status.state !== 'signingIn') return
    this.loginRun++
    this.set(SIGNED_OUT)
  }

  async logout(): Promise<void> {
    const token = this.token
    this.setToken(null)
    this.set(SIGNED_OUT)
    if (token) await fetch(`${this.baseUrl}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
  }

  private setToken(token: string | null) {
    if (token === this.token) return
    this.token = token
    this.db.setMeta('token', token)
    this.db.clearSync()
    this.db.setMeta('since', null)
    this.db.setMeta('syncedAt', null)
    this.hashed = false
    this.stopHashing()
  }

  async refresh(checkSupporter = false): Promise<void> {
    if (!this.token) return
    const token = this.token
    const avatarRevision = this.avatarRevision
    try {
      const me = await this.request<MeJson>(checkSupporter ? 'POST' : 'GET', checkSupporter ? '/me/refresh' : '/me')
      const friends = await this.request<FriendLists>('GET', '/friends')
      if (token !== this.token) return
      const { stun, ...rest } = me
      if (avatarRevision !== this.avatarRevision) rest.avatarUrl = this.status.me?.avatarUrl
      this.set({ ...this.status, state: 'in', me: rest, friends, stun, error: undefined })
      await this.pull()
    } catch (e) {
      if (token !== this.token) return
      if (e instanceof ServerError && e.status === 401) return this.sessionLost()
      this.set({ ...this.status, state: 'error', error: describe(e) })
    }
  }

  private sessionLost() {
    this.setToken(null)
    this.set({ ...SIGNED_OUT, state: 'error', error: t('account.error.signedOut') })
  }

  async setName(name: string): Promise<void> {
    const token = this.token
    const me = await this.request<MeJson>('PATCH', '/me', { name })
    if (token !== this.token || !this.status.me) return
    this.set({ ...this.status, me: { ...this.status.me, name: me.name } })
  }

  async setAvatar(userId: string, png: string | null): Promise<void> {
    const token = this.token
    if (!token || this.status.me?.id !== userId) throw new Error(t('account.error.changed'))
    let photo: Buffer | undefined
    if (png !== null) {
      if (typeof png !== 'string' || png.length > 2_666_668 || !/^[A-Za-z0-9+/]+={0,2}$/.test(png)) throw new Error(t('account.error.invalidPhoto'))
      photo = Buffer.from(png, 'base64')
      if (photo.length === 0 || photo.length > 2_000_000) throw new Error(t('settings.profile.photo.tooLarge'))
    }
    const me = await this.request<MeJson>(photo ? 'PUT' : 'DELETE', '/me/avatar', photo)
    if (token !== this.token || this.status.me?.id !== userId) return
    this.avatarRevision++
    this.set({ ...this.status, me: { ...this.status.me, avatarUrl: me.avatarUrl } })
  }

  async friends(): Promise<void> {
    const friends = await this.request<FriendLists>('GET', '/friends')
    this.set({ ...this.status, friends })
  }

  async addFriend(code: string): Promise<void> {
    const result = await this.request<FriendLists & { status: string }>('POST', '/friends/request', { code })
    this.set({ ...this.status, friends: { friends: result.friends, incoming: result.incoming, outgoing: result.outgoing } })
  }

  async acceptFriend(id: string): Promise<void> {
    this.set({ ...this.status, friends: await this.request<FriendLists>('POST', '/friends/accept', { id }) })
  }

  async removeFriend(id: string): Promise<void> {
    this.set({ ...this.status, friends: await this.request<FriendLists>('DELETE', `/friends/${encodeURIComponent(id)}`) })
  }

  async hash(path: string): Promise<string | null> {
    if (isUrl(path)) return null
    const stamp = await fileStamp(path)
    if (!stamp) return null
    const cached = this.db.hash(path, stamp)
    if (cached) return cached
    const hash = await contentHash(path)
    if (hash) this.db.setHash(path, stamp, hash)
    return hash
  }

  async pathForHash(hash: string): Promise<string | null> {
    if (!isContentHash(hash)) return null
    for (const path of this.db.pathsForHash(hash)) {
      const stamp = await fileStamp(path)
      if (stamp && this.db.hash(path, stamp) === hash) return path
    }
    return null
  }

  private startHashing() {
    if (this.hashTimer || this.stopped) return
    const run = ++this.hashRun
    const queue: string[] = []
    let offset = 0
    let done = false
    const fill = () => {
      if (queue.length === 0 && !done) {
        const ids = this.library.queryIds({ section: 'all', sort: 'added', desc: true, filters: {}, limit: HASH_BATCH, offset })
        offset += ids.length
        done = ids.length < HASH_BATCH
        for (const id of ids) {
          const path = this.library.media(id)?.path
          if (path && !isUrl(path) && !this.db.hasHash(path)) queue.push(path)
        }
      }
    }
    const step = () => {
      if (run !== this.hashRun) return
      fill()
      const path = queue.shift()
      if (!path) {
        this.hashTimer = done ? null : setTimeout(step, HASH_PACE_MS)
        return
      }
      void this.hash(path)
        .catch(() => undefined)
        .finally(() => {
          if (run === this.hashRun) this.hashTimer = setTimeout(step, HASH_PACE_MS)
        })
    }
    this.hashTimer = setTimeout(step, HASH_PACE_MS)
  }

  private stopHashing() {
    this.hashRun++
    if (this.hashTimer) clearTimeout(this.hashTimer)
    this.hashTimer = null
  }

  private get syncing(): boolean {
    return this.token !== null && this.sync
  }

  onVideoSet(path: string, settings: PerVideoSettings) {
    if (!this.syncing || isUrl(path)) return
    void this.hash(path)
      .then((hash) => {
        if (!hash) return
        this.db.putLocal({ hash, updatedAt: Date.now(), payload: syncPayload(settings) })
        this.schedulePush()
      })
      .catch(() => undefined)
  }

  async mergeVideo(path: string, local: PerVideoSettings | null): Promise<PerVideoSettings | null> {
    if (!this.syncing || isUrl(path)) return local
    const hash = await this.hash(path)
    if (!hash) return local
    const row = this.db.synced(hash)
    if (!row || row.updatedAt <= row.appliedAt) return local
    this.library.setVideoSettings(path, mergeSynced(local, row.payload))
    this.db.markApplied(hash, row.updatedAt)
    return this.library.videoSettings(path)
  }

  private schedulePush() {
    this.pushTimer ??= setTimeout(() => void this.push(), PUSH_DELAY_MS)
  }

  private async push(): Promise<void> {
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    if (!this.syncing) return
    const rows = this.db.pending(200)
    if (rows.length === 0) return
    const batch: SyncRow[] = []
    let bytes = 0
    for (const row of rows) {
      bytes += JSON.stringify(row).length
      if (batch.length > 0 && bytes > PUSH_BYTES) break
      batch.push(row)
    }
    const rejected = (e: unknown) => e instanceof ServerError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429
    try {
      await this.request('PUT', '/sync/videos', { videos: batch })
      this.db.clearPending(batch)
    } catch (e) {
      if (e instanceof ServerError && e.status === 401) return this.sessionLost()
      if (!rejected(e)) return
      for (const row of batch) {
        try {
          await this.request('PUT', '/sync/videos', { videos: [row] })
          this.db.clearPending([row])
        } catch (single) {
          if (rejected(single)) this.db.clearPending([row])
          else return
        }
      }
    }
    if (this.db.pending(1).length > 0) this.schedulePush()
  }

  private pull(): Promise<void> {
    this.pulling ??= this.doPull().finally(() => {
      this.pulling = null
    })
    return this.pulling
  }

  private async doPull(): Promise<void> {
    if (!this.syncing) return
    try {
      let since = Number(this.db.meta('since')) || 0
      for (let page = 0; page < 20; page++) {
        const res = await this.request<{ videos: SyncRow[]; next: number; more: boolean }>('GET', `/sync/videos?since=${since}`)
        for (const row of res.videos) {
          if (this.db.takeSynced(row)) await this.applySynced(row.hash)
        }
        since = res.next
        this.db.setMeta('since', String(since))
        if (!res.more) break
      }
      this.db.setMeta('syncedAt', String(Date.now()))
      this.set({ ...this.status, syncedAt: Date.now() })
      await this.push()
      if (!this.hashed) {
        this.hashed = true
        this.startHashing()
      }
    } catch (e) {
      if (e instanceof ServerError && e.status === 401) this.sessionLost()
    }
  }

  private async applySynced(hash: string) {
    const row = this.db.synced(hash)
    if (!row) return
    for (const path of this.db.pathsForHash(hash)) {
      const stamp = await fileStamp(path)
      if (!stamp || this.db.hash(path, stamp) !== hash) continue
      this.library.setVideoSettings(path, mergeSynced(this.library.videoSettings(path), row.payload))
    }
    this.db.markApplied(hash, row.updatedAt)
  }

  track(feature: string) {
    if (!this.usageStats || !isFeatureName(feature)) return
    this.db.bumpUsage(feature)
  }

  private setUsageStats(on: boolean) {
    if (on === this.usageStats) return
    this.usageStats = on
    this.usageRun++
    if (this.usageTimer) clearTimeout(this.usageTimer)
    this.usageTimer = null
    if (on) this.schedulePing(USAGE_FIRST_MS)
    else {
      this.db.dropUsage()
      this.db.setMeta('install', null)
    }
  }

  private schedulePing(ms: number) {
    if (this.usageTimer) clearTimeout(this.usageTimer)
    this.usageTimer = setTimeout(() => void this.ping(), ms)
  }

  private installId(): string {
    let id = this.db.meta('install')
    if (!id) {
      id = randomUUID()
      this.db.setMeta('install', id)
    }
    return id
  }

  private async ping(): Promise<void> {
    this.usageTimer = null
    if (!this.usageStats || this.stopped) return
    const run = this.usageRun
    const features = this.db.usage()
    const ping: UsagePing = { install: this.installId(), os: this.client.os, arch: this.client.arch, version: this.client.version, features }
    try {
      await this.request('POST', '/usage', ping, 'optional')
      if (run === this.usageRun) this.db.clearUsage(features)
    } catch (e) {
      if (run === this.usageRun && e instanceof ServerError && e.status >= 400 && e.status < 500 && e.status !== 429) this.db.clearUsage(features)
    }
    if (run === this.usageRun && this.usageStats && !this.stopped) this.schedulePing(USAGE_EVERY_MS)
  }

  adminStats(days: number): Promise<AdminStats> {
    return this.request<AdminStats>('GET', `/admin/stats?days=${Math.round(days)}`)
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown, auth: 'required' | 'optional' | 'none' = 'required'): Promise<T> {
    if (auth === 'required' && !this.token) throw new ServerError(401, 'unauthorized', t('account.error.notSignedIn'))
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = Buffer.isBuffer(body) ? 'image/png' : 'application/json'
    if (auth !== 'none' && this.token) headers.Authorization = `Bearer ${this.token}`
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: AbortSignal.timeout(Buffer.isBuffer(body) || path === '/me/avatar' ? 45_000 : 15_000) })
    } catch (e) {
      throw new ServerError(0, 'unreachable', t('account.error.unreachable', { host: new URL(this.baseUrl).host }))
    }
    const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    if (!res.ok) throw new ServerError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? t('account.error.serverStatus', { status: res.status }))
    return json as T
  }
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
