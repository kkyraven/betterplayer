import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { isIPv4 } from 'node:net'
import { QUEST_DISCOVERY_PORT, QUEST_PAIR_TIMEOUT_MS, QUEST_PROTOCOL, type QuestHeadset, type QuestPairPrompt, type QuestPairRequest, type QuestPinResult, type QuestProbe } from '@shared/quest'

interface Paired {
  id: string
  name: string
  tokenHash: string
  host?: string
}

interface Pending {
  prompt: QuestPairPrompt
  headset: QuestPairRequest
  tries: number
  timer: NodeJS.Timeout
  respond: (status: number, body: unknown) => void
}

const SEEN_MS = 7000
const PIN_TRIES = 5
const PENDING_MAX = 4
const TEXT_LIMIT = 64

const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, TEXT_LIMIT) : '')

export function readProbe(json: string): Required<QuestProbe> | null {
  try {
    const body: unknown = JSON.parse(json)
    if (!isRecord(body) || !text(body.id)) return null
    const v = typeof body.v === 'number' && Number.isSafeInteger(body.v) && body.v > 0 ? body.v : 2
    return { id: text(body.id), name: text(body.name), v }
  } catch {
    return null
  }
}

export function readPairRequest(body: unknown): QuestPairRequest | null {
  if (!isRecord(body) || !text(body.id) || typeof body.pin !== 'string' || !/^\d{4}$/.test(body.pin)) return null
  return { id: text(body.id), name: text(body.name), pin: body.pin }
}

export class QuestPairing {
  readonly id: string
  private paired: Paired[] = []
  private readonly seen = new Map<string, { name: string; host: string; port: number; v: number; at: number; probes: number }>()
  private readonly answers = new Map<string, Set<() => void>>()
  private readonly pending = new Map<string, Pending>()
  private onHeadsets: (list: QuestHeadset[]) => void = () => {}
  private onPrompts: (list: QuestPairPrompt[]) => void = () => {}
  private shown = ''

  constructor(private readonly file?: string) {
    let saved: unknown = null
    try {
      if (file) saved = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
    }
    const record = isRecord(saved) ? saved : {}
    this.id = typeof record.id === 'string' && record.id ? record.id : randomUUID()
    if (Array.isArray(record.headsets)) {
      this.paired = record.headsets.filter((h): h is Paired => isRecord(h) && typeof h.id === 'string' && typeof h.name === 'string' && typeof h.tokenHash === 'string')
    }
    if (!isRecord(saved)) this.save()
    setInterval(() => this.changed(), SEEN_MS / 2).unref()
  }

  setEmitters(headsets: (list: QuestHeadset[]) => void, prompts: (list: QuestPairPrompt[]) => void) {
    this.onHeadsets = headsets
    this.onPrompts = prompts
  }

  isPaired(id: string): boolean {
    return this.paired.some((h) => h.id === id)
  }

  headsetFor(authorization: string | undefined): { id: string; name: string } | null {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
    if (!m?.[1]) return null
    const wanted = hash(m[1])
    const found = this.paired.find((h) => h.tokenHash === wanted)
    return found ? { id: found.id, name: found.name } : null
  }

  proof(headsetId: string, nonce: string, local: string): string | undefined {
    const found = this.paired.find((h) => h.id === headsetId)
    return found && nonce ? createHmac('sha256', Buffer.from(found.tokenHash, 'hex')).update(`${nonce}|${local}`).digest('hex') : undefined
  }

  headsets(now = Date.now()): QuestHeadset[] {
    const heard = (id: string): Pick<QuestHeadset, 'host' | 'looking' | 'update'> => {
      const s = this.seen.get(id)
      if (!s || now - s.at >= SEEN_MS) return { host: null, looking: false }
      const looking = s.probes >= 2
      if (s.v === QUEST_PROTOCOL) return { host: s.host, looking }
      return { host: s.host, looking, update: s.v < QUEST_PROTOCOL ? 'headset' : 'desktop' }
    }
    const paired = this.paired.map((h) => ({ id: h.id, name: this.seen.get(h.id)?.name || h.name, ...heard(h.id), paired: true }))
    const found = [...this.seen.entries()].filter(([id]) => !this.isPaired(id) && heard(id).host !== null).map(([id, s]) => ({ id, name: s.name, ...heard(id), paired: false }))
    return [...paired, ...found]
  }

  prompts(): QuestPairPrompt[] {
    return [...this.pending.values()].map((p) => p.prompt)
  }

  heard(probe: Required<QuestProbe>, host: string, port: number) {
    const probes = (this.seen.get(probe.id)?.probes ?? 0) + 1
    this.seen.set(probe.id, { name: probe.name, host, port, v: probe.v, at: Date.now(), probes })
    this.changed()
  }

  used(headset: { id: string; name: string }, host: string) {
    const known = this.paired.find((h) => h.id === headset.id)
    if (known && isIPv4(host) && known.host !== host) {
      known.host = host
      this.save()
    }
    const s = this.seen.get(headset.id)
    const fresh = s?.host === host && Date.now() - s.at < SEEN_MS / 2 && s.probes === 0
    this.seen.set(headset.id, { name: s?.name || headset.name, host, port: s?.host === host ? s.port : QUEST_DISCOVERY_PORT, v: s?.v ?? QUEST_PROTOCOL, at: Date.now(), probes: 0 })
    this.answered(headset.id)
    if (!fresh) this.changed()
  }

  address(id: string): { host: string; port: number } | null {
    const s = this.seen.get(id)
    return s && Date.now() - s.at < SEEN_MS ? { host: s.host, port: s.port } : null
  }

  quietHosts(now = Date.now()): string[] {
    return this.paired.flatMap((h) => {
      const s = this.seen.get(h.id)
      return h.host && isIPv4(h.host) && !(s && now - s.at < SEEN_MS) ? [h.host] : []
    })
  }

  request(headset: QuestPairRequest, host: string, respond: (status: number, body: unknown) => void): string | null {
    for (const [requestId, p] of this.pending) if (p.headset.id === headset.id) this.finish(requestId, 409, { error: 'replaced' })
    if (this.pending.size >= PENDING_MAX) {
      respond(429, { error: 'busy' })
      return null
    }
    this.answered(headset.id)
    const requestId = randomUUID()
    const timer = setTimeout(() => this.finish(requestId, 408, { error: 'timeout' }), QUEST_PAIR_TIMEOUT_MS)
    this.pending.set(requestId, { prompt: { requestId, name: headset.name || host, host }, headset, tries: 0, timer, respond })
    this.onPrompts(this.prompts())
    return requestId
  }

  pin(requestId: string, pin: string): QuestPinResult {
    const p = this.pending.get(requestId)
    if (!p) return 'gone'
    if (pin !== p.headset.pin) {
      p.tries += 1
      if (p.tries < PIN_TRIES) return 'wrong'
      this.finish(requestId, 403, { error: 'declined' })
      return 'gone'
    }
    const token = randomBytes(32).toString('base64url')
    this.paired = [...this.paired.filter((h) => h.id !== p.headset.id), { id: p.headset.id, name: p.prompt.name, tokenHash: hash(token) }]
    this.save()
    this.finish(requestId, 200, { token })
    this.changed()
    return 'paired'
  }

  decline(requestId: string) {
    this.finish(requestId, 403, { error: 'declined' })
  }

  cancel(requestId: string) {
    const p = this.pending.get(requestId)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(requestId)
    this.onPrompts(this.prompts())
  }

  answer(id: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const waiting = this.answers.get(id) ?? new Set()
      const done = (answered: boolean) => {
        clearTimeout(timer)
        waiting.delete(reached)
        if (waiting.size === 0) this.answers.delete(id)
        resolve(answered)
      }
      const reached = () => done(true)
      const timer = setTimeout(() => done(false), ms)
      waiting.add(reached)
      this.answers.set(id, waiting)
    })
  }

  answered(id: string) {
    for (const reached of [...(this.answers.get(id) ?? [])]) reached()
  }

  forget(id: string) {
    this.paired = this.paired.filter((h) => h.id !== id)
    this.save()
    this.changed()
  }

  endRequests() {
    for (const requestId of [...this.pending.keys()]) this.finish(requestId, 503, { error: 'closing' })
  }

  private finish(requestId: string, status: number, body: unknown) {
    const p = this.pending.get(requestId)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(requestId)
    p.respond(status, body)
    this.onPrompts(this.prompts())
  }

  private changed() {
    const list = this.headsets()
    const key = JSON.stringify(list)
    if (key === this.shown) return
    this.shown = key
    this.onHeadsets(list)
  }

  private save() {
    if (!this.file) return
    try {
      writeFileSync(this.file, JSON.stringify({ id: this.id, headsets: this.paired }))
    } catch (e) {
      process.stderr.write(`quest pairing: ${String(e)}\n`)
    }
  }
}
