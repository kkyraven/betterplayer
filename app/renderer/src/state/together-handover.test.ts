import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ControlHandover, type Handover } from './together-handover'
import { parseGroupMsg } from '@shared/together'
const peer = { id: 'friend', name: 'Friend', code: 'ABCD-EFGH' }
const other = { ...peer, id: 'other' }
const state = { t: 'state' as const, media: false, paused: true, positionMs: 0, durationMs: 0, rate: 1, intensity: null, stroke: 0.5 }
let grant: Handover | null
let role: 'host' | 'guest'
let handover: ControlHandover
const send = vi.fn(), apply = vi.fn(), release = vi.fn()
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); grant = null; role = 'host'
  handover = new ControlHandover({ role: () => role, connected: () => true, changed: value => { grant = value }, send, apply, release, read: () => state })
})
afterEach(() => { handover.end(); vi.useRealTimers() })
const current = () => { if (!grant) throw Error('No grant'); return grant }
it('requires the selected peer to accept and rejects previous grant commands', () => {
  handover.offer(peer)
  const id = current().id
  const command = { t: 'control-command' as const, id, command: { cmd: 'live' as const, axis: 'L0' as const, value: 0.8 } }
  handover.receive(peer, command)
  handover.receive(other, { t: 'control-answer', id, accepted: true })
  expect(apply).not.toHaveBeenCalled()
  handover.receive(peer, { t: 'control-answer', id, accepted: true })
  handover.receive(peer, command)
  expect(apply).toHaveBeenCalledOnce()
  handover.end()
  expect(release).toHaveBeenCalledOnce()
  handover.offer(peer)
  handover.receive(peer, command)
  expect(apply).toHaveBeenCalledOnce()
})
it('releases on the controller disconnect, but not another viewer leaving', () => {
  handover.offer(peer)
  handover.receive(peer, { t: 'control-answer', id: current().id, accepted: true })
  handover.disconnect(other.id)
  expect(current().status).toBe('active')
  handover.disconnect(peer.id)
  expect(grant).toBeNull()
  expect(release).toHaveBeenCalledOnce()
})
it('expires unanswered offers and stalled active grants', () => {
  handover.offer(peer)
  vi.advanceTimersByTime(30_250)
  expect(grant).toBeNull()
  handover.offer(peer)
  const id = current().id
  handover.receive(peer, { t: 'control-answer', id, accepted: true })
  vi.advanceTimersByTime(3000)
  handover.receive(peer, { t: 'control-heartbeat', id })
  vi.advanceTimersByTime(3000)
  expect(current().status).toBe('active')
  vi.advanceTimersByTime(1500)
  expect(grant).toBeNull()
})
it('allows control without media only after viewer acceptance and releases explicitly', () => {
  role = 'guest'
  handover.receive(peer, { t: 'control-offer', id: 'grant' })
  handover.command({ cmd: 'live', axis: 'L0', value: 0.5 })
  expect(send).not.toHaveBeenCalled()
  handover.answer(true)
  handover.receive(peer, { t: 'control-state', id: 'grant', state })
  handover.command({ cmd: 'live', axis: 'L0', value: 0.5 })
  expect(send).toHaveBeenCalledWith(peer.id, { t: 'control-command', id: 'grant', command: { cmd: 'live', axis: 'L0', value: 0.5 } })
  handover.end()
  expect(send).toHaveBeenLastCalledWith(peer.id, { t: 'control-end', id: 'grant' })
})
it('parses only device commands inside grants and rejects malformed values', () => {
  expect(parseGroupMsg({ t: 'control-command', id: 'grant', command: { cmd: 'play' } })).toBeNull()
  expect(parseGroupMsg({ t: 'control-command', id: 'grant', command: { cmd: 'rate', rate: Infinity } })).toBeNull()
  expect(parseGroupMsg({ t: 'control-answer', id: '../bad', accepted: true })).toBeNull()
})
