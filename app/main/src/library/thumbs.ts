import { existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { rename, unlink } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { flatEye, type Projection } from '@shared/projection'
import { VR_PORTAL } from '@shared/portals'
import type { QuestCensor } from '@shared/quest'
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

export interface View {
  projection: Projection
  width: number
  height: number
}

const VIEW_VERSION = 1
const VR_VIEW_DEGREES = 100

export function viewKey(view: View | null): string {
  const p = view?.projection
  if (!p || (p.kind === 'flat' && p.layout === 'mono')) return ''
  return [VIEW_VERSION, p.kind, p.layout, p.kind === 'fisheye' ? p.fov : ''].join(':')
}

const V360_INPUT = { equirect180: 'hequirect', equirect360: 'equirect', fisheye: 'fisheye' } as const

export function viewFilter(view: View | null, width: number): string {
  const p = view?.projection
  if (!view || !p || !viewKey(view)) return `scale=${width}:-2:flags=lanczos`
  const eye = p.layout === 'sbs' ? 'crop=iw/2:ih:0:0,' : p.layout === 'ou' ? 'crop=iw:ih/2:0:0,' : ''
  if (p.kind === 'flat') {
    const shown = flatEye(p, view.width, view.height)
    const height = shown.width > 0 && shown.height > 0 ? 2 * Math.round((width * shown.height) / shown.width / 2) : -2
    return `${eye}scale=${width}:${height}:flags=lanczos`
  }
  const height = 2 * Math.round((width * 9) / 16 / 2)
  const vDegrees = ((2 * Math.atan(Math.tan((VR_VIEW_DEGREES * Math.PI) / 360) * (9 / 16))) * 180) / Math.PI
  const lens = p.kind === 'fisheye' ? `:ih_fov=${p.fov}:iv_fov=${p.fov}` : ''
  return `${eye}v360=input=${V360_INPUT[p.kind]}${lens}:output=flat:h_fov=${VR_VIEW_DEGREES}:v_fov=${vDegrees.toFixed(2)}:w=${width}:h=${height}:interp=lanczos`
}

export function viewScale(view: View, width: number): number {
  const p = view.projection
  const eye = p.layout === 'sbs' ? view.width / 2 : view.width
  if (eye <= 0) return 1
  const degrees = p.kind === 'equirect180' ? 180 : p.kind === 'equirect360' ? 360 : p.kind === 'fisheye' ? p.fov : null
  return degrees === null ? width / eye : width / ((eye * VR_VIEW_DEGREES) / degrees)
}

export interface ThumbHooks {
  done: (id: number) => void
  progress: () => void
  view: (id: number) => View | null
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
    const view = kind === 'thumb' && job.cover ? null : this.hooks.view(job.id)
    const key = viewKey(view)
    const stamp = this.db.stamp(job.path)
    const state = stamp?.[kind]
    if (state === 'failed' || (state === 'ready' && existsSync(out) && stamp?.views[kind] === key)) return
    const temp = `${out}.${randomUUID()}.jpg`
    try {
      const source = { ...job, codec: stamp?.codec }
      await (kind === 'thumb' ? makePoster(source, view, temp) : makeStrip(source, view, temp))
      await rename(temp, out)
      this.db.setThumbState(job.id, kind, 'ready', key)
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

const KEY_ONLY = new Set(['hevc', 'av1', 'vp9'])
const keyOnly = (codec: string | undefined) => codec !== undefined && KEY_ONLY.has(codec)

type Source = Pick<Job, 'path' | 'durationMs'> & { codec?: string }

const POSTER_KEY_MS = 5000

export function posterArgs(job: Source & Pick<Job, 'cover'>, view: View | null, out: string, exact = false): string[] {
  if (job.cover) return [...BASE_ARGS, '-i', job.cover, '-frames:v', '1', '-vf', viewFilter(null, 960), '-q:v', '2', out]
  const at = secondsArg(job.durationMs * 0.2)
  const skip = keyOnly(job.codec) ? ['-skip_frame', 'nokey'] : []
  const seek = exact ? ['-ss', at] : ['-copyts', '-start_at_zero', ...skip, '-thread_type', 'slice', '-flags', 'low_delay', '-ss', at, '-noaccurate_seek']
  const print = exact ? '' : 'metadata=mode=add:key=bp:value=1,metadata=mode=print:file=-,'
  return [...BASE_ARGS, ...seek, '-i', job.path, '-frames:v', '1', '-vf', `${print}${viewFilter(view, 960)}`, '-q:v', '2', out]
}

export async function makePoster(job: Source & Pick<Job, 'cover'>, view: View | null, out: string): Promise<void> {
  const printed = await runTool('ffmpeg', posterArgs(job, view, out), 60_000)
  if (job.cover) return
  const time = portalTime(printed)
  if (time === null || job.durationMs * 0.2 - time > POSTER_KEY_MS) await runTool('ffmpeg', posterArgs(job, view, out, true), 60_000)
}

const STRIP_END_MARGIN_MS = 1000

const KEY_INPUT = ['-skip_frame', 'nokey', '-flags', 'low_delay', '-noaccurate_seek', '-threads', '2']
const FIRST_INPUT = ['-thread_type', 'slice', '-flags', 'low_delay', '-noaccurate_seek', '-threads', '2']

const STRIP_RUNS = Math.max(1, Math.min(5, Math.floor(availableParallelism() / 2 / CONCURRENCY)))

function stripArgs(job: Source, view: View | null, out: string, from = 0, to = STRIP_FRAMES): string[] {
  const args = [...BASE_ARGS]
  const filters: string[] = []
  const span = Math.max(0, job.durationMs - STRIP_END_MARGIN_MS)
  const keys = keyOnly(job.codec)
  for (let i = from; i < to; i++) {
    args.push(...(keys ? KEY_INPUT : FIRST_INPUT), '-ss', secondsArg((span * (i + 0.5)) / STRIP_FRAMES), '-i', job.path)
    filters.push(`[${i - from}:v]${keys ? '' : 'setpts=N,'}${viewFilter(view, 640)}[s${i - from}]`)
  }
  const n = to - from
  filters.push(n > 1 ? `${Array.from({ length: n }, (_, i) => `[s${i}]`).join('')}hstack=inputs=${n}` : '[s0]null')
  const write = out.endsWith('.nut') ? ['-an', '-fps_mode', 'passthrough', '-c:v', 'rawvideo'] : ['-q:v', '2']
  args.push('-filter_complex', filters.join(';'), '-frames:v', '1', ...write, out)
  return args
}

export async function makeStrip(job: Source, view: View | null, out: string, runs = STRIP_RUNS): Promise<void> {
  const size = Math.ceil(STRIP_FRAMES / runs)
  if (size >= STRIP_FRAMES) {
    await runTool('ffmpeg', stripArgs(job, view, out), 180_000)
    return
  }
  const shares = Array.from({ length: Math.ceil(STRIP_FRAMES / size) }, (_, i) => ({ from: i * size, to: Math.min(STRIP_FRAMES, (i + 1) * size), file: `${out}.${i}.nut` }))
  try {
    const made = await Promise.allSettled(shares.map((s) => runTool('ffmpeg', stripArgs(job, view, s.file, s.from, s.to), 180_000)))
    const failed = made.find((r) => r.status === 'rejected')
    if (failed) throw failed.reason
    const stack = `${shares.map((_, i) => `[${i}:v]`).join('')}hstack=inputs=${shares.length}`
    await runTool('ffmpeg', [...BASE_ARGS, ...shares.flatMap((s) => ['-i', s.file]), '-filter_complex', stack, '-frames:v', '1', '-q:v', '2', out], 60_000)
  } finally {
    await Promise.allSettled(shares.map((s) => unlink(s.file)))
  }
}

export type PortalCover = QuestCensor | 'unknown' | null

export function portalArc(p: Projection): number {
  return p.kind === 'equirect360' ? 360 : p.kind === 'equirect180' ? (p.arc ?? 180) : 180
}

export function coverFilter(cover: QuestCensor | 'unknown', w: number, h: number, share = 1): string {
  const look = cover === 'unknown' ? { style: 'blur' as const, strength: 1 } : cover
  const t = Math.min(1, Math.max(0, look.strength))
  const pixels = look.style === 'pixelate'
  const cells = pixels ? 64 + (14 - 64) * t : 160 + (24 - 160) * t
  return `scale=${Math.max(2, Math.round(cells * share))}:-2:flags=area,scale=${w}:${h}:flags=${pixels ? 'neighbor' : 'bicubic'}`
}

export const SHELF_COVER_SHARE = VR_PORTAL.portal.w / VR_PORTAL.radius / (VR_PORTAL.portal.field * Math.PI)

export interface Colour {
  matrix: 'bt601' | 'bt709' | 'bt2020'
  range: 'tv' | 'pc'
}

export function mpvColour(stream: { color_space?: string; color_range?: string; width?: number; height?: number }): Colour {
  const space = stream.color_space ?? ''
  const matrix = space === 'bt709' ? 'bt709' : space === 'bt470bg' || space === 'smpte170m' ? 'bt601' : space.startsWith('bt2020') ? 'bt2020' : (stream.width ?? 0) >= 1280 || (stream.height ?? 0) > 576 ? 'bt709' : 'bt601'
  return { matrix, range: stream.color_range === 'pc' ? 'pc' : 'tv' }
}

const colourArgs = (c: Colour) => `:in_color_matrix=${c.matrix}:out_color_matrix=bt601:in_range=${c.range}:out_range=pc`

export function portalFilter(view: View, width: 1024 | 2048, cover: PortalCover, colour?: Colour): string | null {
  const p = view.projection
  if (p.kind === 'flat') return null
  const second = p.swapEyes ? 1 : 0
  const eye = p.layout === 'sbs' ? `crop=iw/2:ih:${second ? 'iw/2' : '0'}:0,` : p.layout === 'ou' ? `crop=iw:ih/2:0:${second ? 'ih/2' : '0'},` : ''
  const [w, h] = [width, p.kind === 'equirect360' ? width / 2 : width]
  const fisheye = p.kind === 'fisheye' ? `v360=input=fisheye:ih_fov=${p.fov}:iv_fov=${p.fov}:output=hequirect:w=${w}:h=${h}:interp=lanczos,` : ''
  const convert = colour ? `${colourArgs(colour)},format=yuvj420p` : ''
  const covered = cover === null ? '' : `,${coverFilter(cover, w, h, width === 1024 ? SHELF_COVER_SHARE : 1)}`
  return `${eye}${fisheye}scale=${w}:${h}:flags=lanczos${convert}${covered}`
}

export function portalTime(printed: string): number | null {
  const m = printed.match(/pts_time:(-?\d+(?:\.\d+)?)/)
  return m ? Math.round(Number(m[1]) * 1e6) / 1e3 : null
}

export function portalArgs(path: string, view: View, width: 1024 | 2048, ms: number | null, durationMs: number, cover: PortalCover, out: string, colour?: Colour, codec?: string): string[] {
  const filter = portalFilter(view, width, cover, colour) ?? `scale=${width}:-2:flags=lanczos`
  const at = ms ?? durationMs * 0.2
  const skip = keyOnly(codec) ? ['-skip_frame', 'nokey'] : []
  return [
    ...BASE_ARGS, '-copyts', '-start_at_zero', ...skip, '-thread_type', 'slice', '-flags', 'low_delay', '-ss', secondsArg(Math.max(0, at)), '-noaccurate_seek', '-i', path,
    '-frames:v', '1', '-vf', `metadata=mode=add:key=bp:value=1,metadata=mode=print:file=-,${filter}`, '-q:v', '3', out,
  ]
}
