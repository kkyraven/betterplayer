import { autoKey, eyeToFrame, patchColour, resolvePassthrough, type AutoKey, type PassthroughSettings, type ResolvedPassthrough } from '@shared/passthrough'
import type { Projection } from '@shared/projection'
import { isUrl } from '@shared/remote'
import type { LibraryDb, PassthroughFacts } from './db'
import { runToolBytes } from './tools'

export interface Frame {
  rgb: Uint8Array
  w: number
  h: number
}

const FRAME_WIDTH = 320
const FRAME_TIMEOUT_MS = 20_000
const AUTO_AT_SEC = 10
const PICK_RADIUS = 2

export async function readFrame(path: string, atSec: number, headers?: Record<string, string>, signal?: AbortSignal): Promise<Frame | null> {
  const lines = Object.entries(headers ?? {}).map(([name, value]) => `${name}: ${value}\r\n`).join('')
  const args = [
    ...['-v', 'error', ...(lines ? ['-headers', lines, '-user_agent', 'BetterPlayer'] : []), ...(atSec > 0 ? ['-ss', atSec.toFixed(3)] : [])],
    ...['-i', path, '-frames:v', '1', '-an', '-sn', '-vf', `scale=${FRAME_WIDTH}:-2:flags=area,format=rgb24`, '-f', 'rawvideo', '-'],
  ]
  const rgb = await runToolBytes('ffmpeg', args, FRAME_TIMEOUT_MS, signal)
  const h = Math.floor(rgb.length / (FRAME_WIDTH * 3))
  return h < 2 ? null : { rgb: rgb.subarray(0, FRAME_WIDTH * h * 3), w: FRAME_WIDTH, h }
}

export function pickColour(frame: Frame, u: number, v: number, p: Projection): number | null {
  const [x, y] = eyeToFrame(u, v, p)
  const px = Math.min(frame.w - 1, Math.floor(x * frame.w))
  const py = Math.min(frame.h - 1, Math.floor(y * frame.h))
  return patchColour(frame.rgb, frame.w, frame.h, px, py, PICK_RADIUS)
}

const fileName = (path: string) => (path.split(/[\\/]/).pop() ?? '').replace(/[?#].*$/, '').replace(/\.[^.]*$/, '')

export interface PassthroughDeps {
  projection(path: string): Promise<Projection>
  headers(path: string): Record<string, string> | undefined
  alpha(path: string): string | null
  read?: typeof readFrame
}

export class Passthrough {
  private readonly runs = new Map<string, Promise<AutoKey | null>>()
  private readonly abort = new AbortController()
  private readonly read: typeof readFrame

  constructor(
    private readonly db: LibraryDb,
    private readonly deps: PassthroughDeps,
  ) {
    this.read = deps.read ?? readFrame
  }

  async resolve(path: string, saved: PassthroughSettings | undefined, waitMs = Infinity): Promise<ResolvedPassthrough> {
    const facts = this.db.passthroughFacts(path)
    const name = facts?.name ?? fileName(path)
    const alpha = isUrl(path) ? null : this.deps.alpha(path)
    const aiReady = alpha !== null
    const withAlpha = (r: ResolvedPassthrough): ResolvedPassthrough => (alpha && r.mode === 'ai' ? { ...r, alpha } : r)
    const cached = facts?.auto ?? null
    const first = withAlpha(resolvePassthrough(saved, name, cached, aiReady))
    if (!first.on || first.settings.key !== null || cached !== null) return first
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = Number.isFinite(waitMs) ? new Promise<null>((done) => (timer = setTimeout(done, waitMs, null))) : null
    const auto = await (late ? Promise.race([this.auto(path, facts), late]) : this.auto(path, facts))
    clearTimeout(timer)
    return auto ? withAlpha(resolvePassthrough(saved, name, auto, aiReady)) : first
  }

  async sample(path: string, timeSec: number, u: number, v: number): Promise<number | null> {
    try {
      const [projection, frame] = await Promise.all([this.deps.projection(path), this.read(path, Math.max(0, timeSec), this.deps.headers(path), this.abort.signal)])
      return frame ? pickColour(frame, u, v, projection) : null
    } catch (e) {
      if (!this.abort.signal.aborted) process.stderr.write(`passthrough pick failed for ${path}: ${e instanceof Error ? e.message : String(e)}\n`)
      return null
    }
  }

  close() {
    this.abort.abort()
    this.runs.clear()
  }

  private auto(path: string, facts: PassthroughFacts | null): Promise<AutoKey | null> {
    let run = this.runs.get(path)
    if (!run) {
      run = this.sampleAuto(path, facts?.durationMs ?? 0).then(
        (auto) => {
          if (facts && auto && !this.abort.signal.aborted) {
            this.db.setPassthroughAuto(facts.id, auto)
            this.runs.delete(path)
          }
          return auto
        },
        (e: unknown) => {
          if (!this.abort.signal.aborted) process.stderr.write(`passthrough auto colour failed for ${path}: ${e instanceof Error ? e.message : String(e)}\n`)
          return null
        },
      )
      this.runs.set(path, run)
    }
    return run
  }

  private async sampleAuto(path: string, durationMs: number): Promise<AutoKey | null> {
    const projection = await this.deps.projection(path)
    const headers = this.deps.headers(path)
    const signal = this.abort.signal
    const at = durationMs === 0 || durationMs > AUTO_AT_SEC * 1000 ? AUTO_AT_SEC : 0
    const frame = (await this.read(path, at, headers, signal)) ?? (at > 0 ? await this.read(path, 0, headers, signal) : null)
    return frame ? autoKey(frame.rgb, frame.w, frame.h, projection) : null
  }
}
