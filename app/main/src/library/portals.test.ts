import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Projection } from '@shared/projection'
import type { PortalSource } from './portals'
import { portalArgs, portalTime, type View } from './thumbs'
import { runTool } from './tools'

const load = () => import('./portals')
const vr = (p: Partial<Projection> = {}): View => ({ projection: { kind: 'equirect180', layout: 'sbs', fov: 190, swapEyes: false, ...p }, width: 4096, height: 2048 })
const LOOK = { style: 'pixelate' as const, strength: 0.5, track: 'm1' }
const PRINTED = 'frame:0    pts:307200  pts_time:20\nbp=1\n'

let dir = ''
let rows: Record<number, PortalSource>
let calls: string[][]
let ffmpeg: (args: string[]) => Promise<string>

beforeEach(() => {
  vi.resetModules()
  dir = mkdtempSync(join(tmpdir(), 'bp-portals-'))
  writeFileSync(join(dir, 'poster.jpg'), 'poster')
  rows = {
    1: { path: join(dir, 'a_180_sbs.mp4'), mtimeMs: 1, durationMs: 60_000, view: vr(), keyed: false, remote: false },
    2: { path: join(dir, 'flat.mp4'), mtimeMs: 1, durationMs: 60_000, view: { projection: { kind: 'flat', layout: 'mono', fov: 190, swapEyes: false }, width: 1920, height: 1080 }, keyed: false, remote: false },
    3: { path: join(dir, 'keyed_180_sbs.mp4'), mtimeMs: 1, durationMs: 60_000, view: vr(), keyed: true, remote: false },
    4: { path: 'https://stash.fictional/scene/4', mtimeMs: 1, durationMs: 60_000, view: null, keyed: false, remote: true },
  }
  calls = []
  ffmpeg = async (args) => {
    calls.push(args)
    writeFileSync(args[args.length - 1]!, 'jpeg')
    return PRINTED
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function setup() {
  const mod = await load()
  const stills = new mod.PortalStills(join(dir, 'portals'), {
    source: (id) => rows[id] ?? null,
    poster: async () => ({ file: join(dir, 'poster.jpg'), type: 'image/jpeg' }),
    ffmpeg: (args) => ffmpeg(args),
  })
  return { mod, stills }
}

describe('PortalStills', () => {
  it('makes one still per picture: mtime, view, swap, ms, width and the censor look each make another', async () => {
    const { mod, stills } = await setup()
    mod.setPortalCensor(null)
    const first = await stills.still(1, 1024, 25_000)
    expect(first).toMatchObject({ type: 'image/jpeg', info: { kind: 'equirect', halfDeg: [36, 27], arcDeg: 180, ms: 20_000, censor: 'off' } })
    await stills.still(1, 1024, 25_000)
    expect(calls).toHaveLength(1)
    const changes: (() => void)[] = [
      () => (rows[1] = { ...rows[1]!, mtimeMs: 2 }),
      () => (rows[1] = { ...rows[1]!, view: vr({ arc: 200 }) }),
      () => (rows[1] = { ...rows[1]!, view: vr({ arc: 200, swapEyes: true }) }),
      () => mod.setPortalCensor(LOOK),
      () => mod.setPortalCensor({ ...LOOK, strength: 0.9 }),
    ]
    for (const change of changes) {
      change()
      await stills.still(1, 1024, 25_000)
    }
    await stills.still(1, 1024, 10_000)
    await stills.still(1, 2048, 10_000)
    expect(calls).toHaveLength(8)
    mod.setPortalCensor({ ...LOOK, strength: 0.9, track: 'm2' })
    await stills.still(1, 2048, 10_000)
    expect(calls).toHaveLength(8)
  })

  it('runs one job for concurrent asks', async () => {
    const { mod, stills } = await setup()
    mod.setPortalCensor(null)
    const [a, b] = await Promise.all([stills.still(1, 2048, null), stills.still(1, 2048, null)])
    expect(calls).toHaveLength(1)
    expect(a).toEqual(b)
    expect(a).toMatchObject({ info: { halfDeg: [90, 90] } })
  })

  it.each([['unknown', undefined], ['on', LOOK]] as const)('never shows a plain picture while censoring is %s', async (_, look) => {
    const { mod, stills } = await setup()
    if (look) mod.setPortalCensor(look)
    const covered = await stills.still(1, 1024, null)
    expect(covered).toMatchObject({ info: { kind: 'equirect', censor: look ? expect.stringMatching(/^[0-9a-f]{10}$/) : 'unknown' } })
    expect(calls[0]!.join(' ')).toMatch(look ? /scale=16:-2:flags=area,scale=1024:768:flags=neighbor/ : /scale=10:-2:flags=area,scale=1024:768:flags=bicubic/)
    const flat = await stills.still(2, 1024, null)
    expect(flat).toMatchObject({ info: { kind: 'poster' } })
    expect(flat && 'file' in flat && flat.file).not.toBe(join(dir, 'poster.jpg'))
    expect(calls[1]).toContain(join(dir, 'poster.jpg'))
    expect(await stills.still(3, 1024, null)).toEqual({ blank: true })
    expect(await stills.still(4, 1024, null)).toEqual({ blank: true })
  })

  it('serves the poster for keyed, server and flat rows with censoring off', async () => {
    const { mod, stills } = await setup()
    mod.setPortalCensor(null)
    for (const id of [2, 3, 4]) {
      expect(await stills.still(id, 1024, null)).toEqual({ file: join(dir, 'poster.jpg'), type: 'image/jpeg', info: { kind: 'poster', halfDeg: [0, 0], arcDeg: 0, ms: 0, censor: 'off' } })
    }
    expect(calls).toHaveLength(0)
    expect(await stills.still(9, 1024, null)).toBeNull()
  })

  it('makes the still again when the look changes while it is made', async () => {
    const { mod, stills } = await setup()
    mod.setPortalCensor(null)
    const plain = ffmpeg
    ffmpeg = async (args) => { mod.setPortalCensor(LOOK); return plain(args) }
    const still = await stills.still(1, 1024, null)
    expect(still).toMatchObject({ info: { censor: mod.censorKey() } })
    expect(mod.censorKey()).not.toBe('off')
  })

  it('makes a still with an unreadable .json again', async () => {
    const { mod, stills } = await setup()
    mod.setPortalCensor(null)
    const first = await stills.still(1, 1024, null)
    if (!first || !('file' in first)) throw new Error('no still')
    writeFileSync(`${first.file}.json`, '{"kind":')
    expect(await stills.still(1, 1024, null)).toEqual(first)
    expect(calls).toHaveLength(2)
  })

  it('remembers a failure and falls back to the poster; a missing ffmpeg is not a failure', async () => {
    const { mod, stills } = await setup()
    mod.setPortalCensor(null)
    const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    ffmpeg = async (args) => { calls.push(args); throw new Error('exited with 1') }
    expect(await stills.still(1, 1024, null)).toMatchObject({ info: { kind: 'poster' } })
    await stills.still(1, 1024, null)
    expect(calls).toHaveLength(1)
    errors.mockRestore()
    const { ToolMissingError } = await import('./tools')
    ffmpeg = async () => { throw new ToolMissingError('ffmpeg') }
    await expect(stills.still(1, 2048, null)).rejects.toBeInstanceOf(ToolMissingError)
  })
})

describe('servePortalThumb', () => {
  it('answers with the still and its headers, 204 blank, or 404', async () => {
    const { mod, stills } = await setup()
    mod.setPortalCensor(null)
    const local = { active: false, thumb: async () => new Response(null, { status: 500 }) }
    const res = await mod.servePortalThumb({ portals: stills }, local, 'thumb://portal/1?w=1024&ms=25000')
    expect(res.status).toBe(200)
    expect(Object.fromEntries(res.headers)).toMatchObject({ 'cache-control': 'no-store', 'x-portal-kind': 'equirect', 'x-portal-half': '36,27', 'x-portal-ms': '20000.000', 'x-portal-censor': 'off' })
    expect((await mod.servePortalThumb({ portals: stills }, local, 'thumb://portal/1?w=512')).status).toBe(404)
    mod.setPortalCensor(LOOK)
    const blank = await mod.servePortalThumb({ portals: stills }, local, 'thumb://portal/3?w=1024')
    expect([blank.status, blank.headers.get('X-Portal-Kind')]).toEqual([204, 'blank'])
    const source = { active: true, thumb: async () => new Response('img', { headers: { 'Content-Type': 'image/jpeg' } }) }
    expect((await mod.servePortalThumb({ portals: stills }, source, 'thumb://portal/1?w=1024')).status).toBe(204)
    mod.setPortalCensor(null)
    const poster = await mod.servePortalThumb({ portals: stills }, source, 'thumb://portal/1?w=1024')
    expect([poster.status, poster.headers.get('X-Portal-Kind'), await poster.text()]).toEqual([200, 'poster', 'img'])
  })
})

describe('readAhead', () => {
  it('reads the file and stops on abort', async () => {
    const { readAhead } = await load()
    const file = join(dir, 'v.mp4')
    writeFileSync(file, Buffer.alloc(9 * 1024 * 1024))
    await expect(readAhead(file, 30_000, 60_000, new AbortController().signal)).resolves.toBeUndefined()
    const aborted = new AbortController()
    aborted.abort()
    await expect(readAhead(file, 0, 60_000, aborted.signal)).resolves.toBeUndefined()
    await expect(readAhead('https://x.fictional/v.mp4', 0, 1, new AbortController().signal)).resolves.toBeUndefined()
  })
})

it('reads the frame time ffmpeg prints for the keyframe it seeks to', async () => {
  const out = join(dir, 'still.jpg')
  const path = join(__dirname, 'servers/fixtures/preview.mp4')
  const printed = await runTool('ffmpeg', portalArgs(path, vr({ layout: 'mono' }), 1024, 3000, 4000, null, out), 10_000)
  expect(portalTime(printed)).toBe(0)
  expect(portalTime(PRINTED)).toBe(20_000)
  expect(portalTime('frame:1    pts:307712  pts_time:20.033333')).toBe(20_033.333)
  expect(portalTime('nothing')).toBeNull()
})
