import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TAGGER_INPUT } from '@shared/tagging'
import { LibraryDb } from './db'
import { TagQueue } from './tagger'
import { runToolBytes } from './tools'

const workers = vi.hoisted(() => ({ current: null as (EventEmitter & { postMessage: ReturnType<typeof vi.fn> }) | null }))
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), existsSync: () => true }))
vi.mock('node:fs/promises', () => ({ readFile: async () => 'tag_id,name,category,count\n1,test_tag,0,1' }))
vi.mock('./tools', () => ({ runToolBytes: vi.fn(), ToolMissingError: class extends Error {} }))
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    postMessage = vi.fn()
    constructor() { super(); workers.current = this }
    unref() {}
    async terminate() { return 0 }
  },
}))

let db: LibraryDb
let queue: TagQueue
const done = vi.fn()
const frame = Buffer.alloc(TAGGER_INPUT * TAGGER_INPUT * 3)
const job = { id: 0, path: 'https://server.test/scene/1', durationMs: 60_000 }

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  workers.current = null
  db = new LibraryDb(':memory:')
  const rootId = db.addRoot('/fictional').id
  job.id = db.upsertMedia({ rootId, path: job.path, title: 'remote', folder: '', size: 1, mtime: 1,
    durationMs: job.durationMs, width: 1920, height: 1080, codec: '', projection: 'flat', remoteKey: '1' }, 1)
  db.setThumbState(job.id, 'tags', 'pending')
  vi.mocked(runToolBytes).mockResolvedValue(frame)
  queue = new TagQueue('/models', '/engine', db, { done, progress: vi.fn() })
  queue.setEnabled(true)
})
afterEach(() => { queue.close(); db.close(); vi.clearAllTimers(); vi.useRealTimers() })

it('stops extracting stills when a running remote job is removed', async () => {
  let finish!: (value: Buffer) => void
  vi.mocked(runToolBytes).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  queue.enqueue(job)
  queue.remove([job.id])
  finish(frame)
  await vi.advanceTimersByTimeAsync(0)
  expect(runToolBytes).toHaveBeenCalledTimes(1)
  expect(workers.current).toBeNull()
  expect(done).not.toHaveBeenCalled()
  expect(db.stamp(job.path)?.tags).toBe('pending')
})

it.each([false, true])('discards removed inference results and errors, failure=%s', async (failure) => {
  queue.enqueue(job)
  await vi.advanceTimersByTimeAsync(0)
  expect(workers.current?.postMessage).toHaveBeenCalledTimes(1)
  queue.remove([job.id])
  workers.current!.emit('message', { id: job.id, ...(failure ? { error: 'model failed' } : { probs: [new Float32Array([1])] }) })
  await vi.advanceTimersByTimeAsync(0)
  expect(done).not.toHaveBeenCalled()
  expect(db.stamp(job.path)?.tags).toBe('pending')
  expect(queue.pending()).toBe(0)
  queue.enqueue(job)
  await vi.advanceTimersByTimeAsync(0)
  expect(workers.current?.postMessage).toHaveBeenCalledTimes(2)
  workers.current!.emit('message', { id: job.id, probs: [new Float32Array([1])] })
  await vi.advanceTimersByTimeAsync(0)
  expect(done).toHaveBeenCalledWith(job.id)
  expect(db.stamp(job.path)?.tags).toBe('ready')
})
