import { describe, expect, it, vi } from 'vitest'
import { resolveProjection, type PictureFacts } from '@shared/projection'
import type { LibraryDb, ProjectionFacts } from './db'
import { LOOK_WIDTH, LookQueue, scoreFrames } from './look'

const ffmpeg = vi.hoisted(() => vi.fn<(tool: string, args: string[]) => Promise<Buffer>>())
vi.mock('./tools', () => ({ runToolBytes: ffmpeg }))

type Dir = [number, number, number]
type Scene = (d: Dir) => number
interface Conditions {
  detail: number
  depth: number
  grain: number
  dim: number
}
const CLEAN: Conditions = { detail: 1, depth: 0, grain: 0, dim: 1 }
const HARD: Conditions = { detail: 2.5, depth: 2, grain: 12, dim: 1 }

function random(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function scene(seed: number, detail: number): Scene {
  const rand = random(seed)
  const waves = Array.from({ length: 24 }, () => {
    const z = rand() * 2 - 1
    const a = rand() * Math.PI * 2
    const r = Math.sqrt(1 - z * z)
    const f = (3 + rand() * 9) * detail
    return { k: [r * Math.cos(a) * f, r * Math.sin(a) * f, z * f] as Dir, phase: rand() * Math.PI * 2 }
  })
  return ([x, y, z]) => {
    let v = 0
    for (const w of waves) v += Math.sin(w.k[0] * x + w.k[1] * y + w.k[2] * z + w.phase)
    return 128 + v * 20
  }
}

const fromAngles = (lon: number, lat: number): Dir => [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)]
const yawed = ([x, y, z]: Dir, yaw: number): Dir => [x * Math.cos(yaw) + z * Math.sin(yaw), y, -x * Math.sin(yaw) + z * Math.cos(yaw)]
const EYE = (2 * Math.PI) / 180

type Painter = (x: number, y: number, w: number, h: number) => number | null
type Shot = (s: Scene, c: Conditions) => { x: number; y: number; sx: number; sy: number; p: Painter }[]

const equirect = (s: Scene, span: number, yaw: number, c: Conditions): Painter => (x, y, w, h) => {
  const lat = (0.5 - (y + 0.5) / h) * Math.PI
  return s(fromAngles(((x + 0.5) / w - 0.5) * span + yaw * (1 + c.depth * Math.sin(lat * 5) ** 2), lat))
}
const fisheye = (s: Scene, fovDeg: number, yaw: number): Painter => (x, y, w, h) => {
  const u = ((x + 0.5) / w) * 2 - 1
  const v = 1 - ((y + 0.5) / h) * 2
  const r = Math.hypot(u, v)
  if (r > 1) return null
  const theta = (r * fovDeg * Math.PI) / 360
  const phi = Math.atan2(v, u)
  return s(yawed([Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)], yaw))
}
const camera = (s: Scene, yaw: number): Painter => (x, y, w, h) => {
  const u = ((x + 0.5) / w) * 2 - 1
  const v = (1 - ((y + 0.5) / h) * 2) * (h / w)
  const n = Math.hypot(u, v, 1)
  return s(yawed([u / n, v / n, 1 / n], yaw))
}

const mono = (p: Painter) => [{ x: 0, y: 0, sx: 1, sy: 1, p }]
const sbs = (l: Painter, r: Painter) => [{ x: 0, y: 0, sx: 0.5, sy: 1, p: l }, { x: 0.5, y: 0, sx: 0.5, sy: 1, p: r }]
const ou = (t: Painter, b: Painter) => [{ x: 0, y: 0, sx: 1, sy: 0.5, p: t }, { x: 0, y: 0.5, sx: 1, sy: 0.5, p: b }]

const SHOTS = {
  vr180: (s, c) => sbs(equirect(s, Math.PI, -EYE, c), equirect(s, Math.PI, EYE, c)),
  mono360: (s, c) => mono(equirect(s, 2 * Math.PI, 0, c)),
  fisheye: (s) => sbs(fisheye(s, 190, -EYE), fisheye(s, 190, EYE)),
  film: (s) => mono(camera(s, 0)),
  ou360: (s, c) => ou(equirect(s, 2 * Math.PI, -EYE, c), equirect(s, 2 * Math.PI, EYE, c)),
  ou180: (s, c) => ou(equirect(s, Math.PI, -EYE, c), equirect(s, Math.PI, EYE, c)),
  film3d: (s) => sbs(camera(s, -EYE), camera(s, EYE)),
  filmOu: (s) => ou(camera(s, -EYE), camera(s, EYE)),
} satisfies Record<string, Shot>

function look(fh: number, shot: Shot, c: Conditions = CLEAN, frames = 20): PictureFacts {
  const fw = LOOK_WIDTH
  const grain = random(99)
  const gray = new Uint8Array(frames * fw * fh)
  for (let k = 0; k < frames; k++)
    for (const part of shot(scene(k + 1, c.detail), c)) {
      const w = Math.round(part.sx * fw)
      const h = Math.round(part.sy * fh)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const v = (part.p(x, y, w, h) ?? 0) * c.dim + (grain() - 0.5) * 2 * c.grain
          gray[(Math.round(part.y * fh) + y) * frames * fw + k * fw + Math.round(part.x * fw) + x] = Math.max(0, Math.min(255, v))
        }
    }
  return scoreFrames(gray, frames, fw, fh)
}

const summary = (width: number, height: number, picture: PictureFacts) => {
  const { projection: p, source } = resolveProjection({ name: 'download', width, height, picture })
  return [p.kind, p.kind === 'flat' && p.layout === 'mono' ? '' : p.layout, p.kind === 'fisheye' ? String(p.fov) : ''].filter(Boolean).join(' ') + ` / ${source}`
}

describe('picture check on synthetic strips', () => {
  it.each([
    ['VR180 side by side', 5760, 2880, 64, SHOTS.vr180, 'equirect180 sbs / picture'],
    ['360 mono', 3840, 1920, 64, SHOTS.mono360, 'equirect360 mono / picture'],
    ['fisheye 190 side by side', 7680, 3840, 64, SHOTS.fisheye, 'fisheye sbs 190 / picture'],
    ['Canon RF5.2 raw, 1.9:1', 8192, 4320, 68, SHOTS.fisheye, 'fisheye sbs 190 / picture'],
    ['2:1 film', 3840, 1920, 64, SHOTS.film, 'flat / none'],
    ['360 over under', 4096, 4096, 128, SHOTS.ou360, 'equirect360 ou / picture'],
    ['VR180 over under', 4096, 4096, 128, SHOTS.ou180, 'flat ou / picture'],
    ['full side by side 3D film', 3840, 1080, 36, SHOTS.film3d, 'flat sbs / picture'],
    ['full over under 3D film', 1920, 2160, 144, SHOTS.filmOu, 'flat ou / picture'],
    ['32:9 game capture', 5120, 1440, 36, SHOTS.film, 'flat / none'],
  ] as const)('%s', (_name, width, height, fh, shot, expected) => {
    expect(summary(width, height, look(fh, shot))).toBe(expected)
  })

  it.each([
    ['VR180 side by side', SHOTS.vr180, 'equirect180 sbs / picture'],
    ['360 mono', SHOTS.mono360, 'equirect360 mono / picture'],
    ['fisheye 190 side by side', SHOTS.fisheye, 'fisheye sbs 190 / picture'],
    ['2:1 film', SHOTS.film, 'flat / none'],
  ] as const)('%s in hard conditions', (_name, shot, expected) => {
    expect(summary(3840, 1920, look(64, shot, HARD))).toBe(expected)
  })

  it('scores a 360 seam, fisheye corners and a 180 with picture in its corners', () => {
    expect(look(64, SHOTS.mono360).wrap).toBeLessThanOrEqual(2)
    expect(look(64, SHOTS.fisheye).corner).toBeLessThanOrEqual(0.05)
    expect(look(64, SHOTS.vr180, HARD).corner).toBeGreaterThanOrEqual(0.5)
    expect(look(64, SHOTS.film).wrap).toBeGreaterThanOrEqual(3)
  })

  it('reads one frame as the open-time check does', () => {
    expect(summary(5760, 2880, look(64, SHOTS.vr180, CLEAN, 1))).toBe('equirect180 sbs / picture')
    expect(summary(3840, 1920, look(64, SHOTS.film, CLEAN, 1))).toBe('flat / none')
  })

  it('has no opinion on black frames, even grainy ones', () => {
    for (const grain of [0, 12]) {
      const facts = look(64, SHOTS.mono360, { ...CLEAN, grain, dim: 0.02 })
      expect(facts.frames).toBe(0)
      expect(summary(3840, 1920, facts)).toBe('flat / none')
    }
  })

  it('does not take a dark fisheye for 360', () => {
    const facts = look(64, SHOTS.fisheye, { ...CLEAN, dim: 0.25 })
    expect(facts).toMatchObject({ corner: null, frames: 20 })
  })
})

describe('LookQueue.atOpen', () => {
  const row = (over: Partial<ProjectionFacts> = {}): ProjectionFacts => ({
    id: 4, path: 'D:/v/download.mp4', kind: 'flat', remote: false, strip: 'pending', thumb: 'pending', cover: false, views: { thumb: '', strip: '' }, durationMs: 100_000,
    input: { name: 'download', width: 5760, height: 2880 }, ...over,
  })
  const setup = () => {
    const setVrLook = vi.fn()
    const looked = vi.fn()
    const queue = new LookQueue({ setVrLook } as unknown as LibraryDb, () => 'strip.jpg', looked)
    return { queue, setVrLook, looked }
  }
  const frame = (fill: (i: number) => number) => Buffer.from(Array.from({ length: LOOK_WIDTH * 64 }, (_, i) => fill(i)))

  it('reads one frame 40 percent in when the strip is not ready, and stores it', async () => {
    ffmpeg.mockResolvedValueOnce(frame((i) => (i * 37) % 251))
    const { queue, setVrLook, looked } = setup()
    expect(await queue.atOpen(row())).toBe(true)
    const [, args] = ffmpeg.mock.calls.at(-1)!
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 4)).toEqual(['-ss', '40.000', '-i', 'D:/v/download.mp4'])
    expect(JSON.parse(String(setVrLook.mock.calls[0]?.[1]))).toMatchObject({ frames: 1 })
    expect(looked).toHaveBeenCalledOnce()
  })

  it('reads the file, not a strip made in one eye', async () => {
    ffmpeg.mockResolvedValueOnce(frame((i) => (i * 37) % 251))
    const { queue } = setup()
    expect(await queue.atOpen(row({ strip: 'ready', views: { thumb: '', strip: '1:equirect180:sbs:' } }))).toBe(true)
    const [, args] = ffmpeg.mock.calls.at(-1)!
    expect(args).toContain('D:/v/download.mp4')
  })

  it('stores nothing for a black frame, and skips rows the picture cannot change', async () => {
    ffmpeg.mockResolvedValueOnce(frame(() => 0))
    const { queue, setVrLook } = setup()
    expect(await queue.atOpen(row())).toBe(false)
    ffmpeg.mockClear()
    expect(await queue.atOpen(row({ remote: true }))).toBe(false)
    expect(await queue.atOpen(row({ input: { name: 'Title_180_LR', width: 5760, height: 2880 } }))).toBe(false)
    expect(await queue.atOpen(row({ input: { name: 'download', width: 5760, height: 2880, picture: { lr: 0, tb: 0, wrap: null, corner: null, frames: 1 } } }))).toBe(false)
    expect(ffmpeg).not.toHaveBeenCalled()
    expect(setVrLook).not.toHaveBeenCalled()
  })
})
