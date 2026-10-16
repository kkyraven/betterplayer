import { beforeEach, expect, it, vi } from 'vitest'
import type { TagUndo } from '@shared/library'

const ipc = vi.hoisted(() => ({ invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>() }))
vi.mock('@/ipc', () => ({ invoke: ipc.invoke, on: vi.fn() }))
vi.mock('@/state/ui', () => ({ useUi: { getState: () => ({ screen: 'library' }), subscribe: () => () => {} } }))
import { useLibrary } from './library'
import { useTagManager } from './tagManager'

const undo: TagUndo = { media: [{ id: 1, tags: ['cowgirl', 'pov'] }], blocked: [] }

beforeEach(() => {
  ipc.invoke.mockReset().mockImplementation(async (channel) => {
    if (channel === 'library:tags') return [{ name: 'cowgirl', count: 2 }, { name: 'riding', count: 1 }]
    if (channel === 'library:mergeTags' || channel === 'library:deleteTags') return undo
    return []
  })
  useTagManager.setState({ tags: [{ name: 'cowgirl', count: 2 }, { name: 'riding', count: 1 }], blocked: [], history: [], busy: false })
  useLibrary.setState({ filters: { tag: 'cowgirl' } })
})

it('names a merge into an existing tag a merge and a new name a rename, and the filter follows', async () => {
  expect(await useTagManager.getState().merge(['cowgirl'], ' Riding ')).toEqual({ label: 'Merged cowgirl into riding', ok: true })
  expect(ipc.invoke).toHaveBeenCalledWith('library:mergeTags', ['cowgirl'], 'riding')
  expect(useLibrary.getState().filters.tag).toBe('riding')
  expect((await useTagManager.getState().merge(['cowgirl'], 'on top'))?.label).toBe('Renamed cowgirl to on top')
  expect(await useTagManager.getState().merge(['riding'], 'riding')).toBeNull()
})

it('undoes the newest change with what main returned for it', async () => {
  await useTagManager.getState().remove(['cowgirl', 'riding'], true)
  expect(useTagManager.getState().history).toEqual([{ label: 'Deleted 2 tags', undo }])
  expect(await useTagManager.getState().undo()).toBe(true)
  expect(ipc.invoke).toHaveBeenCalledWith('library:undoTags', undo)
  expect(useTagManager.getState().history).toEqual([])
  expect(await useTagManager.getState().undo()).toBe(false)
})
