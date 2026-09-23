import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SIGNED_OUT, type PeerMsg, type SignalIn } from '@shared/account'

const mocks = vi.hoisted(() => ({ setLive: vi.fn(), play: vi.fn() }))
vi.mock('@/ipc', () => ({ invoke: vi.fn(async () => 'http://localhost:3070') }))
vi.mock('@/engine/client', () => ({ engine: { setLive: mocks.setLive } }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./live', () => ({ subscribe: vi.fn(), get: () => ({ timeMs: 0 }), axisIdsWith: () => [], axisValue: () => 0.5, FLAG_SCRIPT: 1 }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({}) } }))
vi.mock('./player', async () => {
  const { create } = await import('zustand')
  return { usePlayer: create(() => ({ path: '/local.mp4', video: { axes: {} }, snapshot: { loaded: true, paused: true, durationMs: 1000, rate: 1 }, play: mocks.play })) }
})

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = Socket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
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
  channel = new Channel()
  createDataChannel = () => this.channel
  createOffer = vi.fn(async () => ({ sdp: 'offer' }))
  setLocalDescription = vi.fn(async () => {})
  close = vi.fn()
  constructor() { Peer.instances.push(this) }
}

const friend = { id: 'friend', name: 'Friend', code: 'ABCD-EFGH' }
let together: typeof import('./together').useTogether
let account: typeof import('./account').useAccount
let socket: Socket

function signIn() {
  account.setState({ token: 'token', status: { ...SIGNED_OUT, state: 'in', friends: { friends: [friend], incoming: [], outgoing: [] } } })
}

async function giveControl(current: Socket) {
  together.getState().invite(friend, 'control')
  current.receive({ t: 'accept', from: friend.id, kind: 'control' })
  await Promise.resolve()
  await Promise.resolve()
  const peer = Peer.instances.at(-1)!
  peer.channel.onopen?.()
  expect(together.getState().session?.status).toBe('connected')
  return peer
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
  together = (await import('./together')).useTogether
  account = (await import('./account')).useAccount
  signIn()
  await Promise.resolve()
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

it('revokes commands, held stroke and state updates immediately without waiting for the socket close event', async () => {
  const peer = await giveControl(socket)
  peer.channel.receive({ t: 'cmd', cmd: 'live', axis: 'L0', value: 0.8 })
  expect(mocks.setLive).toHaveBeenLastCalledWith('L0', 0.8)
  vi.advanceTimersByTime(250)
  expect(peer.channel.send).toHaveBeenCalledOnce()

  account.setState({ token: null, status: SIGNED_OUT })

  expect(socket.close).toHaveBeenCalledOnce()
  expect(peer.close).toHaveBeenCalledOnce()
  expect(peer.channel.close).toHaveBeenCalledOnce()
  expect(together.getState().session?.status).toBe('ended')
  expect(together.getState().connected).toBe(false)
  expect(together.getState().online).toEqual([])
  expect(mocks.setLive).toHaveBeenLastCalledWith('L0', null)
  peer.channel.receive({ t: 'cmd', cmd: 'play' })
  peer.channel.receive({ t: 'cmd', cmd: 'live', axis: 'L0', value: 0.9 })
  expect(mocks.play).not.toHaveBeenCalled()
  expect(mocks.setLive).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(60_000)
  expect(peer.channel.send).toHaveBeenCalledOnce()
  expect(Socket.instances).toHaveLength(1)
})

it('ignores delayed socket callbacks after signout and preserves a new signed-in control session', async () => {
  const oldPeer = await giveControl(socket)
  account.setState({ token: null, status: SIGNED_OUT })
  const oldSends = socket.send.mock.calls.length
  socket.onopen?.()
  socket.receive({ t: 'hello', id: 'self', stun: [], online: [friend.id] })
  expect(socket.send).toHaveBeenCalledTimes(oldSends)
  expect(together.getState().connected).toBe(false)

  signIn()
  const replacement = Socket.instances[1]!
  replacement.receive({ t: 'hello', id: 'self', stun: [], online: [friend.id] })
  const peer = await giveControl(replacement)
  peer.channel.receive({ t: 'cmd', cmd: 'live', axis: 'L0', value: 0.3 })
  const driveCalls = mocks.setLive.mock.calls.length

  socket.onclose?.({ code: 1000 })
  socket.receive({ t: 'end', from: friend.id })
  oldPeer.channel.onclose?.()
  expect(together.getState().session?.status).toBe('connected')
  expect(together.getState().connected).toBe(true)
  expect(together.getState().online).toEqual([friend.id])
  expect(peer.close).not.toHaveBeenCalled()
  expect(peer.channel.close).not.toHaveBeenCalled()
  expect(mocks.setLive).toHaveBeenCalledTimes(driveCalls)
  peer.channel.receive({ t: 'cmd', cmd: 'play' })
  expect(mocks.play).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(60_000)
  expect(Socket.instances).toHaveLength(2)
})
