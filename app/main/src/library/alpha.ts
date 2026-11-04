import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { ALPHA_SUFFIX } from '@shared/passthrough'
import { runTool, toolFile } from './tools'

const ALPHA_EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov', 'm4v']
const EYE_HEIGHT = 480
const DEFAULT_GOP_S = 2
const PROBE_TIMEOUT_MS = 60_000

export function besideAlpha(video: string): string | null {
  const stem = join(dirname(video), basename(video, extname(video)))
  for (const suffix of [ALPHA_SUFFIX, ALPHA_SUFFIX.toLowerCase()]) {
    for (const ext of ALPHA_EXTENSIONS) {
      for (const e of [ext, ext.toUpperCase()]) {
        const path = `${stem}${suffix}.${e}`
        if (existsSync(path)) return path
      }
    }
  }
  return null
}

export const appAlpha = (root: string, key: string) => join(root, `${key}${ALPHA_SUFFIX}.mp4`)

export const besideAlphaPath = (video: string) => join(dirname(video), `${basename(video, extname(video))}${ALPHA_SUFFIX}.mp4`)

export function findAlpha(video: string, root: string, key: string): string | null {
  const own = appAlpha(root, key)
  return besideAlpha(video) ?? (existsSync(own) ? own : null)
}

const srgb = (l: number) => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055)

export const ALPHA_GREY = Uint8Array.from({ length: 256 }, (_, v) => (v === 255 ? 255 : Math.round(255 * srgb(v / 255 / 3))))

export function medianOfThree(prev: Uint8Array, cur: Uint8Array, next: Uint8Array, out: Uint8Array): Uint8Array {
  for (let i = 0; i < cur.length; i++) {
    const a = prev[i] ?? 0, b = cur[i] ?? 0, c = next[i] ?? 0
    out[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
  }
  return out
}

interface TrackMeta {
  w: number
  h: number
  fps: number
  layout: 'mono' | 'sbs' | 'ou'
}

async function readMeta(dir: string): Promise<TrackMeta> {
  const raw: unknown = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))
  if (typeof raw !== 'object' || raw === null) throw new Error('mask track: no meta.json')
  const m = raw as Record<string, unknown>
  const layout = m.layout === 'sbs' || m.layout === 'ou' ? m.layout : 'mono'
  const ok = m.version === 2 && m.eye === 2 && [m.w, m.h, m.fps].every((n) => typeof n === 'number' && Number.isInteger(n) && n > 0)
  if (!ok) throw new Error('mask track: not a whole-frame track')
  return { w: m.w as number, h: m.h as number, fps: m.fps as number, layout }
}

async function sourceFacts(video: string, signal?: AbortSignal): Promise<{ width: number; height: number; rate: string; gop: number }> {
  const out = await runTool('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate', '-of', 'json', video], PROBE_TIMEOUT_MS, signal)
  const json: unknown = JSON.parse(out)
  const streams = typeof json === 'object' && json !== null && Array.isArray((json as { streams?: unknown }).streams) ? (json as { streams: Record<string, unknown>[] }).streams : []
  const s = streams[0] ?? {}
  const rateOf = (v: unknown) => (typeof v === 'string' && /^\d+\/[1-9]\d*$/.test(v) && !v.startsWith('0/') ? v : null)
  const rate = rateOf(s.avg_frame_rate) ?? rateOf(s.r_frame_rate) ?? '30/1'
  const [num = 30, den = 1] = rate.split('/').map(Number)
  const fps = num / den
  const keys = await runTool('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-read_intervals', '%+120', '-of', 'csv=p=0', video], PROBE_TIMEOUT_MS, signal).catch(() => '')
  const times = keys.split(/\r?\n/).map(Number).filter((n) => Number.isFinite(n))
  const gaps = times.slice(1).map((t, i) => t - (times[i] ?? 0)).filter((g) => g > 0).sort((a, b) => a - b)
  const gopS = gaps[Math.floor(gaps.length / 2)] ?? DEFAULT_GOP_S
  return {
    width: typeof s.width === 'number' ? s.width : 0,
    height: typeof s.height === 'number' ? s.height : 0,
    rate,
    gop: Math.max(1, Math.min(600, Math.round(gopS * fps))),
  }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

export function alphaSize(width: number, height: number, layout: TrackMeta['layout']): [number, number] {
  const h = Math.min(height || Infinity, layout === 'ou' ? EYE_HEIGHT * 2 : EYE_HEIGHT)
  const aspect = width > 0 && height > 0 ? width / height : layout === 'sbs' ? 2 : layout === 'ou' ? 0.5 : 1
  return [even(h * aspect), even(h)]
}

async function* grids(dir: string, meta: TrackMeta, total: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const size = meta.w * meta.h
  let last = new Uint8Array(size)
  for (let s = 0; s < total; s++) {
    signal?.throwIfAborted()
    const raw = await readFile(join(dir, `${s}.z`)).then((z) => inflateSync(z), () => null)
    for (let i = 0; i < meta.fps; i++) {
      if (raw && raw.length === size * meta.fps) last = new Uint8Array(raw.buffer, raw.byteOffset + i * size, size)
      yield last
    }
  }
}

export async function exportAlpha(video: string, dir: string, out: string, progress?: (done: number) => void, signal?: AbortSignal): Promise<void> {
  const meta = await readMeta(dir)
  const seconds = (await readdir(dir)).map((n) => /^(\d+)\.z$/.exec(n)?.[1]).filter((n) => n !== undefined).map(Number)
  if (seconds.length === 0) throw new Error('mask track: no seconds made')
  const total = Math.max(...seconds) + 1
  const source = await sourceFacts(video, signal)
  const [w, h] = alphaSize(source.width, source.height, meta.layout)
  const part = `${out}.part`
  const args = [
    ...['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${meta.w}x${meta.h}`, '-r', String(meta.fps), '-i', '-'],
    ...['-vf', `scale=${w}:${h}:flags=bicubic,fps=${source.rate}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'],
    ...['-g', String(source.gop), '-keyint_min', String(source.gop), '-sc_threshold', '0', '-an', '-movflags', '+faststart', '-f', 'mp4', part],
  ]
  const ffmpeg = spawn(await toolFile('ffmpeg'), args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
  ffmpeg.stdin.on('error', () => undefined)
  let stderr = ''
  ffmpeg.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
  const exited = new Promise<number | null>((done, fail) => {
    ffmpeg.on('error', fail)
    ffmpeg.on('close', done)
  })
  const kill = () => ffmpeg.kill()
  signal?.addEventListener('abort', kill)
  try {
    const count = total * meta.fps
    const smoothed = new Uint8Array(meta.w * meta.h)
    let prev: Uint8Array | null = null
    let cur: Uint8Array | null = null
    let written = 0
    const write = async (frame: Uint8Array) => {
      const grey = Buffer.allocUnsafe(frame.length)
      for (let i = 0; i < frame.length; i++) grey[i] = ALPHA_GREY[frame[i] ?? 0] ?? 0
      if (!ffmpeg.stdin.write(grey)) await once(ffmpeg.stdin, 'drain')
      if (++written % meta.fps === 0) progress?.(written / count)
    }
    for await (const next of grids(dir, meta, total, signal)) {
      const copy = Uint8Array.from(next)
      if (cur) await write(medianOfThree(prev ?? cur, cur, copy, smoothed))
      prev = cur
      cur = copy
    }
    if (cur) await write(medianOfThree(prev ?? cur, cur, cur, smoothed))
    ffmpeg.stdin.end()
    const code = await exited
    signal?.throwIfAborted()
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').pop() ?? ''}`)
    await rename(part, out)
    progress?.(1)
  } catch (e) {
    ffmpeg.kill()
    await exited.catch(() => undefined)
    await rm(part, { force: true })
    throw e
  } finally {
    signal?.removeEventListener('abort', kill)
  }
}
