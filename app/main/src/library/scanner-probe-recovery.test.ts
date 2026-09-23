import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { LibraryDb } from './db'
import { Scanner } from './scanner'
import { probe } from './probe'
import { ToolMissingError } from './tools'

vi.mock('./probe', () => ({ probe: vi.fn() }))

it('recovers an unchanged video after a missing probe, then resumes incremental scanning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-probe-recovery-'))
  const db = new LibraryDb(':memory:')
  try {
    const file = join(dir, 'scene.mp4')
    await writeFile(file, '')
    const root = db.addRoot(dir)
    const enqueue = vi.fn()
    const scanner = new Scanner(db, { scriptsFor: vi.fn(async () => []) }, { enqueue, remove: vi.fn() }, { progress: vi.fn(), changed: vi.fn() }, { sync: vi.fn() })
    const scan = async () => {
      scanner.scan(root.id)
      await vi.waitFor(() => expect(scanner.state.scanning).toBe(false))
    }
    vi.mocked(probe).mockRejectedValueOnce(new ToolMissingError('ffprobe'))
    await scan()
    const original = db.stamp(file)!
    expect(original.durationMs).toBe(0)
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ thumb: true, strip: false }))

    db.setRating(original.id, 4)
    db.setThumbState(original.id, 'thumb', 'failed')
    vi.mocked(probe).mockResolvedValue({ durationMs: 5000, width: 1920, height: 1080, codec: 'h264' })
    await scan()
    expect(db.stamp(file)).toMatchObject({ id: original.id, size: original.size, mtime: original.mtime, durationMs: 5000, thumb: 'pending' })
    expect(db.mediaRow(original.id)?.rating).toBe(4)
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ durationMs: 5000, thumb: true, strip: true, tags: true }))

    db.setThumbState(original.id, 'thumb', 'ready')
    db.setThumbState(original.id, 'strip', 'ready')
    await scan()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ thumb: false, strip: false }))
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
