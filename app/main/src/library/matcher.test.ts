import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AxisId } from '@shared/axes'
import { LibraryDb } from './db'
import { buildReport, resolveSet } from './matcher'

vi.mock('../i18n', () => ({ t: (key: string) => key }))

let dir: string
let db: LibraryDb
let rootId: number

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bp-matcher-'))
  db = new LibraryDb(':memory:')
  rootId = db.addRoot(dir).id
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

async function video(stem: string, axes: AxisId[] = []) {
  const folder = join(dir, 'videos')
  await mkdir(folder, { recursive: true })
  const path = join(folder, `${stem}.mp4`)
  await writeFile(path, '')
  const info = await stat(path)
  const id = db.upsertMedia({ rootId, path, folder: 'videos', title: stem, size: 0, mtime: info.mtimeMs, durationMs: 60_000, width: 1, height: 1, codec: '', projection: 'flat' }, Date.now())
  if (axes.length) {
    db.setScripts(id, axes.map((axis) => ({ axis, source: join(folder, `${stem}.${axis}.funscript`), container: '', actions: 2, averageSpeed: 50, maxSpeed: 100, heatmap: [], durationMs: 60_000 })), { axes, averageSpeed: 50, heat: [] })
  }
  return { id, path, folder }
}

async function script(name: string, raw: unknown = { actions: [{ at: 0, pos: 0 }, { at: 60_000, pos: 100 }] }) {
  const folder = join(dir, 'scripts')
  await mkdir(folder, { recursive: true })
  const path = join(folder, name)
  await writeFile(path, JSON.stringify(raw))
  return path
}

describe('matcher script sets', () => {
  it('discovers a standalone packed script bundle and matches it without rewriting its contents', async () => {
    const target = await video('scene')
    const folder = join(dir, 'scripts')
    await mkdir(folder)
    const bytes = await readFile(new URL('../downloads/fixtures/script-bundle.zip', import.meta.url))
    const source = join(folder, 'scene.ZIP')
    await writeFile(source, bytes)
    const set = (await buildReport(db)).sets[0]!
    expect(set).toMatchObject({ stem: 'scene', durationMs: 1000, files: [{ name: 'scene.ZIP', suffix: '', axis: 'L0' }] })
    expect(set.candidates[0]?.mediaId).toBe(target.id)
    const destination = join(target.folder, 'scene.zip')
    expect(await resolveSet(set, target.path)).toEqual({ renamed: [destination], failed: [] })
    expect(await readFile(destination)).toEqual(bytes)
    await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await buildReport(db)).sets).toEqual([])
  })

  it('ignores video archives, unsafe archives and files beyond the packed-script byte limit', async () => {
    const folder = join(dir, 'scripts')
    await mkdir(folder)
    for (const name of ['video-archive.zip', 'traversal.zip', 'symlink.zip']) {
      await writeFile(join(folder, name), await readFile(new URL(`../downloads/fixtures/${name}`, import.meta.url)))
    }
    const handle = await open(join(folder, 'oversized.zip'), 'w')
    try { await handle.truncate(64 * 1024 * 1024 + 1) } finally { await handle.close() }
    expect((await buildReport(db)).sets).toEqual([])
  })

  it('groups MAX and compound variants with their nearby plain script', async () => {
    await script('source.funscript')
    await script('source.MAX.FUNSCRIPT')
    await script('source.alternative.roll.funscript')
    await script('source.alternative.funscript')
    const { sets } = await buildReport(db)
    expect(sets).toHaveLength(1)
    expect(sets[0]).toMatchObject({
      stem: 'source',
      files: expect.arrayContaining([
        { name: 'source.funscript', suffix: '', axis: 'L0' },
        { name: 'source.MAX.FUNSCRIPT', suffix: 'MAX', axis: 'L0' },
        { name: 'source.alternative.roll.funscript', suffix: 'alternative.roll', axis: 'R1' },
        { name: 'source.alternative.funscript', suffix: 'alternative', axis: 'L0' },
      ]),
    })
  })

  it('keeps an unknown dotted video stem intact', async () => {
    await script('scene.part.roll.funscript')
    expect((await buildReport(db)).sets).toMatchObject([{ stem: 'scene.part', files: [{ suffix: 'roll', axis: 'R1' }] }])
  })

  it('uses the longest library video stem for variants in another folder', async () => {
    await video('scene')
    const target = await video('scene.part')
    await script('scene.part.alternative.roll.funscript')
    const { sets } = await buildReport(db)
    expect(sets).toHaveLength(1)
    expect(sets[0]).toMatchObject({ stem: 'scene.part', files: [{ suffix: 'alternative.roll', axis: 'R1' }] })
    expect(sets[0]?.candidates[0]?.mediaId).toBe(target.id)
  })

  it('does not report an existing video and its compound sibling variant as orphaned', async () => {
    const target = await video('scene.part')
    await writeFile(join(target.folder, 'scene.part.alternative.roll.funscript'), '{}')
    await writeFile(join(target.folder, 'scene.part.MAX.FuNsCrIpT'), '{}')
    expect((await buildReport(db)).sets).toEqual([])
  })
})

describe('matcher rename', () => {
  it('retains the original pack when the destination becomes occupied after matching', async () => {
    const target = await video('scene')
    const folder = join(dir, 'scripts')
    await mkdir(folder)
    const bytes = await readFile(new URL('../downloads/fixtures/script-bundle.zip', import.meta.url))
    const source = join(folder, 'scene.ZIP')
    await writeFile(source, bytes)
    const set = (await buildReport(db)).sets[0]!
    const destination = join(target.folder, 'SCENE.ZIP')
    await writeFile(destination, 'occupied')
    expect((await buildReport(db)).sets[0]?.candidates).toEqual([])
    expect(await resolveSet(set, target.path)).toEqual({ renamed: [], failed: [{ name: 'scene.ZIP', error: 'matcher.nameTaken' }] })
    expect(await readFile(source)).toEqual(bytes)
    expect(await readFile(destination, 'utf8')).toBe('occupied')
  })

  it('allows one winner when two sets concurrently select the same destination', async () => {
    const target = await video('scene')
    const bytes = await readFile(new URL('../downloads/fixtures/script-bundle.zip', import.meta.url))
    const folders = [join(dir, 'scripts-a'), join(dir, 'scripts-b')]
    await Promise.all(folders.map(async (folder) => { await mkdir(folder); await writeFile(join(folder, 'source.zip'), bytes) }))
    const results = await Promise.all(folders.map((folder) => resolveSet({ dir: folder, files: [{ name: 'source.zip', suffix: '', axis: 'L0' }] }, target.path)))
    expect(results.flatMap((result) => result.renamed)).toEqual([join(target.folder, 'scene.zip')])
    expect(results.flatMap((result) => result.failed)).toEqual([{ name: 'source.zip', error: 'matcher.nameTaken' }])
    expect(await readFile(join(target.folder, 'scene.zip'))).toEqual(bytes)
    expect((await Promise.all(folders.map((folder) => readdir(folder)))).flat()).toEqual(['source.zip'])
  })

  it('matches a named roll variant beside an existing roll script and preserves its suffix', async () => {
    const target = await video('source', ['R1'])
    const existing = join(target.folder, 'source.roll.funscript')
    await writeFile(existing, 'existing roll')
    const from = await script('source.alternative.roll.funscript')
    const set = (await buildReport(db)).sets[0]!
    expect(set.candidates.map((candidate) => candidate.mediaId)).toContain(target.id)
    const renamed = join(target.folder, 'source.alternative.roll.funscript')
    expect(await resolveSet(set, target.path)).toEqual({ renamed: [renamed], failed: [] })
    expect(await readFile(existing, 'utf8')).toBe('existing roll')
    expect(JSON.parse(await readFile(renamed, 'utf8')).actions).toHaveLength(2)
    await expect(stat(from)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows MAX beside a video that already has stroke actions', async () => {
    const target = await video('source', ['L0'])
    await writeFile(join(target.folder, 'source.funscript'), 'existing stroke')
    await script('source.MAX.FUNSCRIPT')
    const set = (await buildReport(db)).sets[0]!
    expect(set.candidates.map((candidate) => candidate.mediaId)).toContain(target.id)
    expect(await resolveSet(set, target.path)).toEqual({ renamed: [join(target.folder, 'source.MAX.funscript')], failed: [] })
    expect(await readFile(join(target.folder, 'source.funscript'), 'utf8')).toBe('existing stroke')
  })

  it('excludes an occupied destination and leaves both files unchanged on resolve', async () => {
    const target = await video('source', ['R1'])
    const name = 'source.alternative.roll.funscript'
    const occupied = join(target.folder, name)
    await writeFile(occupied, 'existing variant')
    const from = await script(name)
    const original = await readFile(from, 'utf8')
    const set = (await buildReport(db)).sets[0]!
    expect(set.candidates).toEqual([])
    expect(await resolveSet(set, target.path)).toEqual({ renamed: [], failed: [{ name, error: 'matcher.nameTaken' }] })
    expect(await readFile(occupied, 'utf8')).toBe('existing variant')
    expect(await readFile(from, 'utf8')).toBe(original)
  })
})

describe('matcher duration', () => {
  it.each([
    [{ actions: [{ at: 2000 }], channels: { stroke: { actions: [{ at: 8000 }] }, roll: { actions: [{ at: 12_000 }] } } }, 12_000],
    [{ actions: [{ at: 2000 }], axes: [{ id: 'R1', actions: [{ at: 15_000 }] }] }, 15_000],
    [{ actions: [{ at: 2000 }], channels: { roll: { actions: [{ at: 12_000 }] } }, metadata: { duration: 20 } }, 20_000],
    [{ actions: [{ at: 1e309 }, { at: -1 }, { at: 1000 }], metadata: { duration: 1e308 } }, 1000],
  ])('reads root, channel, legacy axes and finite metadata durations', async (raw, durationMs) => {
    await script('source.funscript', raw)
    expect((await buildReport(db)).sets[0]?.durationMs).toBe(durationMs)
  })

  it('rejects files over the byte limit without reading their contents', async () => {
    const path = await script('source.funscript', { metadata: { duration: 60 } })
    const handle = await open(path, 'r+')
    try {
      await handle.truncate(32 * 1024 * 1024 + 1)
    } finally {
      await handle.close()
    }
    expect((await buildReport(db)).sets[0]?.durationMs).toBe(0)
  })

  it('counts raw action entries across root and channels against one shared limit', async () => {
    const half = Array<null>(500_000).fill(null)
    await script('at-limit.funscript', { actions: half, channels: { roll: { actions: half } }, metadata: { duration: 60 } })
    await script('over-limit.funscript', { actions: [...half, null], channels: { roll: { actions: half } }, metadata: { duration: 60 } })
    const durations = new Map((await buildReport(db)).sets.map((set) => [set.stem, set.durationMs]))
    expect(durations.get('at-limit')).toBe(60_000)
    expect(durations.get('over-limit')).toBe(0)
  })
})
