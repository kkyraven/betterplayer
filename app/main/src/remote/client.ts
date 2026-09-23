import { t } from '../i18n'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { get as httpGet, type IncomingMessage } from 'node:http'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { net } from 'electron'
import type { IpcEvents } from '@shared/ipc'
import { basicAuth, IDLE_PLAYING, mediaIdFromUrl, sourceBase, type ForwardedChannel, type PlayingState, type RemoteSourceStatus, type ScriptSet } from '@shared/peer'
import type { Settings } from '@shared/settings'

const RETRY_MS = 3000
const CALL_TIMEOUT_MS = 15_000

type Emit = <E extends 'remote:source' | 'remote:playing' | 'library:changed' | 'library:progress'>(event: E, payload: IpcEvents[E]) => void

type CacheIndex = Record<string, { size: number; mtime: number }>

const isFileName = (name: string) => name !== '' && name !== '.' && name !== '..' && !name.includes('\0') && basename(name) === name && name !== 'index.json'

export class RemoteClient {
  private source = ''
  private base = ''
  private password = ''
  private connected = false
  private error: string | null = null
  private stream: IncomingMessage | null = null
  private retry: NodeJS.Timeout | null = null
  private emit: Emit = () => {}
  playing: PlayingState = IDLE_PLAYING

  constructor(private readonly cacheDir: string) {}

  setEmitter(emit: Emit) {
    this.emit = emit
  }

  get active(): boolean {
    return this.source !== ''
  }

  status(): RemoteSourceStatus {
    return { source: this.source, connected: this.connected, error: this.error }
  }

  apply(settings: Settings) {
    const { source, sourcePassword } = settings.remote
    if (source === this.source && sourcePassword === this.password) return
    this.disconnect()
    this.playing = IDLE_PLAYING
    this.source = source
    this.password = sourcePassword
    this.base = source ? sourceBase(source) : ''
    this.emit('remote:source', this.status())
    if (source) this.connect()
  }

  stop() {
    this.disconnect()
  }

  private headers(): Record<string, string> {
    return this.password ? { Authorization: basicAuth(this.password) } : {}
  }

  async call(channel: ForwardedChannel, args: unknown[]): Promise<unknown> {
    const res = await fetch(`${this.base}/api/${channel}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers() },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(t('settings.source.requestFailed', { channel, status: res.status, source: this.source }))
    const body = (await res.json()) as { result: unknown }
    return body.result
  }

  async thumb(url: string, range: string | null = null, signal?: AbortSignal): Promise<Response> {
    const { hostname, pathname } = new URL(url)
    if (hostname === 'preview') {
      const id = Number(pathname.slice(1))
      if (!Number.isSafeInteger(id) || id <= 0) return new Response(null, { status: 404 })
      try {
        return await net.fetch(`${this.base}/preview/${id}`, { headers: { ...this.headers(), ...(range ? { Range: range } : {}) }, signal })
      } catch {
        return new Response(null, { status: 404 })
      }
    }
    const kind = hostname === 'media' ? 'thumb' : hostname === 'strip' ? 'strip' : null
    const id = Number(pathname.slice(1))
    if (!kind || !Number.isInteger(id)) return new Response(null, { status: 404 })
    try {
      const res = await net.fetch(`${this.base}/${kind}/${id}`, { headers: this.headers() })
      if (!res.ok) return new Response(null, { status: 404 })
      return new Response(res.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } })
    } catch {
      return new Response(null, { status: 404 })
    }
  }

  async scripts(url: string): Promise<string | null> {
    const id = mediaIdFromUrl(url)
    if (id === null || !this.active) return null
    let set: ScriptSet
    try {
      const res = await fetch(`${this.base}/scripts/${id}`, { headers: this.headers(), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
      if (!res.ok) return null
      set = (await res.json()) as ScriptSet
    } catch {
      return null
    }
    const files = set.files.filter((f) => isFileName(f.name))
    if (files.length === 0 || !isFileName(set.media)) return null
    const dir = join(this.cacheDir, this.source.replace(/[^\w.-]/g, '_'), String(id))
    await mkdir(dir, { recursive: true })
    const indexFile = join(dir, 'index.json')
    const index = await readFile(indexFile, 'utf8')
      .then((text) => JSON.parse(text) as CacheIndex)
      .catch((): CacheIndex => ({}))
    const next: CacheIndex = {}
    for (const file of files) {
      const cached = index[file.name]
      if (!cached || cached.size !== file.size || cached.mtime !== file.mtime) {
        const res = await fetch(`${this.base}/scripts/${id}/${encodeURIComponent(file.name)}`, { headers: this.headers(), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
        if (!res.ok || !res.body) continue
        await pipeline(res.body, createWriteStream(join(dir, file.name)))
      }
      next[file.name] = { size: file.size, mtime: file.mtime }
    }
    await writeFile(indexFile, JSON.stringify(next))
    return join(dir, set.media)
  }

  private connect() {
    const base = this.base
    const req = httpGet(`${base}/events`, { headers: this.headers() }, (res) => {
      if (this.base !== base) {
        res.destroy()
        return
      }
      if (res.statusCode !== 200) {
        res.destroy()
        this.dropped(res.statusCode === 401 ? (this.password ? t('settings.source.wrongPassword') : t('settings.source.passwordRequired')) : res.statusCode === undefined ? t('settings.source.noResponse') : t('settings.source.responseStatus', { status: res.statusCode }))
        return
      }
      this.stream = res
      this.connected = true
      this.error = null
      this.emit('remote:source', this.status())
      let event = ''
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('data: ')) this.receive(event, line.slice(6))
          nl = buffer.indexOf('\n')
        }
      })
      res.on('close', () => {
        if (this.stream === res) this.dropped(t('settings.source.connectionClosed'))
      })
    })
    req.on('error', (e) => {
      if (this.base === base) this.dropped(e.message)
    })
  }

  private receive(event: string, data: string) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      return
    }
    if (event === 'playing') {
      this.playing = payload as PlayingState
      this.emit('remote:playing', this.playing)
    }
    else if (event === 'library:changed') this.emit('library:changed', payload as IpcEvents['library:changed'])
    else if (event === 'library:progress') this.emit('library:progress', payload as IpcEvents['library:progress'])
  }

  private dropped(error: string) {
    const wasConnected = this.connected
    this.stream = null
    this.connected = false
    this.error = error
    this.emit('remote:source', this.status())
    this.playing = IDLE_PLAYING
    if (wasConnected) this.emit('remote:playing', IDLE_PLAYING)
    if (this.retry) clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.active) this.connect()
    }, RETRY_MS)
  }

  private disconnect() {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const stream = this.stream
    this.stream = null
    stream?.destroy()
    this.connected = false
    this.error = null
  }
}
