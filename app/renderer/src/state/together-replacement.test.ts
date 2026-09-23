import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SIGNED_OUT, type SignalIn } from '@shared/account'

vi.mock('@/ipc', () => ({ invoke: vi.fn(async () => 'http://localhost:3070') }))
vi.mock('@/engine/client', () => ({ engine: { setLive: vi.fn() } }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./live', () => ({ subscribe: vi.fn(), get: () => ({ timeMs: 0 }) }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({}) } }))
vi.mock('./player', async () => {
  const { create } = await import('zustand')
  return { usePlayer: create(() => ({ path: null, snapshot: { loaded: false, paused: true, rate: 1 } })) }
})

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = Socket.OPEN
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor() { Socket.instances.push(this) }
  receive(message: SignalIn) { this.onmessage?.({ data: JSON.stringify(message) }) }
  disconnect(code: number, reason = '') { this.onclose?.({ code, reason }) }
}

const friend = { id: 'friend', name: 'Friend', code: 'ABCD-EFGH' }
let together: typeof import('./together').useTogether
let account: typeof import('./account').useAccount
let socket: Socket

function signIn() {
  account.setState({ token: 'token', status: { ...SIGNED_OUT, state: 'in', friends: { friends: [friend], incoming: [], outgoing: [] } } })
}

beforeEach(async () => {
  vi.resetModules()
  vi.doMock('./account', async () => {
    const { create } = await import('zustand')
    return { useAccount: create(() => ({ status: SIGNED_OUT, token: null as string | null })) }
  })
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('WebSocket', Socket)
  Socket.instances = []
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('ends a session and stays disconnected when another device replaces the socket', () => {
  together.getState().invite(friend, 'control')
  socket.disconnect(4000, 'replaced')
  expect(together.getState().connected).toBe(false)
  expect(together.getState().online).toEqual([])
  expect(together.getState().session?.status).toBe('ended')
  vi.advanceTimersByTime(10 * 60_000)
  expect(Socket.instances).toHaveLength(1)
})

it('does not reclaim a replaced connection when account status refreshes', () => {
  socket.disconnect(4000, 'replaced')
  account.setState({ status: { ...account.getState().status, state: 'error' } })
  signIn()
  vi.advanceTimersByTime(10 * 60_000)
  expect(Socket.instances).toHaveLength(1)
})

it('allows a new connection after explicitly signing out and back in', () => {
  socket.disconnect(4000, 'replaced')
  account.setState({ token: null, status: SIGNED_OUT })
  signIn()
  expect(Socket.instances).toHaveLength(2)
  Socket.instances[1]!.receive({ t: 'hello', id: 'self', stun: [], online: [friend.id] })
  expect(together.getState().connected).toBe(true)
  vi.advanceTimersByTime(10 * 60_000)
  expect(Socket.instances).toHaveLength(2)
})

it('retries transient failures with backoff and resets the delay after hello', () => {
  socket.disconnect(1006)
  vi.advanceTimersByTime(4999)
  expect(Socket.instances).toHaveLength(1)
  vi.advanceTimersByTime(1)
  expect(Socket.instances).toHaveLength(2)
  Socket.instances[1]!.disconnect(1006)
  vi.advanceTimersByTime(9999)
  expect(Socket.instances).toHaveLength(2)
  vi.advanceTimersByTime(1)
  expect(Socket.instances).toHaveLength(3)
  Socket.instances[2]!.receive({ t: 'hello', id: 'self', stun: [], online: [] })
  Socket.instances[2]!.disconnect(1006)
  vi.advanceTimersByTime(4999)
  expect(Socket.instances).toHaveLength(3)
  vi.advanceTimersByTime(1)
  expect(Socket.instances).toHaveLength(4)
})
