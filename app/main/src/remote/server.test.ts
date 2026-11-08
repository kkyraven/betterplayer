import type { QuestDom } from '@shared/quest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcEvents } from '@shared/ipc'
import type { MediaDetail } from '@shared/library'
import { FLAT } from '@shared/projection'
import type { RemoteLoad } from '@shared/remote'
import type { Settings } from '@shared/settings'
import type { Library } from '../library'
import type { HereSphereScan, HereSphereScene } from './heresphere'
import { urlKey } from './auth'
import type { SpeechApi } from '../speech'
import { QuestStreams, type Encode } from './questStream'
import { RemoteServer } from './server'

vi.mock('electron', () => ({ app: {} }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))

const BYTES = 'abcdefghij'

const freePort = () =>
  new Promise<number>((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => done(typeof address === 'object' && address ? address.port : 0))
    })
  })

describe('/media', () => {
  let upstream: Server
  let seen: IncomingHttpHeaders[]
  let events: { event: keyof IpcEvents; data: unknown }[]
  let server: RemoteServer
  let base: string
  let row: MediaDetail

  beforeEach(async () => {
    seen = []
    events = []
    upstream = createHttpServer((req, res) => {
      seen.push(req.headers)
      if (req.url === '/moved') {
        res.writeHead(302, { Location: 'http://example.invalid/stream' })
        res.end()
        return
      }
      const [, start = '0', end = '9'] = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '') ?? []
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${BYTES.length}`, 'Accept-Ranges': 'bytes' })
      res.end(BYTES.slice(Number(start), Number(end) + 1))
    })
    const upstreamPort = await freePort()
    await new Promise<void>((done) => upstream.listen(upstreamPort, '127.0.0.1', done))
    row = { id: 7, path: `http://127.0.0.1:${upstreamPort}/scene/7/stream`, durationMs: 60_000 } as MediaDetail
    const library = {
      media: (id: number) => (id === row.id ? row : null),
      remote: (path: string): RemoteLoad | null => (path === row.path ? { scriptsPath: '', headers: 'ApiKey: k1' } : null),
      index: () => [],
    } as unknown as Library
    const port = await freePort()
    server = new RemoteServer(library, port)
    server.setHeadsetEmitter((event, data) => events.push({ event, data }))
    await new Promise<void>((done) => {
      server.setEmitter(() => done())
      server.apply({ remote: { password: 'pw' } } as Settings)
    })
    base = `http://127.0.0.1:${port}`
  })

  afterEach(() => {
    server.stop()
    upstream.close()
  })

  const auth = { Authorization: `Basic ${btoa('bp:pw')}` }
  const player = { ...auth, 'User-Agent': 'UnityPlayer/2022.3.20f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)' }

  it("streams a library server's row through with its own headers and the client's range", async () => {
    const res = await fetch(`${base}/media/7`, { headers: { ...auth, Range: 'bytes=2-5' }, redirect: 'manual' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(await res.text()).toBe('cdef')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ apikey: 'k1', range: 'bytes=2-5', 'accept-encoding': 'identity' })
    expect(seen[0]?.authorization).toBeUndefined()
    await (await fetch(`${base}/media/7`, { headers: auth })).text()
    expect(seen[1]?.['accept-encoding']).toBe('identity')
  })

  it('refuses a redirect, so the key never reaches another origin', async () => {
    row.path = row.path.replace('/scene/7/stream', '/moved')
    expect((await fetch(`${base}/media/7`, { headers: auth })).status).toBe(502)
    expect(seen).toHaveLength(1)
  })

  it('follows HereSphere by its header and DeoVR by its last request, past the free length too', async () => {
    await (await fetch(`${base}/media/7`, { headers: player })).text()
    expect(events).toEqual([])
    await (await fetch(`${base}/media/7`, { headers: { ...player, 'HereSphere-JSON-Version': '1' } })).text()
    await (await fetch(`${base}/deovr`, { headers: player })).text()
    await (await fetch(`${base}/media/7`, { headers: player })).text()
    expect(events).toEqual([
      { event: 'headset:play', data: { kind: 'heresphere', host: '127.0.0.1', mediaId: 7 } },
      { event: 'headset:play', data: { kind: 'deovr', host: '127.0.0.1', mediaId: 7 } },
    ])
    server.setVrLimit(() => 30_000)
    await (await fetch(`${base}/media/7`, { headers: player })).text()
    expect(events).toHaveLength(3)
  })

  it("never follows Better Player's own clients, as another desktop's HereSphere library server", async () => {
    for (const agent of ['node', 'libmpv', 'mpv 0.39.0', 'BetterPlayer']) {
      await (await fetch(`${base}/media/7`, { headers: { ...auth, 'HereSphere-JSON-Version': '1', 'User-Agent': agent } })).text()
    }
    expect(events).toEqual([])
  })
})

describe('HereSphere', () => {
  const agent = { 'User-Agent': 'UnityPlayer/2022.3.20f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)' }
  const signIn = (password = 'pw', extra: object = {}) => JSON.stringify({ username: 'someone', password, ...extra })
  const row = { id: 7, path: 'FILE', title: 'clip', addedAt: 0, durationMs: 60_000, rating: 0, favourite: false, width: 1920, height: 1080, size: 6, scripts: [], tags: [], marks: [] } as unknown as MediaDetail

  let server: RemoteServer
  let base: string
  let dir: string
  let port: number
  let events: { event: keyof IpcEvents; data: unknown }[]
  const setRating = vi.fn()
  const api = vi.fn(async () => ({ rows: [] }))

  const library = {
    media: (id: number) => (id === row.id ? row : null),
    index: () => [{ id: 7, title: 'clip', durationMs: 60_000 }],
    tags: () => [],
    tagIndex: () => [],
    scanRows: () => [{ id: 7, title: 'clip', durationMs: 60_000, addedAt: 0, rating: 0, favourite: false, tags: [] }],
    projection: async () => ({ projection: FLAT }),
    setRating,
    poster: async () => ({ file: row.path, type: 'image/jpeg' }),
  } as unknown as Library

  const apply = (password: string, enabled = true) => server.apply({ remote: { enabled, password, port } } as Settings)
  const key = () => urlKey('pw', server.pairing.id)

  beforeEach(async () => {
    setRating.mockClear()
    api.mockClear()
    events = []
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    dir = mkdtempSync(join(tmpdir(), 'bp-heresphere-'))
    row.path = join(dir, 'clip.mp4')
    writeFileSync(row.path, 'abcdef')
    port = await freePort()
    server = new RemoteServer(library)
    server.setApi(api)
    server.setHeadsetEmitter((event, data) => events.push({ event, data }))
    await new Promise<void>((done) => {
      server.setEmitter(() => done())
      apply('pw')
    })
    base = `http://127.0.0.1:${port}`
  })

  afterEach(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const post = (url: string, body?: string, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { ...agent, ...headers }, body })
  const get = (url: string) => fetch(url, { headers: agent })
  const index = async () => (await (await post(`${base}/heresphere`, signIn())).json()) as { access: number; library: { list: string[] }[] }
  const sceneUrl = async () => (await index()).library[0]?.list[0] ?? ''

  it('asks for the sign-in, then says when it failed', async () => {
    for (const res of [await get(`${base}/heresphere`), await post(`${base}/heresphere`), await post(`${base}/heresphere/7`)]) {
      expect(res.status).toBe(200)
      expect(res.headers.get('heresphere-json-version')).toBe('1')
      expect(await res.json()).toEqual({ access: 0, library: [] })
    }
    expect(await (await post(`${base}/heresphere`, signIn('nope'))).json()).toEqual({ access: -1, library: [] })
  })

  it('opens its library view from the bare address', async () => {
    const first = await get(base)
    expect(first.status).toBe(401)
    expect(first.headers.get('heresphere-json-version')).toBe('1')
    expect(await (await post(base)).json()).toEqual({ access: 0, library: [] })
    expect(((await (await post(base, signIn())).json()) as { access: number }).access).toBe(1)
  })

  it('signs in, then scans, opens and plays with plain GETs', async () => {
    const list = await index()
    expect(list.access).toBe(1)
    const url = list.library[0]?.list[0] ?? ''
    expect(url).toBe(`${base}/k/${key()}/heresphere/7`)
    const scene = await get(url)
    expect(scene.headers.get('heresphere-json-version')).toBe('1')
    const doc = (await scene.json()) as HereSphereScene
    expect(doc.access).toBe(1)
    const media = await fetch(doc.media[0]?.sources[0]?.url ?? '', { headers: { ...agent, Range: 'bytes=1-3' } })
    expect(media.status).toBe(206)
    expect(await media.text()).toBe('bcd')
    expect((await get(doc.thumbnailImage)).status).toBe(200)
    expect(events).toContainEqual({ event: 'headset:play', data: { kind: 'heresphere', host: '127.0.0.1', mediaId: 7 } })
  })

  it('scans at the address it was given and beside the root, with the links of the index', async () => {
    const url = await sceneUrl()
    for (const path of ['/heresphere/scan', '/scan']) {
      const res = await post(`${base}${path}`, signIn())
      expect(res.headers.get('heresphere-json-version')).toBe('1')
      expect(((await res.json()) as HereSphereScan).scanData[0]?.link).toBe(url)
    }
    expect(await (await post(`${base}/heresphere/scan`)).json()).toEqual({ access: 0, library: [] })
  })

  it('takes a write only with the sign-in, never on the key alone', async () => {
    const url = await sceneUrl()
    await post(url, JSON.stringify({ rating: 5 }))
    expect(setRating).not.toHaveBeenCalled()
    await post(url, signIn('pw', { rating: 5 }))
    expect(setRating).toHaveBeenCalledWith(7, 5)
  })

  it('reads nothing past a player with the key', async () => {
    for (const [method, path] of [['POST', '/api/library:setFavourite'], ['GET', '/events'], ['GET', '/quest/toys'], ['POST', '/quest/hello'], ['GET', '/scripts/7'], ['GET', '/strip/7'], ['GET', '/preview/7'], ['GET', '/']]) {
      expect((await fetch(`${base}/k/${key()}${path}`, { method, headers: agent, body: method === 'POST' ? '[]' : undefined })).status).toBe(401)
    }
    expect(api).not.toHaveBeenCalled()
  })

  it('refuses a made up key, and the old key once the password changes', async () => {
    expect((await get(`${base}/k/nope/media/7`)).status).toBe(401)
    const url = (await sceneUrl()).replace('heresphere/7', 'media/7')
    expect((await get(url)).status).toBe(200)
    apply('new')
    expect((await get(url)).status).toBe(401)
  })

  it('keeps the key out of the log', async () => {
    const log = vi.mocked(process.stderr.write)
    log.mockClear()
    await get(`${base}/k/${key()}/media/8`)
    await get(`${base}/k/${key()}/api`)
    await get(`${base}/K/${key()}/media/8`)
    await get(`${base}//k/${key()}/k/${key()}/api`)
    const lines = log.mock.calls.map(([line]) => String(line))
    expect(lines).toHaveLength(4)
    expect(lines.join('')).not.toContain(key())
  })

  it('gives a paired headset no key, so forgetting it ends its reading', async () => {
    const token = await new Promise<string>((done) => {
      const id = server.pairing.request({ id: 'quest-1', name: 'Quest', pin: '1234' }, '127.0.0.1', (_status, body) => done((body as { token: string }).token))
      if (id) server.pairing.pin(id, '1234')
    })
    const body = (await (await post(`${base}/heresphere`, undefined, { Authorization: `Bearer ${token}` })).json()) as { library: { list: string[] }[] }
    expect(body.library[0]?.list[0]).toBe(`${base}/heresphere/7`)
  })

  it('opens only its own routes with a posted password, and none while not serving', async () => {
    for (const path of ['/api/library:query', '/quest/hello', '/deovr/7', '/media/7']) expect((await post(`${base}${path}`, signIn())).status).toBe(401)
    expect(api).not.toHaveBeenCalled()
    apply('pw', false)
    expect((await post(`${base}/heresphere`, signIn())).status).toBe(401)
  })

  it('answers the next request on the connection after a body over the limit', async () => {
    expect(await (await post(`${base}/heresphere`, 'x'.repeat(1_200_000))).json()).toEqual({ access: 0, library: [] })
    const next = await fetch(`${base}/heresphere`, { headers: agent, signal: AbortSignal.timeout(2000) })
    expect(next.status).toBe(200)
  })

  it('answers nothing under the scan', async () => {
    expect((await post(`${base}/scan/x`, signIn())).status).toBe(401)
    expect((await fetch(`${base}/scan/x`, { headers: { ...agent, Authorization: `Basic ${btoa('bp:pw')}` } })).status).toBe(404)
  })

  it('gives Better Player itself URLs with no key, so a stored row outlives the password', async () => {
    const body = (await (await fetch(`${base}/heresphere`, { method: 'POST', body: signIn(), headers: { 'User-Agent': 'node' } })).json()) as { library: { list: string[] }[] }
    expect(body.library[0]?.list[0]).toBe(`${base}/heresphere/7`)
  })

  it('gives DeoVR keyed URLs too, as it fetches them the same way', async () => {
    const auth = { Authorization: `Basic ${btoa('bp:pw')}` }
    const res = await fetch(`${base}/deovr/7`, { headers: { ...agent, ...auth } })
    const doc = (await res.json()) as { encodings: { videoSources: { url: string }[] }[] }
    expect((await get(doc.encodings[0]?.videoSources[0]?.url ?? '')).status).toBe(200)
  })
})

describe('access', () => {
  const ROUTES: [method: string, path: string][] = [
    ['GET', '/'],
    ['POST', '/'],
    ['GET', '/heresphere'],
    ['POST', '/heresphere/1'],
    ['GET', '/deovr/1'],
    ['GET', '/media/1'],
    ['GET', '/preview/1'],
    ['GET', '/thumb/1'],
    ['GET', '/strip/1'],
    ['GET', '/portal/1'],
    ['GET', '/script/1/L0.funscript'],
    ['GET', '/scripts/1'],
    ['POST', '/api/library:query'],
    ['POST', '/api/library:setFavourite'],
    ['GET', '/events'],
    ['GET', '/quest/scene/1'],
    ['POST', '/quest/scene/1/position'],
    ['GET', '/quest/toys'],
    ['POST', '/quest/toys'],
    ['POST', '/quest/hello'],
    ['GET', '/quest/censor'],
    ['GET', '/quest/mask/1/meta'],
    ['GET', '/quest/info/x'],
    ['GET', '/quest/speech'],
    ['POST', '/quest/speech/model'],
    ['POST', '/quest/speech/s1?seq=0'],
    ['POST', '/quest/speech/s1/end'],
    ['DELETE', '/quest/speech/s1'],
    ['GET', '/quest/dom?since=-1'],
    ['POST', '/quest/dom'],
  ]
  const OPEN: [method: string, path: string][] = [
    ['GET', '/quest/info'],
    ['POST', '/quest/pair'],
  ]

  let server: RemoteServer
  let base: string
  let token: string
  const api = vi.fn(async () => ({ rows: [] }))
  const headsetEvents: unknown[] = []

  const library = {
    media: () => null,
    index: () => [],
    tags: () => [],
    tagIndex: () => [],
    roots: () => [],
    stripFile: () => '/nonexistent/strip.jpg',
    poster: async () => ({ file: '/nonexistent/poster.jpg', type: 'image/jpeg' }),
    portals: { still: async () => null },
    scriptSet: async () => null,
    scriptFile: () => null,
    servePreview: async () => new Response(null, { status: 404 }),
  } as unknown as Library

  const start = async (remote: { enabled: boolean; password: string }, forced = false) => {
    const port = await freePort()
    server = new RemoteServer(library, forced ? port : undefined)
    server.setApi(api)
    server.setHeadsetEmitter((_event, data) => headsetEvents.push(data))
    await new Promise<void>((done) => {
      server.setEmitter(() => done())
      server.apply({ remote: { ...remote, port } } as Settings)
    })
    base = `http://127.0.0.1:${port}`
    token = await new Promise<string>((done) => {
      const id = server.pairing.request({ id: 'quest-1', name: 'Quest', pin: '1234' }, '127.0.0.1', (_status, body) => done((body as { token: string }).token))
      if (id) server.pairing.pin(id, '1234')
    })
  }

  const status = async (method: string, path: string, authorization?: string) => {
    const res = await fetch(`${base}${path}`, { method, headers: authorization ? { Authorization: authorization } : {}, body: method === 'POST' ? '[]' : undefined })
    const body: unknown = res.headers.get('content-type') === 'application/json' ? await res.json() : await res.body?.cancel()
    const refused = typeof body === 'object' && body !== null && 'access' in body && body.access !== 1
    if (refused) expect(body).toEqual({ access: 0, library: [] })
    return { status: refused ? 401 : res.status, challenge: res.headers.get('www-authenticate') }
  }

  const credentials = () => ({
    none: undefined,
    wrong: `Basic ${btoa('bp:nope')}`,
    empty: `Basic ${btoa('bp:')}`,
    password: `Basic ${btoa('bp:pw')}`,
    token: `Bearer ${token}`,
    unknownToken: 'Bearer not-a-token',
  })

  beforeEach(() => {
    api.mockClear()
    headsetEvents.length = 0
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    server.stop()
    vi.restoreAllMocks()
  })

  const MODES: { name: string; remote: { enabled: boolean; password: string }; forced?: boolean; allowed: (keyof ReturnType<typeof credentials>)[] }[] = [
    { name: 'serving off, no password', remote: { enabled: false, password: '' }, allowed: ['token'] },
    { name: 'serving off, password set', remote: { enabled: false, password: 'pw' }, allowed: ['token'] },
    { name: 'serving on, no password', remote: { enabled: true, password: '' }, allowed: ['token'] },
    { name: 'serving on, password set', remote: { enabled: true, password: 'pw' }, allowed: ['token', 'password'] },
    { name: 'dev flag, no password', remote: { enabled: false, password: '' }, forced: true, allowed: ['token'] },
    { name: 'dev flag, password set', remote: { enabled: false, password: 'pw' }, forced: true, allowed: ['token', 'password'] },
  ]

  it.each(MODES)('$name', async ({ remote, forced, allowed }) => {
    await start(remote, forced)
    for (const [kind, authorization] of Object.entries(credentials())) {
      const reaches = allowed.includes(kind as keyof ReturnType<typeof credentials>)
      for (const [method, path] of ROUTES) {
        const got = await status(method, path, authorization)
        expect({ kind, method, path, refused: got.status === 401 }).toEqual({ kind, method, path, refused: !reaches })
      }
      for (const [method, path] of OPEN) expect((await status(method, path, authorization)).status).not.toBe(401)
    }
  })

  it('never runs a forwarded channel or a headset event without credentials', async () => {
    await start({ enabled: true, password: '' })
    for (const [method, path] of ROUTES) await status(method, path)
    expect(api).not.toHaveBeenCalled()
    expect(headsetEvents).toEqual([])
    await status('POST', '/api/library:setFavourite', `Bearer ${token}`)
    expect(api).toHaveBeenCalledOnce()
  })

  it('asks for the password only while it can be given', async () => {
    await start({ enabled: true, password: '' })
    expect((await status('GET', '/')).challenge).toBeNull()
    server.stop()
    await start({ enabled: true, password: 'pw' })
    expect((await status('GET', '/')).challenge).toBe('Basic realm="Better Player"')
  })

  it('stops letting the password in once it is cleared or serving is turned off', async () => {
    await start({ enabled: true, password: 'pw' })
    const password = `Basic ${btoa('bp:pw')}`
    expect((await status('GET', '/thumb/1', password)).status).toBe(404)
    server.apply({ remote: { enabled: true, password: '', port: Number(new URL(base).port) } } as Settings)
    expect((await status('GET', '/thumb/1', password)).status).toBe(401)
    server.apply({ remote: { enabled: false, password: 'pw', port: Number(new URL(base).port) } } as Settings)
    expect((await status('GET', '/thumb/1', password)).status).toBe(401)
    expect((await status('GET', '/thumb/1', `Bearer ${token}`)).status).toBe(404)
  })
})

describe('/quest/scene', () => {
  const row = (id: number, path: string) => ({ id, path, title: 'clip', durationMs: 60_000, size: 1e8, mtime: 1, width: 1920, height: 1080 }) as unknown as MediaDetail
  let server: RemoteServer
  let base: string
  let token: string
  let dir: string
  let rows: MediaDetail[]
  let spawned: { args: string[]; killed: boolean; frames: (chunk: Buffer) => void; exit: (code: number | null) => void }[]
  let encodes: QuestStreams
  let produces = true

  const streams = () =>
    new QuestStreams({
      probe: async (args) => (args.at(-1)?.endsWith('here.mp4') ? '{"streams":[{"codec_name":"av1","width":7680,"height":3840,"avg_frame_rate":"120/1"}]}' : '{"streams":[{"codec_name":"h264","width":1920,"height":1080,"avg_frame_rate":"30/1"}]}'),
      encoder: async () => true,
      spawn: async (args, frames): Promise<Encode> => {
        let exit: (code: number | null) => void = () => {}
        const exited = new Promise<number | null>((done) => (exit = done))
        const record = { args, killed: false, frames, exit: (code: number | null) => exit(code) }
        spawned.push(record)
        const stdout = new PassThrough()
        const produced = produces
        stdout.write('G')
        return { stdout, exited, produced: () => produced, stderr: () => '', kill: () => { record.killed = true; exit(null) } }
      },
    })

  beforeEach(async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    spawned = []
    produces = true
    dir = mkdtempSync(join(tmpdir(), 'bp-quest-scene-'))
    writeFileSync(join(dir, 'here.mp4'), BYTES)
    writeFileSync(join(dir, 'small.mp4'), BYTES)
    const unplugged = join(dir, 'unplugged')
    rows = [row(1, join(dir, 'here.mp4')), row(2, join(dir, 'gone.mp4')), row(3, join(dir, 'small.mp4')), row(4, join(unplugged, 'away.mp4'))]
    const library = {
      media: (id: number) => rows.find((r) => r.id === id) ?? null,
      index: () => [],
      roots: () => [{ id: 1, path: dir, kind: 'folder' }, { id: 2, path: unplugged, kind: 'folder' }],
      projection: async () => ({ projection: FLAT }),
      videoSettings: () => null,
      passthrough: async () => ({ settings: {}, on: false, mode: 'off' }),
    } as unknown as Library
    const port = await freePort()
    encodes = streams()
    server = new RemoteServer(library, undefined, undefined, encodes)
    await new Promise<void>((done) => {
      server.setEmitter(() => done())
      server.apply({ remote: { enabled: false, password: '', port } } as Settings)
    })
    base = `http://127.0.0.1:${port}`
    token = await new Promise<string>((done) => {
      const id = server.pairing.request({ id: 'quest-1', name: 'Quest', pin: '1234' }, '127.0.0.1', (_status, body) => done((body as { token: string }).token))
      if (id) server.pairing.pin(id, '1234')
    })
  })

  afterEach(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const scene = (id: number) => fetch(`${base}/quest/scene/${id}`, { headers: { Authorization: `Bearer ${token}` } })
  const feed = (t: number, init: RequestInit = {}) => fetch(`${base}/quest/stream/1?t=${t}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } })

  it('offers the feed only for a file the headset cannot decode in real time', async () => {
    expect(((await (await scene(1)).json()) as { stream?: unknown }).stream).toEqual({ url: `${base}/quest/stream/1`, width: 7680, height: 3840, fps: 60 })
    expect(await (await scene(3)).json()).not.toHaveProperty('stream')
    expect((await fetch(`${base}/quest/stream/3`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(404)
  })

  it('runs one encode per headset: a new request ends the last, from its own time', async () => {
    const first = await feed(0)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('video/mp2t')
    const second = await feed(5_000)
    expect(spawned.map((s) => s.killed)).toEqual([true, false])
    expect(spawned[1]?.args[spawned[1].args.indexOf('-ss') + 1]).toBe('5.000')
    await expect(first.text()).rejects.toThrow()
    await second.body?.cancel()
  })

  it('ends the encode when the headset closes the stream', async () => {
    const closing = new AbortController()
    await feed(0, { signal: closing.signal })
    closing.abort()
    await vi.waitFor(() => expect(spawned[0]?.killed).toBe(true))
  })

  it('answers HEAD and a range past the start without encoding', async () => {
    const head = await feed(0, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('video/mp2t')
    expect((await feed(0, { headers: { Range: 'bytes=100-' } })).status).toBe(416)
    expect(spawned).toHaveLength(0)
    const fromStart = await feed(0, { headers: { Range: 'bytes=0-' } })
    expect(fromStart.status).toBe(200)
    await fromStart.body?.cancel()
  })

  it("sends an encode's tracking frames only while the window wants that headset's video, a run per encode", async () => {
    const sent: unknown[] = []
    server.setHeadsetEmitter((event, data) => event === 'headset:frame' && sent.push(data))
    const frame = Buffer.alloc(384 * 192 * 4, 7)
    const first = await feed(5_000)
    spawned[0]?.frames(frame)
    server.wantFrames({ host: '127.0.0.1', mediaId: 1 })
    spawned[0]?.frames(frame)
    server.wantFrames({ host: '127.0.0.1', mediaId: 3 })
    spawned[0]?.frames(frame)
    server.wantFrames({ host: '127.0.0.1', mediaId: 1 })
    const second = await feed(0)
    spawned[1]?.frames(frame)
    expect(sent).toEqual([
      { run: 1, timeMs: 5_000 + 1000 / 30, width: 384, height: 192, bytes: frame },
      { run: 2, timeMs: 0, width: 384, height: 192, bytes: frame },
    ])
    await expect(first.text()).rejects.toThrow()
    await second.body?.cancel()
  })

  it('tells the window when an encode is busy or fails before any output, as the headset then plays the file itself', async () => {
    const events: unknown[] = []
    server.setHeadsetEmitter((event, data) => event === 'headset:feedFailed' && events.push(data))
    const file = { path: join(dir, 'small.mp4'), mtime: 0 }
    await encodes.open('quest-2', file, [])
    await encodes.open('quest-3', file, [])
    expect((await feed(0)).status).toBe(503)
    expect(events).toEqual([{ host: '127.0.0.1', mediaId: 1 }])
    encodes.end('quest-2')
    produces = false
    const early = await feed(0)
    spawned[2]?.exit(1)
    await expect(early.text()).rejects.toThrow()
    expect(events).toEqual([{ host: '127.0.0.1', mediaId: 1 }, { host: '127.0.0.1', mediaId: 1 }])
  })

  it('answers for a file that is there and refuses one that is not, saying whether its drive is there', async () => {
    const here = await scene(1)
    expect(here.status).toBe(200)
    expect(await here.json()).toMatchObject({ id: 1, url: `${base}/media/1` })
    const gone = await scene(2)
    expect(gone.status).toBe(404)
    expect(await gone.json()).toEqual({ error: 'file missing' })
    const away = await scene(4)
    expect(away.status).toBe(404)
    expect(await away.json()).toEqual({ error: 'drive missing' })
  })
})

describe('/quest/speech', () => {
  let server: RemoteServer
  let base: string
  let token: string
  const calls: unknown[][] = []
  const speech: SpeechApi = {
    model: () => ({ kind: 'downloading', done: 5, total: 10 }),
    download: () => { calls.push(['download']) },
    chunk: async (session, seq, pcm, kind) => {
      calls.push(['chunk', session, seq, [...pcm], ...(kind === 'reply' ? [kind] : [])])
      return { words: [{ text: 'VR', filter: true }], end: 'none' }
    },
    end: async (session) => {
      calls.push(['end', session])
      return { words: [{ text: 'VR', filter: true }], chips: [{ id: 'v0', kind: 'vr', label: 'VR' }] }
    },
    cancel: (session) => { calls.push(['cancel', session]) },
  }

  beforeEach(async () => {
    calls.length = 0
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const port = await freePort()
    server = new RemoteServer({ index: () => [] } as unknown as Library)
    server.setSpeech(speech)
    await new Promise<void>((done) => {
      server.setEmitter(() => done())
      server.apply({ remote: { enabled: false, password: '', port } } as Settings)
    })
    base = `http://127.0.0.1:${port}`
    token = await new Promise<string>((done) => {
      const id = server.pairing.request({ id: 'quest-1', name: 'Quest', pin: '1234' }, '127.0.0.1', (_status, body) => done((body as { token: string }).token))
      if (id) server.pairing.pin(id, '1234')
    })
  })

  afterEach(() => {
    server.stop()
    vi.restoreAllMocks()
  })

  const call = (method: string, path: string, body?: Uint8Array) =>
    fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/L16;rate=16000' }, body })

  const dom = { doms: [{ id: 'd', name: 'Vale' }], session: { name: 'Vale', line: 'Good.', said: 1, replies: ['Yes'], thinking: false, level: null }, note: null }
  const pause = [{ n: 1, kind: 'pause' as const }]

  it('holds GET /quest/dom until the session moves', async () => {
    const first = (await (await call('GET', '/quest/dom?since=-1')).json()) as QuestDom
    expect(first).toMatchObject({ doms: [], session: null })
    const held = call('GET', `/quest/dom?since=${first.version}`)
    await new Promise((done) => setTimeout(done, 30))
    server.setDom(dom, pause, '127.0.0.1')
    expect(await (await held).json()).toEqual({ ...dom, commands: pause, version: first.version + 1 })
  })

  it('tells the window once that a headset asked', async () => {
    const events: unknown[] = []
    server.setHeadsetEmitter((event, data) => events.push([event, data]))
    await call('GET', '/quest/dom?since=-1')
    await call('GET', '/quest/dom?since=-1')
    expect(events).toEqual([['headset:domAsk', { host: '127.0.0.1' }]])
  })

  it('shows a session and its commands only to the headset running it', async () => {
    server.setDom(dom, pause, '10.0.0.9')
    expect(await (await call('GET', '/quest/dom?since=-1')).json()).toMatchObject({ doms: [], session: null, commands: [] })
    server.setDom({ ...dom, session: null }, [], null)
    expect(await (await call('GET', '/quest/dom?since=-1')).json()).toMatchObject({ doms: dom.doms, session: null })
  })

  it('passes a start and a reply on with the host, and refuses anything else', async () => {
    const events: unknown[] = []
    server.setHeadsetEmitter((event, data) => events.push([event, data]))
    const send = (body: unknown) => fetch(`${base}/quest/dom`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await send({ kind: 'start', domId: 'd' })).status).toBe(200)
    expect((await send({ kind: 'send', text: 'Yes' })).status).toBe(200)
    expect((await send({ kind: 'stop' })).status).toBe(400)
    expect(events).toEqual([['headset:dom', { kind: 'start', domId: 'd', host: '127.0.0.1' }], ['headset:dom', { kind: 'send', text: 'Yes', host: '127.0.0.1' }]])
  })

  it('answers the model state and starts its download', async () => {
    expect(await (await call('GET', '/quest/speech')).json()).toEqual({ kind: 'downloading', done: 5, total: 10 })
    expect((await call('POST', '/quest/speech/model')).status).toBe(204)
    expect(calls).toEqual([['download']])
  })

  it('takes a chunk of PCM16 LE with its seq, then the end and a cancel', async () => {
    const pcm = new Uint8Array(new Int16Array([1, -2, 300]).buffer)
    const reply = await call('POST', '/quest/speech/abc-1?seq=3', pcm)
    expect(await reply.json()).toEqual({ words: [{ text: 'VR', filter: true }], end: 'none' })
    expect(await (await call('POST', '/quest/speech/abc-1/end')).json()).toEqual({ words: [{ text: 'VR', filter: true }], chips: [{ id: 'v0', kind: 'vr', label: 'VR' }] })
    expect((await call('DELETE', '/quest/speech/abc-1')).status).toBe(204)
    expect(calls).toEqual([['chunk', 'abc-1', 3, [1, -2, 300]], ['end', 'abc-1'], ['cancel', 'abc-1']])
  })

  it('takes a reply as a reply', async () => {
    await call('POST', '/quest/speech/abc-1?seq=0&kind=reply', new Uint8Array(new Int16Array([1]).buffer))
    expect(calls).toEqual([['chunk', 'abc-1', 0, [1], 'reply']])
  })

  it('refuses a chunk over 2 MB, half a sample, or no seq', async () => {
    expect((await call('POST', '/quest/speech/s?seq=0', new Uint8Array(2 * 1024 * 1024 + 2))).status).toBe(413)
    expect((await call('POST', '/quest/speech/s?seq=0', new Uint8Array(2 * 1024 * 1024))).status).toBe(200)
    expect((await call('POST', '/quest/speech/s?seq=0', new Uint8Array(3))).status).toBe(400)
    expect((await call('POST', '/quest/speech/s', new Uint8Array(2))).status).toBe(400)
    expect((await call('POST', '/quest/speech/s?seq=-1', new Uint8Array(2))).status).toBe(400)
    expect(calls).toHaveLength(1)
  })

  it('takes DELETE only to cancel a session', async () => {
    expect((await call('DELETE', '/quest/speech')).status).toBe(405)
    expect((await call('DELETE', '/quest/speech/s/end')).status).toBe(405)
    expect((await call('DELETE', '/quest/scene/1')).status).toBe(405)
    expect((await call('GET', '/quest/speech/s')).status).toBe(405)
    expect(calls).toEqual([])
  })
})
