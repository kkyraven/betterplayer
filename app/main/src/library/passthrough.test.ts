import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PASSTHROUGH_DEFAULTS, PASSTHROUGH_FALLBACK_KEY } from '@shared/passthrough'
import { FLAT, type Projection } from '@shared/projection'
import { LibraryDb } from './db'
import { Passthrough, pickColour, type Frame, type readFrame } from './passthrough'

const GREEN = 0x00b140
const RED = 0xd02020
const BLUE = 0x2040d0

function frame(colour: number, fill?: { x: number; y: number; w: number; h: number; colour: number }, w = 64, h = 32): Frame {
  const rgb = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = fill && x >= fill.x * w && x < (fill.x + fill.w) * w && y >= fill.y * h && y < (fill.y + fill.h) * h
      const c = inside ? fill.colour : colour
      rgb.set([(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff], (y * w + x) * 3)
    }
  }
  return { rgb, w, h }
}

const media = { folder: '', size: 1, mtime: 1, durationMs: 60_000, width: 1920, height: 1080, codec: '', projection: 'flat' as const }

describe('the auto colour column', () => {
  it('is added to an older database with every row not sampled, and a changed file is sampled again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-passthrough-'))
    const path = join(dir, 'library.db')
    try {
      const db = new LibraryDb(path)
      const rootId = db.addRoot('/fictional').id
      db.upsertMedia({ ...media, rootId, path: '/fictional/a.mp4', title: 'a' }, 1)
      db.close()
      const old = new DatabaseSync(path)
      old.exec('ALTER TABLE media DROP COLUMN passthrough_key; ALTER TABLE media DROP COLUMN passthrough_candidates; PRAGMA user_version = 23')
      old.close()
      const migrated = new LibraryDb(path)
      try {
        const facts = migrated.passthroughFacts('/fictional/a.mp4')
        expect(facts).toMatchObject({ name: 'a.mp4 a', remote: false, durationMs: 60_000, auto: null })
        migrated.setPassthroughAuto(facts?.id ?? 0, { key: null, candidates: [RED, BLUE] })
        expect(migrated.passthroughFacts('/fictional/a.mp4')?.auto).toEqual({ key: null, candidates: [RED, BLUE] })
        migrated.setPassthroughAuto(facts?.id ?? 0, { key: GREEN, candidates: [] })
        expect(migrated.passthroughFacts('/fictional/a.mp4')?.auto).toEqual({ key: GREEN, candidates: [] })
        migrated.upsertMedia({ ...media, rootId, path: '/fictional/a.mp4', title: 'a', mtime: 2 }, 2)
        expect(migrated.passthroughFacts('/fictional/a.mp4')?.auto).toBeNull()
      } finally {
        migrated.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Passthrough', () => {
  let db: LibraryDb
  let projection: Projection
  let modelReady: boolean
  const read = vi.fn<typeof readFrame>()
  let passthrough: Passthrough

  beforeEach(() => {
    db = new LibraryDb(':memory:')
    const rootId = db.addRoot('/v').id
    db.upsertMedia({ ...media, rootId, path: '/v/room passthrough.mp4', title: 'Room' }, 1)
    db.upsertMedia({ ...media, rootId, path: '/v/plain.mp4', title: 'Plain' }, 1)
    projection = FLAT
    modelReady = false
    read.mockReset()
    read.mockResolvedValue(frame(GREEN, { x: 0.3, y: 0.2, w: 0.4, h: 0.6, colour: RED }))
    passthrough = new Passthrough(db, { projection: async () => projection, headers: () => undefined, modelReady: () => modelReady, read })
  })

  afterEach(() => {
    passthrough.close()
    db.close()
  })

  it('samples 10 s in once when the name turns it on, then answers from the library row', async () => {
    const [a, b] = await Promise.all([passthrough.resolve('/v/room passthrough.mp4', undefined), passthrough.resolve('/v/room passthrough.mp4', undefined)])
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]?.[1]).toBe(10)
    expect(a).toEqual(b)
    expect(a).toMatchObject({ on: true, onSource: 'name', key: GREEN, keySource: 'auto', auto: GREEN, mode: 'colour' })
    expect(db.passthroughFacts('/v/room passthrough.mp4')?.auto).toEqual({ key: GREEN, candidates: [] })
    await passthrough.resolve('/v/room passthrough.mp4', undefined)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('answers with the fallback key past waitMs, and caches the late sample for the next open', async () => {
    let done: (f: Awaited<ReturnType<typeof readFrame>>) => void = () => {}
    read.mockReturnValueOnce(new Promise((r) => (done = r)))
    expect(await passthrough.resolve('/v/room passthrough.mp4', undefined, 5)).toMatchObject({ on: true, key: PASSTHROUGH_FALLBACK_KEY, auto: null })
    done(frame(GREEN, { x: 0.3, y: 0.2, w: 0.4, h: 0.6, colour: RED }))
    await vi.waitFor(() => expect(db.passthroughFacts('/v/room passthrough.mp4')?.auto).toEqual({ key: GREEN, candidates: [] }))
    expect(await passthrough.resolve('/v/room passthrough.mp4', undefined, 5)).toMatchObject({ key: GREEN })
  })

  it('does not sample a video that is off or has its own key', async () => {
    expect(await passthrough.resolve('/v/plain.mp4', undefined)).toMatchObject({ on: false, onSource: 'none', auto: null })
    expect(await passthrough.resolve('/v/room passthrough.mp4', { ...PASSTHROUGH_DEFAULTS, on: false })).toMatchObject({ on: false, onSource: 'user' })
    expect(await passthrough.resolve('/v/plain.mp4', { ...PASSTHROUGH_DEFAULTS, on: true, key: BLUE })).toMatchObject({ on: true, key: BLUE, keySource: 'user' })
    expect(read).not.toHaveBeenCalled()
  })

  it('turns to AI with no winning colour only for a local file with the model on disk', async () => {
    read.mockResolvedValue(frame(GREEN, { x: 0, y: 0, w: 0.5, h: 1, colour: RED }))
    const on = { ...PASSTHROUGH_DEFAULTS, on: true }
    expect(await passthrough.resolve('/v/plain.mp4', on)).toMatchObject({ mode: 'colour', modeSource: 'auto', aiReady: false })
    modelReady = true
    expect(await passthrough.resolve('/v/plain.mp4', on)).toMatchObject({ mode: 'ai', aiReady: true })
    expect(await passthrough.resolve('https://cdn.example/clip.mp4', on)).toMatchObject({ mode: 'colour', aiReady: false })
  })

  it('reads the first frame when a file with no row has no frame 10 s in, and keeps it for the session', async () => {
    read.mockImplementation(async (_path, at) => (at > 0 ? null : frame(BLUE)))
    const on = { ...PASSTHROUGH_DEFAULTS, on: true }
    expect(await passthrough.resolve('D:/drop/short.mp4', on)).toMatchObject({ key: BLUE, auto: BLUE })
    expect(read.mock.calls.map((c) => c[1])).toEqual([10, 0])
    await passthrough.resolve('D:/drop/short.mp4', on)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('picks inside the shown eye, and gives nothing on texture or an unreadable frame', async () => {
    read.mockResolvedValue(frame(GREEN, { x: 0.5, y: 0, w: 0.5, h: 1, colour: BLUE }))
    projection = { kind: 'equirect180', layout: 'sbs', fov: 180, swapEyes: false }
    expect(await passthrough.sample('/v/plain.mp4', 12.5, 0.5, 0.5)).toBe(GREEN)
    projection = { ...projection, swapEyes: true }
    expect(await passthrough.sample('/v/plain.mp4', 12.5, 0.5, 0.5)).toBe(BLUE)
    expect(read).toHaveBeenLastCalledWith('/v/plain.mp4', 12.5, undefined, expect.any(AbortSignal))
    read.mockRejectedValueOnce(new Error('ffmpeg exited with 1'))
    const quiet = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(await passthrough.sample('/v/plain.mp4', 12.5, 0.5, 0.5)).toBeNull()
    quiet.mockRestore()
  })
})

describe('pickColour', () => {
  it('reads a patch at the point and abstains on an edge', () => {
    const f = frame(GREEN, { x: 0.5, y: 0, w: 0.5, h: 1, colour: RED })
    expect(pickColour(f, 0.25, 0.5, FLAT)).toBe(GREEN)
    expect(pickColour(f, 0.9, 0.5, FLAT)).toBe(RED)
    expect(pickColour(f, 0.5, 0.5, FLAT)).toBeNull()
  })
})
