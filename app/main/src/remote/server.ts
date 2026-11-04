import type { Socket } from 'node:dgram'
import { Readable } from 'node:stream'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { isAxisId } from '@shared/axes'
import type { IpcEvent, IpcEvents, RemoteStatus } from '@shared/ipc'
import { QUEST_ANSWER_MS, QUEST_DISCOVERY_PORT, type QuestBeacon, type QuestCensor, type QuestConnectResult, type QuestPassthrough, type QuestSampled, type QuestToys } from '@shared/quest'
import { readPassthrough, type ResolvedPassthrough } from '@shared/passthrough'
import type { MediaDetail, MediaRow } from '@shared/library'
import type { ResolvedProjection } from '@shared/projection'
import { isUrl } from '@shared/remote'
import { IDLE_PLAYING, isForwarded, type ForwardedChannel, type PlayingState } from '@shared/peer'
import { REMOTE_PORT_DEFAULT, type Settings } from '@shared/settings'
import type { Library } from '../library'
import { deoIndex, deoScene } from './deovr'
import { hereSphereIndex, hereSphereScene, readWrite, type HereSphereWrite } from './heresphere'
import { t } from '../i18n'
import { readPerVideo } from '../settings/store'
import { authorised } from './auth'
import { answerProbes, invite } from './discovery'
import { firewallBlocks } from './firewall'
import { QuestPairing, readPairRequest } from './pairing'
import { inbound, outbound, permitted } from './paths'
import { servePortal } from './portal'
import { vpnName } from './vpn'
import { peerHost, questBeacon, questScene, readHello, readPosition, readSample, readToyCommand, resumePosition } from './quest'

export type RemoteApi = (channel: ForwardedChannel, args: unknown[]) => Promise<unknown>

export type HeadsetEvent = 'headset:hello' | 'headset:bye' | 'headset:stop' | 'headset:toys' | 'headset:play'
export type HeadsetEmit = <E extends HeadsetEvent>(event: E, data: IpcEvents[E]) => void

type StreamEvent = { event: 'playing'; data: PlayingState } | { event: 'library:changed'; data: IpcEvents['library:changed'] } | { event: 'library:progress'; data: IpcEvents['library:progress'] }

const HEARTBEAT_MS = 15_000

const QUEST_KEY_WAIT_MS = 2_000

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

const UPSTREAM_ANSWER_MS = 30_000

const UPSTREAM_HEADERS = ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']

const CLIENT_GONE = 499

const OWN_CLIENTS = /^(node|undici|libmpv|mpv|BetterPlayer)\b/i

function headerFields(list: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const pair of list.split(',')) {
    const at = pair.indexOf(':')
    if (at > 0) fields[pair.slice(0, at).trim()] = pair.slice(at + 1).trim()
  }
  return fields
}

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

  const stream = createReadStream(path, { start, end, highWaterMark: 1 << 20 })
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
  private headset: HeadsetEmit = () => {}
  private discovery: Socket | null = null
  private serving = false
  private api: RemoteApi | null = null
  private playing: PlayingState = IDLE_PLAYING
  private toys: QuestToys = { outputs: [], video: null, estim: [] }
  private toysHost: string | null = null
  private vrFreeMs: () => number | undefined = () => undefined
  private readonly streams = new Set<ServerResponse>()
  private heartbeat: NodeJS.Timeout | null = null
  private masks: string | null = null
  private censorTracks: string | null = null
  private censor: QuestCensor | null | undefined = undefined
  private readonly players = new Map<string, 'deovr' | 'heresphere'>()

  constructor(
    private readonly library: Library,
    private readonly forcedPort?: number,
    readonly pairing = new QuestPairing(),
  ) {}

  setEmitter(emit: (status: RemoteStatus) => void) {
    this.emit = emit
  }

  setHeadsetEmitter(emit: HeadsetEmit) {
    this.headset = emit
  }

  setToys(toys: QuestToys, host: string | null) {
    this.toys = toys
    this.toysHost = host
  }

  setVrLimit(limit: () => number | undefined) {
    this.vrFreeMs = limit
  }

  setApi(api: RemoteApi) {
    this.api = api
  }

  setMasks(dir: string) {
    this.masks = dir
  }

  setCensorTracks(dir: string) {
    this.censorTracks = dir
  }

  setCensor(look: QuestCensor | null) {
    this.censor = look
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
    this.serving = this.forcedPort !== undefined || settings.remote.enabled
    const port = this.forcedPort ?? settings.remote.port
    if (this.server !== null && port === this.port) return
    this.stop()
    this.port = port
    this.listen(port)
  }

  stop() {
    const server = this.server
    this.server = null
    this.pairing.endRequests()
    this.discovery?.close()
    this.discovery = null
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
    server.keepAliveTimeout = 65_000
    server.headersTimeout = 66_000
    server.on('error', (e) => {
      process.stderr.write(`remote server on ${port}: ${String(e)}\n`)
      this.server = null
      this.discovery?.close()
      this.discovery = null
      this.emit(this.status())
    })
    server.listen(port, '0.0.0.0', () => this.emit(this.status()))
    this.server = server
    this.discovery = answerProbes(port, (probe, host, from) => {
      this.pairing.heard(probe, host, from)
      return this.beacon(this.pairing.isPaired(probe.id))
    })
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

  private questPassthrough(req: IncomingMessage, row: MediaRow, passthrough: ResolvedPassthrough): QuestPassthrough {
    return passthrough.mode === 'ai' && this.masks ? { ...passthrough, maskBase: `${this.base(req)}/quest/mask/${row.id}` } : passthrough
  }

  private projection(row: MediaRow): Promise<ResolvedProjection> {
    return this.library.projection(row.path)
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      this.log(req, 405)
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const path = new URL(req.url ?? '/', 'http://library').pathname
    const [head, second, third, fourth] = path.split('/').filter(Boolean)
    const open = head === 'quest' && (second === 'info' || second === 'pair') && third === undefined
    const headset = this.pairing.headsetFor(req.headers.authorization)
    if (headset) this.pairing.used(headset, peerHost(req.socket.remoteAddress))
    if (!open && !headset && !(this.serving && authorised(req.headers.authorization, this.password))) {
      this.log(req, 401)
      res.writeHead(401, { ...(this.serving ? { 'WWW-Authenticate': 'Basic realm="Better Player"' } : {}), 'Content-Type': 'application/json' })
      res.end('{"error":"password required"}')
      return
    }
    const status = await this.dispatch(req, res, head, second, third, fourth)
    if (status >= 400 && status !== CLIENT_GONE) this.log(req, status)
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, head: string | undefined, second: string | undefined, third: string | undefined, fourth: string | undefined): Promise<number> {
    if (head === undefined) {
      if (req.method === 'POST' || req.headers['heresphere-json-version'] !== undefined) {
        this.players.set(peerHost(req.socket.remoteAddress), 'heresphere')
        return this.hereSphereIndex(req, res)
      }
      this.players.set(peerHost(req.socket.remoteAddress), 'deovr')
      return sendJson(res, 200, deoIndex(this.library.index('all'), this.base(req)))
    }
    if (head === 'deovr') {
      this.players.set(peerHost(req.socket.remoteAddress), 'deovr')
      const row = this.row(second)
      if (!row) return sendJson(res, 404, { error: 'not found' })
      return sendJson(res, 200, deoScene(row, (await this.projection(row)).projection, this.base(req)))
    }
    if (head === 'heresphere') {
      this.players.set(peerHost(req.socket.remoteAddress), 'heresphere')
      if (second === undefined) return this.hereSphereIndex(req, res)
      return this.hereSphereScene(req, res, second)
    }
    if (head === 'media') {
      const row = this.row(second)
      if (!row) return sendJson(res, 404, { error: 'not found' })
      this.played(req, row)
      return isUrl(row.path) ? this.proxy(req, res, row.path) : serveFile(req, res, row.path, contentType(row.path))
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
      if (head === 'strip') return serveFile(req, res, this.library.stripFile(n), 'image/jpeg')
      const poster = await this.library.poster(n)
      return serveFile(req, res, poster.file, poster.type)
    }
    if (head === 'portal') return servePortal(this.library, req, res, second)
    if (head === 'script') return this.script(req, res, second, third)
    if (head === 'scripts') return this.scripts(req, res, second, third)
    if (head === 'api') return this.call(req, res, second)
    if (head === 'events') return this.stream(req, res)
    if (head === 'quest') return this.quest(req, res, second, third, fourth)
    return sendJson(res, 404, { error: 'not found' })
  }

  private beacon(paired: boolean): QuestBeacon {
    const vrFreeMs = this.vrFreeMs()
    return { ...questBeacon(this.pairing.id, this.port, paired), ...(vrFreeMs === undefined ? {} : { vrFreeMs }) }
  }

  async connect(id: string): Promise<QuestConnectResult> {
    if (this.invite({ id }) && (await this.pairing.answer(id, QUEST_ANSWER_MS))) return { answered: true }
    return { answered: false, firewall: await firewallBlocks(), vpn: vpnName() }
  }

  invite(target: { id: string } | { address: string }): boolean {
    if (!this.discovery) return false
    if ('id' in target) {
      const to = this.pairing.address(target.id)
      if (!to) return false
      invite(this.discovery, this.beacon(this.pairing.isPaired(target.id)), to.host, to.port)
      return true
    }
    const m = /^\s*\[?([^\]\s]+?)\]?(?::(\d{1,5}))?\s*$/.exec(target.address)
    if (!m?.[1]) return false
    invite(this.discovery, this.beacon(false), m[1], m[2] ? Number(m[2]) : QUEST_DISCOVERY_PORT)
    return true
  }

  private async quest(req: IncomingMessage, res: ServerResponse, name: string | undefined, id: string | undefined, action: string | undefined): Promise<number> {
    if (name === 'info' && id === undefined) {
      const query = new URL(req.url ?? '/', 'http://library').searchParams
      const headset = query.get('headset') ?? ''
      const local = `${peerHost(req.socket.localAddress)}:${req.socket.localPort ?? this.port}`
      const proof = this.pairing.proof(headset, query.get('nonce')?.slice(0, 128) ?? '', local)
      if (headset) this.pairing.answered(headset)
      return sendJson(res, 200, { ...this.beacon(this.pairing.isPaired(headset)), ...(proof ? { proof } : {}) })
    }
    if (name === 'pair' && id === undefined) return this.pair(req, res)
    if (name === 'scene' && action === undefined) {
      const row = this.row(id)
      if (!row) return sendJson(res, 404, { error: 'not found' })
      const vrFreeMs = this.vrFreeMs()
      if (vrFreeMs !== undefined && row.durationMs > vrFreeMs) return sendJson(res, 402, { error: 'supporter', vrFreeMs })
      const settings = this.library.videoSettings(row.path)
      const [projection, passthrough] = await Promise.all([this.projection(row), this.library.passthrough(row.path, settings?.passthrough, QUEST_KEY_WAIT_MS)])
      return sendJson(res, 200, questScene(row, projection, settings?.position ?? 0, this.base(req), this.questPassthrough(req, row, passthrough)))
    }
    if (name === 'censor' && id === undefined && req.method !== 'POST') return this.censor === undefined ? sendJson(res, 503, { error: 'not ready' }) : sendJson(res, 200, this.censor)
    if ((name === 'mask' || name === 'censor') && action !== undefined && req.method !== 'POST') {
      const row = this.row(id)
      const root = name === 'mask' ? this.masks : this.censorTracks
      if (!row || !root || !(action === 'meta' || /^\d{1,6}$/.test(action))) return sendJson(res, 404, { error: 'not found' })
      const dir = join(root, String(row.id))
      return action === 'meta' ? serveFile(req, res, join(dir, 'meta.json'), 'application/json') : serveFile(req, res, join(dir, `${Number(action)}.z`), 'application/octet-stream')
    }
    if (name === 'toys' && id === undefined && req.method !== 'POST') {
      const followed = this.toysHost !== null && peerHost(req.socket.remoteAddress) === this.toysHost
      return sendJson(res, 200, followed ? this.toys : { ...this.toys, video: null, estim: [] })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    if (name === 'scene' && action === 'position') {
      const row = this.row(id)
      if (!row) return sendJson(res, 404, { error: 'not found' })
      const ms = readPosition(await readBody(req))
      if (ms === null) return sendJson(res, 400, { error: 'bad request' })
      if (!this.api) return sendJson(res, 503, { error: 'not ready' })
      const { position: _old, ...rest } = readPerVideo(await this.api('video:get', [row.path]))
      const position = resumePosition(ms, row.durationMs)
      await this.api('video:set', [row.path, position === undefined ? rest : { ...rest, position }])
      return sendJson(res, 200, {})
    }
    if (name === 'scene' && action === 'passthrough') {
      const row = this.row(id)
      if (!row) return sendJson(res, 404, { error: 'not found' })
      const passthrough = readPassthrough(await readBody(req))
      if (!passthrough) return sendJson(res, 400, { error: 'bad request' })
      if (!this.api) return sendJson(res, 503, { error: 'not ready' })
      await this.api('video:set', [row.path, { ...readPerVideo(await this.api('video:get', [row.path])), passthrough }])
      return sendJson(res, 200, this.questPassthrough(req, row, await this.library.passthrough(row.path, passthrough)))
    }
    if (name === 'scene' && action === 'sample') {
      const row = this.row(id)
      if (!row) return sendJson(res, 404, { error: 'not found' })
      const sample = readSample(await readBody(req))
      if (!sample) return sendJson(res, 400, { error: 'bad request' })
      const sampled: QuestSampled = { colour: await this.library.samplePassthrough(row.path, sample.timeSec, sample.u, sample.v) }
      return sendJson(res, 200, sampled)
    }
    const host = peerHost(req.socket.remoteAddress)
    if (name === 'hello' && id === undefined) {
      const hello = readHello(await readBody(req))
      if (!hello) return sendJson(res, 400, { error: 'bad request' })
      this.headset('headset:hello', { ...hello, host })
      return sendJson(res, 200, {})
    }
    if (name === 'bye' && id === undefined) {
      this.headset('headset:bye', { host })
      return sendJson(res, 200, {})
    }
    if (name === 'stop' && id === undefined) {
      this.headset('headset:stop', { host })
      return sendJson(res, 200, {})
    }
    if (name === 'toys' && id === undefined) {
      const command = readToyCommand(await readBody(req))
      if (!command) return sendJson(res, 400, { error: 'bad request' })
      this.headset('headset:toys', { ...command, host })
      return sendJson(res, 200, {})
    }
    return sendJson(res, 404, { error: 'not found' })
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<number> {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    const request = readPairRequest(await readBody(req))
    if (!request) return sendJson(res, 400, { error: 'bad request' })
    return new Promise<number>((done) => {
      const requestId = this.pairing.request(request, peerHost(req.socket.remoteAddress), (status, body) => {
        if (!res.destroyed) sendJson(res, status, body)
        done(status)
      })
      res.on('close', () => {
        if (!requestId || res.writableFinished) return
        this.pairing.cancel(requestId)
        done(CLIENT_GONE)
      })
    })
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

  private played(req: IncomingMessage, row: MediaDetail) {
    if (this.pairing.headsetFor(req.headers.authorization) || OWN_CLIENTS.test(req.headers['user-agent'] ?? '')) return
    const host = peerHost(req.socket.remoteAddress)
    const kind = req.headers['heresphere-json-version'] !== undefined ? 'heresphere' : this.players.get(host)
    const vrFreeMs = this.vrFreeMs()
    if (!kind || (vrFreeMs !== undefined && row.durationMs > vrFreeMs)) return
    this.headset('headset:play', { kind, host, mediaId: row.id })
  }

  private async proxy(req: IncomingMessage, res: ServerResponse, url: string): Promise<number> {
    const remote = this.library.remote(url)
    if (!remote) return sendJson(res, 404, { error: 'not found' })
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    const timer = setTimeout(() => controller.abort(), UPSTREAM_ANSWER_MS)
    let upstream: Response
    try {
      upstream = await fetch(url, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: { ...headerFields(remote.headers), ...(req.headers.range ? { Range: req.headers.range } : { 'Accept-Encoding': 'identity' }) },
        redirect: 'error',
        signal: controller.signal,
      })
    } catch {
      return res.destroyed ? CLIENT_GONE : sendJson(res, 502, { error: 'library server unreachable' })
    } finally {
      clearTimeout(timer)
    }
    if (res.destroyed) {
      await upstream.body?.cancel()
      return CLIENT_GONE
    }
    const headers: Record<string, string> = {}
    for (const name of UPSTREAM_HEADERS) {
      const value = upstream.headers.get(name)
      if (value) headers[name] = value
    }
    headers['Content-Type'] ??= contentType(new URL(url).pathname)
    res.writeHead(upstream.status, headers)
    if (!upstream.body || req.method === 'HEAD') {
      await upstream.body?.cancel()
      res.end()
      return upstream.status
    }
    const stream = Readable.from(upstream.body)
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
    return upstream.status
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
      const write = readWrite(await readBody(req), row)
      if (write) {
        this.write(row, write)
        row = this.library.media(row.id) ?? row
      }
    }
    return sendJson(res, 200, hereSphereScene(row, (await this.projection(row)).projection, this.base(req)))
  }

  private write(row: MediaDetail, write: HereSphereWrite) {
    if (write.rating !== undefined) {
      const rating = Math.max(0, Math.min(5, Math.round(write.rating)))
      if (rating !== row.rating) this.library.setRating(row.id, rating)
    }
    if (write.isFavorite !== undefined && write.isFavorite !== row.favourite) this.library.setFavourite([row.id], write.isFavorite)
    if (write.tags) this.library.setTags(row.id, write.tags)
    if (write.marks) this.library.setHeadsetMarks(row.id, write.marks)
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
