import { t } from './i18n'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import type { AudioPeaks } from '@shared/ipc'
import { join } from 'node:path'
import { runTool } from './library/tools'
import { execFile } from 'node:child_process'

export const BEAT_RATE = 22050
export const PEAKS_HZ = 100
const DECODE_TIMEOUT_MS = 5 * 60 * 1000
const WINDOW_TIMEOUT_MS = 60_000
const WINDOW_MAX_MS = 40_000
const WINDOW_CACHE_SIZE = 8
const URL_CACHE_MS = 10 * 60_000

const isUrl = (path: string) => /^https?:\/\//i.test(path)

function ytdlpAudioUrl(ytdlp: string, url: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    execFile(ytdlp, ['-f', 'bestaudio/best', '-g', '--no-playlist', url], { timeout: 60_000, windowsHide: true, signal }, (err, stdout, stderr) => {
      if (signal?.aborted) return reject(signal.reason)
      const line = stdout.split('\n').map((l) => l.trim()).find(Boolean)
      if (err || !line) reject(new Error(`yt-dlp: ${err?.message ?? 'no url'}${stderr ? `: ${stderr.trim()}` : ''}`))
      else resolve(line)
    })
  })
}

export class Audio {
  readonly dir: string
  private readonly windowsDir: string
  private readonly full = new Map<string, Promise<string>>()
  private readonly requests = new Map<string, AbortController>()
  private readonly urls = new Map<string, { input: string; expires: number }>()

  constructor(
    userData: string,
    private readonly ytdlp: string | null,
  ) {
    this.dir = join(userData, 'beat')
    this.windowsDir = join(this.dir, 'windows')
    mkdirSync(this.windowsDir, { recursive: true })
    this.trimWindows()
  }

  private sourceKey(source: string): string {
    const file = isUrl(source) ? null : statSync(source)
    return `${source}:${file?.size ?? 0}:${file?.mtimeMs ?? 0}`
  }

  private async input(source: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    if (!isUrl(source)) return source
    const saved = this.urls.get(source)
    if (saved && saved.expires > Date.now()) return saved.input
    if (!this.ytdlp) throw new Error(t('player.error.needsYtdlp'))
    const input = await ytdlpAudioUrl(this.ytdlp, source, signal)
    signal?.throwIfAborted()
    this.urls.delete(source)
    this.urls.set(source, { input, expires: Date.now() + URL_CACHE_MS })
    if (this.urls.size > 16) this.urls.delete(this.urls.keys().next().value!)
    return input
  }

  private async samples(source: string, out: string, signal?: AbortSignal, window?: { startMs: number; durationMs: number }): Promise<string> {
    const temp = `${out}.${randomUUID()}.tmp`
    try {
      const input = await this.input(source, signal)
      signal?.throwIfAborted()
      const seek = window ? ['-ss', String(window.startMs / 1000)] : []
      const limit = window ? ['-t', String(window.durationMs / 1000)] : []
      try {
        await runTool('ffmpeg', ['-y', '-v', 'error', ...seek, '-i', input, ...limit, '-vn', '-ac', '1', '-ar', String(BEAT_RATE), '-f', 'f32le', temp], window ? WINDOW_TIMEOUT_MS : DECODE_TIMEOUT_MS, signal)
      } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof Error && /does not contain any stream|matches no streams/i.test(error.message)) writeFileSync(temp, Buffer.alloc(0))
        else {
          if (this.urls.get(source)?.input === input) this.urls.delete(source)
          throw error
        }
      }
      signal?.throwIfAborted()
      const size = statSync(temp).size
      const completeBytes = Math.floor(size / 4) * 4
      const bytes = window ? Math.min(completeBytes, Math.floor(window.durationMs * BEAT_RATE / 1000) * 4) : completeBytes
      if (bytes !== size) truncateSync(temp, bytes)
      renameSync(temp, out)
      return out
    } finally {
      rmSync(temp, { force: true })
    }
  }

  private trimWindows(keep?: string) {
    const files = readdirSync(this.windowsDir).filter((name) => /^[a-f0-9]{32}\.f32$/.test(name))
      .map((name) => ({ path: join(this.windowsDir, name), modified: statSync(join(this.windowsDir, name)).mtimeMs }))
      .sort((a, b) => Number(b.path === keep) - Number(a.path === keep) || b.modified - a.modified)
    for (const file of files.slice(WINDOW_CACHE_SIZE)) rmSync(file.path, { force: true })
  }

  cancelWindow(requestId: string): void {
    const controller = this.requests.get(requestId)
    if (!controller) return
    this.requests.delete(requestId)
    controller.abort()
  }

  async window(source: string, startMs: number, durationMs: number, requestId: string): Promise<{ path: string; startMs: number; endMs: number }> {
    this.cancelWindow(requestId)
    const controller = new AbortController()
    this.requests.set(requestId, controller)
    const start = Number.isFinite(startMs) ? Math.max(0, Math.floor(startMs)) : 0
    const duration = Number.isFinite(durationMs) ? Math.max(1, Math.min(WINDOW_MAX_MS, Math.floor(durationMs))) : WINDOW_MAX_MS
    try {
      const key = createHash('sha256').update(`${this.sourceKey(source)}:${start}:${duration}`).digest('hex').slice(0, 32)
      const path = join(this.windowsDir, `${key}.f32`)
      if (!existsSync(path)) await this.samples(source, path, controller.signal, { startMs: start, durationMs: duration })
      controller.signal.throwIfAborted()
      const endMs = start + statSync(path).size / 4 / BEAT_RATE * 1000
      const now = new Date()
      utimesSync(path, now, now)
      this.trimWindows(path)
      return { path, startMs: start, endMs }
    } finally {
      if (this.requests.get(requestId) === controller) this.requests.delete(requestId)
    }
  }

  async decode(source: string): Promise<string> {
    const key = createHash('sha256').update(`complete:${this.sourceKey(source)}`).digest('hex').slice(0, 32)
    const out = join(this.dir, `${key}.f32`)
    if (existsSync(out)) return out
    const existing = this.full.get(out)
    if (existing) return existing
    const job = this.samples(source, out)
    this.full.set(out, job)
    try {
      return await job
    } finally {
      if (this.full.get(out) === job) this.full.delete(out)
    }
  }

  async peaks(source: string): Promise<AudioPeaks> {
    const samplesPath = await this.decode(source)
    const peaksPath = samplesPath.replace(/\.f32$/, '.peaks')
    if (existsSync(peaksPath)) {
      const bytes = readFileSync(peaksPath)
      return { hz: PEAKS_HZ, peaks: new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) }
    }
    const bytes = readFileSync(samplesPath)
    const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - (bytes.byteLength % 4)))
    const per = BEAT_RATE / PEAKS_HZ
    const peaks = new Float32Array(Math.ceil(samples.length / per))
    for (let i = 0; i < peaks.length; i++) {
      const end = Math.min(samples.length, Math.floor((i + 1) * per))
      let m = 0
      for (let j = Math.floor(i * per); j < end; j++) {
        const v = Math.abs(samples[j] ?? 0)
        if (v > m) m = v
      }
      peaks[i] = m
    }
    const temp = `${peaksPath}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, Buffer.from(peaks.buffer))
      renameSync(temp, peaksPath)
    } finally {
      rmSync(temp, { force: true })
    }
    return { hz: PEAKS_HZ, peaks }
  }
}
