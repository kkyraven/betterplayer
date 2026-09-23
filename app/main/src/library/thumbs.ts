import { existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { LibraryDb } from './db'
import { runTool, ToolMissingError } from './tools'

const CONCURRENCY = 2
export const STRIP_FRAMES = 20

interface Job {
  id: number
  path: string
  durationMs: number
  cover: string | null
  thumb: boolean
  strip: boolean
}

export interface ThumbHooks {
  done: (id: number) => void
  progress: () => void
}

export class ThumbQueue {
  private readonly queue = new Map<number, Job>()
  private running = 0

  constructor(
    private readonly dataDir: string,
    private readonly db: LibraryDb,
    private readonly hooks: ThumbHooks,
  ) {
    mkdirSync(join(dataDir, 'thumbs'), { recursive: true })
    mkdirSync(join(dataDir, 'strips'), { recursive: true })
  }

  file(kind: 'thumb' | 'strip', id: number): string {
    return join(this.dataDir, kind === 'thumb' ? 'thumbs' : 'strips', `${id}.jpg`)
  }

  pending(): number {
    return this.queue.size + this.running
  }

  enqueue(job: Job) {
    if (!job.thumb && !job.strip) return
    const existing = this.queue.get(job.id)
    if (existing) {
      existing.thumb ||= job.thumb
      existing.strip ||= job.strip
    } else this.queue.set(job.id, { ...job })
    this.hooks.progress()
    this.pump()
  }

  async remove(ids: number[]) {
    for (const id of ids) this.queue.delete(id)
    await Promise.allSettled(ids.flatMap((id) => [unlink(this.file('thumb', id)), unlink(this.file('strip', id))]))
  }

  private pump() {
    while (this.running < CONCURRENCY && this.queue.size > 0) {
      const next = this.queue.values().next()
      if (next.done) return
      const job = next.value
      this.queue.delete(job.id)
      this.running++
      void this.run(job).finally(() => {
        this.running--
        this.hooks.progress()
        this.pump()
      })
    }
  }

  private async run(job: Job) {
    if (job.thumb) await this.make('thumb', job)
    if (job.strip) await this.make('strip', job)
  }

  private async make(kind: 'thumb' | 'strip', job: Job) {
    const out = this.file(kind, job.id)
    const state = this.db.stamp(job.path)?.[kind]
    if (state === 'failed' || (state === 'ready' && existsSync(out))) return
    const temp = `${out}.${randomUUID()}.jpg`
    try {
      await runTool('ffmpeg', kind === 'thumb' ? posterArgs(job, temp) : stripArgs(job, temp), kind === 'thumb' ? 60_000 : 180_000)
      await rename(temp, out)
      this.db.setThumbState(job.id, kind, 'ready')
      this.hooks.done(job.id)
    } catch (e) {
      if (!(e instanceof ToolMissingError) && existsSync(job.path) && !existsSync(out)) this.db.setThumbState(job.id, kind, 'failed')
      process.stderr.write(`thumbnail ${kind} failed for ${job.path}: ${e instanceof Error ? e.message : String(e)}\n`)
    } finally {
      await unlink(temp).catch(() => {})
    }
  }
}

const secondsArg = (ms: number) => (ms / 1000).toFixed(3)

const BASE_ARGS = ['-y', '-v', 'error', '-max_error_rate', '1']

function posterArgs(job: Job, out: string): string[] {
  const input = job.cover ? ['-i', job.cover] : ['-ss', secondsArg(job.durationMs * 0.2), '-i', job.path]
  return [...BASE_ARGS, ...input, '-frames:v', '1', '-vf', 'scale=960:-2:flags=lanczos', '-q:v', '2', out]
}

const STRIP_END_MARGIN_MS = 1000

const STRIP_INPUT_ARGS = ['-skip_frame', 'nokey', '-noaccurate_seek', '-threads', '2']

function stripArgs(job: Job, out: string): string[] {
  const args = [...BASE_ARGS]
  const filters: string[] = []
  const span = Math.max(0, job.durationMs - STRIP_END_MARGIN_MS)
  for (let i = 0; i < STRIP_FRAMES; i++) {
    args.push(...STRIP_INPUT_ARGS, '-ss', secondsArg((span * (i + 0.5)) / STRIP_FRAMES), '-i', job.path)
    filters.push(`[${i}:v]scale=640:-2:flags=lanczos[s${i}]`)
  }
  const inputs = Array.from({ length: STRIP_FRAMES }, (_, i) => `[s${i}]`).join('')
  filters.push(`${inputs}hstack=inputs=${STRIP_FRAMES}`)
  args.push('-filter_complex', filters.join(';'), '-frames:v', '1', '-q:v', '2', out)
  return args
}
