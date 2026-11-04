import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { open, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PORTAL_HEADERS, VR_PORTAL, type PortalStillInfo } from '@shared/portals'
import type { QuestCensor } from '@shared/quest'
import { isUrl } from '@shared/remote'
import type { RemoteClient } from '../remote/client'
import { coverFilter, mpvColour, portalArc, portalArgs, portalTime, type Colour, type PortalCover, type View } from './thumbs'
import { runTool, ToolMissingError } from './tools'

let look: QuestCensor | null | undefined

export function setPortalCensor(next: QuestCensor | null) {
  look = next
}

export function censorState(): PortalCover {
  return look === undefined ? 'unknown' : look
}

export function censorKey(): string {
  const c = censorState()
  if (c === null || c === 'unknown') return c ?? 'off'
  return sha(JSON.stringify({ style: c.style, strength: c.strength }))
}

const sha = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 10)

export interface PortalSource {
  path: string
  mtimeMs: number
  durationMs: number
  view: View | null
  keyed: boolean
  remote: boolean
}

export interface PortalDeps {
  source: (id: number) => PortalSource | null
  poster: (id: number) => Promise<{ file: string; type: 'image/jpeg' | 'image/webp' }>
  ffmpeg?: (args: string[]) => Promise<string>
  ffprobe?: (args: string[]) => Promise<string>
}

export type PortalStill = { file: string; type: string; info: PortalStillInfo } | { blank: true }

const CONCURRENCY = 2
const FAILURE_MS = 10 * 60_000
const CACHE_BYTES = 512 * 1024 * 1024
const POSTER_COVER_WIDTH = 960

export class PortalStills {
  private readonly ffmpeg: (args: string[]) => Promise<string>
  private readonly ffprobe: (args: string[]) => Promise<string>
  private readonly running = new Map<string, Promise<PortalStill | null>>()
  private readonly failed = new Map<string, number>()
  private readonly waiting: (() => void)[] = []
  private active = 0
  private pruning: Promise<void> | null = null

  constructor(
    private readonly dir: string,
    private readonly deps: PortalDeps,
  ) {
    mkdirSync(dir, { recursive: true })
    this.ffmpeg = deps.ffmpeg ?? ((args) => runTool('ffmpeg', args, 60_000))
    this.ffprobe = deps.ffprobe ?? ((args) => runTool('ffprobe', args, 20_000))
  }

  private async colour(path: string): Promise<Colour> {
    const out = await this.ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_range,width,height', '-of', 'json', path]).catch(() => '{}')
    let stream: Parameters<typeof mpvColour>[0] = {}
    try {
      const parsed: unknown = JSON.parse(out)
      const first = parsed && typeof parsed === 'object' && 'streams' in parsed && Array.isArray(parsed.streams) ? (parsed.streams[0] as unknown) : null
      if (first && typeof first === 'object') stream = first
    } catch {
    }
    return mpvColour(stream)
  }

  async still(id: number, width: 1024 | 2048, ms: number | null): Promise<PortalStill | null> {
    for (;;) {
      const censor = censorKey()
      const still = await this.stillUnder(id, width, ms)
      if (censorKey() === censor) return still
    }
  }

  private async stillUnder(id: number, width: 1024 | 2048, ms: number | null): Promise<PortalStill | null> {
    const src = this.deps.source(id)
    if (!src) return null
    const cover = censorState(), censor = censorKey()
    if (cover !== null && (src.remote || src.keyed)) return { blank: true }
    const view = src.view && src.view.projection.kind !== 'flat' && !src.keyed && !src.remote && !isUrl(src.path) ? src.view : null
    if (view) {
      const arc = portalArc(view.projection)
      const halfDeg: [number, number] = width === 1024 ? [...VR_PORTAL.stills.shelfHalfDeg] : [arc / 2, 90]
      const made = await this.cached(this.name(id, String(width), ms, src.mtimeMs, JSON.stringify(view.projection) + censor + 'colour:1'), async (out) => {
        const time = portalTime(await this.ffmpeg(portalArgs(src.path, view, width, ms, src.durationMs, cover, out, await this.colour(src.path))))
        if (time === null) throw new Error('ffmpeg printed no frame time')
        return { kind: 'equirect', halfDeg, arcDeg: arc, ms: time, censor }
      })
      if (made) return made
    }
    return this.poster(id, cover, censor)
  }

  private async poster(id: number, cover: PortalCover, censor: string): Promise<PortalStill | null> {
    const poster = await this.deps.poster(id)
    const info = await stat(poster.file).catch(() => null)
    if (!info) return null
    const base = { kind: 'poster' as const, halfDeg: [0, 0] as [number, number], arcDeg: 0, ms: 0, censor }
    if (cover === null) return { file: poster.file, type: poster.type, info: base }
    return this.cached(this.name(id, 'poster', null, info.mtimeMs, censor), async (out) => {
      await this.ffmpeg(['-y', '-v', 'error', '-i', poster.file, '-frames:v', '1', '-vf', coverFilter(cover, POSTER_COVER_WIDTH, -2), '-q:v', '3', out])
      return base
    })
  }

  private name(id: number, width: string, ms: number | null, mtimeMs: number, shows: string): string {
    return `${id}-${width}-${ms === null ? 'p' : Math.round(ms)}-${Math.round(mtimeMs)}-${sha(shows)}.jpg`
  }

  private async cached(name: string, make: (out: string) => Promise<PortalStillInfo>): Promise<PortalStill | null> {
    const file = join(this.dir, name)
    const hit = await readFile(`${file}.json`, 'utf8').then((text) => JSON.parse(text) as PortalStillInfo).catch(() => null)
    if (hit && (await stat(file).catch(() => null))) {
      const now = new Date()
      void utimes(file, now, now).catch(() => {})
      return { file, type: 'image/jpeg', info: hit }
    }
    if ((this.failed.get(name) ?? 0) > Date.now()) return null
    const pending = this.running.get(name)
    if (pending) return pending
    const job = this.make(file, name, make).finally(() => this.running.delete(name))
    this.running.set(name, job)
    return job
  }

  private async make(file: string, name: string, make: (out: string) => Promise<PortalStillInfo>): Promise<PortalStill | null> {
    await this.slot()
    const temp = `${file}.${process.pid}.${Date.now()}.tmp.jpg`
    const tempInfo = `${temp}.json`
    try {
      const info = await make(temp)
      await writeFile(tempInfo, JSON.stringify(info))
      await rename(tempInfo, `${file}.json`)
      await rename(temp, file)
      this.prune()
      return { file, type: 'image/jpeg', info }
    } catch (e) {
      await Promise.allSettled([unlink(temp), unlink(tempInfo)])
      if (e instanceof ToolMissingError) throw e
      this.failed.set(name, Date.now() + FAILURE_MS)
      process.stderr.write(`portal still ${name} failed: ${e instanceof Error ? e.message : String(e)}
`)
      return null
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }

  private async slot() {
    if (this.active >= CONCURRENCY) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
  }

  private prune() {
    this.pruning ??= (async () => {
      const names = (await readdir(this.dir).catch(() => [])).filter((n) => n.endsWith('.jpg') && !n.includes('.tmp.'))
      const files = (await Promise.all(names.map(async (n) => ({ n, s: await stat(join(this.dir, n)).catch(() => null) })))).flatMap(({ n, s }) => (s ? [{ n, size: s.size, mtime: s.mtimeMs }] : []))
      let total = files.reduce((sum, f) => sum + f.size, 0)
      for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
        if (total <= CACHE_BYTES) break
        await Promise.allSettled([unlink(join(this.dir, f.n)), unlink(join(this.dir, `${f.n}.json`))])
        total -= f.size
      }
    })().finally(() => (this.pruning = null))
  }
}

export function portalHeaders(info: PortalStillInfo): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    [PORTAL_HEADERS.kind]: info.kind,
    [PORTAL_HEADERS.half]: info.halfDeg.join(','),
    [PORTAL_HEADERS.arc]: String(info.arcDeg),
    [PORTAL_HEADERS.ms]: info.ms.toFixed(3),
    [PORTAL_HEADERS.censor]: info.censor,
  }
}

export const blankHeaders = () => ({ 'Cache-Control': 'no-store', [PORTAL_HEADERS.kind]: 'blank', [PORTAL_HEADERS.censor]: censorKey() })

export function readPortalAsk(id: string | undefined, params: URLSearchParams): { id: number; width: 1024 | 2048; ms: number | null } | null {
  const n = Number(id)
  const w = Number(params.get('w') ?? 1024)
  const ms = params.get('ms')
  if (!Number.isSafeInteger(n) || n <= 0 || (w !== 1024 && w !== 2048)) return null
  if (ms !== null && !(Number.isFinite(Number(ms)) && Number(ms) >= 0)) return null
  return { id: n, width: w, ms: ms === null ? null : Number(ms) }
}

export async function servePortalThumb(lib: { portals: Pick<PortalStills, 'still'> }, source: Pick<RemoteClient, 'active' | 'thumb'>, url: string, signal?: AbortSignal): Promise<Response> {
  const { pathname, searchParams } = new URL(url)
  const ask = readPortalAsk(pathname.slice(1), searchParams)
  if (!ask) return new Response(null, { status: 404 })
  if (source.active) {
    const blank = () => new Response(null, { status: 204, headers: blankHeaders() })
    if (censorState() !== null) return blank()
    const poster = await source.thumb(`thumb://media/${ask.id}`, null, signal)
    if (censorState() !== null) return blank()
    if (!poster.ok) return new Response(null, { status: 404 })
    const headers = new Headers(poster.headers)
    for (const [k, v] of Object.entries(portalHeaders({ kind: 'poster', halfDeg: [0, 0], arcDeg: 0, ms: 0, censor: 'off' }))) headers.set(k, v)
    return new Response(poster.body, { headers })
  }
  try {
    const still = await lib.portals.still(ask.id, ask.width, ask.ms)
    if (!still) return new Response(null, { status: 404 })
    if ('blank' in still) return new Response(null, { status: 204, headers: blankHeaders() })
    const bytes = await readFile(still.file)
    return new Response(bytes, { headers: { 'Content-Type': still.type, ...portalHeaders(still.info) } })
  } catch (e) {
    return new Response(null, { status: e instanceof ToolMissingError ? 503 : 404 })
  }
}

const MIB = 1024 * 1024
const CHUNK = 4 * MIB

export async function readAhead(path: string, startMs: number, durationMs: number, signal: AbortSignal): Promise<void> {
  if (isUrl(path) || signal.aborted) return
  const file = await open(path, 'r').catch(() => null)
  if (!file) return
  try {
    const { size } = await file.stat()
    const buffer = Buffer.allocUnsafe(CHUNK)
    const from = durationMs > 0 ? Math.floor((size * Math.max(0, startMs)) / durationMs) : 0
    const to = durationMs > 0 ? Math.min(size, Math.ceil((size * (Math.max(0, startMs) + VR_PORTAL.ms.preload)) / durationMs)) : Math.min(size, CHUNK)
    const ranges: [number, number][] = [[0, Math.min(size, MIB)], [Math.max(0, size - MIB), size], [from, to]]
    for (const [start, end] of ranges) {
      for (let at = start; at < end; at += CHUNK) {
        if (signal.aborted) return
        await file.read(buffer, 0, Math.min(CHUNK, end - at), at)
      }
    }
  } catch {
  } finally {
    await file.close().catch(() => {})
  }
}
