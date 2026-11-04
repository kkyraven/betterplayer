import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KEY_FILL, KEY_FILL_FAR_FROM, KEY_FILL_FAR_TO, KEY_FILL_NEAR_FROM, KEY_FILL_NEAR_TO, KEY_GREY_FROM, KEY_GREY_TO, KEY_SOFT_FROM, KEY_SOFT_TO, KEY_SPILL, resolvePassthrough, type AutoKey, type PassthroughSettings, type ResolvedPassthrough } from '@shared/passthrough'
import type { Layout } from '@shared/projection'
import { runTool, runToolBytes } from './tools'

export const POSTER_WIDTH = 960
const TIMEOUT_MS = 20_000
const WEBP_QUALITY = '82'
const KEY_VERSION = 2

export function posterKeyed(saved: PassthroughSettings | undefined, name: string, auto: AutoKey | null): boolean {
  const p = resolvePassthrough(saved, name, auto, false)
  return p.on && p.settings.mode !== 'ai'
}

type Rgb = [number, number, number]

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const ycc = ([r, g, b]: Rgb): Rgb => [0.299 * r + 0.587 * g + 0.114 * b, 0.5 - 0.168736 * r - 0.331264 * g + 0.5 * b, 0.5 + 0.5 * r - 0.418688 * g - 0.081312 * b]
const rgb = ([y, cb, cr]: Rgb): Rgb => [y + 1.402 * (cr - 0.5), y - 0.344136 * (cb - 0.5) - 0.714136 * (cr - 0.5), y + 1.772 * (cb - 0.5)]
const unit = (c: number): Rgb => [((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255]

function shows(c: Rgb, key: Rgb): number {
  const [, kb, kr] = ycc(key)
  const sat = Math.hypot(kb - 0.5, kr - 0.5)
  const [, cb, cr] = ycc(c)
  const chroma = clamp01((Math.hypot(cb - kb, cr - kr) - KEY_SOFT_FROM) / Math.max(KEY_SOFT_TO * sat - KEY_SOFT_FROM, 0.001))
  const d = Math.max(Math.abs(c[0] - key[0]), Math.abs(c[1] - key[1]), Math.abs(c[2] - key[2]))
  const grey = clamp01((d - KEY_GREY_FROM) / (KEY_GREY_TO - KEY_GREY_FROM))
  const t = smoothstep(0.05, 0.15, sat)
  return grey + (chroma - grey) * t
}

function unkeyed(c: Rgb, key: Rgb, a: number): Rgb {
  if (a <= 0) return c
  const y = ycc([clamp01((c[0] - (1 - a) * key[0]) / a), clamp01((c[1] - (1 - a) * key[1]) / a), clamp01((c[2] - (1 - a) * key[2]) / a)])
  const [, kb, kr] = ycc(key)
  const sat = Math.hypot(kb - 0.5, kr - 0.5)
  const along = [(kb - 0.5) / Math.max(sat, 0.001), (kr - 0.5) / Math.max(sat, 0.001)] as const
  const v = [y[1] - 0.5, y[2] - 0.5] as const
  const spill = Math.max(v[0] * along[0] + v[1] * along[1] - Math.abs(v[0] * along[1] - v[1] * along[0]) * KEY_SPILL, 0) * smoothstep(0.05, 0.15, sat)
  const out = rgb([y[0], y[1] - along[0] * spill, y[2] - along[1] * spill])
  return [clamp01(out[0]), clamp01(out[1]), clamp01(out[2])]
}

function hits(c: Rgb, key: Rgb, from: number, to: number): number {
  return smoothstep(from, to, Math.max(Math.abs(c[0] - key[0]), Math.abs(c[1] - key[1]), Math.abs(c[2] - key[2])))
}

function boxMeans(src: Uint8Array, w: number, h: number) {
  const W = w + 1
  const sum = new Float64Array(W * (h + 1) * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        const at = ((y + 1) * W + x + 1) * 3 + c
        sum[at] = src[(y * w + x) * 3 + c]! / 255 + sum[at - 3]! + sum[at - W * 3]! - sum[at - W * 3 - 3]!
      }
    }
  }
  return (x0: number, y0: number, x1: number, y1: number): Rgb => {
    const n = (x1 - x0 + 1) * (y1 - y0 + 1)
    const a = (y0 * W + x0) * 3, b = (y0 * W + x1 + 1) * 3, c = ((y1 + 1) * W + x0) * 3, d = ((y1 + 1) * W + x1 + 1) * 3
    const at = (k: number) => (sum[d + k]! - sum[b + k]! - sum[c + k]! + sum[a + k]!) / n
    return [at(0), at(1), at(2)]
  }
}

export interface KeyLook {
  key: number
  feather: ResolvedPassthrough['feather']
  featherPx: number
  layout: Layout
}

export function keyPixels(src: Uint8Array, w: number, h: number, look: KeyLook): Uint8Array {
  const key = unit(look.key)
  const n = w * h
  const own = new Float32Array(n)
  for (let i = 0; i < n; i++) own[i] = shows([src[i * 3]! / 255, src[i * 3 + 1]! / 255, src[i * 3 + 2]! / 255], key)

  const eyeW = look.layout === 'sbs' ? w / 2 : w
  const eyeH = look.layout === 'ou' ? h / 2 : h
  const bilinear = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => {
    const fx = Math.min(x1, Math.max(x0, x))
    const fy = Math.min(y1, Math.max(y0, y))
    const ix = Math.floor(fx), iy = Math.floor(fy)
    const jx = Math.min(x1, ix + 1), jy = Math.min(y1, iy + 1)
    const tx = fx - ix, ty = fy - iy
    const top = own[iy * w + ix]! * (1 - tx) + own[iy * w + jx]! * tx
    const bottom = own[jy * w + ix]! * (1 - tx) + own[jy * w + jx]! * tx
    return top * (1 - ty) + bottom * ty
  }

  const px = look.featherPx
  const distance = look.feather === 'distance'
  const [, kb, kr] = ycc(key)
  const grey = 1 - smoothstep(0.05, 0.15, Math.hypot(kb - 0.5, kr - 0.5))
  const mean = grey > 0 ? boxMeans(src, w, h) : null
  const reach = KEY_FILL * eyeW
  const half = Math.max(0, Math.round(reach / 4))
  const enclosed = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => {
    if (!mean) return 0
    const tap = (fx: number, fy: number, from: number, to: number) => {
      const cx = Math.round(Math.min(x1, Math.max(x0, fx)))
      const cy = Math.round(Math.min(y1, Math.max(y0, fy)))
      return hits(mean(Math.max(x0, cx - half), Math.max(y0, cy - half), Math.min(x1, cx + half), Math.min(y1, cy + half)), key, from, to)
    }
    let least = 1
    for (let t = 0; t < 8 && least > 0; t++) {
      const a = (Math.PI * 2 * t) / 8
      const dx = reach * Math.cos(a), dy = reach * Math.sin(a)
      least = Math.min(least, Math.max(tap(x + dx * 0.375, y + dy * 0.375, KEY_FILL_NEAR_FROM, KEY_FILL_NEAR_TO), tap(x + dx * 0.875, y + dy * 0.875, KEY_FILL_FAR_FROM, KEY_FILL_FAR_TO)))
    }
    return least
  }
  const out = new Uint8Array(n * 4)
  for (let y = 0; y < h; y++) {
    const y0 = y < eyeH ? 0 : eyeH
    const y1 = Math.ceil(y0 + eyeH) - 1
    for (let x = 0; x < w; x++) {
      const x0 = x < eyeW ? 0 : eyeW
      const x1 = Math.ceil(x0 + eyeW) - 1
      const i = y * w + x
      const o = own[i]!
      let k = o
      if (px > 0) {
        let sum = o
        let least = 1
        let most = 0
        for (let t = 0; t < 8; t++) {
          const a = (Math.PI * 2 * t) / 8
          const s = bilinear(x + px * Math.cos(a), y + px * Math.sin(a), x0, y0, x1, y1)
          sum += s
          least = Math.min(least, s)
          most = Math.max(most, s)
        }
        k = distance ? (least > 0.5 ? 1 : most < 0.5 ? 0 : o) : Math.min(o, sum / 9)
      }
      if (grey > 0 && k < 1) k = Math.max(k, grey * enclosed(x, y, x0, y0, x1, y1))
      const c = unkeyed([src[i * 3]! / 255, src[i * 3 + 1]! / 255, src[i * 3 + 2]! / 255], key, Math.max(o, k))
      out[i * 4] = Math.round(c[0] * 255)
      out[i * 4 + 1] = Math.round(c[1] * 255)
      out[i * 4 + 2] = Math.round(c[2] * 255)
      out[i * 4 + 3] = Math.round(k * 255)
    }
  }
  return out
}

export class KeyedPosters {
  private readonly dir: string
  private readonly runs = new Map<string, Promise<string | null>>()

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'keyed')
    mkdirSync(this.dir, { recursive: true })
  }

  async file(id: number, jpg: string, look: KeyLook): Promise<string | null> {
    const info = await stat(jpg).catch(() => null)
    if (!info?.isFile()) return null
    const hash = createHash('sha1').update(JSON.stringify([KEY_VERSION, look, info.size, info.mtimeMs])).digest('hex').slice(0, 12)
    const out = join(this.dir, `${id}.${hash}.webp`)
    if (await stat(out).then(() => true, () => false)) return out
    let run = this.runs.get(out)
    if (!run) {
      run = this.bake(id, jpg, look, out).then(
        () => out,
        (e: unknown) => {
          process.stderr.write(`keyed poster failed for ${jpg}: ${e instanceof Error ? e.message : String(e)}\n`)
          return null
        },
      ).finally(() => this.runs.delete(out))
      this.runs.set(out, run)
    }
    return run
  }

  async remove(ids: number[]) {
    const drop = new Set(ids.map(String))
    const names = await readdir(this.dir).catch(() => [])
    await Promise.allSettled(names.filter((f) => drop.has(f.split('.')[0] ?? '')).map((f) => unlink(join(this.dir, f))))
  }

  private async bake(id: number, jpg: string, look: KeyLook, out: string) {
    const raw = await runToolBytes('ffmpeg', ['-v', 'error', '-i', jpg, '-frames:v', '1', '-vf', `scale=${POSTER_WIDTH}:-2:flags=area,format=rgb24`, '-f', 'rawvideo', '-'], TIMEOUT_MS)
    const h = Math.floor(raw.length / (POSTER_WIDTH * 3))
    if (h < 2) throw new Error('poster has no picture')
    const rgba = keyPixels(raw.subarray(0, POSTER_WIDTH * h * 3), POSTER_WIDTH, h, look)
    const temp = `${out}.${randomUUID()}`
    try {
      await writeFile(`${temp}.rgba`, rgba)
      await runTool('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${POSTER_WIDTH}x${h}`, '-i', `${temp}.rgba`, '-frames:v', '1', '-c:v', 'libwebp', '-quality', WEBP_QUALITY, `${temp}.webp`], TIMEOUT_MS)
      const names = await readdir(this.dir)
      await Promise.allSettled(names.filter((f) => f.startsWith(`${id}.`) && f.endsWith('.webp') && !f.includes('.webp.')).map((f) => unlink(join(this.dir, f))))
      await rename(`${temp}.webp`, out)
    } finally {
      await Promise.allSettled([unlink(`${temp}.rgba`), unlink(`${temp}.webp`)])
    }
  }
}
