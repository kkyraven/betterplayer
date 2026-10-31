import { needsLook, type PictureFacts } from '@shared/projection'
import type { LibraryDb, ProjectionFacts } from './db'
import { STRIP_FRAMES } from './thumbs'
import { runToolBytes } from './tools'

export const LOOK_WIDTH = 128
const MIN_TEXTURE = 3
const MIN_SEAM_STEP = 0.5
const MIN_STRUCTURE = 2.5
const MAX_SHIFT = 0.06
const MIN_INSIDE = 40

interface View {
  px: Uint8Array
  stride: number
  x: number
  y: number
  w: number
  h: number
}

const at = (v: View, x: number, y: number) => v.px[(v.y + y) * v.stride + v.x + x] ?? 0
const part = (v: View, x: number, y: number, w: number, h: number): View => ({ ...v, x: v.x + x, y: v.y + y, w, h })
const mean = (values: ArrayLike<number>) => {
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i] ?? 0
  return values.length > 0 ? sum / values.length : 0
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1] ?? 0
}
const round = (n: number) => Math.round(n * 100) / 100

function edges(v: View, axis: 'x' | 'y' | 'xy'): Float32Array {
  const soft = new Float32Array(v.w * v.h)
  for (let y = 0; y < v.h; y++)
    for (let x = 0; x < v.w; x++) {
      let sum = 0
      let n = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const sx = x + dx
          const sy = y + dy
          if (sx < 0 || sy < 0 || sx >= v.w || sy >= v.h) continue
          sum += at(v, sx, sy)
          n++
        }
      soft[y * v.w + x] = sum / n
    }
  const out = new Float32Array(v.w * v.h)
  for (let y = 0; y < v.h - 1; y++)
    for (let x = 0; x < v.w - 1; x++) {
      const i = y * v.w + x
      const p = soft[i] ?? 0
      out[i] = (axis === 'y' ? 0 : Math.abs((soft[i + 1] ?? 0) - p)) + (axis === 'x' ? 0 : Math.abs((soft[i + v.w] ?? 0) - p))
    }
  return out
}

function correlation(a: Float32Array, b: Float32Array, w: number, h: number): number {
  const max = Math.max(2, Math.round(w * MAX_SHIFT))
  let best = -1
  for (let dx = -max; dx <= max; dx++) {
    let sa = 0
    let sb = 0
    let saa = 0
    let sbb = 0
    let sab = 0
    let n = 0
    for (let y = 0; y < h; y++)
      for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) {
        const va = a[y * w + x] ?? 0
        const vb = b[y * w + x + dx] ?? 0
        sa += va
        sb += vb
        saa += va * va
        sbb += vb * vb
        sab += va * vb
        n++
      }
    if (n === 0) continue
    const spread = Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2))
    if (spread > 1e-6) best = Math.max(best, (sab / n - (sa / n) * (sb / n)) / spread)
  }
  return best
}

function seam(v: View): number | null {
  const step = (a: number, b: number) => {
    let sum = 0
    for (let y = 0; y < v.h; y++) sum += Math.abs(at(v, a, y) - at(v, b, y))
    return sum / v.h
  }
  const near: number[] = []
  const far: number[] = []
  const quarter = v.w >> 2
  for (let x = 0; x < v.w - 1; x++) near.push(step(x, x + 1))
  for (let x = 0; x + quarter < v.w; x++) far.push(step(x, x + quarter))
  if (median(far) < MIN_STRUCTURE * Math.max(1, median(near))) return null
  const w = v.w
  const beside = (step(0, 1) + step(1, 2) + step(w - 3, w - 2) + step(w - 2, w - 1)) / 4
  if (beside < MIN_SEAM_STEP) return null
  return step(0, w - 1) / beside
}

function corner(v: View): number | null {
  const s = Math.min(v.w, v.h)
  const x0 = (v.w - s) >> 1
  const y0 = (v.h - s) >> 1
  let outside = 0
  let outsideN = 0
  let inside = 0
  let insideN = 0
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const r = Math.hypot(x + 0.5 - s / 2, y + 0.5 - s / 2) / (s / 2)
      const p = at(v, x0 + x, y0 + y)
      if (r > 1.08) {
        outside += p
        outsideN++
      } else if (r < 0.9) {
        inside += p
        insideN++
      }
    }
  if (outsideN === 0 || insideN === 0 || inside / insideN < MIN_INSIDE) return null
  return outside / outsideN / (inside / insideN)
}

export function scoreFrames(gray: Uint8Array, frames: number, fw: number, fh: number): PictureFacts {
  const lr: number[] = []
  const tb: number[] = []
  const wraps: number[] = []
  const corners: number[] = []
  const hw = fw >> 1
  const hh = fh >> 1
  for (let k = 0; k < frames; k++) {
    const frame: View = { px: gray, stride: frames * fw, x: k * fw, y: 0, w: fw, h: fh }
    if (mean(edges(frame, 'xy')) < MIN_TEXTURE) continue
    const l = correlation(edges(part(frame, 0, 0, hw, fh), 'x'), edges(part(frame, hw, 0, hw, fh), 'x'), hw, fh)
    const t = correlation(edges(part(frame, 0, 0, fw, hh), 'y'), edges(part(frame, 0, hh, fw, hh), 'y'), fw, hh)
    lr.push(l)
    tb.push(t)
    const eye = l >= 0.6 && l >= t ? part(frame, 0, 0, hw, fh) : t >= 0.6 && t > l ? part(frame, 0, 0, fw, hh) : frame
    const w = seam(eye)
    if (w !== null) wraps.push(w)
    const c = corner(eye)
    if (c !== null) corners.push(c)
  }
  return {
    lr: round(median(lr)),
    tb: round(median(tb)),
    wrap: wraps.length > 0 ? round(median(wraps)) : null,
    corner: corners.length > 0 ? round(median(corners)) : null,
    frames: lr.length,
  }
}

export async function lookAtStrip(strip: string, signal?: AbortSignal): Promise<PictureFacts> {
  const width = STRIP_FRAMES * LOOK_WIDTH
  const gray = await runToolBytes('ffmpeg', ['-v', 'error', '-i', strip, '-vf', `scale=${width}:-2:flags=area,format=gray`, '-f', 'rawvideo', '-'], 30_000, signal)
  const fh = Math.floor(gray.length / width)
  if (fh < 4) throw new Error(`${strip} is too small to look at`)
  return scoreFrames(gray, STRIP_FRAMES, LOOK_WIDTH, fh)
}

export async function lookAtFile(path: string, durationMs: number, signal?: AbortSignal): Promise<PictureFacts> {
  const seek = ((durationMs * 0.4) / 1000).toFixed(3)
  const args = ['-v', 'error', '-skip_frame', 'nokey', '-noaccurate_seek', '-threads', '2', '-ss', seek, '-i', path, '-frames:v', '1', '-vf', `scale=${LOOK_WIDTH}:-2:flags=area,format=gray`, '-f', 'rawvideo', '-']
  const gray = await runToolBytes('ffmpeg', args, 30_000, signal)
  const fh = Math.floor(gray.length / LOOK_WIDTH)
  if (fh < 4) throw new Error(`${path} gave no frame to look at`)
  return scoreFrames(gray, 1, LOOK_WIDTH, fh)
}

export class LookQueue {
  private readonly ids = new Set<number>()
  private running = false
  private readonly abort = new AbortController()

  constructor(
    private readonly db: LibraryDb,
    private readonly stripFile: (id: number) => string,
    private readonly looked: (row: ProjectionFacts) => void,
  ) {}

  static wants(row: ProjectionFacts | null): row is ProjectionFacts {
    return row !== null && !row.remote && row.strip === 'ready' && row.input.picture === undefined && needsLook(row.input)
  }

  enqueue(id: number) {
    if (this.abort.signal.aborted) return
    this.ids.add(id)
    void this.pump()
  }

  async run(row: ProjectionFacts | null): Promise<boolean> {
    if (!LookQueue.wants(row)) return false
    this.ids.delete(row.id)
    const scores = await lookAtStrip(this.stripFile(row.id), this.abort.signal)
    if (this.abort.signal.aborted) return false
    this.db.setVrLook(row.id, JSON.stringify(scores))
    this.looked(row)
    return true
  }

  async atOpen(row: ProjectionFacts | null): Promise<boolean> {
    if (!row || row.remote || row.input.picture !== undefined || !needsLook(row.input)) return false
    if (row.strip === 'ready') return this.run(row)
    const scores = await lookAtFile(row.path, row.durationMs, this.abort.signal)
    if (this.abort.signal.aborted || scores.frames === 0) return false
    this.db.setVrLook(row.id, JSON.stringify(scores))
    this.looked(row)
    return true
  }

  close() {
    this.abort.abort()
    this.ids.clear()
  }

  private async pump() {
    if (this.running) return
    this.running = true
    try {
      for (const id of this.ids) {
        this.ids.delete(id)
        await this.run(this.db.projectionFactsById(id)).catch((e: unknown) => {
          if (!this.abort.signal.aborted) process.stderr.write(`picture check failed for ${id}: ${e instanceof Error ? e.message : String(e)}\n`)
        })
        if (this.abort.signal.aborted) return
      }
    } finally {
      this.running = false
    }
  }
}
