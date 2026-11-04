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
