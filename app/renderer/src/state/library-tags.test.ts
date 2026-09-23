import { beforeEach, expect, it, vi } from 'vitest'
import type { MediaRow } from '@shared/library'

const ipc = vi.hoisted(() => ({ invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>() }))
vi.mock('@/ipc', () => ({ invoke: ipc.invoke, on: vi.fn() }))
vi.mock('@/state/ui', () => ({ useUi: { getState: () => ({ screen: 'library' }), subscribe: () => () => {} } }))
import { useLibrary } from './library'

const row: MediaRow = { id: 1, rootId: 1, path: '/fictional/one.mp4', title: 'One', folder: '', size: 1, mtime: 1, addedAt: 1, durationMs: 1000, width: 100, height: 100, codec: '', projection: 'flat', thumb: null, strip: null, axes: [], averageSpeed: 0, heat: [], rating: 0, favourite: false, watchedMs: null, playCount: 0, lastPlayed: null, tags: ['original'], pinned: false, hidden: false }
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  ipc.invoke.mockReset().mockResolvedValue([])
  useLibrary.setState({ rows: [row], continueRows: [row], detail: { ...row, scripts: [] }, selectedId: 1, tags: [], tagEdits: {}, filters: {}, search: '', section: 'all', playlistId: null })
})

it('publishes rapid selections immediately and writes them in order', async () => {
  const first = deferred()
  const writes: unknown[] = []
  ipc.invoke.mockImplementation(async (channel, _id, tags) => {
    if (channel !== 'library:setTags') return []
    writes.push(tags)
    if (writes.length === 1) await first.promise
  })
  const one = useLibrary.getState().setTags(1, ['original', 'one'])
  const two = useLibrary.getState().setTags(1, ['original', 'one', 'two'])
  expect(useLibrary.getState().rows[0]).toMatchObject({ tags: ['original', 'one', 'two'] })
  expect(useLibrary.getState().continueRows[0]?.tags).toEqual(['original', 'one', 'two'])
  await Promise.resolve()
  expect(writes).toEqual([['original', 'one']])
  first.resolve()
  await Promise.all([one, two])
  expect(writes).toEqual([['original', 'one'], ['original', 'one', 'two']])
  expect(useLibrary.getState().detail?.tags).toEqual(['original', 'one', 'two'])
})

it('rolls back to the last successful selection after queued failures', async () => {
  const first = deferred()
  ipc.invoke.mockImplementation(async (channel) => {
    if (channel === 'library:setTags') return first.promise
    return []
  })
  const one = useLibrary.getState().setTags(1, ['one'])
  const two = useLibrary.getState().setTags(1, ['two'])
  const results = Promise.allSettled([one, two])
  first.reject(new Error('write failed'))
  expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected'])
  expect(useLibrary.getState().rows[0]).toMatchObject({ tags: ['original'] })
  expect(useLibrary.getState().detail?.tags).toEqual(['original'])
  ipc.invoke.mockResolvedValue([])
  await useLibrary.getState().setTags(1, ['retry'])
  expect(useLibrary.getState().rows[0]).toMatchObject({ tags: ['retry'] })
})

it('does not let an earlier failure undo a later selection', async () => {
  const first = deferred()
  let count = 0
  ipc.invoke.mockImplementation(async (channel) => {
    if (channel === 'library:setTags' && ++count === 1) return first.promise
    return []
  })
  const one = useLibrary.getState().setTags(1, ['one'])
  const two = useLibrary.getState().setTags(1, ['two'])
  const results = Promise.allSettled([one, two])
  first.reject(new Error('write failed'))
  expect((await results).map((result) => result.status)).toEqual(['rejected', 'fulfilled'])
  expect(useLibrary.getState().rows[0]).toMatchObject({ tags: ['two'] })
})

it('keeps pending selections when a library refresh returns older tags', async () => {
  const writing = deferred()
  ipc.invoke.mockImplementation(async (channel) => {
    if (channel === 'library:setTags') return writing.promise
    if (channel === 'library:query') return { rows: [row], total: 1 }
    return []
  })
  const saving = useLibrary.getState().setTags(1, ['new'])
  await useLibrary.getState().query()
  expect(useLibrary.getState().rows[0]).toMatchObject({ tags: ['new'] })
  writing.resolve()
  await saving
})

it('normalizes tags and keeps completed saves when the catalogue refresh fails', async () => {
  ipc.invoke.mockImplementation(async (channel) => {
    if (channel === 'library:tags') throw new Error('catalogue unavailable')
  })
  await useLibrary.getState().setTags(1, [' NEW ', 'new', ''])
  expect(ipc.invoke).toHaveBeenCalledWith('library:setTags', 1, ['new'])
  expect(useLibrary.getState().rows[0]).toMatchObject({ tags: ['new'] })
})

it('keeps rollback and failure available to a reopened picker after its row is filtered out', async () => {
  const writing = deferred()
  ipc.invoke.mockImplementation(async (channel) => channel === 'library:setTags' ? writing.promise : [])
  const saving = useLibrary.getState().setTags(1, ['new'])
  expect(useLibrary.getState().tagEdits[1]).toEqual({ tags: ['new'], error: false })
  useLibrary.setState({ rows: [], continueRows: [], detail: null })
  const rejected = expect(saving).rejects.toThrow('failed')
  writing.reject(new Error('failed'))
  await rejected
  expect(useLibrary.getState().tagEdits[1]).toEqual({ tags: ['original'], error: true })
})

it('preserves the pending selection when fetching the media detail', async () => {
  const writing = deferred()
  ipc.invoke.mockImplementation(async (channel) => {
    if (channel === 'library:setTags') return writing.promise
    if (channel === 'library:media') return { ...row, scripts: [] }
    return []
  })
  const saving = useLibrary.getState().setTags(1, ['new'])
  await useLibrary.getState().select(1)
  expect(useLibrary.getState().detail?.tags).toEqual(['new'])
  writing.resolve()
  await saving
})

it('uses current row tags for rollback after an older failed edit and an external change', async () => {
  useLibrary.setState({ tagEdits: { 1: { tags: ['obsolete'], error: true } }, rows: [{ ...row, tags: ['external'] }] })
  ipc.invoke.mockRejectedValue(new Error('failed'))
  await expect(useLibrary.getState().setTags(1, ['external', 'new'])).rejects.toThrow('failed')
  expect(useLibrary.getState().tagEdits[1]).toEqual({ tags: ['external'], error: true })
})
