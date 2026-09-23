import type { GroupMsg } from '@shared/together'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SIGNED_OUT, type PeerMsg, type SignalIn } from '@shared/account'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), play: vi.fn(), pause: vi.fn(), seek: vi.fn() }))
vi.mock('@/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/engine/client', () => ({ engine: { setLive: vi.fn() } }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./live', () => ({ subscribe: vi.fn(), get: () => ({ timeMs: 0 }) }))
vi.mock('./session', () => ({ useSession: { getState: () => ({ stage: 'setup' }) } }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({}) } }))

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = Socket.OPEN
  onmessage: ((event: { data: string }) => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor() { Socket.instances.push(this) }
  receive(message: SignalIn) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

class Channel {
  label = 'bp'
  readyState = 'open'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  close = vi.fn()
  send = vi.fn()
  receive(message: PeerMsg | GroupMsg) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

class Peer {
  static instances: Peer[] = []
  channel = new Channel()
  ondatachannel: ((event: { channel: Channel }) => void) | null = null
  setRemoteDescription = vi.fn(async () => {})
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer' }))
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer' }))
  createDataChannel = vi.fn(() => this.channel)
  setLocalDescription = vi.fn(async () => {})
  close = vi.fn()
  constructor() { Peer.instances.push(this) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const friend = { id: 'friend', name: 'Friend', code: 'ABCD-EFGH' }
const hashA = 'a'.repeat(64)
const hashB = 'b'.repeat(64)
let together: typeof import('./together').useTogether
let player: typeof import('./player').usePlayer
let account: typeof import('./account').useAccount
let socket: Socket
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

async function connect(role: 'guest' | 'host' = 'guest') {
  if (role === 'guest') {
    socket.receive({ t: 'invite', from: friend.id, kind: 'watch' })
    together.getState().accept()
    socket.receive({ t: 'signal', from: friend.id, data: { type: 'offer', sdp: 'offer' } })
  } else {
    together.getState().invite(friend, 'watch')
    socket.receive({ t: 'accept', from: friend.id, kind: 'watch', sessionId: together.getState().session?.id })
  }
  await settle()
  const peer = Peer.instances.at(-1)!
  if (role === 'guest') peer.ondatachannel?.({ channel: peer.channel })
  peer.channel.onopen?.()
  expect(together.getState().session?.status).toBe('connected')
  return peer.channel
}

function transport(channel: Channel) {
  channel.receive({ t: 'play', positionMs: 5000 })
  channel.receive({ t: 'seek', positionMs: 10_000 })
  player.setState({ snapshot: { ...player.getState().snapshot, paused: false } })
  channel.receive({ t: 'pause', positionMs: 15_000 })
}

function expectNoTransport() {
  expect(mocks.play).not.toHaveBeenCalled()
  expect(mocks.pause).not.toHaveBeenCalled()
  expect(mocks.seek).not.toHaveBeenCalled()
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.doMock('./account', async () => {
    const { create } = await import('zustand')
    return { useAccount: create(() => ({ status: SIGNED_OUT, token: null as string | null })) }
  })
  vi.doMock('./player', async () => {
    const { create } = await import('zustand')
    return { usePlayer: create(() => ({ path: null as string | null, snapshot: { loaded: true, paused: true, rate: 1 }, open: mocks.open, play: mocks.play, pause: mocks.pause, seek: mocks.seek })) }
  })
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('RTCPeerConnection', Peer)
  Socket.instances = []
  Peer.instances = []
  mocks.invoke.mockImplementation(async (method: string, path: string) => {
    if (method === 'account:url') return 'http://localhost:3070'
    if (method === 'account:hash') return path === '/a.mp4' ? hashA : hashB
    return null
  })
  mocks.open.mockImplementation(async (path: string) => { player.setState({ path }) })
  together = (await import('./together')).useTogether
  player = (await import('./player')).usePlayer
  account = (await import('./account')).useAccount
  account.setState({ token: 'token', status: { ...SIGNED_OUT, state: 'in', friends: { friends: [friend], incoming: [], outgoing: [] } } })
  player.setState({ path: '/a.mp4' })
  await settle()
  socket = Socket.instances[0]!
  socket.receive({ t: 'hello', id: 'self', stun: [], online: [friend.id] })
})

afterEach(() => {
  account.setState({ token: null, status: SIGNED_OUT })
  together.getState().end()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('ignores transport commands before the host identifies the shared video', async () => {
  const channel = await connect()
  transport(channel)
  expectNoTransport()
})

it('keeps commands for missing B from changing the guest video A', async () => {
  const channel = await connect()
  channel.receive({ t: 'open', hash: hashB, positionMs: 0, paused: true })
  await settle()
  expect(together.getState().session?.missing).toBe(true)
  expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ t: 'missing', hash: hashB }))
  transport(channel)
  expectNoTransport()
  expect(player.getState().path).toBe('/a.mp4')
  expect(channel.send).toHaveBeenCalledTimes(1)
})

it('ignores commands during lookup and open, then accepts them for the resolved video', async () => {
  const channel = await connect()
  const lookup = deferred<string>()
  const opened = deferred<void>()
  mocks.invoke.mockReturnValueOnce(lookup.promise)
  mocks.open.mockImplementationOnce(async (path: string) => { await opened.promise; player.setState({ path }) })
  channel.receive({ t: 'open', hash: hashB, positionMs: 0, paused: false })
  transport(channel)
  expectNoTransport()
  lookup.resolve('/b.mp4')
  await settle()
  transport(channel)
  expectNoTransport()
  opened.resolve()
  await settle()
  expect(player.getState().path).toBe('/b.mp4')
  channel.receive({ t: 'seek', positionMs: 20_000 })
  expect(mocks.seek).toHaveBeenCalledExactlyOnceWith(20)
})

it('keeps the old video protected if opening the shared file fails', async () => {
  const channel = await connect()
  mocks.invoke.mockResolvedValueOnce('/b.mp4')
  mocks.open.mockRejectedValueOnce(new Error('Cannot open'))
  channel.receive({ t: 'open', hash: hashB, positionMs: 0, paused: true })
  await settle()
  transport(channel)
  expectNoTransport()
})

it('clears missing when the host returns to A and resumes play, pause, and seek', async () => {
  const channel = await connect()
  channel.receive({ t: 'open', hash: hashB, positionMs: 0, paused: true })
  await settle()
  channel.receive({ t: 'open', hash: hashA, positionMs: 0, paused: true })
  expect(together.getState().session?.missing).toBe(false)
  transport(channel)
  expect(mocks.play).toHaveBeenCalledOnce()
  expect(mocks.pause).toHaveBeenCalledOnce()
  expect(mocks.seek).toHaveBeenCalledWith(10)
})

it('blocks old shared-file commands immediately when the local path changes', async () => {
  const channel = await connect()
  channel.receive({ t: 'open', hash: hashA, positionMs: 0, paused: true })
  const hash = deferred<string>()
  mocks.invoke.mockReturnValueOnce(hash.promise)
  player.setState({ path: '/b.mp4' })
  transport(channel)
  expectNoTransport()
  hash.resolve(hashB)
  await settle()
})

it('preserves requests from a guest to the host player', async () => {
  const channel = await connect('host')
  transport(channel)
  expect(mocks.play).toHaveBeenCalledOnce()
  expect(mocks.pause).toHaveBeenCalledOnce()
  expect(mocks.seek).toHaveBeenCalledWith(10)
})

it('accepts guest commands after an unavailable guest request returns to the host file', async () => {
  const channel = await connect('host')
  channel.receive({ t: 'open', hash: hashB, positionMs: 0, paused: true })
  await settle()
  expect(together.getState().session?.missing).toBe(true)
  expect(player.getState().path).toBe('/a.mp4')
  vi.advanceTimersByTime(1000)
  expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ t: 'tick', hash: hashA, positionMs: 0, paused: true, rate: 1 }))
  transport(channel)
  expect(mocks.play).toHaveBeenCalledOnce()
  expect(mocks.pause).toHaveBeenCalledOnce()
  expect(mocks.seek).toHaveBeenCalledWith(10)
})

it('recovers on a matching host tick and allows the guest to request playback again', async () => {
  const channel = await connect()
  channel.receive({ t: 'open', hash: hashB, positionMs: 0, paused: true })
  await settle()
  channel.receive({ t: 'tick', hash: hashA, positionMs: 0, paused: true })
  expect(together.getState().session?.missing).toBe(false)
  channel.send.mockClear()
  player.setState({ snapshot: { ...player.getState().snapshot, paused: false } })
  expect(channel.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ t: 'play', positionMs: 0 }))
  channel.receive({ t: 'seek', positionMs: 10_000 })
  expect(mocks.seek).toHaveBeenCalledExactlyOnceWith(10)
})

it('does not apply a tick while a different shared video is still opening', async () => {
  const channel = await connect()
  const lookup = deferred<string>()
  mocks.invoke.mockReturnValueOnce(lookup.promise)
  channel.receive({ t: 'open', hash: hashB, positionMs: 0, paused: false })
  channel.receive({ t: 'tick', hash: hashA, positionMs: 5000, paused: false })
  expectNoTransport()
  lookup.resolve('/b.mp4')
  await settle()
  transport(channel)
  expectNoTransport()
})

it('preserves the host-empty pause but blocks subsequent untagged transport', async () => {
  const channel = await connect()
  channel.receive({ t: 'open', hash: hashA, positionMs: 0, paused: true })
  player.setState({ snapshot: { ...player.getState().snapshot, paused: false } })
  channel.receive({ t: 'tick', hash: null, positionMs: 0, paused: true })
  expect(mocks.pause).toHaveBeenCalledOnce()
  mocks.pause.mockClear()
  transport(channel)
  expectNoTransport()
})

it('invites multiple guests to one session and isolates a guest leaving', async () => {
  const a = await connect('host')
  const second = { id: 'second', name: 'Second', code: 'IJKL-MNOP' }
  const third = { id: 'third', name: 'Third', code: 'QRST-UVWX' }
  account.setState({ status: { ...account.getState().status, friends: { friends: [friend, second, third], incoming: [], outgoing: [] } } })
  socket.receive({ t: 'presence', id: second.id, online: true })
  socket.receive({ t: 'presence', id: third.id, online: true })
  const sessionId = together.getState().session!.id
  together.getState().inviteMany([second, third])
  expect(together.getState().session?.id).toBe(sessionId)
  expect(together.getState().session?.members).toHaveLength(3)
  socket.receive({ t: 'accept', from: second.id, kind: 'watch', sessionId })
  await settle()
  const b = Peer.instances.at(-1)!.channel
  b.onopen?.()
  a.send.mockClear()
  b.send.mockClear()
  player.setState({ snapshot: { ...player.getState().snapshot, paused: false } })
  expect(a.send).toHaveBeenCalledWith(JSON.stringify({ t: 'play', positionMs: 0 }))
  expect(b.send).toHaveBeenCalledWith(JSON.stringify({ t: 'play', positionMs: 0 }))
  socket.receive({ t: 'end', from: second.id, sessionId })
  expect(together.getState().session?.status).toBe('connected')
  expect(a.close).not.toHaveBeenCalled()
  expect(b.close).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(1000)
  expect(a.send).toHaveBeenCalledWith(JSON.stringify({ t: 'tick', hash: hashA, positionMs: 0, paused: false, rate: 1 }))
})

it('ignores acceptance and end messages for an obsolete session', async () => {
  together.getState().invite(friend, 'watch')
  const old = together.getState().session!.id
  together.getState().end()
  together.getState().invite(friend, 'watch')
  socket.receive({ t: 'accept', from: friend.id, kind: 'watch', sessionId: old })
  socket.receive({ t: 'end', from: friend.id, sessionId: old })
  await settle()
  expect(together.getState().session?.status).toBe('inviting')
  expect(Peer.instances).toHaveLength(0)
})

it('does not let a guest enable downloads or publish a roster', async () => {
  const channel = await connect('host')
  channel.receive({ t: 'open', hash: hashA, positionMs: 0, paused: true })
  channel.onmessage?.({ data: JSON.stringify({ t: 'sharing', video: { id: 'offer', hash: hashA, name: 'file.mp4', size: 100 } }) })
  channel.onmessage?.({ data: JSON.stringify({ t: 'members', members: [] }) })
  expect(together.getState().sharedVideo).toBeNull()
  expect(together.getState().session?.members).toHaveLength(1)
})

it('closes an incoming invitation when its host goes offline', () => {
  socket.receive({ t: 'invite', from: friend.id, kind: 'watch', sessionId: 'current-session' })
  socket.receive({ t: 'presence', id: friend.id, online: false })
  expect(together.getState().session?.status).toBe('ended')
})

it('ignores an error belonging to an older invitation', () => {
  together.getState().invite(friend, 'watch')
  const old = together.getState().session!.id
  together.getState().end()
  together.getState().invite(friend, 'watch')
  socket.receive({ t: 'error', code: 'offline', to: friend.id, sessionId: old })
  expect(together.getState().session?.status).toBe('inviting')
})

it('clears a guest missing status when they manually open the matching file', async () => {
  const channel = await connect('host')
  channel.receive({ t: 'missing', hash: hashA })
  expect(together.getState().session?.members[0]?.missing).toBe(true)
  channel.receive({ t: 'open', hash: hashA, positionMs: 0, paused: true })
  expect(together.getState().session?.members[0]?.missing).toBe(false)
})

const queued = [
  { id: 'one', name: 'one.mp4', hash: 'c'.repeat(64), size: 1 },
  { id: 'two', name: 'two.mp4', hash: 'd'.repeat(64), size: 1 },
]

it('shows host offers independently and requires viewer acceptance before receiving queued files', async () => {
  const channel = await connect()
  channel.receive({ t: 'sharing-queue', enabled: true, videos: queued })
  await settle()
  expect(together.getState().downloadsAllowed).toBe(true)
  expect(together.getState().acceptsDownloads).toBe(false)
  expect(mocks.invoke.mock.calls.some(([method]) => method === 'together:receiveStart')).toBe(false)
  mocks.invoke.mockImplementation(async method => method === 'together:receiveStart' ? 'incoming' : null)
  together.getState().acceptDownloads(true)
  await settle()
  expect(mocks.invoke).toHaveBeenCalledWith('together:receiveStart', queued[0])
  expect(channel.send.mock.calls.some(([raw]) => JSON.parse(raw).t === 'file-request')).toBe(true)
  together.getState().acceptDownloads(false)
  expect(mocks.invoke).toHaveBeenCalledWith('together:cancel', 'incoming')
  channel.send.mockClear()
  await vi.advanceTimersByTimeAsync(2100)
  expect(channel.send.mock.calls.some(([raw]) => JSON.parse(raw).t === 'file-request')).toBe(false)
})

it('predownloads the next queue item after verified completion and stops on host revocation', async () => {
  const channel = await connect()
  mocks.invoke.mockImplementation(async method => method === 'together:receiveStart' ? 'incoming' : method === 'together:complete' ? '/download.mp4' : null)
  together.getState().acceptDownloads(true)
  await settle()
  expect(together.getState().transfers).toEqual([])
  channel.receive({ t: 'sharing-queue', enabled: true, videos: queued })
  await settle()
  const request = channel.send.mock.calls.map(([raw]) => JSON.parse(raw)).find(msg => msg.t === 'file-request')
  const file = new Channel()
  file.label = `bp-file:${request.requestId}`
  Peer.instances.at(-1)!.ondatachannel?.({ channel: file })
  file.onopen?.()
  file.onmessage?.({ data: new Uint8Array([42]).buffer })
  file.onmessage?.({ data: JSON.stringify({ t: 'done', digest: 'e'.repeat(64) }) })
  await settle()
  await vi.advanceTimersByTimeAsync(1)
  expect(mocks.invoke).toHaveBeenCalledWith('together:receiveStart', queued[1])
  channel.receive({ t: 'sharing-queue', enabled: false, videos: [] })
  expect(together.getState().downloadsAllowed).toBe(false)
  expect(together.getState().acceptsDownloads).toBe(true)
  channel.send.mockClear()
  await vi.advanceTimersByTimeAsync(2100)
  expect(channel.send.mock.calls.some(([raw]) => JSON.parse(raw).t === 'file-request')).toBe(false)
})

it('retains a retry action when an earlier queued download fails', async () => {
  const channel = await connect()
  let attempts = 0
  mocks.invoke.mockImplementation(async method => {
    if (method === 'together:receiveStart') { if (++attempts === 1) throw Error('disk'); return 'incoming' }
    return null
  })
  together.getState().acceptDownloads(true)
  channel.receive({ t: 'sharing-queue', enabled: true, videos: queued })
  await vi.advanceTimersByTimeAsync(1)
  expect(mocks.invoke).toHaveBeenCalledWith('together:receiveStart', queued[1])
  expect(together.getState().transferError).toBe('together.transfer.failed')
  channel.receive({ t: 'sharing-queue', enabled: true, videos: [...queued].reverse() })
  expect(together.getState().transferError).toBe('together.transfer.failed')
})

it('ignores download completion from an ended session while registering its hash', async () => {
  const channel = await connect()
  const pendingHash = deferred<string>()
  mocks.invoke.mockImplementation(async method => method === 'together:receiveStart' ? 'incoming' : method === 'together:complete' ? '/download.mp4' : method === 'account:hash' ? pendingHash.promise : null)
  together.getState().acceptDownloads(true)
  channel.receive({ t: 'sharing-queue', enabled: true, videos: queued })
  await settle()
  const request = channel.send.mock.calls.map(([raw]) => JSON.parse(raw)).find(msg => msg.t === 'file-request')
  const file = new Channel()
  file.label = `bp-file:${request.requestId}`
  Peer.instances.at(-1)!.ondatachannel?.({ channel: file })
  file.onopen?.()
  file.onmessage?.({ data: new Uint8Array([42]).buffer })
  file.onmessage?.({ data: JSON.stringify({ t: 'done', digest: 'e'.repeat(64) }) })
  await settle()
  expect(mocks.invoke).toHaveBeenCalledWith('account:hash', '/download.mp4')
  together.getState().end()
  const next = await connect()
  next.receive({ t: 'open', hash: queued[0]!.hash, positionMs: 0, paused: false })
  await settle()
  expect(together.getState().session?.missing).toBe(true)
  pendingHash.resolve(queued[0]!.hash)
  await settle()
  expect(mocks.open).not.toHaveBeenCalled()
  expect(together.getState().session?.missing).toBe(true)
})

it('starts the Give control shortcut as Watch Together and offers control only once the friend joins', async () => {
  together.getState().inviteWithControl(friend)
  const sessionId = together.getState().session?.id
  expect(together.getState().session?.kind).toBe('watch')
  expect(together.getState().handover).toBeNull()
  expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ t: 'invite', to: friend.id, kind: 'watch', sessionId }))
  socket.receive({ t: 'accept', from: friend.id, kind: 'watch', sessionId })
  await settle()
  const channel = Peer.instances.at(-1)!.channel
  expect(together.getState().handover).toBeNull()
  channel.onopen?.()
  const grant = together.getState().handover
  expect(grant?.status).toBe('offering')
  expect(grant?.peer.id).toBe(friend.id)
  expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ t: 'control-offer', id: grant?.id }))
  channel.receive({ t: 'control-answer', id: grant!.id, accepted: false })
  expect(together.getState().handover).toBeNull()
  expect(together.getState().session?.status).toBe('connected')
})

it('clears automatic handover when a pending shortcut invitation is cancelled', async () => {
  together.getState().inviteWithControl(friend)
  together.getState().end()
  await connect('host')
  expect(together.getState().handover).toBeNull()
})
