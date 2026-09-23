import { Readable } from 'node:stream'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { isAxisId } from '@shared/axes'
import type { IpcEvent, IpcEvents, RemoteStatus } from '@shared/ipc'
import type { MediaDetail, MediaRow } from '@shared/library'
import { detectProjection, type Projection } from '@shared/projection'
import { isUrl } from '@shared/remote'
import { IDLE_PLAYING, isForwarded, type ForwardedChannel, type PlayingState } from '@shared/peer'
import { REMOTE_PORT_DEFAULT, type Settings } from '@shared/settings'
import type { Library } from '../library'
import { deoIndex, deoScene } from './deovr'
import { hereSphereIndex, hereSphereScene, readWrite, type HereSphereWrite } from './heresphere'
import { t } from '../i18n'
import { authorised } from './auth'
import { inbound, outbound, permitted } from './paths'

export type RemoteApi = (channel: ForwardedChannel, args: unknown[]) => Promise<unknown>

type StreamEvent = { event: 'playing'; data: PlayingState } | { event: 'library:changed'; data: IpcEvents['library:changed'] } | { event: 'library:progress'; data: IpcEvents['library:progress'] }

const HEARTBEAT_MS = 15_000

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  mk3d: 'video/x-matroska',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  divx: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  asf: 'video/x-ms-asf',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  m2v: 'video/mpeg',
  vob: 'video/mpeg',
  flv: 'video/x-flv',
  f4v: 'video/x-f4v',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  ogv: 'video/ogg',
  ogm: 'video/ogg',
  mxf: 'application/mxf',
  dv: 'video/x-dv',
  rm: 'application/vnd.rn-realmedia',
  rmvb: 'application/vnd.rn-realmedia-vbr',
}

const BODY_LIMIT = 1_000_000

interface Range {
  start: number
  end: number
}

function contentType(path: string): string {
  return CONTENT_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'
}

function parseRange(header: string | undefined, size: number): Range | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart = '', rawEnd = ''] = match
  if (!rawStart && !rawEnd) return 'invalid'
  if (!rawStart) {
    const length = Number(rawEnd)
    return length > 0 && size > 0 ? { start: Math.max(0, size - length), end: size - 1 } : 'invalid'
  }
  const start = Number(rawStart)
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  return start > end || start >= size ? 'invalid' : { start, end }
}

function sendJson(res: ServerResponse, status: number, body: unknown): number {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
  return status
}

async function serveFile(req: IncomingMessage, res: ServerResponse, path: string, type: string): Promise<number> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return sendJson(res, 404, { error: 'not found' })

  const range = parseRange(req.headers.range, info.size)
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${info.size}`, 'Content-Length': '0' })
    res.end()
    return 416
  }

  const start = range ? range.start : 0
  const end = range ? range.end : Math.max(0, info.size - 1)
  const length = info.size === 0 ? 0 : end - start + 1
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(length) }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`
  const status = range ? 206 : 200
  res.writeHead(status, headers)
  if (req.method === 'HEAD' || length === 0) {
    res.end()
    return status
  }

  const stream = createReadStream(path, { start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
  return status
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > BODY_LIMIT) return null
    chunks.push(chunk)
  }
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

const VIRTUAL_RANGE = /^(169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

function lanUrls(port: number): string[] {
  const addresses: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) {
      if (address.family === 'IPv4' && !address.internal) addresses.push(address.address)
    }
  }
  addresses.sort((a, b) => Number(VIRTUAL_RANGE.test(a)) - Number(VIRTUAL_RANGE.test(b)))
  return addresses.map((a) => `http://${a}:${port}`)
}

export class RemoteServer {
  private server: Server | null = null
  private port = REMOTE_PORT_DEFAULT
  private password = ''
  private emit: (status: RemoteStatus) => void = () => {}
  private api: RemoteApi | null = null
  private playing: PlayingState = IDLE_PLAYING
  private readonly streams = new Set<ServerResponse>()
  private heartbeat: NodeJS.Timeout | null = null

  constructor(
    private readonly library: Library,
    private readonly forcedPort?: number,
  ) {}

  setEmitter(emit: (status: RemoteStatus) => void) {
    this.emit = emit
  }

  setApi(api: RemoteApi) {
    this.api = api
  }

  publish(state: PlayingState) {
    this.playing = state
    this.push({ event: 'playing', data: state })
  }

  broadcast<E extends IpcEvent>(event: E, data: IpcEvents[E]) {
    if (this.streams.size === 0 || (event !== 'library:changed' && event !== 'library:progress')) return
    this.push({ event, data } as StreamEvent)
  }

  private push(e: StreamEvent) {
    const text = `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`
    for (const res of this.streams) res.write(text)
  }

  status(): RemoteStatus {
    const running = this.server !== null && this.server.listening
    return { running, port: this.port, urls: running ? lanUrls(this.port) : [] }
  }

  apply(settings: Settings) {
    this.password = settings.remote.password
    const enabled = this.forcedPort !== undefined || settings.remote.enabled
    const port = this.forcedPort ?? settings.remote.port
    if (enabled === (this.server !== null) && port === this.port) return
    this.stop()
    this.port = port
    if (enabled) this.listen(port)
    else this.emit(this.status())
  }

  stop() {
    const server = this.server
    this.server = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const res of this.streams) res.end()
    this.streams.clear()
    if (!server) return
    server.closeAllConnections()
    server.close()
  }

  private listen(port: number) {
    const server = createServer((req, res) => {
      void this.route(req, res).catch((e: unknown) => {
        this.log(req, 500, String(e))
        if (!res.headersSent) sendJson(res, 500, { error: 'server error' })
        else res.destroy()
      })
    })
    server.on('error', (e) => {
      process.stderr.write(`remote server on ${port}: ${String(e)}\n`)
      this.server = null
      this.emit(this.status())
    })
    server.listen(port, '0.0.0.0', () => this.emit(this.status()))
    this.server = server
    this.heartbeat = setInterval(() => {
      for (const res of this.streams) res.write(':\n\n')
    }, HEARTBEAT_MS)
  }

  private log(req: IncomingMessage, status: number, detail = '') {
    process.stderr.write(`remote ${status} ${req.method ?? '?'} ${req.url ?? ''}${detail ? ` ${detail}` : ''}\n`)
  }

  private base(req: IncomingMessage): string {
    return `http://${req.headers.host ?? `127.0.0.1:${this.port}`}`
  }

  private projection(row: MediaRow): Projection {
    const override = this.library.videoSettings(row.path)?.projection
    if (override) return override
    return { ...detectProjection(row.title), kind: row.projection }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      this.log(req, 405)
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (!authorised(req.headers.authorization, this.password)) {
      this.log(req, 401)
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Better Player"', 'Content-Type': 'application/json' })
      res.end('{"error":"password required"}')
      return
    }
    const path = new URL(req.url ?? '/', 'http://library').pathname
    const [head, second, third] = path.split('/').filter(Boolean)
    const status = await this.dispatch(req, res, head, second, third)
    if (status >= 400) this.log(req, status)
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, head: string | undefined, second: string | undefined, third: string | undefined): Promise<number> {
    if (head === undefined) {
      if (req.method === 'POST' || req.headers['heresphere-json-version'] !== undefined) return this.hereSphereIndex(req, res)
      return sendJson(res, 200, deoIndex(this.library.index('all'), this.base(req)))
    }
    if (head === 'deovr') {
      const row = this.row(second)
      if (!row) return sendJson(res, 404, { error: 'not found' })
      return sendJson(res, 200, deoScene(row, this.projection(row), this.base(req)))
    }
    if (head === 'heresphere') {
      if (second === undefined) return this.hereSphereIndex(req, res)
      return this.hereSphereScene(req, res, second)
    }
    if (head === 'media') {
      const row = this.row(second)
      if (!row) return sendJson(res, 404, { error: 'not found' })
      if (isUrl(row.path)) {
        res.writeHead(302, { Location: row.path })
        res.end()
        return 302
      }
      return serveFile(req, res, row.path, contentType(row.path))
    }
    if (head === 'preview') {
      const id = Number(second)
      if (!Number.isSafeInteger(id) || id <= 0) return sendJson(res, 404, { error: 'not found' })
      const controller = new AbortController()
      res.on('close', () => controller.abort())
      const preview = await this.library.servePreview(id, req.headers.range ?? null, controller.signal)
      if (res.destroyed) { await preview.body?.cancel(); return preview.status }
      res.writeHead(preview.status, Object.fromEntries(preview.headers))
      if (!preview.body || req.method === 'HEAD') {
        await preview.body?.cancel()
        res.end()
      } else {
        const stream = Readable.from(preview.body)
        stream.on('error', () => res.destroy())
        res.on('close', () => stream.destroy())
        stream.pipe(res)
      }
      return preview.status
    }
    if (head === 'thumb' || head === 'strip') {
      const n = Number(second)
      if (!Number.isInteger(n)) return sendJson(res, 404, { error: 'not found' })
      return serveFile(req, res, head === 'thumb' ? this.library.posterFile(n) : this.library.stripFile(n), 'image/jpeg')
    }
    if (head === 'script') return this.script(req, res, second, third)
    if (head === 'scripts') return this.scripts(req, res, second, third)
    if (head === 'api') return this.call(req, res, second)
    if (head === 'events') return this.stream(req, res)
    return sendJson(res, 404, { error: 'not found' })
  }

  private async call(req: IncomingMessage, res: ServerResponse, channel: string | undefined): Promise<number> {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (channel === undefined || !isForwarded(channel)) return sendJson(res, 404, { error: 'not found' })
    if (!this.api) return sendJson(res, 503, { error: 'not ready' })
    const body = await readBody(req)
    const args = inbound(channel, Array.isArray(body) ? body : [], (id) => this.library.media(id)?.path ?? null)
    if (!permitted(channel, args, this.library.roots())) return sendJson(res, 403, { error: 'forbidden' })
    const result = outbound(channel, await this.api(channel, args), this.base(req))
    return sendJson(res, 200, { result: result ?? null })
  }

  private async scripts(req: IncomingMessage, res: ServerResponse, id: string | undefined, name: string | undefined): Promise<number> {
    const n = Number(id)
    const found = Number.isInteger(n) ? await this.library.scriptSet(n) : null
    if (!found) return sendJson(res, 404, { error: 'not found' })
    if (name === undefined) return sendJson(res, 200, found.set)
    const file = decodeURIComponent(name)
    if (!found.set.files.some((f) => f.name === file)) return sendJson(res, 404, { error: 'not found' })
    return serveFile(req, res, join(found.dir, file), file.toLowerCase().endsWith('.zip') ? 'application/zip' : 'application/json')
  }

  private stream(req: IncomingMessage, res: ServerResponse): number {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write(`event: playing\ndata: ${JSON.stringify(this.playing)}\n\n`)
    this.streams.add(res)
    req.on('close', () => this.streams.delete(res))
    return 200
  }

  private row(id: string | undefined): MediaDetail | null {
    const n = Number(id)
    return Number.isInteger(n) ? this.library.media(n) : null
  }

  private hereSphereIndex(req: IncomingMessage, res: ServerResponse): number {
    const sections = [
      { name: t('main.headset.all'), rows: this.library.index('all') },
      { name: t('main.headset.continue'), rows: this.library.index('continue') },
      ...this.library.tags().map(({ name }) => ({ name, rows: this.library.tagIndex(name) })),
    ]
    return sendJson(res, 200, hereSphereIndex(sections, this.base(req)))
  }

  private async hereSphereScene(req: IncomingMessage, res: ServerResponse, id: string | undefined): Promise<number> {
    let row = this.row(id)
    if (!row) return sendJson(res, 404, { error: 'not found' })
    if (req.method === 'POST') {
      const write = readWrite(await readBody(req))
      if (write) {
        this.write(row, write)
        row = this.library.media(row.id) ?? row
      }
    }
    return sendJson(res, 200, hereSphereScene(row, this.projection(row), this.base(req)))
  }

  private write(row: MediaDetail, write: HereSphereWrite) {
    if (write.rating !== undefined) {
      const rating = Math.max(0, Math.min(5, Math.round(write.rating)))
      if (rating !== row.rating) this.library.setRating(row.id, rating)
    }
    if (write.isFavorite !== undefined && write.isFavorite !== row.favourite) this.library.setFavourite([row.id], write.isFavorite)
    if (write.tags) this.library.setTags(row.id, write.tags)
  }

  private async script(req: IncomingMessage, res: ServerResponse, id: string | undefined, file: string | undefined): Promise<number> {
    const n = Number(id)
    const axis = file?.replace(/\.funscript$/i, '') ?? ''
    if (!Number.isInteger(n) || !isAxisId(axis)) return sendJson(res, 404, { error: 'not found' })
    const source = this.library.scriptFile(n, axis)
    if (!source) return sendJson(res, 404, { error: 'not found' })
    return serveFile(req, res, source, 'application/json')
  }
}
