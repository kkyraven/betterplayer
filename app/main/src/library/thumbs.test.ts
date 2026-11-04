import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LibraryDb } from './db'
import { FLAT, type Projection } from '@shared/projection'
import { ThumbQueue, coverFilter, makePoster, makeStrip, mpvColour, portalArgs, portalFilter, posterArgs, viewFilter, viewKey, type View } from './thumbs'
import { runTool } from './tools'

it('refreshes older local previews without hiding them or invalidating server images', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-thumb-quality-'))
  const file = join(dir, 'library.db')
  let db = new LibraryDb(file)
  try {
    const rootId = db.addRoot(dir).id
    const path = join(__dirname, 'servers/fixtures/preview.mp4')
    const base = { rootId, folder: '', size: 1, mtime: 1, durationMs: 4000, width: 1920, height: 1080, codec: '', projection: 'flat' as const }
    const id = db.upsertMedia({ ...base, path, title: 'Local' }, 1)
    const remotePath = 'https://example.test/video'
    const remote = db.upsertMedia({ ...base, path: remotePath, title: 'Remote', remoteKey: '1' }, 1)
    for (const mediaId of [id, remote]) {
      db.setThumbState(mediaId, 'thumb', 'ready')
      db.setThumbState(mediaId, 'strip', 'ready')
    }
    db.close()
    const old = new DatabaseSync(file)
    old.exec('DROP TABLE remote_asset_jobs; ALTER TABLE remote_assets DROP COLUMN validators; ALTER TABLE media DROP COLUMN thumb_quality; ALTER TABLE media DROP COLUMN strip_quality; PRAGMA user_version = 18')
    old.close()
    db = new LibraryDb(file)
    expect(db.stamp(path)).toMatchObject({ thumb: 'pending', strip: 'pending' })
    expect(db.stamp(remotePath)).toMatchObject({ thumb: 'ready', strip: 'ready' })
    const before = db.mediaRow(id)
    expect(before?.thumb).toBeTruthy()
    expect(before?.strip).toBeTruthy()
    const queue = new ThumbQueue(dir, db, { done: () => {}, progress: () => {}, view: () => null })
    queue.enqueue({ id, path, durationMs: 4000, cover: null, thumb: true, strip: true })
    await vi.waitFor(() => expect(queue.pending()).toBe(0), { timeout: 30_000 })
    expect(db.stamp(path)).toMatchObject({ thumb: 'ready', strip: 'ready' })
    for (const [kind, width] of [['thumb', 960], ['strip', 12800]] as const) {
      const dimensions = await runTool('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', queue.file(kind, id)], 5000)
      expect(Number(dimensions.trim())).toBe(width)
      expect(db.mediaRow(id)?.[kind]).not.toBe(before?.[kind])
    }
    expect(readdirSync(join(dir, 'thumbs'))).toEqual([`${id}.jpg`])
    expect(readdirSync(join(dir, 'strips'))).toEqual([`${id}.jpg`])
    db.close()
    db = new LibraryDb(file)
    expect(db.stamp(path)).toMatchObject({ thumb: 'ready', strip: 'ready' })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 40_000)

it('keeps the existing preview when its replacement cannot be decoded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-thumb-failure-'))
  const file = join(dir, 'library.db')
  const db = new LibraryDb(file)
  const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    const path = join(dir, 'broken.mp4')
    writeFileSync(path, 'broken video')
    const rootId = db.addRoot(dir).id
    const id = db.upsertMedia({ rootId, path, title: 'Broken', folder: '', size: 1, mtime: 1, durationMs: 4000, width: 1, height: 1, codec: '', projection: 'flat' }, 1)
    const raw = new DatabaseSync(file)
    raw.prepare('UPDATE media SET thumb_ready = 1 WHERE id = ?').run(id)
    raw.close()
    const queue = new ThumbQueue(dir, db, { done: () => {}, progress: () => {}, view: () => null })
    const image = readFileSync(join(__dirname, 'servers/fixtures/poster.jpg'))
    writeFileSync(queue.file('thumb', id), image)
    const url = db.mediaRow(id)?.thumb
    queue.enqueue({ id, path, durationMs: 4000, cover: null, thumb: true, strip: false })
    await vi.waitFor(() => expect(queue.pending()).toBe(0), { timeout: 10_000 })
    expect(readFileSync(queue.file('thumb', id))).toEqual(image)
    expect(db.mediaRow(id)?.thumb).toBe(url)
    expect(db.stamp(path)?.thumb).toBe('pending')
    expect(readdirSync(join(dir, 'thumbs'))).toEqual([`${id}.jpg`])
  } finally {
    errors.mockRestore()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('makes a VR poster from one eye, flat, and remakes it when the projection changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-thumb-view-'))
  const db = new LibraryDb(join(dir, 'library.db'))
  try {
    const path = join(__dirname, 'servers/fixtures/preview.mp4')
    const id = db.upsertMedia({ rootId: db.addRoot(dir).id, path, title: 'VR', folder: '', size: 1, mtime: 1, durationMs: 4000, width: 64, height: 36, codec: '', projection: 'equirect180' }, 1)
    const vr: Projection = { kind: 'equirect180', layout: 'sbs', fov: 190, swapEyes: false }
    let view: View = { projection: vr, width: 64, height: 36 }
    const queue = new ThumbQueue(dir, db, { done: () => {}, progress: () => {}, view: () => view })
    queue.enqueue({ id, path, durationMs: 4000, cover: null, thumb: true, strip: false })
    await vi.waitFor(() => expect(queue.pending()).toBe(0), { timeout: 10_000 })
    const size = await runTool('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', queue.file('thumb', id)], 5000)
    expect(size.trim()).toBe('960,540')
    expect(db.stamp(path)?.views.thumb).toBe(viewKey(view))
    const url = db.mediaRow(id)?.thumb

    view = { projection: FLAT, width: 64, height: 36 }
    queue.enqueue({ id, path, durationMs: 4000, cover: null, thumb: true, strip: false })
    await vi.waitFor(() => expect(queue.pending()).toBe(0), { timeout: 10_000 })
    expect(db.stamp(path)?.views.thumb).toBe('')
    expect(db.mediaRow(id)?.thumb).not.toBe(url)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)

describe('frames from a clip with a keyframe every 10 s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-thumb-gop-'))
  const path = join(dir, 'gop.mp4')
  const image = (name: string) => join(dir, name)
  beforeAll(() => runTool('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x64:rate=10:duration=30', '-c:v', 'mpeg4', '-g', '100', '-q:v', '5', path], 30_000))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('makes the same strip in several runs as in one', async () => {
    const vr: View = { projection: { kind: 'equirect180', layout: 'sbs', fov: 180, swapEyes: false }, width: 128, height: 64 }
    await makeStrip({ path, durationMs: 30_000 }, vr, image('one.jpg'), 1)
    await makeStrip({ path, durationMs: 30_000 }, vr, image('four.jpg'), 4)
    expect(readFileSync(image('four.jpg'))).toEqual(readFileSync(image('one.jpg')))
    expect(readdirSync(dir).filter((n) => n.endsWith('.nut'))).toEqual([])
  }, 30_000)

  it('takes the keyframe for a poster unless it is over 5 s before 20 percent', async () => {
    const poster = async (durationMs: number, name: string) => {
      await makePoster({ path, durationMs, cover: null }, null, image(`${name}.jpg`))
      await runTool('ffmpeg', posterArgs({ path, durationMs, cover: null }, null, image(`${name}-exact.jpg`), true), 10_000)
      return readFileSync(image(`${name}.jpg`)).equals(readFileSync(image(`${name}-exact.jpg`)))
    }
    expect(await poster(20_000, 'near')).toBe(false)
    expect(await poster(30_000, 'far')).toBe(true)
  }, 30_000)
})

it('shows half-width 3D at its full shape', () => {
  const half: View = { projection: { ...FLAT, layout: 'sbs' }, width: 1920, height: 1080 }
  expect(viewFilter(half, 640)).toBe('crop=iw/2:ih:0:0,scale=640:360:flags=lanczos')
})

describe('portal stills', () => {
  const vr = (projection: Partial<Projection>): View => ({ projection: { kind: 'equirect180', layout: 'sbs', fov: 190, swapEyes: false, ...projection }, width: 8192, height: 4096 })

  it('reads colour as mpv does: tags first, else BT.709 from 1280 wide or over 576 tall', () => {
    expect(mpvColour({ width: 4096, height: 2048 })).toEqual({ matrix: 'bt709', range: 'tv' })
    expect(mpvColour({ width: 720, height: 576 })).toEqual({ matrix: 'bt601', range: 'tv' })
    expect(mpvColour({ width: 4096, height: 2048, color_space: 'smpte170m', color_range: 'pc' })).toEqual({ matrix: 'bt601', range: 'pc' })
    expect(mpvColour({ width: 640, height: 480, color_space: 'bt709' })).toEqual({ matrix: 'bt709', range: 'tv' })
    expect(mpvColour({ color_space: 'bt2020nc' }).matrix).toBe('bt2020')
  })

  it('takes the shown eye whole, 2048 across for the dive and 1024 for the shelf', () => {
    expect(portalFilter(vr({}), 2048, null)).toBe('crop=iw/2:ih:0:0,scale=2048:2048:flags=lanczos')
    expect(portalFilter(vr({ swapEyes: true }), 2048, null)).toBe('crop=iw/2:ih:iw/2:0,scale=2048:2048:flags=lanczos')
    expect(portalFilter(vr({ arc: 200 }), 1024, null)).toBe('crop=iw/2:ih:0:0,scale=1024:1024:flags=lanczos')
    expect(portalFilter(vr({ kind: 'equirect360', layout: 'ou' }), 2048, null)).toBe('crop=iw:ih/2:0:0,scale=2048:1024:flags=lanczos')
    expect(portalFilter(vr({ kind: 'equirect360', layout: 'ou', swapEyes: true }), 1024, null)).toBe('crop=iw:ih/2:0:ih/2,scale=1024:512:flags=lanczos')
    expect(portalFilter({ projection: FLAT, width: 1920, height: 1080 }, 1024, null)).toBeNull()
    expect(portalFilter(vr({}), 2048, null, { matrix: 'bt709', range: 'tv' })).toBe('crop=iw/2:ih:0:0,scale=2048:2048:flags=lanczos:in_color_matrix=bt709:out_color_matrix=bt601:in_range=tv:out_range=pc,format=yuvj420p')
  })

  it('turns fisheye into a half equirect', () => {
    expect(portalFilter(vr({ kind: 'fisheye', fov: 190 }), 2048, null)).toBe('crop=iw/2:ih:0:0,v360=input=fisheye:ih_fov=190:iv_fov=190:output=hequirect:w=2048:h=2048:interp=lanczos,scale=2048:2048:flags=lanczos')
    expect(portalFilter(vr({ kind: 'fisheye', fov: 190, layout: 'mono' }), 1024, null)).toBe('v360=input=fisheye:ih_fov=190:iv_fov=190:output=hequirect:w=1024:h=1024:interp=lanczos,scale=1024:1024:flags=lanczos')
  })

  it('covers the whole picture at the look strength, cells as large as in the headset', () => {
    expect(coverFilter({ style: 'pixelate', strength: 0, track: null }, 960, 540)).toBe('scale=64:-2:flags=area,scale=960:540:flags=neighbor')
    expect(coverFilter({ style: 'blur', strength: 1, track: null }, 2048, 2048)).toBe('scale=24:-2:flags=area,scale=2048:2048:flags=bicubic')
    expect(coverFilter('unknown', 2048, 2048)).toBe(coverFilter({ style: 'blur', strength: 1, track: null }, 2048, 2048))
    expect(portalFilter(vr({}), 2048, { style: 'pixelate', strength: 0, track: 'm' })).toMatch(/,scale=64:-2:flags=area,scale=2048:2048:flags=neighbor$/)
  })

  it('covers a shelf still as coarsely as its window shrinks it, so the fitted picture hides as much as the headset', () => {
    expect(portalFilter(vr({}), 1024, { style: 'pixelate', strength: 0, track: 'm' })).toMatch(/,scale=7:-2:flags=area,scale=1024:1024:flags=neighbor$/)
    expect(portalFilter(vr({}), 1024, 'unknown')).toMatch(/,scale=3:-2:flags=area,scale=1024:1024:flags=bicubic$/)
  })

  it('seeks to the keyframe, decodes only keyframes but for H.264 and prints the frame time in one process', () => {
    const args = portalArgs('/v.mp4', vr({}), 2048, null, 60_000, null, '/out.jpg', undefined, 'hevc')
    expect(args.slice(args.indexOf('-copyts'), args.indexOf('-i') + 2)).toEqual(['-copyts', '-start_at_zero', '-skip_frame', 'nokey', '-thread_type', 'slice', '-flags', 'low_delay', '-ss', '12.000', '-noaccurate_seek', '-i', '/v.mp4'])
    expect(portalArgs('/v.mp4', vr({}), 2048, null, 60_000, null, '/out.jpg', undefined, 'h264')).not.toContain('-skip_frame')
    expect(portalArgs('/v.mp4', vr({}), 2048, null, 60_000, null, '/out.jpg')).not.toContain('-skip_frame')
    expect(args[args.indexOf('-vf') + 1]).toMatch(/^metadata=mode=add:key=bp:value=1,metadata=mode=print:file=-,crop=/)
    expect(portalArgs('/v.mp4', vr({}), 1024, 25_000, 60_000, null, '/o.jpg')).toContain('25.000')
  })
})
