import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SIGNED_OUT, type SignalIn } from '@shared/account'

const mocks = vi.hoisted(() => ({ offer: vi.fn(), answer: vi.fn(), remote: vi.fn() }))
vi.mock('@/ipc', () => ({ invoke: vi.fn(async () => 'http://localhost:3070') }))
vi.mock('@/engine/client', () => ({ engine: { setLive: vi.fn() } }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./live', () => ({ subscribe: vi.fn(), get: () => ({ timeMs: 0 }), axisIdsWith: () => [], axisValue: () => 0.5, FLAG_SCRIPT: 1 }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({}) } }))
vi.mock('./player', async () => {
  const { create } = await import('zustand')
  return { usePlayer: create(() => ({ path: null, video: { axes: {} }, snapshot: { loaded: false, paused: true, durationMs: 0, rate: 1 } })) }
})

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
  readyState = 'open'
  onopen: (() => void) | null = null
  close = vi.fn()
  send = vi.fn()
}

class Peer {
  static instances: Peer[] = []
  channel = new Channel()
  connectionState = 'new'
  onconnectionstatechange: (() => void) | null = null
  ondatachannel: ((event: { channel: Channel }) => void) | null = null
  createDataChannel = () => this.channel
  createOffer = mocks.offer
  createAnswer = mocks.answer
  setRemoteDescription = mocks.remote
  setLocalDescription = vi.fn(async () => {})
  close = vi.fn()
  constructor() { Peer.instances.push(this) }
}

const friend = { id: 'friend', name: 'Friend', code: 'ABCD-EFGH' }
let together: typeof import('./together').useTogether
let account: typeof import('./account').useAccount
let socket: Socket
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const ends = () => socket.send.mock.calls.filter(([value]) => JSON.parse(value).t === 'end')

function signIn() {
  account.setState({ token: 'token', status: { ...SIGNED_OUT, state: 'in', friends: { friends: [friend], incoming: [], outgoing: [] } } })
}

async function connecting(role: 'host' | 'guest', receiveOffer = true) {
  if (role === 'host') {
    together.getState().invite(friend, 'control')
    socket.receive({ t: 'accept', from: friend.id, kind: 'control' })
  } else {
    socket.receive({ t: 'invite', from: friend.id, kind: 'control' })
    together.getState().accept()
    if (receiveOffer) socket.receive({ t: 'signal', from: friend.id, data: { type: 'offer', sdp: 'offer' } })
  }
  await settle()
}

function openChannel(role: 'host' | 'guest') {
  const peer = Peer.instances.at(-1)!
  if (role === 'guest') peer.ondatachannel?.({ channel: peer.channel })
  peer.channel.onopen?.()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.doMock('./account', async () => {
    const { create } = await import('zustand')
    return { useAccount: create(() => ({ status: SIGNED_OUT, token: null as string | null })) }
  })
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('RTCPeerConnection', Peer)
  Socket.instances = []
  Peer.instances = []
  mocks.offer.mockResolvedValue({ sdp: 'offer' })
  mocks.answer.mockResolvedValue({ sdp: 'answer' })
  mocks.remote.mockResolvedValue(undefined)
  together = (await import('./together')).useTogether
  account = (await import('./account')).useAccount
  signIn()
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

it.each(['offer', 'answer', 'remote'] as const)('notifies the partner when %s setup fails', async (step) => {
  mocks[step].mockRejectedValueOnce(new Error('setup failed'))
  await connecting(step === 'offer' ? 'host' : 'guest')
  expect(together.getState().session?.status).toBe('ended')
  expect(together.getState().session?.note).toBe('together.note.couldNotConnect')
  expect(ends()).toHaveLength(1)
  expect(JSON.parse(ends()[0]![0])).toEqual({ t: 'end', to: friend.id })
  expect(Peer.instances[0]!.close).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(60_000)
  expect(ends()).toHaveLength(1)
})

it.each(['host', 'guest'] as const)('bounds a stalled %s connection and notifies its partner', async (role) => {
  await connecting(role, false)
  vi.advanceTimersByTime(29_999)
  expect(together.getState().session?.status).toBe('connecting')
  vi.advanceTimersByTime(1)
  expect(together.getState().session?.status).toBe('ended')
  expect(ends()).toHaveLength(1)
})

it.each(['host', 'guest'] as const)('keeps a healthy %s session connected past the setup deadline', async (role) => {
  await connecting(role)
  if (role === 'host') {
    socket.receive({ t: 'signal', from: friend.id, data: { type: 'answer', sdp: 'answer' } })
    await settle()
  }
  expect(mocks.remote).toHaveBeenCalledOnce()
  openChannel(role)
  vi.advanceTimersByTime(60_000)
  expect(together.getState().session?.status).toBe('connected')
  expect(ends()).toHaveLength(0)
})

it('ends a guest waiting for its first offer when the host reports setup failure', async () => {
  await connecting('guest', false)
  socket.receive({ t: 'end', from: friend.id })
  expect(together.getState().session?.status).toBe('ended')
  vi.advanceTimersByTime(60_000)
  expect(ends()).toHaveLength(0)
})

it.each(['reject', 'resolve'] as const)('ignores an old offer %s after signout, signin and a replacement session', async (outcome) => {
  const offer = deferred<{ sdp: string }>()
  mocks.offer.mockReturnValueOnce(offer.promise)
  await connecting('host')
  const oldPeer = Peer.instances[0]!
  account.setState({ token: null, status: SIGNED_OUT })
  signIn()
  socket = Socket.instances[1]!
  socket.receive({ t: 'hello', id: 'self', stun: [], online: [friend.id] })
  await connecting('guest')
  if (outcome === 'reject') offer.reject(new Error('old setup failed'))
  else offer.resolve({ sdp: 'obsolete offer' })
  oldPeer.connectionState = 'failed'
  oldPeer.onconnectionstatechange?.()
  await settle()
  expect(together.getState().session?.status).toBe('connecting')
  expect(ends()).toHaveLength(0)
  expect(socket.send.mock.calls.some(([value]) => value.includes('obsolete offer'))).toBe(false)
  openChannel('guest')
  expect(together.getState().session?.status).toBe('connected')
})

it('lets a new guest negotiate while an abandoned remote description is still pending', async () => {
  const remote = deferred<void>()
  mocks.remote.mockReturnValueOnce(remote.promise)
  await connecting('guest')
  vi.advanceTimersByTime(20_000)
  together.getState().end()
  socket.send.mockClear()
  await connecting('guest')
  expect(Peer.instances).toHaveLength(2)
  expect(mocks.answer).toHaveBeenCalledOnce()
  remote.reject(new Error('old description failed'))
  await settle()
  vi.advanceTimersByTime(10_000)
  expect(together.getState().session?.status).toBe('connecting')
  expect(ends()).toHaveLength(0)
  openChannel('guest')
  vi.advanceTimersByTime(30_000)
  expect(together.getState().session?.status).toBe('connected')
})
