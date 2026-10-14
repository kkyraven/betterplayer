import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadArchive, DownloadDestination, DownloadState } from '@shared/downloads'

const ipc = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (payload: DownloadState) => void>(),
}))
vi.mock('@/ipc', () => ({ invoke: ipc.invoke, on: (event: string, listener: (payload: DownloadState) => void) => {
  ipc.listeners.set(event, listener)
  return () => ipc.listeners.delete(event)
} }))

import { useDownloads } from './downloads'

const empty: DownloadState = { batches: [], canClear: false, cancellable: 0, session: { id: 'session', completed: 0, total: 0, failed: 0, cancelled: 0, active: 0, attention: 0, receivedBytes: 0, totalBytes: 0, progress: 0 } }
const archiveAttention = (state: DownloadArchive['state']): DownloadState => ({
  ...empty,
  batches: [{ id: 'batch', title: 'Grid', topicUrl: 'https://discuss.eroscripts.com/t/123', topicTabId: 1, topicGeneration: 1, destination: { rootId: 1, relativePath: '' }, destinationName: 'Library', createdAt: 0,
    files: [{ id: 'zip', batchId: 'batch', sourceId: 'source', fileName: 'grid.zip', publishedName: null, kind: 'archive', phase: 'waiting', host: 'example.test', receivedBytes: 100, totalBytes: 100, reason: null, attempts: [], canPause: false, canContinue: false, mediaId: null,
      archive: { state, entries: [], extractedBytes: 0, totalBytes: 200, skippedEntries: 0 } }],
  }],
})
let dispose: (() => void) | undefined

beforeEach(() => {
  ipc.invoke.mockReset().mockResolvedValue(undefined)
  ipc.listeners.clear()
  useDownloads.setState({ state: empty, initialized: false, error: null, destination: null, defaultDestination: null, managerOpen: false, topicCard: null })
})
afterEach(() => { dispose?.(); dispose = undefined })

describe('downloads renderer state', () => {
  it('keeps a newer push when an older hydration response arrives', async () => {
    let resolveState: (value: DownloadState) => void = () => {}
    ipc.invoke.mockImplementation((channel) => channel === 'downloads:state' ? new Promise<DownloadState>((resolve) => { resolveState = resolve }) : Promise.resolve(null))
    dispose = useDownloads.getState().init()
    const live = { ...empty, session: { ...empty.session, completed: 2, total: 6 } }
    ipc.listeners.get('downloads:state')?.(live)
    resolveState(empty)
    await Promise.resolve()
    expect(useDownloads.getState().state).toEqual(live)
  })

  it('remembers the first library and keeps subsequent overrides separate', async () => {
    await useDownloads.getState().setDestination({ rootId: 1, relativePath: '' })
    await useDownloads.getState().setDestination({ rootId: 2, relativePath: '' })
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    expect(ipc.invoke).toHaveBeenCalledWith('downloads:setDefault', { rootId: 1, relativePath: '' })
    expect(useDownloads.getState().defaultDestination?.rootId).toBe(1)
    expect(useDownloads.getState().destination?.rootId).toBe(2)
  })

  it('ignores a stale remembered-folder response after a deliberate choice', async () => {
    let resolveDefault: (value: DownloadDestination | null) => void = () => {}
    ipc.invoke.mockImplementation((channel) => channel === 'downloads:default' ? new Promise<DownloadDestination | null>((resolve) => { resolveDefault = resolve }) : Promise.resolve(channel === 'downloads:state' ? empty : undefined))
    dispose = useDownloads.getState().init()
    await useDownloads.getState().setDestination({ rootId: 2, relativePath: '' })
    resolveDefault({ rootId: 1, relativePath: '' })
    await Promise.resolve()
    expect(useDownloads.getState().defaultDestination?.rootId).toBe(2)
  })

  it('clear and closing the manager leave session counts owned by main', async () => {
    const state = { ...empty, canClear: true, session: { ...empty.session, completed: 2, total: 6 } }
    useDownloads.setState({ state, managerOpen: true })
    await useDownloads.getState().clear()
    useDownloads.getState().setManagerOpen(false)
    expect(ipc.invoke).toHaveBeenCalledWith('downloads:clear')
    expect(useDownloads.getState().state.session).toEqual(state.session)
    expect(useDownloads.getState().state).toEqual(state)
  })

  it('sends only selected source IDs and a frozen destination, then surfaces command errors', async () => {
    const request = { tabId: 7, generation: 4, sourceIds: ['script'], destination: { rootId: 2, relativePath: '' } }
    ipc.invoke.mockResolvedValueOnce('batch')
    expect(await useDownloads.getState().enqueue(request)).toBe('batch')
    expect(ipc.invoke).toHaveBeenCalledWith('downloads:enqueue', request)
    ipc.invoke.mockRejectedValueOnce(new Error('Folder unavailable'))
    await useDownloads.getState().command('retry', 'file')
    expect(useDownloads.getState().error).toBe('Folder unavailable')
  })

  it('requests video-only recovery by batch ID without creating a new transfer', async () => {
    await useDownloads.getState().videoOnly('partial-batch')
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('downloads:videoOnly', 'partial-batch')
    expect(useDownloads.getState().state).toEqual(empty)
  })

  it('opens new archive attention while respecting dismissal until another input step arrives', () => {
    ipc.invoke.mockImplementation((channel) => Promise.resolve(channel === 'downloads:state' ? empty : null))
    dispose = useDownloads.getState().init()
    const push = ipc.listeners.get('downloads:state')!
    push(archiveAttention('password-required'))
    expect(useDownloads.getState().managerOpen).toBe(true)
    useDownloads.getState().setManagerOpen(false)
    push(archiveAttention('password-required'))
    expect(useDownloads.getState().managerOpen).toBe(false)
    push(archiveAttention('wrong-password'))
    expect(useDownloads.getState().managerOpen).toBe(true)
    useDownloads.getState().setManagerOpen(false)
    push(archiveAttention('selection-required'))
    expect(useDownloads.getState().managerOpen).toBe(true)
    useDownloads.getState().setManagerOpen(false)
    const cancelled = archiveAttention('password-required')
    cancelled.batches[0]!.files[0]!.phase = 'cancelled'
    push(cancelled)
    expect(useDownloads.getState().managerOpen).toBe(false)
  })

  it('leaves archive prompts to the topic card that shows them', () => {
    ipc.invoke.mockImplementation((channel) => Promise.resolve(channel === 'downloads:state' ? empty : null))
    dispose = useDownloads.getState().init()
    const push = ipc.listeners.get('downloads:state')!
    useDownloads.getState().setTopicCard({ tabId: 1, url: 'https://discuss.eroscripts.com/t/grid/123/4' })
    push(archiveAttention('password-required'))
    expect(useDownloads.getState().managerOpen).toBe(false)
    useDownloads.getState().setTopicCard({ tabId: 2, url: 'https://discuss.eroscripts.com/t/grid/123' })
    push(archiveAttention('wrong-password'))
    expect(useDownloads.getState().managerOpen).toBe(false)
    useDownloads.getState().setTopicCard({ tabId: 2, url: 'https://discuss.eroscripts.com/t/other/124' })
    push(archiveAttention('password-required'))
    expect(useDownloads.getState().managerOpen).toBe(true)
  })

  it('sends literal archive passwords without storing them and leaves a rejected request recoverable', async () => {
    const password = '  Case ! 密碼  '
    expect(await useDownloads.getState().unlock('zip', password)).toBe(true)
    expect(ipc.invoke).toHaveBeenCalledWith('downloads:unlock', 'zip', password)
    expect(JSON.stringify(useDownloads.getState())).not.toContain(password)
    expect(useDownloads.getState().state).toEqual(empty)
    ipc.invoke.mockRejectedValueOnce(new Error('Archive is not waiting'))
    expect(await useDownloads.getState().unlock('zip', password)).toBe(false)
    expect(useDownloads.getState().error).toBe('Archive is not waiting')
    expect(await useDownloads.getState().unlock('zip', password)).toBe(true)
    expect(useDownloads.getState().error).toBeNull()
  })

  it('selects archive entry IDs without creating session records or hiding command failure', async () => {
    expect(await useDownloads.getState().selectArchive('zip', ['entry-0', 'entry-2'])).toBe(true)
    expect(ipc.invoke).toHaveBeenCalledWith('downloads:selectArchive', 'zip', ['entry-0', 'entry-2'])
    expect(useDownloads.getState().state).toEqual(empty)
    ipc.invoke.mockRejectedValueOnce(new Error('Invalid archive selection'))
    expect(await useDownloads.getState().selectArchive('zip', ['entry-3'])).toBe(false)
    expect(useDownloads.getState().error).toBe('Invalid archive selection')
  })
})
