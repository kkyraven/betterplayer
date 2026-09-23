import { FILE_CHUNK_BYTES, FILE_TIMEOUT_MS, FILE_WINDOW_BYTES, type GroupMsg, type SharedVideo } from '@shared/together'
import { invoke } from '@/ipc'

export interface FileTransfer {
  peerId: string
  requestId: string
  video: SharedVideo
  direction: 'send' | 'receive'
  status: 'choosing' | 'connecting' | 'transferring' | 'complete' | 'failed'
  bytes: number
}

interface Transfer extends FileTransfer {
  fileId: string | null
  channel: RTCDataChannel | null
  timer: ReturnType<typeof setTimeout> | null
  closed: boolean
  requestTimer: ReturnType<typeof setInterval> | null
  queued: number
  pending: number
  doneReceived: boolean
  acknowledged: number
  pumping: boolean
  sentDone: boolean
  chain: Promise<void>
}

interface Ports {
  changed: (transfers: FileTransfer[]) => void
  send: (peerId: string, message: GroupMsg) => void
  allowed: (peerId: string, video: SharedVideo) => boolean
  received: (path: string, video: SharedVideo) => Promise<void>
}

export class FileTransfers {
  private transfers = new Map<string, Transfer>()
  private progressTimer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly ports: Ports) {}

  private update() {
    if (this.progressTimer) clearTimeout(this.progressTimer)
    this.progressTimer = null
    this.ports.changed([...this.transfers.values()].map(({ peerId, requestId, video, direction, status, bytes }) => ({ peerId, requestId, video, direction, status, bytes })))
  }

  private progress() {
    if (!this.progressTimer) this.progressTimer = setTimeout(() => this.update(), 100)
  }

  private create(peerId: string, requestId: string, video: SharedVideo, direction: FileTransfer['direction']): Transfer {
    const transfer: Transfer = { peerId, requestId, video, direction, status: direction === 'receive' ? 'choosing' : 'connecting', bytes: 0, fileId: null, channel: null, timer: null, closed: false, requestTimer: null, queued: 0, pending: 0, doneReceived: false, acknowledged: 0, pumping: false, sentDone: false, chain: Promise.resolve() }
    this.transfers.set(peerId, transfer)
    this.update()
    return transfer
  }

  private arm(transfer: Transfer) {
    if (transfer.timer) clearTimeout(transfer.timer)
    transfer.timer = setTimeout(() => this.stop(transfer, true), FILE_TIMEOUT_MS)
  }

  private stop(transfer: Transfer, failed: boolean, notify = true) {
    if (transfer.closed) return
    transfer.closed = true
    if (transfer.requestTimer) clearInterval(transfer.requestTimer)
    if (transfer.timer) clearTimeout(transfer.timer)
    if (notify) this.ports.send(transfer.peerId, { t: 'file-cancel', requestId: transfer.requestId })
    transfer.channel?.close()
    if (transfer.fileId) void invoke('together:cancel', transfer.fileId).catch(() => undefined)
    if (failed) transfer.status = 'failed'
    else if (this.transfers.get(transfer.peerId) === transfer) this.transfers.delete(transfer.peerId)
    this.update()
  }

  cancel(peerId: string, requestId?: string) {
    const transfer = this.transfers.get(peerId)
    if (!transfer || (requestId && transfer.requestId !== requestId)) return
    if (transfer.closed) { this.transfers.delete(peerId); this.update() }
    else this.stop(transfer, Boolean(requestId), !requestId)
  }

  clear() {
    for (const transfer of this.transfers.values()) this.stop(transfer, false)
    this.transfers.clear()
    this.update()
  }

  async download(peerId: string, video: SharedVideo) {
    const existing = this.transfers.get(peerId)
    if (existing && !existing.closed) return
    const transfer = this.create(peerId, crypto.randomUUID(), video, 'receive')
    try {
      const fileId = await invoke('together:receiveStart', video)
      if (transfer.closed || !this.ports.allowed(peerId, video)) {
        if (fileId) await invoke('together:cancel', fileId)
        this.stop(transfer, false)
        return
      }
      if (!fileId) { this.stop(transfer, false); return }
      transfer.fileId = fileId
      transfer.status = 'connecting'
      this.arm(transfer)
      this.update()
      const request = () => { if (!transfer.closed && this.ports.allowed(peerId, video)) this.ports.send(peerId, { t: 'file-request', offerId: video.id, requestId: transfer.requestId }) }
      request()
      transfer.requestTimer = setInterval(request, 2000)
    } catch { this.stop(transfer, true) }
  }

  async send(peerId: string, requestId: string, video: SharedVideo, peer: RTCPeerConnection) {
    if (!this.ports.allowed(peerId, video)) return
    const existing = this.transfers.get(peerId)
    if (existing && !existing.closed) return
    const transfer = this.create(peerId, requestId, video, 'send')
    this.arm(transfer)
    try {
      const fileId = await invoke('together:sendStart', video.id)
      if (transfer.closed || !this.ports.allowed(peerId, video)) { await invoke('together:cancel', fileId); this.stop(transfer, false); return }
      transfer.fileId = fileId
      const channel = peer.createDataChannel(`bp-file:${requestId}`, { ordered: true })
      transfer.channel = channel
      channel.onclose = () => this.stop(transfer, true)
      channel.onerror = () => this.stop(transfer, true)
      channel.onmessage = (event) => {
        if (transfer.closed || typeof event.data !== 'string' || event.data.length > 256) return
        try {
          const message: unknown = JSON.parse(event.data)
          if (!message || typeof message !== 'object') throw new Error('Bad acknowledgement')
          const ack = message as Record<string, unknown>
          if (ack.t === 'saving' && transfer.sentDone) { this.arm(transfer); return }
          if (ack.t === 'saved' && transfer.sentDone && transfer.acknowledged === video.size) {
            transfer.status = 'complete'
            transfer.closed = true
            if (transfer.timer) clearTimeout(transfer.timer)
            channel.close()
            this.update()
            return
          }
          if (ack.t !== 'ack' || typeof ack.bytes !== 'number' || !Number.isSafeInteger(ack.bytes) || ack.bytes <= transfer.acknowledged || ack.bytes > transfer.bytes) throw new Error('Bad acknowledgement')
          transfer.acknowledged = ack.bytes
          this.progress()
          this.arm(transfer)
          void pump()
        } catch { this.stop(transfer, true) }
      }
      const pump = async () => {
        if (transfer.pumping || transfer.sentDone || transfer.closed || channel.readyState !== 'open') return
        transfer.pumping = true
        try {
          transfer.status = 'transferring'
          while (!transfer.closed && this.ports.allowed(peerId, video) && transfer.bytes - transfer.acknowledged < FILE_WINDOW_BYTES && channel.bufferedAmount < FILE_WINDOW_BYTES) {
            const chunk = await invoke('together:read', fileId)
            if (transfer.closed || !this.ports.allowed(peerId, video)) return
            if (chunk.digest) {
              transfer.sentDone = true
              channel.send(JSON.stringify({ t: 'done', digest: chunk.digest }))
              transfer.fileId = null
              break
            }
            transfer.bytes += chunk.data.byteLength
            channel.send(new Uint8Array(chunk.data).buffer)
          }
          this.progress()
        } catch { this.stop(transfer, true) }
        finally { transfer.pumping = false }
      }
      channel.bufferedAmountLowThreshold = FILE_WINDOW_BYTES / 2
      channel.onbufferedamountlow = () => { void pump() }
      channel.onopen = () => { this.arm(transfer); void pump() }
    } catch { this.stop(transfer, true) }
  }

  attach(peerId: string, channel: RTCDataChannel) {
    const transfer = this.transfers.get(peerId)
    if (!transfer || transfer.closed || transfer.direction !== 'receive' || !transfer.fileId || transfer.channel || channel.label !== `bp-file:${transfer.requestId}` || !this.ports.allowed(peerId, transfer.video)) { channel.close(); return }
    if (transfer.requestTimer) clearInterval(transfer.requestTimer)
    transfer.requestTimer = null
    const fileId = transfer.fileId
    transfer.channel = channel
    channel.binaryType = 'arraybuffer'
    channel.onopen = () => { transfer.status = 'transferring'; this.arm(transfer); this.update() }
    channel.onerror = () => this.stop(transfer, true)
    channel.onclose = () => this.stop(transfer, true)
    channel.onmessage = (event) => {
      if (transfer.closed) return
      const data: unknown = event.data
      const length = data instanceof ArrayBuffer ? data.byteLength : 0
      if (transfer.doneReceived || transfer.pending >= FILE_WINDOW_BYTES / FILE_CHUNK_BYTES + 1 || transfer.queued + length > FILE_WINDOW_BYTES) { this.stop(transfer, true); return }
      if (data instanceof ArrayBuffer) {
        if (!length || length !== Math.min(FILE_CHUNK_BYTES, transfer.video.size - transfer.bytes - transfer.queued)) { this.stop(transfer, true); return }
      } else if (typeof data === 'string' && data.length <= 256) {
        try {
          const done = JSON.parse(data) as Record<string, unknown>
          if (!done || done.t !== 'done' || typeof done.digest !== 'string' || !/^[a-f0-9]{64}$/.test(done.digest) || transfer.bytes + transfer.queued !== transfer.video.size) throw new Error('Invalid completion')
          transfer.doneReceived = true
        } catch { this.stop(transfer, true); return }
      } else { this.stop(transfer, true); return }
      transfer.queued += length
      transfer.pending++
      transfer.chain = transfer.chain.then(async () => {
        if (transfer.closed || !this.ports.allowed(peerId, transfer.video)) return
        if (data instanceof ArrayBuffer) {
          await invoke('together:write', fileId, transfer.bytes, new Uint8Array(data))
          if (transfer.closed) return
          transfer.bytes += data.byteLength
          transfer.queued -= data.byteLength
          channel.send(JSON.stringify({ t: 'ack', bytes: transfer.bytes }))
        } else if (typeof data === 'string') {
          const raw: unknown = JSON.parse(data)
          if (!raw || typeof raw !== 'object' || !('t' in raw) || raw.t !== 'done' || !('digest' in raw) || typeof raw.digest !== 'string') throw new Error('Invalid transfer')
          if (transfer.timer) clearTimeout(transfer.timer)
          const heartbeat = setInterval(() => { if (!transfer.closed && channel.readyState === 'open') channel.send(JSON.stringify({ t: 'saving' })) }, 5000)
          let path: string
          try { path = await invoke('together:complete', fileId, raw.digest) }
          finally { clearInterval(heartbeat) }
          transfer.fileId = null
          if (transfer.closed) return
          await this.ports.received(path, transfer.video)
          if (transfer.closed) return
          channel.send(JSON.stringify({ t: 'saved' }))
          transfer.status = 'complete'
          transfer.closed = true
          if (transfer.timer) clearTimeout(transfer.timer)
        } else throw new Error('Invalid chunk')
        transfer.pending--
        if (!transfer.closed) { this.arm(transfer); this.progress() }
        else this.update()
      }).catch(() => this.stop(transfer, true))
    }
  }
}
