import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { isAxisId } from '@shared/axes'
import type { ScriptInfo } from '../../../../engine/index'
import type { ScriptRow, ScriptSummary } from './db'

type ScanScripts = (path: string, folders?: string[]) => ScriptInfo[] | Promise<ScriptInfo[]>

export const HEAT_BUCKETS = 60

export function downsample(values: number[], buckets: number): number[] {
  if (values.length === 0) return []
  const out: number[] = []
  for (let i = 0; i < buckets; i++) {
    const from = Math.floor((i * values.length) / buckets)
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / buckets))
    let sum = 0
    for (let j = from; j < to; j++) sum += values[j] ?? 0
    out.push(sum / (to - from))
  }
  return out
}

export function summarise(scripts: ScriptRow[]): ScriptSummary {
  const stroke = scripts.find((s) => s.axis === 'L0') ?? scripts[0]
  return {
    axes: scripts.map((s) => s.axis),
    averageSpeed: stroke?.averageSpeed ?? 0,
    heat: stroke?.axis === 'L0' ? downsample(stroke.heatmap, HEAT_BUCKETS) : [],
  }
}

const WORKER_SOURCE = `
const { createRequire } = require('node:module')
const { parentPort, workerData } = require('node:worker_threads')
const { scanScripts } = createRequire(workerData.enginePath)(workerData.enginePath)
parentPort.on('message', async ({ id, path, folders }) => {
  try {
    parentPort.postMessage({ id, scripts: await scanScripts(path, folders) })
  } catch (e) {
    parentPort.postMessage({ id, error: e instanceof Error ? e.message : String(e) })
  }
})
`

interface Reply {
  id: number
  scripts?: ScriptInfo[]
  error?: string
}

const isReply = (m: unknown): m is Reply => typeof m === 'object' && m !== null && typeof (m as Reply).id === 'number'

interface Pending {
  path: string
  folders: string[]
  resolve: (scripts: ScriptInfo[]) => void
  reject: (e: unknown) => void
}

const warn = (what: string, e: unknown) => process.stderr.write(`${what}: ${e instanceof Error ? e.message : String(e)}\n`)

export class ScriptScanner {
  private worker: Worker | null = null
  private inMain: ScanScripts | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 0

  constructor(private readonly enginePath: string) {}

  async scriptsFor(path: string, folders: string[] = []): Promise<ScriptRow[]> {
    const rows: ScriptRow[] = []
    for (const s of await this.scan(path, folders)) {
      if (!isAxisId(s.axis) || !s.selected) continue
      rows.push({
        axis: s.axis,
        source: s.source,
        container: s.container,
        actions: s.actions,
        durationMs: s.durationMs,
        averageSpeed: s.averageSpeed,
        maxSpeed: s.maxSpeed,
        heatmap: s.heatmap,
      })
    }
    return rows
  }

  private scan(path: string, folders: string[]): Promise<ScriptInfo[]> {
    if (this.inMain) return Promise.resolve(this.inMain(path, folders))
    const worker = this.worker ?? this.spawn()
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      this.pending.set(id, { path, folders, resolve, reject })
      worker.ref()
      worker.postMessage({ id, path, folders })
    })
  }

  private spawn(): Worker {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { enginePath: this.enginePath } })
    worker.on('message', (m: unknown) => {
      if (!isReply(m)) return
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (this.pending.size === 0) worker.unref()
      if (m.scripts) p.resolve(m.scripts)
      else p.reject(new Error(m.error ?? 'scanScripts failed'))
    })
    const fail = (why: string) => {
      if (this.worker !== worker) return
      this.worker = null
      warn('script scan worker stopped, scanning in main instead', why)
      try {
        this.inMain = this.loadInMain()
      } catch (e) {
        warn('engine addon failed to load, scripts will not be read', e)
        this.inMain = () => Promise.reject(e)
      }
      const scan = this.inMain
      const waiting = [...this.pending.values()]
      this.pending.clear()
      for (const p of waiting) {
        Promise.resolve()
          .then(() => scan(p.path, p.folders))
          .then(p.resolve, p.reject)
      }
    }
    worker.on('error', (e) => fail(e.message))
    worker.on('exit', (code) => fail(`exit ${code}`))
    worker.unref()
    this.worker = worker
    return worker
  }

  private loadInMain(): ScanScripts {
    const mod: { scanScripts: ScanScripts } = createRequire(__filename)(this.enginePath)
    return mod.scanScripts
  }
}
