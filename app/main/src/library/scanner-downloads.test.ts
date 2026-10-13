import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { LibraryDb } from './db'
import { Scanner } from './scanner'

vi.mock('./probe', () => ({ probe: vi.fn(async () => ({ durationMs: 1000, width: 32, height: 18, codec: 'h264' })) }))

it('waits for queued download imports and excludes staged videos', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-download-scan-'))
  const db = new LibraryDb(':memory:')
  const scanner = new Scanner(db, { scriptsFor: vi.fn(async () => []) }, { enqueue: vi.fn(), remove: vi.fn() }, { progress: vi.fn(), changed: vi.fn() }, { sync: vi.fn() })
  try {
    const root = db.addRoot(dir)
    await mkdir(join(dir, '.bp-downloads-test'))
    await writeFile(join(dir, '.bp-downloads-test', 'staged.mp4'), '')
    await writeFile(join(dir, 'first.mp4'), '')
    scanner.scan(root.id)
    await writeFile(join(dir, 'second.mp4'), '')
    await scanner.scanAndWait(root.id)
    expect(db.mediaRowByPath(join(dir, 'second.mp4'))).not.toBeNull()
    expect(db.mediaRowByPath(join(dir, '.bp-downloads-test', 'staged.mp4'))).toBeNull()
    expect(scanner.state.scanning).toBe(false)
    scanner.close()
    await expect(scanner.scanAndWait(root.id)).rejects.toThrow('Library closed')
  } finally {
    scanner.close()
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
