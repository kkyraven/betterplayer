import { createHash, createHmac } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcEvents } from '@shared/ipc'
import type { MediaDetail } from '@shared/library'
import { PASSTHROUGH_DEFAULTS, resolvePassthrough, type PassthroughSettings } from '@shared/passthrough'
import { resolveProjection } from '@shared/projection'
import { QUEST_DISCOVERY_PORT, type QuestBeacon, type QuestPairPrompt, type QuestPaired, type QuestScene, type QuestToys } from '@shared/quest'
import type { PerVideoSettings, Settings } from '@shared/settings'
import type { Library } from '../library'
import { peerHost, readDomRequest, readHello, readPosition, readSample, readToyCommand, resumePosition } from './quest'
import { QuestStreams } from './questStream'
import { NUDGE_MS, RemoteServer } from './server'

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

  it('reads a Pick sample, holding u and v to the picture, and refuses anything else', () => {
    expect(readSample({ timeSec: 12.5, u: 0.25, v: 1.2 })).toEqual({ timeSec: 12.5, u: 0.25, v: 1 })
    expect(readSample({ timeSec: -1, u: 0.5, v: 0.5 })).toBeNull()
    expect(readSample({ timeSec: 1, u: Number.NaN, v: 0.5 })).toBeNull()
    expect(readSample({ timeSec: 1, u: 0.5 })).toBeNull()
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
    expect(readToyCommand({ kind: 'range', mediaId: 7, min: 0.8, max: 0.2 })).toEqual({ kind: 'range', mediaId: 7, min: 0.8, max: 0.8 })
    expect(readToyCommand({ kind: 'range', min: 0, max: 1 })).toBeNull()
    expect(readToyCommand({ kind: 'restimVolume', change: 'up' })).toEqual({ kind: 'restimVolume', change: 'up' })
    expect(readToyCommand({ kind: 'restimVolume', change: 1.5 })).toEqual({ kind: 'restimVolume', change: 1 })
    expect(readToyCommand({ kind: 'restimVolume', value: 0.5 })).toBeNull()
    expect(readToyCommand({ kind: 'audioVolume', change: 'up' })).toEqual({ kind: 'audioVolume', change: 'up' })
    expect(readToyCommand({ kind: 'audioVolume', change: 0.456 })).toEqual({ kind: 'audioVolume', change: 0.46 })
    expect(readToyCommand({ kind: 'audioVolume', change: 'down' })).toBeNull()
    expect(readToyCommand({ kind: 'coyote', id: 'c1', channel: 'b', change: 999 })).toEqual({ kind: 'coyote', id: 'c1', channel: 'b', change: 200 })
    expect(readToyCommand({ kind: 'coyote', id: 'c1', channel: 'a', change: 'down' })).toBeNull()
    expect(readToyCommand({ kind: 'coyote', id: 'c1', channel: 'c', change: 40 })).toBeNull()
    expect(readToyCommand({ kind: 'tracking', mediaId: 7, on: false })).toEqual({ kind: 'tracking', mediaId: 7, on: false })
    expect(readToyCommand({ kind: 'tracking', mediaId: 7, on: 1 })).toBeNull()
    expect(readToyCommand({ kind: 'tracking', on: true })).toBeNull()
    expect(readToyCommand('intensity')).toBeNull()
  })

  it('strips the IPv4-mapped prefix from a peer address', () => {
    expect(peerHost('::ffff:192.168.1.40')).toBe('192.168.1.40')
    expect(peerHost('192.168.1.40')).toBe('192.168.1.40')
  })
})

const FILES = mkdtempSync(join(tmpdir(), 'bp-quest-'))
writeFileSync(join(FILES, 'clip MKX200.mp4'), '')
afterAll(() => rmSync(FILES, { recursive: true, force: true }))
const ROW = { id: 7, path: join(FILES, 'clip MKX200.mp4'), title: 'clip MKX200', durationMs: 60_000, width: 5760, height: 2880, projection: 'fisheye', axes: ['L0'], heat: [0.5, 1] } as unknown as MediaDetail
const OVERRIDE: PerVideoSettings['projection'] = { kind: 'equirect180', layout: 'ou', fov: 180, arc: 200, swapEyes: true }

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

  beforeEach(async () => {
    saved = { [ROW.path]: { globalOffsetMs: 40, axes: {}, position: 5_000, projection: OVERRIDE } }
    events = []
    const library = {
      media: (id: number) => (id === ROW.id ? ROW : null),
      videoSettings: (key: string) => saved[key] ?? null,
      projection: async (path: string) => resolveProjection({ name: 'clip MKX200', width: 5760, height: 2880, user: saved[path]?.projection }),
      passthrough: async (_path: string, settings: PassthroughSettings | undefined) => resolvePassthrough(settings, 'clip MKX200', { key: 0x00b140, candidates: [] }, settings?.mode === 'ai'),
      samplePassthrough: async (_path: string, timeSec: number, u: number, v: number) => (timeSec === 12.5 && u === 0.25 && v === 1 ? 0xd02020 : null),
      roots: () => [],
    } as unknown as Library
    const port = await freePort()
    server = new RemoteServer(library, port, undefined, new QuestStreams({ encoder: async () => false }))
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

  it('answers info without a token, for an address typed in the headset', async () => {
    const info = await (await fetch(`${base}/quest/info`)).json()
    expect(info).toEqual({ app: 'betterplayer', v: 2, id: server.pairing.id, name: expect.any(String), port: Number(new URL(base).port), paired: false })
    expect((await fetch(`${base}/quest/scene/7`)).status).toBe(401)
  })

  it('serves a scene with the override, the resume position, the frame size and a URL on the asked host', async () => {
    const scene = async () => (await (await fetch(`${base}/quest/scene/7`, { headers: auth })).json()) as QuestScene
    const passthrough = resolvePassthrough(undefined, 'clip MKX200', { key: 0x00b140, candidates: [] }, false)
    expect(await scene()).toEqual({ id: 7, title: 'clip MKX200', url: `${base}/media/7`, durationMs: 60_000, resumeMs: 5_000, projection: OVERRIDE, projectionSource: 'user', width: 5760, height: 2880, axes: ['L0'], heat: [0.5, 1], passthrough })
    delete saved[ROW.path]
    expect(await scene()).toMatchObject({ resumeMs: 0, projection: { kind: 'fisheye' }, projectionSource: 'name' })
    expect((await fetch(`${base}/quest/scene/8`, { headers: auth })).status).toBe(404)
  })

  it('refuses scenes over the account headset limit and says so in the beacon', async () => {
    server.setVrLimit(() => 30_000)
    const refused = await fetch(`${base}/quest/scene/7`, { headers: auth })
    expect(refused.status).toBe(402)
    expect(await refused.json()).toEqual({ error: 'supporter', vrFreeMs: 30_000 })
    expect(await (await fetch(`${base}/quest/info`, { headers: auth })).json()).toMatchObject({ vrFreeMs: 30_000 })
    server.setVrLimit(() => undefined)
    expect((await fetch(`${base}/quest/scene/7`, { headers: auth })).status).toBe(200)
    expect(await (await fetch(`${base}/quest/info`, { headers: auth })).json()).not.toHaveProperty('vrFreeMs')
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

  it('carries the saved passthrough, saves a change keeping the rest of the entry, and answers a Pick', async () => {
    const on: PassthroughSettings = { ...PASSTHROUGH_DEFAULTS, on: true, featherPx: 8 }
    saved[ROW.path] = { ...saved[ROW.path], passthrough: on } as PerVideoSettings
    const scene = (await (await fetch(`${base}/quest/scene/7`, { headers: auth })).json()) as QuestScene
    expect(scene.passthrough).toMatchObject({ on: true, onSource: 'user', key: 0x00b140, keySource: 'auto', featherPx: 8 })
    const keyed = await post('/quest/scene/7/passthrough', { ...on, key: 0xd02020 })
    expect(keyed.status).toBe(200)
    expect(await keyed.json()).toMatchObject({ on: true, key: 0xd02020, keySource: 'user', auto: 0x00b140 })
    expect(saved[ROW.path]).toEqual({ globalOffsetMs: 40, axes: {}, position: 5_000, projection: OVERRIDE, passthrough: { ...on, key: 0xd02020 } })
    expect((await post('/quest/scene/7/passthrough', { key: 0xd02020 })).status).toBe(400)
    expect((await post('/quest/scene/8/passthrough', on)).status).toBe(404)
    expect(await (await post('/quest/scene/7/sample', { timeSec: 12.5, u: 0.25, v: 3 })).json()).toEqual({ colour: 0xd02020 })
    expect(await (await post('/quest/scene/7/sample', { timeSec: 1, u: 0.25, v: 0.5 })).json()).toEqual({ colour: null })
    expect((await post('/quest/scene/7/sample', { u: 0.25, v: 0.5 })).status).toBe(400)
  })

  it('serves the AI mask track under the maskBase of a video in AI mode', async () => {
    const masks = mkdtempSync(join(tmpdir(), 'bp-masks-'))
    mkdirSync(join(masks, '7'))
    writeFileSync(join(masks, '7', 'meta.json'), '{"version":1,"w":2,"h":1}')
    writeFileSync(join(masks, '7', '3.z'), Uint8Array.of(0x78, 1, 2))
    const get = (path: string) => fetch(base + path, { headers: auth })
    try {
      expect((await get('/quest/mask/7/meta')).status).toBe(404)
      server.setMasks(masks)
      const scene = async () => (await (await get('/quest/scene/7')).json()) as QuestScene
      expect((await scene()).passthrough?.maskBase).toBeUndefined()
      saved[ROW.path] = { ...saved[ROW.path], passthrough: { ...PASSTHROUGH_DEFAULTS, on: true, mode: 'ai' } } as PerVideoSettings
      const maskBase = (await scene()).passthrough?.maskBase
      expect(maskBase).toBe(`${base}/quest/mask/7`)
      expect(await (await fetch(`${maskBase}/meta`, { headers: auth })).json()).toEqual({ version: 1, w: 2, h: 1 })
      expect([...new Uint8Array(await (await fetch(`${maskBase}/3`, { headers: auth })).arrayBuffer())]).toEqual([0x78, 1, 2])
      expect((await get('/quest/mask/7/4')).status).toBe(404)
      expect((await get('/quest/mask/7/meta.json')).status).toBe(404)
      expect((await get('/quest/mask/8/meta')).status).toBe(404)
      expect((await fetch(`${maskBase}/meta`)).status).toBe(401)
    } finally {
      rmSync(masks, { recursive: true, force: true })
    }
  })

  it("answers Beta Censoring's look and serves its track", async () => {
    const tracks = mkdtempSync(join(tmpdir(), 'bp-censor-'))
    mkdirSync(join(tracks, '7'))
    writeFileSync(join(tracks, '7', 'meta.json'), '{"version":1,"w":4,"h":1,"eye":2}')
    writeFileSync(join(tracks, '7', '0.z'), Uint8Array.of(0x78, 9))
    const get = (path: string) => fetch(base + path, { headers: auth })
    try {
      expect((await get('/quest/censor')).status).toBe(503)
      expect((await get('/quest/censor/7/meta')).status).toBe(404)
      server.setCensorTracks(tracks)
      server.setCensor(null)
      expect(await (await get('/quest/censor')).json()).toBeNull()
      server.setCensor({ style: 'blur', strength: 0.4, track: 'det;faces' })
      expect(await (await get('/quest/censor')).json()).toEqual({ style: 'blur', strength: 0.4, track: 'det;faces' })
      expect(await (await get('/quest/censor/7/meta')).json()).toEqual({ version: 1, w: 4, h: 1, eye: 2 })
      expect([...new Uint8Array(await (await get('/quest/censor/7/0')).arrayBuffer())]).toEqual([0x78, 9])
      expect((await get('/quest/censor/7/1')).status).toBe(404)
      expect((await fetch(`${base}/quest/censor`)).status).toBe(401)
    } finally {
      rmSync(tracks, { recursive: true, force: true })
    }
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
    expect(await (await fetch(`${base}/quest/toys`, { headers: auth })).json()).toEqual({ outputs: [], video: null, estim: [] })
    const toys: QuestToys = { outputs: [{ id: 'a1b2', name: 'Handy', connected: true }], video: { mediaId: 7, intensity: 1.2, offsetMs: -40, range: { min: 0.1, max: 0.9 }, tracking: true }, estim: [{ kind: 'restim', volume: 0.6 }] }
    server.setToys(toys, '10.0.0.9')
    expect(await (await fetch(`${base}/quest/toys`, { headers: auth })).json()).toEqual({ ...toys, video: null, estim: [] })
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
    const probe = () => client.send('BPQ2?{"id":"h1","name":"Quest 3"}', Number(new URL(base).port), '127.0.0.1')
    probe()
    const retry = setInterval(probe, 50)
    const beacon = JSON.parse(await reply)
    clearInterval(retry)
    client.close()
    expect(beacon).toMatchObject({ app: 'betterplayer', v: 2, id: server.pairing.id, port: Number(new URL(base).port), paired: false })
    expect(server.pairing.headsets()).toEqual([{ id: 'h1', name: 'Quest 3', host: '127.0.0.1', looking: false, paired: false }])
    expect(typeof beacon.name).toBe('string')
  })
})

describe('pairing', () => {
  let server: RemoteServer
  let base: string
  let prompts: QuestPairPrompt[]

  beforeEach(async () => {
    prompts = []
    const library = { media: (id: number) => (id === ROW.id ? ROW : null), videoSettings: () => null, projection: async () => resolveProjection({ name: 'clip', width: 0, height: 0 }), passthrough: async () => resolvePassthrough(undefined, 'clip', null, false), roots: () => [] } as unknown as Library
    const port = await freePort()
    server = new RemoteServer(library, undefined, undefined, new QuestStreams({ encoder: async () => false }))
    server.pairing.setEmitters(
      () => {},
      (list) => (prompts = list),
    )
    await new Promise<void>((done) => {
      server.setEmitter(() => done())
      server.apply({ remote: { enabled: false, port, password: 'pw' } } as Settings)
    })
    base = `http://127.0.0.1:${port}`
  })

  afterEach(() => server.stop())

  const pair = (pin: string, signal?: AbortSignal) => fetch(`${base}/quest/pair`, { method: 'POST', body: JSON.stringify({ id: 'h1', name: 'Quest 3', pin }), signal })
  const prompted = async () => {
    while (prompts.length === 0) await new Promise((r) => setTimeout(r, 5))
    return prompts[0]!
  }

  it('lets a headset in once its PIN is typed here, until it is removed', async () => {
    expect((await fetch(`${base}/quest/scene/7`, { headers: { Authorization: `Basic ${btoa('bp:pw')}` } })).status).toBe(401)
    const answer = pair('4829')
    const prompt = await prompted()
    expect(prompt).toMatchObject({ name: 'Quest 3', host: '127.0.0.1' })
    expect(server.pairing.pin(prompt.requestId, '1111')).toBe('wrong')
    expect(server.pairing.pin(prompt.requestId, '4829')).toBe('paired')
    const res = await answer
    expect(res.status).toBe(200)
    const { token } = (await res.json()) as QuestPaired
    const bearer = { Authorization: `Bearer ${token}` }
    expect((await fetch(`${base}/quest/scene/7`, { headers: bearer })).status).toBe(200)
    const info = (await (await fetch(`${base}/quest/info?headset=h1&nonce=n1`)).json()) as QuestBeacon
    const key = createHash('sha256').update(token).digest()
    expect(info).toMatchObject({ paired: true, proof: createHmac('sha256', key).update(`n1|127.0.0.1:${new URL(base).port}`).digest('hex') })
    const stranger = await (await fetch(`${base}/quest/info?headset=h2&nonce=n1`)).json()
    expect(stranger).toMatchObject({ paired: false })
    expect(stranger).not.toHaveProperty('proof')
    expect(prompts).toEqual([])
    server.pairing.forget('h1')
    expect((await fetch(`${base}/quest/scene/7`, { headers: bearer })).status).toBe(401)
  })

  it('refuses after too many wrong PINs, and on decline', async () => {
    const first = pair('4829')
    const { requestId } = await prompted()
    for (let i = 0; i < 4; i++) expect(server.pairing.pin(requestId, '0000')).toBe('wrong')
    expect(server.pairing.pin(requestId, '0000')).toBe('gone')
    expect((await first).status).toBe(403)
    const second = pair('1234')
    server.pairing.decline((await prompted()).requestId)
    expect((await second).status).toBe(403)
  })

  it('drops the prompt when the headset gives up, and replaces an older request', async () => {
    const abort = new AbortController()
    const gaveUp = pair('4829', abort.signal).catch(() => null)
    await prompted()
    abort.abort()
    await gaveUp
    while (prompts.length > 0) await new Promise((r) => setTimeout(r, 5))
    const older = pair('1111')
    await prompted()
    const newer = pair('2222')
    expect((await older).status).toBe(409)
    expect(prompts).toHaveLength(1)
    server.pairing.decline(prompts[0]!.requestId)
    await newer
  })
})

describe('nudge', () => {
  let server: RemoteServer
  let headset: ReturnType<typeof createSocket>

  afterEach(() => {
    server.stop()
    headset.close()
    vi.useRealTimers()
  })

  it('sends the beacon to a paired headset that went quiet, and not while it is heard', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    headset = createSocket('udp4')
    const got: QuestBeacon[] = []
    headset.on('message', (m) => got.push(JSON.parse(m.toString('utf8')) as QuestBeacon))
    await new Promise<void>((done) => headset.bind(QUEST_DISCOVERY_PORT, '127.0.0.1', done))
    const port = await freePort()
    server = new RemoteServer({} as Library)
    await new Promise<void>((done) => {
      server.setEmitter(() => done())
      server.apply({ remote: { enabled: false, port, password: '' } } as Settings)
    })
    const requestId = server.pairing.request({ id: 'h1', name: 'Quest 3', pin: '0420' }, '127.0.0.1', () => {})
    server.pairing.pin(requestId!, '0420')
    server.pairing.used({ id: 'h1', name: 'Quest 3' }, '127.0.0.1')
    const settle = () => new Promise((r) => setTimeout(r, 100))
    vi.advanceTimersByTime(NUDGE_MS)
    await settle()
    expect(got).toEqual([])
    vi.advanceTimersByTime(10_000)
    while (got.length === 0) await settle()
    expect(got[0]).toMatchObject({ app: 'betterplayer', id: server.pairing.id, port, paired: true })
  })
})

describe('readDomRequest', () => {
  it('takes a start and a reply, trimmed and held to a length', () => {
    expect(readDomRequest({ kind: 'start', domId: 'd1' })).toEqual({ kind: 'start', domId: 'd1' })
    expect(readDomRequest({ kind: 'send', text: ' Yes ' })).toEqual({ kind: 'send', text: 'Yes' })
    expect((readDomRequest({ kind: 'send', text: 'x'.repeat(9000) }) as { text: string }).text).toHaveLength(2000)
  })

  it('refuses anything else', () => {
    for (const bad of [null, [], { kind: 'stop' }, { kind: 'start' }, { kind: 'send', text: '  ' }, { kind: 'send', text: 4 }]) expect(readDomRequest(bad)).toBeNull()
  })
})
