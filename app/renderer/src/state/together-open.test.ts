import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SIGNED_OUT, type PeerMsg, type SignalIn } from '@shared/account'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), pause: vi.fn() }))
vi.mock('@/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/engine/client', () => ({ engine: { setLive: vi.fn() } }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./live', () => ({ subscribe: vi.fn(), get: () => ({ timeMs: 0 }) }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({}) } }))
vi.mock('./account', async () => {
  const { create } = await import('zustand')
  return { useAccount: create(() => ({ status: SIGNED_OUT, token: null as string | null })) }
})
vi.mock('./player', async () => {
  const { create } = await import('zustand')
  return { usePlayer: create(() => ({ path: null as string | null, snapshot: { loaded: true, paused: false, rate: 1 }, open: mocks.open, pause: mocks.pause })) }
})

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = Socket.OPEN
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor() { Socket.instances.push(this) }
  receive(message: SignalIn) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

class Channel {
  readyState = 'open'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  close = vi.fn()
  send = vi.fn()
  receive(message: PeerMsg) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

class Peer {
  static instances: Peer[] = []
  ondatachannel: ((event: { channel: Channel }) => void) | null = null
  setRemoteDescription = vi.fn(async () => {})
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer' }))
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
const hash = 'a'.repeat(64)
let together: typeof import('./together').useTogether
let player: typeof import('./player').usePlayer
let socket: Socket
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

async function connectGuest() {
  socket.receive({ t: 'invite', from: friend.id, kind: 'watch' })
  together.getState().accept()
  socket.receive({ t: 'signal', from: friend.id, data: { type: 'offer', sdp: 'offer' } })
  await settle()
  const channel = new Channel()
  Peer.instances.at(-1)!.ondatachannel?.({ channel })
  channel.onopen?.()
  expect(together.getState().session?.status).toBe('connected')
  return channel
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('RTCPeerConnection', Peer)
  Socket.instances = []
  Peer.instances = []
  mocks.invoke.mockImplementation(async (method: string) => method === 'account:url' ? 'http://localhost:3070' : null)
  mocks.open.mockResolvedValue(undefined)
  together = (await import('./together')).useTogether
  player = (await import('./player')).usePlayer
  const { useAccount } = await import('./account')
  useAccount.setState({ token: 'token', status: { ...SIGNED_OUT, state: 'in', friends: { friends: [friend], incoming: [], outgoing: [] } } })
  await settle()
  socket = Socket.instances[0]!
  socket.receive({ t: 'hello', id: 'self', stun: [], online: [friend.id] })
})

afterEach(() => {
  together.getState().end()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('opens a resolved remote file while its session remains connected', async () => {
  const channel = await connectGuest()
  mocks.invoke.mockResolvedValue('/shared.mp4')
  channel.receive({ t: 'open', hash, positionMs: 2500, paused: false })
  await settle()
  expect(mocks.open).toHaveBeenCalledWith('/shared.mp4', 2.5, undefined, true, expect.any(AbortSignal))
})

it.each(['end', 'disconnect'] as const)('does not open a remote file after %s while its lookup was pending', async (reason) => {
  const channel = await connectGuest()
  const lookup = deferred<string>()
  mocks.invoke.mockReturnValue(lookup.promise)
  channel.receive({ t: 'open', hash, positionMs: 0, paused: true })
  if (reason === 'end') together.getState().end()
  else socket.onclose?.()
  lookup.resolve('/shared.mp4')
  await settle()
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.pause).not.toHaveBeenCalled()
})

it('keeps an ended lookup from marking the replacement session missing or releasing its pending open', async () => {
  const oldChannel = await connectGuest()
  const oldLookup = deferred<string | null>()
  mocks.invoke.mockReturnValueOnce(oldLookup.promise)
  oldChannel.receive({ t: 'open', hash, positionMs: 0, paused: false })
  together.getState().end()
  const channel = await connectGuest()
  const lookup = deferred<string>()
  mocks.invoke.mockReturnValueOnce(lookup.promise)
  channel.receive({ t: 'open', hash, positionMs: 1000, paused: false })
  const calls = mocks.invoke.mock.calls.length
  oldLookup.resolve(null)
  await settle()
  channel.receive({ t: 'open', hash, positionMs: 2000, paused: false })
  expect(mocks.invoke).toHaveBeenCalledTimes(calls)
  expect(together.getState().session?.missing).toBe(false)
  expect(channel.send).not.toHaveBeenCalled()
  lookup.resolve('/shared.mp4')
  await settle()
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith('/shared.mp4', 1, undefined, true, expect.any(AbortSignal))
})

it('does not apply a completed old player open to the replacement session', async () => {
  const channel = await connectGuest()
  const opened = deferred<void>()
  mocks.invoke.mockResolvedValue('/shared.mp4')
  mocks.open.mockReturnValueOnce(opened.promise)
  channel.receive({ t: 'open', hash, positionMs: 0, paused: true })
  await settle()
  expect(mocks.open).toHaveBeenCalledOnce()
  const signal: AbortSignal = mocks.open.mock.calls[0]![4]
  together.getState().end()
  expect(signal.aborted).toBe(true)
  await connectGuest()
  mocks.invoke.mockResolvedValue(null)
  player.setState({ path: '/shared.mp4' })
  await settle()
  opened.resolve()
  await settle()
  expect(together.getState().hash).toBeNull()
  expect(mocks.pause).not.toHaveBeenCalled()
})

it('ignores delayed data channel callbacks from an ended session', async () => {
  const oldChannel = await connectGuest()
  together.getState().end()
  await connectGuest()
  oldChannel.onclose?.()
  oldChannel.onopen?.()
  const calls = mocks.invoke.mock.calls.length
  oldChannel.receive({ t: 'open', hash, positionMs: 0, paused: false })
  await settle()
  expect(together.getState().session?.status).toBe('connected')
  expect(mocks.invoke).toHaveBeenCalledTimes(calls)
})
