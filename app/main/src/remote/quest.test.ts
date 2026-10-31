import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcEvents } from '@shared/ipc'
import type { MediaDetail } from '@shared/library'
import { resolveProjection } from '@shared/projection'
import type { QuestScene, QuestToys } from '@shared/quest'
import type { PerVideoSettings, Settings } from '@shared/settings'
import type { Library } from '../library'
import { peerHost, readHello, readPosition, readToyCommand, resumePosition } from './quest'
import { RemoteServer } from './server'

vi.mock('electron', () => ({ app: {} }))

describe('request bodies', () => {
  it('reads a hello, trimming the name and refusing a bad port or no session', () => {
    expect(readHello({ name: ' Quest 3 ', port: 23554, session: ' s1 ' })).toEqual({ name: 'Quest 3', port: 23554, session: 's1' })
    expect(readHello({ port: 23554, session: 's1' })).toEqual({ name: '', port: 23554, session: 's1' })
    expect(readHello({ name: 'Quest 3', port: 0, session: 's1' })).toBeNull()
    expect(readHello({ name: 'Quest 3', port: '23554', session: 's1' })).toBeNull()
    expect(readHello({ name: 'Quest 3', port: 23554 })).toBeNull()
    expect(readHello({ name: 'Quest 3', port: 23554, session: ' ' })).toBeNull()
    expect(readHello({ name: 'Quest 3', port: 23554, session: 7 })).toBeNull()
    expect(readHello(null)).toBeNull()
  })

  it('reads a position in whole ms and refuses anything else', () => {
    expect(readPosition({ ms: 1234.6 })).toBe(1235)
    expect(readPosition({ ms: -1 })).toBeNull()
    expect(readPosition({ ms: Number.NaN })).toBeNull()
    expect(readPosition([])).toBeNull()
  })

  it('keeps a resume position only away from the first and last 5 s, as the desktop player does', () => {
    expect(resumePosition(4_999, 60_000)).toBeUndefined()
    expect(resumePosition(5_000, 60_000)).toBe(5_000)
    expect(resumePosition(55_000, 60_000)).toBe(55_000)
    expect(resumePosition(55_001, 60_000)).toBeUndefined()
    expect(resumePosition(90_000, 0)).toBe(90_000)
  })

  it('reads a toy change, clamped to the Quick settings ranges, and refuses anything else', () => {
    expect(readToyCommand({ kind: 'intensity', mediaId: 7, value: 1.234 })).toEqual({ kind: 'intensity', mediaId: 7, value: 1.23 })
    expect(readToyCommand({ kind: 'intensity', mediaId: 7, value: 9 })).toEqual({ kind: 'intensity', mediaId: 7, value: 2 })
    expect(readToyCommand({ kind: 'intensity', mediaId: 7, value: -1 })).toEqual({ kind: 'intensity', mediaId: 7, value: 0 })
    expect(readToyCommand({ kind: 'offset', mediaId: 7, ms: -12_000.4 })).toEqual({ kind: 'offset', mediaId: 7, ms: -5000 })
    expect(readToyCommand({ kind: 'offset', mediaId: 7, ms: 120.6 })).toEqual({ kind: 'offset', mediaId: 7, ms: 121 })
    expect(readToyCommand({ kind: 'reconnect', id: 'a1b2' })).toEqual({ kind: 'reconnect', id: 'a1b2' })
    expect(readToyCommand({ kind: 'intensity', mediaId: 7, value: Number.NaN })).toBeNull()
    expect(readToyCommand({ kind: 'intensity', mediaId: 7.5, value: 1 })).toBeNull()
    expect(readToyCommand({ kind: 'offset', ms: 10 })).toBeNull()
    expect(readToyCommand({ kind: 'reconnect', id: '' })).toBeNull()
    expect(readToyCommand({ kind: 'range', mediaId: 7, min: 0, max: 1 })).toBeNull()
    expect(readToyCommand('intensity')).toBeNull()
  })

  it('strips the IPv4-mapped prefix from a peer address', () => {
    expect(peerHost('::ffff:192.168.1.40')).toBe('192.168.1.40')
    expect(peerHost('192.168.1.40')).toBe('192.168.1.40')
  })
})

const ROW = { id: 7, path: 'D:/v/clip MKX200.mp4', title: 'clip MKX200', durationMs: 60_000, width: 5760, height: 2880, projection: 'fisheye', axes: ['L0'], heat: [0.5, 1] } as unknown as MediaDetail
const OVERRIDE: PerVideoSettings['projection'] = { kind: 'equirect180', layout: 'ou', fov: 180, swapEyes: true }

const freePort = () =>
  new Promise<number>((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => done(typeof address === 'object' && address ? address.port : 0))
    })
  })

describe('/quest routes', () => {
  let saved: Record<string, PerVideoSettings>
  let events: { event: keyof IpcEvents; data: unknown }[]
  let server: RemoteServer
  let base: string
  const counts = vi.fn(() => ({ all: 3 }))

  beforeEach(async () => {
    saved = { [ROW.path]: { globalOffsetMs: 40, axes: {}, position: 5_000, projection: OVERRIDE } }
    events = []
    counts.mockClear()
    const library = {
      media: (id: number) => (id === ROW.id ? ROW : null),
      videoSettings: (key: string) => saved[key] ?? null,
      projection: async (path: string) => resolveProjection({ name: 'clip MKX200', width: 5760, height: 2880, user: saved[path]?.projection }),
      counts,
    } as unknown as Library
    const port = await freePort()
    server = new RemoteServer(library, port)
    server.setApi(async (channel, args) => {
      if (channel === 'video:get') return saved[String(args[0])] ?? null
      if (channel === 'video:set') saved[String(args[0])] = args[1] as PerVideoSettings
      return null
    })
    server.setHeadsetEmitter((event, data) => events.push({ event, data }))
    await new Promise<void>((done) => {
      server.setEmitter(() => done())
      server.apply({ remote: { password: 'pw' } } as Settings)
    })
    base = `http://127.0.0.1:${port}`
  })

  afterEach(() => server.stop())

  const auth = { Authorization: `Basic ${btoa('bp:pw')}` }
  const post = (path: string, body?: unknown) => fetch(base + path, { method: 'POST', headers: auth, body: body === undefined ? undefined : JSON.stringify(body) })

  it('answers info behind the password', async () => {
    expect((await fetch(`${base}/quest/info`)).status).toBe(401)
    const info = await (await fetch(`${base}/quest/info`, { headers: auth })).json()
    expect(info).toMatchObject({ app: 'betterplayer', v: 1, port: Number(new URL(base).port), videos: 3, auth: true })
    await fetch(`${base}/quest/info`, { headers: auth })
    expect(counts).toHaveBeenCalledTimes(1)
  })

  it('serves a scene with the override, the resume position, the frame size and a URL on the asked host', async () => {
    const scene = async () => (await (await fetch(`${base}/quest/scene/7`, { headers: auth })).json()) as QuestScene
    expect(await scene()).toEqual({ id: 7, title: 'clip MKX200', url: `${base}/media/7`, durationMs: 60_000, resumeMs: 5_000, projection: OVERRIDE, projectionSource: 'user', width: 5760, height: 2880, axes: ['L0'], heat: [0.5, 1] })
    delete saved[ROW.path]
    expect(await scene()).toMatchObject({ resumeMs: 0, projection: { kind: 'fisheye' }, projectionSource: 'name' })
    expect((await fetch(`${base}/quest/scene/8`, { headers: auth })).status).toBe(404)
  })

  it('saves a position and keeps the rest of the entry', async () => {
    expect((await post('/quest/scene/7/position', { ms: 12_345 })).status).toBe(200)
    expect(saved[ROW.path]).toEqual({ globalOffsetMs: 40, axes: {}, position: 12_345, projection: OVERRIDE })
    await post('/quest/scene/7/position', { ms: 1_000 })
    expect(saved[ROW.path]).toEqual({ globalOffsetMs: 40, axes: {}, projection: OVERRIDE })
    await post('/quest/scene/7/position', { ms: 12_345 })
    await post('/quest/scene/7/position', { ms: 58_000 })
    expect(saved[ROW.path]).toEqual({ globalOffsetMs: 40, axes: {}, projection: OVERRIDE })
    expect((await post('/quest/scene/7/position', { ms: 'soon' })).status).toBe(400)
    expect((await fetch(`${base}/quest/scene/7/position`, { headers: auth })).status).toBe(405)
  })

  it('passes hello, bye and stop to the window with the sender as host', async () => {
    expect((await post('/quest/hello', { name: 'Quest 3', port: 23554, session: 's1' })).status).toBe(200)
    expect((await post('/quest/hello', { name: 'Quest 3', session: 's1' })).status).toBe(400)
    expect((await post('/quest/hello', { name: 'Quest 3', port: 23554 })).status).toBe(400)
    await post('/quest/stop')
    await post('/quest/bye')
    expect((await fetch(`${base}/quest/hello`, { headers: auth })).status).toBe(405)
    expect(events).toEqual([
      { event: 'headset:hello', data: { name: 'Quest 3', port: 23554, session: 's1', host: '127.0.0.1' } },
      { event: 'headset:stop', data: { host: '127.0.0.1' } },
      { event: 'headset:bye', data: { host: '127.0.0.1' } },
    ])
  })

  it("answers the window's toys and passes a toy change on with the sender as host", async () => {
    expect((await fetch(`${base}/quest/toys`)).status).toBe(401)
    expect(await (await fetch(`${base}/quest/toys`, { headers: auth })).json()).toEqual({ outputs: [], video: null })
    const toys: QuestToys = { outputs: [{ id: 'a1b2', name: 'Handy', connected: true }], video: { mediaId: 7, intensity: 1.2, offsetMs: -40 } }
    server.setToys(toys, '10.0.0.9')
    expect(await (await fetch(`${base}/quest/toys`, { headers: auth })).json()).toEqual({ ...toys, video: null })
    server.setToys(toys, '127.0.0.1')
    expect(await (await fetch(`${base}/quest/toys`, { headers: auth })).json()).toEqual(toys)
    expect((await post('/quest/toys', { kind: 'intensity', mediaId: 7, value: 1.5 })).status).toBe(200)
    expect((await post('/quest/toys', { kind: 'reconnect', id: 'a1b2' })).status).toBe(200)
    expect((await post('/quest/toys', { kind: 'intensity', value: 1.5 })).status).toBe(400)
    expect(events).toEqual([
      { event: 'headset:toys', data: { kind: 'intensity', mediaId: 7, value: 1.5, host: '127.0.0.1' } },
      { event: 'headset:toys', data: { kind: 'reconnect', id: 'a1b2', host: '127.0.0.1' } },
    ])
  })

  it('answers a discovery probe on the same port', async () => {
    const client = createSocket('udp4')
    const reply = new Promise<string>((done) => client.once('message', (m) => done(m.toString('utf8'))))
    const probe = () => client.send('BPQ1?', Number(new URL(base).port), '127.0.0.1')
    probe()
    const retry = setInterval(probe, 50)
    const beacon = JSON.parse(await reply)
    clearInterval(retry)
    client.close()
    expect(beacon).toMatchObject({ app: 'betterplayer', v: 1, port: Number(new URL(base).port), videos: 3, auth: true })
    expect(typeof beacon.name).toBe('string')
  })
})
