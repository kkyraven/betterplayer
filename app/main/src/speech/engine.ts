import { Worker } from 'node:worker_threads'

export interface SpeechFiles { encoder: string; decoder: string; tokenizer: string; vad: string }

export interface SpeechEar {
  vad(pcm: Int16Array): Promise<Float32Array>
  reset(): Promise<void>
}

export interface SpeechVoice {
  transcribe(pcm: Int16Array, prompt: string): Promise<string>
}

type Role = 'ear' | 'voice'

const IDLE_UNLOAD_MS = 60_000

const WORKER_SOURCE = `
const { createRequire } = require('node:module')
const { parentPort, workerData } = require('node:worker_threads')
const engine = createRequire(workerData.enginePath)(workerData.enginePath)
const f = workerData.files
const model = workerData.role === 'ear' ? new engine.SpeechVad(f.vad) : new engine.SpeechModel(f.encoder, f.decoder, f.tokenizer)
parentPort.on('message', ({ id, op, pcm, prompt }) => {
  try {
    if (op === 'vad') parentPort.postMessage({ id, probs: model.vad(pcm) })
    else if (op === 'reset') { model.reset(); parentPort.postMessage({ id }) }
    else parentPort.postMessage({ id, text: model.transcribe(pcm, prompt) })
  } catch (e) {
    parentPort.postMessage({ id, error: e instanceof Error ? e.message : String(e) })
  }
})
`

interface Reply { id: number; probs?: Float32Array; text?: string; error?: string }
const isReply = (m: unknown): m is Reply => typeof m === 'object' && m !== null && typeof (m as Reply).id === 'number'

class WorkerHost {
  private worker: Worker | null = null
  private idle: NodeJS.Timeout | null = null
  private next = 0
  private readonly waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>()

  constructor(private readonly role: Role, private readonly enginePath: string, private readonly files: () => SpeechFiles | null) {}

  warm() {
    if (!this.worker && this.files()) this.spawn()
    this.touch()
  }

  call(op: 'vad' | 'reset' | 'transcribe', pcm?: Int16Array, prompt?: string): Promise<Reply> {
    const worker = this.worker ?? this.spawn()
    this.touch()
    const id = this.next++
    return new Promise<Reply>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      const copy = pcm ? pcm.slice() : undefined
      worker.postMessage({ id, op, pcm: copy, prompt }, copy ? [copy.buffer] : [])
    }).finally(() => this.touch())
  }

  private touch() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.unload(), IDLE_UNLOAD_MS)
    this.idle.unref()
  }

  private spawn(): Worker {
    const files = this.files()
    if (!files) throw new Error('voice models are not downloaded')
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { role: this.role, enginePath: this.enginePath, files } })
    worker.on('message', (m: unknown) => {
      if (!isReply(m)) return
      const p = this.waiting.get(m.id)
      if (!p) return
      this.waiting.delete(m.id)
      if (m.error !== undefined) p.reject(new Error(m.error))
      else p.resolve(m)
    })
    const fail = (why: string) => {
      if (this.worker !== worker) return
      this.worker = null
      const waiting = [...this.waiting.values()]
      this.waiting.clear()
      for (const p of waiting) p.reject(new Error(why))
    }
    worker.on('error', (e) => fail(e.message))
    worker.on('exit', (code) => fail(`speech ${this.role} worker exited with ${code}`))
    worker.unref()
    this.worker = worker
    return worker
  }

  private unload() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    if (this.waiting.size > 0) return this.touch()
    const worker = this.worker
    this.worker = null
    void worker?.terminate()
  }
}

export class WorkerEar implements SpeechEar {
  private readonly host: WorkerHost
  constructor(enginePath: string, files: () => SpeechFiles | null) {
    this.host = new WorkerHost('ear', enginePath, files)
  }
  warm() { this.host.warm() }
  vad(pcm: Int16Array) { return this.host.call('vad', pcm).then((r) => r.probs ?? new Float32Array()) }
  reset() { return this.host.call('reset').then(() => undefined) }
}

export class WorkerVoice implements SpeechVoice {
  private readonly host: WorkerHost
  constructor(enginePath: string, files: () => SpeechFiles | null) {
    this.host = new WorkerHost('voice', enginePath, files)
  }
  warm() { this.host.warm() }
  transcribe(pcm: Int16Array, prompt: string) { return this.host.call('transcribe', pcm, prompt).then((r) => r.text ?? '') }
}
