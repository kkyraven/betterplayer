import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FILE_CHUNK_BYTES, FILE_WINDOW_BYTES, type SharedVideo } from '@shared/together'
import { FileTransfers, type FileTransfer } from './together-transfer'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@/ipc', () => ({ invoke }))

class Channel {
  label = 'bp-file:request'
  readyState = 'open'
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onbufferedamountlow: (() => void) | null = null
  close = vi.fn()
  send = vi.fn()
  receive(data: unknown) { this.onmessage?.({ data }) }
}

const video: SharedVideo = { id: 'offer', hash: 'a'.repeat(64), name: 'test.mp4', size: 1 }
let transfers: FileTransfers
let views: FileTransfer[]
let channel: Channel
let allowed: boolean
const signal = vi.fn()
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  signal.mockReset()
  channel = new Channel()
  views = []
  allowed = true
  transfers = new FileTransfers({ changed: next => { views = next }, send: signal, allowed: () => allowed, received: async () => {} })
})
afterEach(() => { transfers.clear(); vi.clearAllTimers(); vi.useRealTimers() })

it('waits for verified saving after EOF, without reading a closed handle on the final ACK', async () => {
  let reads = 0
  invoke.mockImplementation(async (method: string) => {
    if (method === 'together:sendStart') return 'out'
    if (method === 'together:read') {
      reads++
      if (reads === 1) return { data: new Uint8Array([42]), digest: null }
      if (reads === 2) return { data: new Uint8Array(), digest: 'd'.repeat(64) }
      throw Error('Read after EOF')
    }
  })
  const peer = { createDataChannel: () => channel } as unknown as RTCPeerConnection
  await transfers.send('guest', 'request', video, peer)
  channel.onopen?.()
  await settle()
  channel.receive(JSON.stringify({ t: 'ack', bytes: 1 }))
  channel.onbufferedamountlow?.()
  await settle()
  expect(reads).toBe(2)
  expect(signal).not.toHaveBeenCalled()
  channel.receive(JSON.stringify({ t: 'saved' }))
  expect(views[0]?.status).toBe('complete')
})

it('limits outgoing reads to the unacknowledged window', async () => {
  let reads = 0
  invoke.mockImplementation(async (method: string) => {
    if (method === 'together:sendStart') return 'out'
    if (method === 'together:read') { reads++; return { data: new Uint8Array(FILE_CHUNK_BYTES), digest: null } }
  })
  await transfers.send('guest', 'request', { ...video, size: FILE_WINDOW_BYTES * 3 }, { createDataChannel: () => channel } as unknown as RTCPeerConnection)
  channel.onopen?.()
  await settle()
  expect(reads).toBe(FILE_WINDOW_BYTES / FILE_CHUNK_BYTES)
  channel.receive(JSON.stringify({ t: 'ack', bytes: FILE_CHUNK_BYTES }))
  await settle()
  expect(reads).toBe(FILE_WINDOW_BYTES / FILE_CHUNK_BYTES + 1)
})

it('does not request data after host revocation during the save dialog', async () => {
  let resolve!: (id: string) => void
  invoke.mockImplementation((method: string) => method === 'together:receiveStart' ? new Promise(done => { resolve = done }) : Promise.resolve())
  const pending = transfers.download('host', video)
  allowed = false
  transfers.cancel('host')
  resolve('incoming')
  await pending
  expect(signal.mock.calls.some(([, msg]) => msg.t === 'file-request')).toBe(false)
  expect(invoke).toHaveBeenCalledWith('together:cancel', 'incoming')
})

it('rejects empty messages before enqueuing disk work', async () => {
  invoke.mockResolvedValue('incoming')
  await transfers.download('host', video)
  const request = signal.mock.calls.find(([, msg]) => msg.t === 'file-request')![1]
  channel.label = `bp-file:${request.requestId}`
  transfers.attach('host', channel as unknown as RTCDataChannel)
  channel.receive(new ArrayBuffer(0))
  await settle()
  expect(views[0]?.status).toBe('failed')
  expect(invoke.mock.calls.some(([method]) => method === 'together:write')).toBe(false)
})

it('retries a queued file request until attached, then stops retrying', async () => {
  invoke.mockResolvedValue('incoming')
  await transfers.download('host', video)
  const request = signal.mock.calls.find(([, msg]) => msg.t === 'file-request')![1]
  vi.advanceTimersByTime(2000)
  expect(signal.mock.calls.filter(([, msg]) => msg.t === 'file-request')).toHaveLength(2)
  channel.label = `bp-file:${request.requestId}`
  transfers.attach('host', channel as unknown as RTCDataChannel)
  vi.advanceTimersByTime(4000)
  expect(signal.mock.calls.filter(([, msg]) => msg.t === 'file-request')).toHaveLength(2)
})
