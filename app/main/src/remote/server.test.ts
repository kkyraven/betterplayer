import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { createServer } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcEvents } from '@shared/ipc'
import type { MediaDetail } from '@shared/library'
import type { RemoteLoad } from '@shared/remote'
import type { Settings } from '@shared/settings'
import type { Library } from '../library'
import { RemoteServer } from './server'

vi.mock('electron', () => ({ app: {} }))

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

  it('follows HereSphere by its header and DeoVR by its last request, within the free length', async () => {
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
    expect(events).toHaveLength(2)
  })

  it("never follows Better Player's own clients, as another desktop's HereSphere library server", async () => {
    for (const agent of ['node', 'libmpv', 'mpv 0.39.0', 'BetterPlayer']) {
      await (await fetch(`${base}/media/7`, { headers: { ...auth, 'HereSphere-JSON-Version': '1', 'User-Agent': agent } })).text()
    }
    expect(events).toEqual([])
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
    await res.body?.cancel()
    return { status: res.status, challenge: res.headers.get('www-authenticate') }
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
