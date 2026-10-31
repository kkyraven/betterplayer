import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { LibraryDb } from './db'
import { Scanner, type MediaJob } from './scanner'
import { probe } from './probe'

vi.mock('./probe', () => ({ probe: vi.fn() }))

it('re-detects the kind of an unchanged file scanned before its tag was known', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-scanner-projection-'))
  const db = new LibraryDb(':memory:')
  try {
    const file = join(dir, 'Beach VR180 SBS.mp4')
    await writeFile(file, '')
    const root = db.addRoot(dir)
    vi.mocked(probe).mockResolvedValue({ durationMs: 5000, width: 3840, height: 1920, codec: 'hevc', vr: {} })
    const scanner = new Scanner(db, { scriptsFor: vi.fn(async () => []) }, { enqueue: vi.fn(), remove: vi.fn() }, { progress: vi.fn(), changed: vi.fn() }, { sync: vi.fn() })
    const scan = async () => {
      scanner.scan(root.id)
      await vi.waitFor(() => expect(scanner.state.scanning).toBe(false))
    }
    await scan()
    const id = db.stamp(file)!.id
    expect(db.mediaRow(id)?.projection).toBe('equirect180')

    db.setProjection(id, 'flat')
    await scan()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(db.mediaRow(id)?.projection).toBe('equirect180')
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('probes an older VR-shaped row once for its metadata, keeps a pick, and queues a look', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-scanner-facts-'))
  const db = new LibraryDb(':memory:')
  try {
    const camera = join(dir, 'GS010012.mp4')
    const picked = join(dir, 'download.mp4')
    const untagged = join(dir, 'video.mp4')
    for (const file of [camera, picked, untagged]) await writeFile(file, '')
    const root = db.addRoot(dir)
    vi.mocked(probe).mockReset()
    vi.mocked(probe).mockResolvedValue({ durationMs: 5000, width: 5376, height: 2688, codec: 'hevc', vr: {} })
    const enqueue = vi.fn<(job: MediaJob) => void>()
    const scanner = new Scanner(db, { scriptsFor: vi.fn(async () => []) }, { enqueue, remove: vi.fn() }, { progress: vi.fn(), changed: vi.fn() }, { sync: vi.fn() })
    const scan = async () => {
      scanner.scan(root.id)
      await vi.waitFor(() => expect(scanner.state.scanning).toBe(false))
    }
    await scan()
    const id = db.stamp(camera)!.id
    expect(db.mediaRow(id)?.projection).toBe('flat')

    db.setVrProbe(id, '')
    vi.mocked(probe).mockClear()
    vi.mocked(probe).mockResolvedValue({ durationMs: 5000, width: 5376, height: 2688, codec: 'hevc', vr: { stereo: 'mono', sphere: 'equirect' } })
    db.setVideoSettings(picked, { positionMs: null, settings: JSON.stringify({ projection: { kind: 'flat', layout: 'mono', fov: 190, swapEyes: false } }) }, 1)
    await scan()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(db.stamp(camera)?.vrProbe).toBe('{"stereo":"mono","sphere":"equirect"}')
    expect(db.mediaRow(id)?.projection).toBe('equirect360')
    expect(db.mediaRow(db.stamp(picked)!.id)?.projection).toBe('flat')

    const ids = [id, db.stamp(picked)!.id, db.stamp(untagged)!.id] as const
    for (const row of ids) db.setThumbState(row, 'strip', 'ready')
    enqueue.mockClear()
    await scan()
    expect(probe).toHaveBeenCalledTimes(1)
    const looks = new Map(enqueue.mock.calls.map(([job]) => [job.id, job.look]))
    expect(looks).toEqual(new Map([[ids[0], false], [ids[1], false], [ids[2], true]]))
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
