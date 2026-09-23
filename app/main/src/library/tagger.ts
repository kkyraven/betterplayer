import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { isUrl } from '@shared/remote'
import { TAGGER_INPUT, TAGGER_WEIGHTS, TAGGER_STILLS, TAGGER_TAGS_FILE, parseTagList, selectTags, type TagEntry } from '@shared/tagging'
import type { LibraryDb } from './db'
import { ToolMissingError, runToolBytes } from './tools'

const IDLE_UNLOAD_MS = 60_000
const STILL_TIMEOUT_MS = 60_000
const PACE_MS = 5000
const END_MARGIN_MS = 1000
const STILL_BYTES = TAGGER_INPUT * TAGGER_INPUT * 3

export interface TagJob {
  id: number
  path: string
  durationMs: number
  headers?: Record<string, string>
}

export interface TagHooks {
  done: (id: number) => void
  progress: () => void
}

const WORKER_SOURCE = `
const { createRequire } = require('node:module')
const { parentPort, workerData } = require('node:worker_threads')
const { WdTagger } = createRequire(workerData.enginePath)(workerData.enginePath)
const tagger = new WdTagger(workerData.modelPath)
parentPort.on('message', ({ id, stills }) => {
  try {
    parentPort.postMessage({ id, probs: tagger.tag(stills) })
  } catch (e) {
    parentPort.postMessage({ id, error: e instanceof Error ? e.message : String(e) })
  }
})
`

interface Reply {
  id: number
  probs?: Float32Array[]
  error?: string
}

const isReply = (m: unknown): m is Reply => typeof m === 'object' && m !== null && typeof (m as Reply).id === 'number'

interface Pending {
  resolve: (probs: Float32Array[]) => void
  reject: (e: Error) => void
}

const warn = (what: string, e: unknown) => process.stderr.write(`${what}: ${e instanceof Error ? e.message : String(e)}\n`)

export class TagQueue {
  private readonly queue = new Map<number, TagJob>()
  private running = false
  private active: { id: number; cancelled: boolean } | null = null
  private enabled = false
  private stopped: string | null = null
  private worker: Worker | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private readonly waiting = new Map<number, Pending>()
  private tagList: Promise<TagEntry[]> | null = null

  constructor(
    private readonly modelsDir: string,
    private readonly enginePath: string,
    private readonly db: LibraryDb,
    private readonly hooks: TagHooks,
  ) {}

  available(): boolean {
    return existsSync(this.modelFile) && existsSync(this.tagsFile)
  }

  private get modelFile() {
    return join(this.modelsDir, TAGGER_WEIGHTS)
  }

  private get tagsFile() {
    return join(this.modelsDir, TAGGER_TAGS_FILE)
  }

  setEnabled(on: boolean) {
    this.enabled = on
    if (on) this.wake()
    else this.hooks.progress()
  }

  wake() {
    this.stopped = null
    this.tagList = null
    this.hooks.progress()
    this.pump()
  }

  pending(): number {
    return this.canRun() ? this.queue.size + (this.running ? 1 : 0) : 0
  }

  enqueue(job: TagJob) {
    if (this.queue.has(job.id)) return
    this.queue.set(job.id, { ...job })
    this.hooks.progress()
    this.pump()
  }

  remove(ids: number[]) {
    for (const id of ids) {
      this.queue.delete(id)
      if (this.active?.id === id) this.active.cancelled = true
    }
  }

  close() {
    this.enabled = false
    if (this.active) this.active.cancelled = true
    this.queue.clear()
    this.unload()
  }

  private canRun(): boolean {
    return this.enabled && this.stopped === null && this.available()
  }

  private pump() {
    if (this.running || !this.canRun()) return
    const next = this.queue.values().next()
    if (next.done) {
      this.idleTimer ??= setTimeout(() => this.unload(), IDLE_UNLOAD_MS)
      return
    }
    const job = next.value
    this.queue.delete(job.id)
    this.running = true
    const active = this.active = { id: job.id, cancelled: false }
    void this.run(job, active).finally(() => {
      this.active = null
      this.running = false
      this.hooks.progress()
      setTimeout(() => this.pump(), PACE_MS)
    })
  }

  private async run(job: TagJob, active: { cancelled: boolean }) {
    if (this.db.stamp(job.path)?.tags !== 'pending') return
    if (job.durationMs <= 0) return
    const stills: Buffer[] = []
    try {
      for (const at of TAGGER_STILLS) {
        stills.push(await still(job, at))
        if (active.cancelled) return
      }
    } catch (e) {
      if (active.cancelled) return
      if (!(e instanceof ToolMissingError) && (isUrl(job.path) || existsSync(job.path))) this.db.setThumbState(job.id, 'tags', 'failed')
      warn(`tagging stills failed for ${job.path}`, e)
      return
    }
    let probs: Float32Array[]
    let tags: TagEntry[]
    try {
      ;[probs, tags] = await Promise.all([this.infer(job.id, stills), this.readTagList()])
    } catch (e) {
      if (active.cancelled) return
      this.stopped = e instanceof Error ? e.message : String(e)
      this.queue.set(job.id, job)
      warn('tagger stopped', e)
      return
    }
    if (active.cancelled) return
    const names = selectTags(tags, probs)
    this.db.transaction(() => {
      this.db.addTags(job.id, names)
      this.db.setThumbState(job.id, 'tags', 'ready')
    })
    this.hooks.done(job.id)
  }

  private readTagList(): Promise<TagEntry[]> {
    this.tagList ??= readFile(this.tagsFile, 'utf8').then((csv) => {
      const list = parseTagList(csv)
      if (list.length === 0) throw new Error(`${TAGGER_TAGS_FILE} is empty`)
      return list
    })
    return this.tagList
  }

  private infer(id: number, stills: Buffer[]): Promise<Float32Array[]> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const worker = this.worker ?? this.spawn()
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      const views = stills.map((s) => new Uint8Array(s))
      worker.postMessage({ id, stills: views }, views.map((v) => v.buffer))
    })
  }

  private spawn(): Worker {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { enginePath: this.enginePath, modelPath: this.modelFile } })
    worker.on('message', (m: unknown) => {
      if (!isReply(m)) return
      const p = this.waiting.get(m.id)
      if (!p) return
      this.waiting.delete(m.id)
      if (m.probs) p.resolve(m.probs)
      else p.reject(new Error(m.error ?? 'tagger failed'))
    })
    const fail = (why: string) => {
      if (this.worker !== worker) return
      this.worker = null
      const waiting = [...this.waiting.values()]
      this.waiting.clear()
      for (const p of waiting) p.reject(new Error(why))
    }
    worker.on('error', (e) => fail(e.message))
    worker.on('exit', (code) => fail(`tagger worker exited with ${code}`))
    worker.unref()
    this.worker = worker
    return worker
  }

  private unload() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const worker = this.worker
    this.worker = null
    void worker?.terminate()
  }
}

async function still(job: TagJob, at: number): Promise<Buffer> {
  const seconds = (Math.max(0, Math.min(job.durationMs * at, job.durationMs - END_MARGIN_MS)) / 1000).toFixed(3)
  const size = TAGGER_INPUT
  const headers = Object.entries(job.headers ?? {}).map(([name, value]) => `${name}: ${value}\r\n`).join('')
  const args = [
    ...['-v', 'error', '-max_error_rate', '1'],
    ...(headers ? ['-headers', headers] : []),
    ...['-ss', seconds, '-i', job.path, '-frames:v', '1', '-an', '-sn'],
    ...['-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${size}:${size}:-1:-1:color=white`],
    ...['-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
  ]
  const bytes = await runToolBytes('ffmpeg', args, STILL_TIMEOUT_MS)
  if (bytes.length !== STILL_BYTES) throw new Error(`still at ${seconds}s is ${bytes.length} bytes, expected ${STILL_BYTES}`)
  return bytes
}
