import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { LibraryDb } from './db'
import { Scanner } from './scanner'

it('refreshes videos across roots when scripts change, respects exclusions, and clears fallbacks when disabled', async () => {
  const db = new LibraryDb(':memory:')
  const dir = await mkdtemp(join(tmpdir(), 'bp-script-folders-'))
  try {
    const videos = join(dir, 'videos')
    const scripts = join(dir, 'scripts')
    const excluded = join(scripts, 'excluded')
    await mkdir(videos)
    await mkdir(excluded, { recursive: true })
    const video = join(videos, 'scene.mp4')
    await writeFile(video, '')
    await writeFile(join(scripts, 'scene.funscript'), '{}')
    await writeFile(join(excluded, 'scene.roll.funscript'), '{}')
    const videoRoot = db.addRoot(videos)
    const scriptRoot = db.addRoot(scripts)
    db.excludeFolder({ rootId: scriptRoot.id, folder: 'excluded' })
    const info = await stat(video)
    db.upsertMedia({ rootId: videoRoot.id, path: video, folder: '', title: 'scene', size: info.size, mtime: Math.round(info.mtimeMs), durationMs: 1000, width: 1, height: 1, codec: '', projection: 'flat' }, Date.now())
    const scriptsFor = vi.fn(async (_file: string, _folders?: string[]) => [])
    const scanner = new Scanner(db, { scriptsFor }, { enqueue: vi.fn(), remove: vi.fn() }, { progress: vi.fn(), changed: vi.fn() }, { sync: vi.fn() })
    const scanned = () => vi.waitFor(() => expect(scanner.state.scanning).toBe(false))
    expect(await scanner.scriptFolders(video)).toEqual([scripts])
    scanner.scan(videoRoot.id)
    await scanned()
    expect(scriptsFor).toHaveBeenLastCalledWith(video, [scripts])
    scriptsFor.mockClear()
    scanner.scan(videoRoot.id)
    await scanned()
    expect(scriptsFor).not.toHaveBeenCalled()
    await writeFile(join(scripts, 'scene.funscript'), '{"actions":[]}')
    scanner.scan(scriptRoot.id)
    await scanned()
    expect(scriptsFor).toHaveBeenLastCalledWith(video, [scripts])
    scriptsFor.mockClear()
    scanner.setMatchOtherFolders(false)
    await scanned()
    expect(await scanner.scriptFolders(video)).toEqual([])
    expect(scriptsFor).toHaveBeenLastCalledWith(video, [])
    scanner.setMatchOtherFolders(true)
    await scanned()
    expect(scriptsFor).toHaveBeenLastCalledWith(video, [scripts])
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
