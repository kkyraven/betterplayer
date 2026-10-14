import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library } from './index'
import { ScriptScanner } from './scripts'

vi.mock('electron', () => ({ net: {}, ipcMain: { on: vi.fn(), removeListener: vi.fn() }, WebContentsView: vi.fn() }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))
vi.mock('./probe', () => ({ probe: vi.fn(async () => ({ durationMs: 1000, width: 32, height: 18, codec: 'h264' })) }))
vi.mock('./thumbs', () => ({
  ThumbQueue: class {
    file() { return '' }
    pending() { return 0 }
    enqueue() {}
    async remove() {}
  },
}))

let directory: string
let physicalRoot: string
let logicalRoot: string
let library: Library

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bp-download-import-'))
  physicalRoot = join(directory, 'physical-library')
  logicalRoot = join(directory, 'library-alias')
  const dataDir = join(directory, 'profile')
  await Promise.all([mkdir(physicalRoot), mkdir(dataDir)])
  await symlink(physicalRoot, logicalRoot, 'junction')
  vi.spyOn(ScriptScanner.prototype, 'scriptsFor').mockImplementation(async (video) => {
    const source = video.replace(/\.mp4$/i, '.funscript')
    if (!await readFile(source).catch(() => null)) return []
    return [{ axis: 'L0', source, container: 'sibling', actions: 2, durationMs: 1000, averageSpeed: 100, maxSpeed: 100, heatmap: [] }]
  })
  library = new Library({ dataDir, enginePath: join(directory, 'unused-engine.js'), modelsDir: join(directory, 'models') })
})

afterEach(async () => {
  library.close()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

async function pair(folder: string) {
  await mkdir(folder, { recursive: true })
  const video = join(folder, 'scene.mp4')
  const script = join(folder, 'scene.funscript')
  await Promise.all([writeFile(video, 'synthetic video'), writeFile(script, JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] }))])
  return { video, script }
}

describe('download library import', () => {
  it('indexes a physically published pair under its symlink library path and confirms script association', async () => {
    const files = await pair(join(physicalRoot, 'scenes'))
    const root = library.addRoot(logicalRoot)
    const imported = await library.importDownloads(root.id, [files.video, files.script])
    const logicalVideo = join(logicalRoot, 'scenes', 'scene.mp4')
    const media = library.byPath(logicalVideo)
    expect(imported.mediaId).toBe(media?.id)
    expect(media).toMatchObject({ rootId: root.id, path: logicalVideo, scripts: [{ source: join(logicalRoot, 'scenes', 'scene.funscript') }] })
    expect(library.byPath(files.video)).toBeNull()
  })

  it('rejects outside files and an in-library link that points outside the physical root', async ({ skip }) => {
    const outside = await pair(join(directory, 'outside'))
    const escaped = join(physicalRoot, 'escaped.mp4')
    await symlink(outside.video, escaped).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EPERM') skip('file symlinks are unavailable')
      throw error
    })
    const root = library.addRoot(logicalRoot)
    await expect(library.importDownloads(root.id, [outside.video])).rejects.toThrow('excluded from the library')
    await expect(library.importDownloads(root.id, [escaped])).rejects.toThrow('excluded from the library')
    expect(library.byPath(outside.video)).toBeNull()
  })
  it('accepts indexed alternate variants while retaining wrong-edition rejection', async () => {
    const files = await pair(physicalRoot)
    const variant = join(physicalRoot, 'scene-max.funscript')
    const unrelated = join(physicalRoot, 'other-scene.funscript')
    await Promise.all([writeFile(variant, await readFile(files.script)), writeFile(unrelated, await readFile(files.script))])
    const sources = vi.spyOn(ScriptScanner.prototype, 'sourcesFor').mockImplementation(async (video) => [video.replace(/\.mp4$/i, '.funscript'), video.replace(/\.mp4$/i, '-max.funscript')])
    const root = library.addRoot(logicalRoot)
    const imported = await library.importDownloads(root.id, [files.video, files.script, variant])
    expect(imported.mediaId).toBe(library.byPath(join(logicalRoot, 'scene.mp4'))?.id)
    expect(sources).toHaveBeenCalledWith(join(logicalRoot, 'scene.mp4'), expect.any(Array))
    await expect(library.importDownloads(root.id, [files.video, unrelated])).rejects.toThrow('could not be matched')
  })

  it('applies excluded folders to the logical library path before accepting physical files', async () => {
    const files = await pair(join(physicalRoot, 'excluded'))
    const root = library.addRoot(logicalRoot)
    await library.excludeFolder({ rootId: root.id, folder: 'excluded' })
    await expect(library.importDownloads(root.id, [files.video, files.script])).rejects.toThrow('excluded from the library')
  })
})
