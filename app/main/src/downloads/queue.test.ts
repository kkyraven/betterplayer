import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import type { DownloadItem } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DownloadQueue, type DownloadQueueOptions } from './index'
import type { DownloadCandidate, DownloadTransport, TransferRequest, TrustedDownloadSelection } from './transport'
import type { SecretCodec } from './journal'
import { checkDestination, safeFileName } from './files'
import { verifyFunscript } from './verify'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
const SCRIPT = Buffer.from(JSON.stringify({ version: '2.0', actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }], channels: { roll: { actions: [{ at: 0, pos: 50 }] } }, metadata: { creator: 'Fixture' } }))
const VIDEO = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)])
const codec: SecretCodec = { seal: text => Buffer.from(text).toString('base64'), unseal: text => Buffer.from(text, 'base64').toString('utf8') }
const resources: { directory: string; queue: DownloadQueue }[] = []
afterEach(async () => { for (const item of resources.splice(0)) { await item.queue.destroy(); await rm(item.directory, { recursive: true, force: true }) } })

function candidate(id: string, kind: DownloadCandidate['kind'] = 'script', host = 'fixture.example', mirrorKey: string | null = null): DownloadCandidate {
  return { id, kind, host, mirrorKey, url: `https://${host}/${id}?signature=private-${id}`, fileName: kind === 'video' ? 'scene.mp4' : 'scene.alternative.roll.funscript', label: id, postNumber: 1, controlId: null }
}
async function setup(transport: DownloadTransport, importPublished = vi.fn(async () => ({ mediaId: 42 })), privateCodec = codec, openOrdinarySource?: DownloadQueueOptions['openOrdinarySource']) {
  const directory = await mkdtemp(join(tmpdir(), 'bp-download-test-'))
  const root = { id: 1, kind: 'folder', path: directory, name: 'Fixtures' }
  const options = { journalDir: join(directory, '.journal'), getRoot: () => root, transport, importPublished, onState: vi.fn(), codec: privateCodec, openOrdinarySource }
  const queue = await DownloadQueue.open(options)
  resources.push({ directory, queue })
  const selection = (sources: DownloadCandidate[], availableSources = sources): TrustedDownloadSelection => ({ topic: { tabId: 1, generation: 2, title: 'Fixture topic', url: 'https://discuss.eroscripts.com/t/fixture/1?token=secret' }, sources, availableSources, destination: { rootId: 1, relativePath: '' } })
  return { queue, directory, selection, options, importPublished }
}
async function complete(request: TransferRequest): Promise<{ status: 'complete'; fileName: string; totalBytes: number }> {
  const bytes = request.candidate.kind === 'video' ? VIDEO : SCRIPT
  await writeFile(request.stagingPath, bytes)
  request.onProgress({ receivedBytes: bytes.length, totalBytes: bytes.length })
  return { status: 'complete', fileName: request.candidate.fileName!, totalBytes: bytes.length }
}
async function settled(queue: DownloadQueue): Promise<void> { await expect.poll(() => queue.state().batches.every(batch => batch.files.every(file => ['complete', 'failed', 'waiting', 'cancelled'].includes(file.phase) || (file.phase === 'staged' && batch.files.some(sibling => ['failed', 'waiting'].includes(sibling.phase))))), { timeout: 3000, interval: 10 }).toBe(true) }

describe('durable download queue', () => {
  it('persists before network, tries only equivalent mirrors, and keeps one logical file', async () => {
    const calls: string[] = []
    const context = await setup(async request => {
      const journal = await readFile(join(context.directory, '.journal', 'queue.json'), 'utf8')
      expect(journal).toContain(request.fileId)
      expect(journal).not.toContain('signature=private')
      expect(JSON.stringify(context.queue.state())).not.toContain('signature=private')
      calls.push(request.candidate.id)
      return request.candidate.id === 'preferred' ? { status: 'waiting', reason: 'Transfer quota reached', tabId: 9 } : complete(request)
    })
    const preferred = candidate('preferred', 'script', 'one.example', 'mirror:1')
    const mirror = candidate('mirror', 'script', 'two.example', 'mirror:1')
    const edition = { ...candidate('wrong-edition', 'script', 'three.example', 'mirror:1'), fileName: 'scene.roll.funscript' }
    const unrelated = candidate('unrelated', 'script', 'four.example')
    await context.queue.enqueue(context.selection([preferred], [preferred, mirror, edition, unrelated]))
    await settled(context.queue)
    expect(calls).toEqual(['preferred', 'mirror'])
    expect(context.queue.state().session).toMatchObject({ completed: 1, total: 1 })
    expect(context.queue.state().batches[0]?.files[0]?.attempts).toHaveLength(2)
  })

  it.each(['continue', 'retry'] as const)('clears a superseded login wait on %s so the matching viewer fallback can complete', async command => {
    const requests: TransferRequest[] = []
    let removed = false
    const context = await setup(async request => {
      requests.push(request)
      if (request.candidate.id === 'preferred') return removed
        ? { status: 'failed', reason: 'The file was removed', scope: 'remote', unavailable: true }
        : { status: 'waiting', reason: 'Sign in to download', tabId: 9 }
      return request.directUrl ? { status: 'failed', reason: 'HTTP 403 hotlink_detected', scope: 'remote' } : complete(request)
    })
    const preferred = candidate('preferred', 'script', 'one.example', 'mirror:1')
    const mirror = { ...candidate('mirror', 'script', 'pixeldrain.com', 'mirror:1'), url: 'https://pixeldrain.com/u/Synthetic' }
    const id = await context.queue.enqueue(context.selection([preferred], [preferred, mirror]))
    await settled(context.queue)
    expect(context.queue.state().batches[0]?.files[0]).toMatchObject({ phase: 'waiting', sourceId: 'preferred', reason: 'Sign in to download', canContinue: true })
    expect(requests).toHaveLength(2)

    removed = true
    await context.queue[command](id)
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    expect(requests.map(request => request.candidate.id)).toEqual(['preferred', 'mirror', 'preferred', 'mirror', 'mirror'])
    expect(requests.at(-1)?.directUrl).toBeNull()
    expect(new Set(requests.map(request => request.fileId)).size).toBe(1)
    expect(context.queue.state().batches[0]?.files[0]?.attempts.map(attempt => attempt.outcome)).toEqual(['waiting', 'failed', 'failed', 'failed', 'complete'])
    expect(context.queue.state().session).toMatchObject({ completed: 1, total: 1 })
  })

  it('fails a removed source and its dead mirror after Continue instead of restoring the old login wait', async () => {
    let removed = false
    const context = await setup(async request => request.candidate.id === 'preferred' && !removed
      ? { status: 'waiting', reason: 'Sign in to download', tabId: 9 }
      : { status: 'failed', reason: 'The file was removed', scope: 'remote', unavailable: true })
    const preferred = candidate('preferred', 'script', 'one.example', 'mirror:1')
    const mirror = candidate('mirror', 'script', 'two.example', 'mirror:1')
    const id = await context.queue.enqueue(context.selection([preferred], [preferred, mirror]))
    await settled(context.queue)
    expect(context.queue.state().batches[0]?.files[0]).toMatchObject({ phase: 'waiting', sourceId: 'preferred', canContinue: true })

    removed = true
    await context.queue.continue(id)
    await settled(context.queue)
    expect(context.queue.state().batches[0]?.files[0]).toMatchObject({ phase: 'failed', reason: 'The file was removed', canContinue: false })
    expect(context.queue.state().batches[0]?.files[0]?.attempts.map(attempt => attempt.outcome)).toEqual(['waiting', 'failed', 'failed', 'failed'])
  })

  it('retains a staged sibling on partial failure, clear preserves recovery, retry downloads only missing work', async () => {
    let failScript = true
    const calls: string[] = []
    const context = await setup(async request => {
      calls.push(request.candidate.id)
      if (request.candidate.kind === 'script' && failScript) return { status: 'failed', reason: 'Removed file', scope: 'remote' }
      return complete(request)
    })
    const batchId = await context.queue.enqueue(context.selection([candidate('video', 'video'), candidate('script')]))
    await settled(context.queue)
    expect(context.queue.state().session).toMatchObject({ completed: 0, total: 2 })
    expect(context.queue.state().cancellable).toBe(2)
    await context.queue.clear()
    expect(context.queue.state().batches).toHaveLength(1)
    expect(context.importPublished).not.toHaveBeenCalled()
    failScript = false
    await context.queue.retry(batchId)
    await expect.poll(() => context.queue.state().session.completed).toBe(2)
    expect(calls.filter(id => id === 'video')).toHaveLength(1)
    expect(calls.filter(id => id === 'script')).toHaveLength(2)
    expect(await readFile(join(context.directory, 'scene.alternative.roll.funscript'))).toEqual(SCRIPT)
    await context.queue.clear()
    expect(context.queue.state().batches).toEqual([])
    expect(context.queue.state().session).toMatchObject({ completed: 2, total: 2 })
    expect(await readFile(join(context.directory, 'scene.mp4'))).toEqual(VIDEO)
  })

  it('requires an explicit video-only choice and retains the cancelled script in session totals', async () => {
    const context = await setup(async request => request.candidate.kind === 'video' ? complete(request) : { status: 'failed', reason: 'Missing script', scope: 'remote' })
    const id = await context.queue.enqueue(context.selection([candidate('video', 'video'), candidate('script')]))
    await settled(context.queue)
    expect(context.queue.state().batches[0]?.canImportVideoOnly).toBe(true)
    expect(context.importPublished).not.toHaveBeenCalled()
    await context.queue.cancel(context.queue.state().batches[0]!.files.find(file => file.kind === 'script')!.id)
    expect(context.queue.state().batches[0]?.canImportVideoOnly).toBe(true)
    await context.queue.videoOnly(id)
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    expect(context.queue.state().session).toMatchObject({ completed: 1, total: 2, cancelled: 1 })
    expect(await readFile(join(context.directory, 'scene.mp4'))).toEqual(VIDEO)
    await expect(readFile(join(context.directory, 'scene.alternative.roll.funscript'))).rejects.toThrow()
  })

  it('adopts a native browser download only after its save path is selected, without a library import', async () => {
    const context = await setup(complete)
    let path = ''
    let received = 0
    let state: 'progressing' | 'completed' = 'progressing'
    const item = Object.assign(new EventEmitter(), {
      getSavePath: () => path, getReceivedBytes: () => received, getTotalBytes: () => SCRIPT.length,
      getFilename: () => 'native.funscript', getURL: () => 'https://fixture.example/native.funscript?signature=private',
      getMimeType: () => 'application/octet-stream', getState: () => state, pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    })
    context.queue.adoptOrdinary({ item: item as unknown as DownloadItem, tabId: 3, pageUrl: 'https://fixture.example/topic' })
    expect(context.queue.state().session.total).toBe(0)
    path = join(context.directory, 'native.funscript')
    received = 10
    item.emit('updated', {}, 'progressing')
    await expect.poll(() => context.queue.state().session.total).toBe(1)
    await writeFile(path, SCRIPT)
    received = SCRIPT.length; state = 'completed'
    item.emit('done', {}, 'completed')
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    expect(context.queue.state().batches[0]).toMatchObject({ origin: 'browser', savedPath: path })
    expect(context.queue.state().batches[0]?.files[0]?.canRetry).toBe(false)
    expect(context.importPublished).not.toHaveBeenCalled()
    expect(JSON.stringify(context.queue.state())).not.toContain('signature=private')
  })

  it('accepts a tiny native transfer completed before attachment exactly once and cleans listeners on shutdown', async () => {
    const context = await setup(complete)
    const path = join(context.directory, 'chosen-name.funscript')
    await writeFile(path, SCRIPT)
    const item = Object.assign(new EventEmitter(), {
      getSavePath: () => path, getReceivedBytes: () => SCRIPT.length, getTotalBytes: () => SCRIPT.length,
      getFilename: () => 'host-name.funscript', getURL: () => 'https://fixture.example/file?signature=private',
      getMimeType: () => 'application/octet-stream', getState: () => 'completed' as const, pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    })
    const download = { item: item as unknown as DownloadItem, tabId: 3, pageUrl: 'https://fixture.example/topic' }
    context.queue.adoptOrdinary(download)
    context.queue.adoptOrdinary(download)
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    expect(context.queue.state().session.total).toBe(1)
    expect(context.queue.state().batches[0]?.files[0]?.fileName).toBe('chosen-name.funscript')
    expect(item.listenerCount('updated')).toBe(0)
    expect(item.listenerCount('done')).toBe(0)
    await context.queue.destroy()
    expect(item.listenerCount('updated')).toBe(0)
  })

  it.each([true, false])('continues a recovered native download with a fixed record only for the same chosen path: %s', async samePath => {
    const context = await setup(complete)
    const originalPath = join(context.directory, 'native.funscript')
    const sourceUrl = 'https://fixture.example/native.funscript?signature=private'
    const interrupted = Object.assign(new EventEmitter(), {
      getSavePath: () => originalPath, getReceivedBytes: () => 10, getTotalBytes: () => SCRIPT.length,
      getURL: () => sourceUrl, getURLChain: () => [sourceUrl], getMimeType: () => 'application/octet-stream',
      getState: () => 'interrupted' as const, pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    })
    context.queue.adoptOrdinary({ item: interrupted as unknown as DownloadItem, tabId: 3, pageUrl: 'https://fixture.example/topic' })
    await expect.poll(() => context.queue.state().batches[0]?.files[0]?.phase).toBe('waiting')
    const fileId = context.queue.state().batches[0]!.files[0]!.id
    await context.queue.destroy()
    const openOrdinarySource = vi.fn()
    const recovered = await DownloadQueue.open({ ...context.options, openOrdinarySource })
    resources.find(resource => resource.queue === context.queue)!.queue = recovered
    await recovered.continue(fileId)
    expect(openOrdinarySource).toHaveBeenCalledWith(sourceUrl)
    const savedPath = samePath ? originalPath : join(context.directory, 'another.funscript')
    await writeFile(savedPath, SCRIPT)
    const restarted = Object.assign(new EventEmitter(), {
      getSavePath: () => savedPath, getReceivedBytes: () => SCRIPT.length, getTotalBytes: () => SCRIPT.length,
      getURL: () => 'https://cdn.fixture.example/resolved', getURLChain: () => [sourceUrl, 'https://cdn.fixture.example/resolved'],
      getMimeType: () => 'application/octet-stream', getState: () => 'completed' as const, pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    })
    recovered.adoptOrdinary({ item: restarted as unknown as DownloadItem, tabId: 4, pageUrl: sourceUrl })
    await expect.poll(() => recovered.state().session.completed).toBe(1)
    expect(recovered.state().session).toMatchObject({ total: samePath ? 1 : 2, cancelled: samePath ? 0 : 1 })
    expect(recovered.state().batches[0]?.files[0]).toMatchObject({ id: fileId, phase: samePath ? 'complete' : 'cancelled' })
    expect(context.importPublished).not.toHaveBeenCalled()
  })

  it('reuses duplicate clicks and leaves completed counters after clearing', async () => {
    const transport = vi.fn(complete)
    const context = await setup(transport)
    const selection = context.selection([candidate('script')])
    const [first, second] = await Promise.all([context.queue.enqueue(selection), context.queue.enqueue(selection)])
    expect(second).toBe(first)
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    await context.queue.clear()
    expect(await context.queue.enqueue(selection)).toBe(first)
    expect(transport).toHaveBeenCalledOnce()
    await context.queue.enqueue({ ...selection, again: true })
    await expect.poll(() => context.queue.state().session.completed).toBe(2)
    expect(context.queue.state().session.total).toBe(2)
  })

  it('retries library import without transferring again', async () => {
    let fail = true
    const imports = vi.fn(async () => { if (fail) throw new Error('Scanner failed'); return { mediaId: 4 } })
    const transport = vi.fn(complete)
    const context = await setup(transport, imports)
    const id = await context.queue.enqueue(context.selection([candidate('script')]))
    await settled(context.queue)
    expect(context.queue.state().session.completed).toBe(0)
    fail = false
    await context.queue.retry(id)
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    expect(transport).toHaveBeenCalledOnce()
    expect(imports).toHaveBeenCalledTimes(2)
  })

  it('reserves a coordinated collision stem and preserves compound script suffixes', async () => {
    const context = await setup(complete)
    await writeFile(join(context.directory, 'SCENE.MP4'), Buffer.from('existing'))
    await context.queue.enqueue(context.selection([candidate('video', 'video'), candidate('script')]))
    await expect.poll(() => context.queue.state().session.completed).toBe(2)
    expect(await readdir(context.directory)).toEqual(expect.arrayContaining(['SCENE.MP4', 'scene (2).mp4', 'scene (2).alternative.roll.funscript']))
    expect(await readFile(join(context.directory, 'SCENE.MP4'), 'utf8')).toBe('existing')
  })

  it.each([false, true])('keeps the other scene script beside one selected WebM with a video collision of %s', async collision => {
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])
    const context = await setup(async request => {
      const bytes = request.candidate.kind === 'video' ? webm : SCRIPT
      await writeFile(request.stagingPath, bytes)
      return { status: 'complete', fileName: request.candidate.fileName!, totalBytes: bytes.length }
    })
    if (collision) await writeFile(join(context.directory, '1641647055994.webm'), Buffer.from('existing'))
    await context.queue.enqueue(context.selection([
      { ...candidate('video', 'video'), fileName: '1641647055994.webm' },
      { ...candidate('paired'), fileName: '1641647055994.funscript' },
      { ...candidate('other'), fileName: '1645668234609.funscript' },
    ]))
    await expect.poll(() => context.queue.state().session.completed).toBe(3)
    const stem = `1641647055994${collision ? ' (2)' : ''}`
    expect(await readFile(join(context.directory, `${stem}.webm`))).toEqual(webm)
    expect(await readFile(join(context.directory, `${stem}.funscript`))).toEqual(SCRIPT)
    expect(await readFile(join(context.directory, '1645668234609.funscript'))).toEqual(SCRIPT)
    expect(context.importPublished).toHaveBeenCalledWith(expect.objectContaining({ files: expect.arrayContaining([
      expect.objectContaining({ kind: 'video', name: `${stem}.webm` }),
      expect.objectContaining({ kind: 'script', name: `${stem}.funscript` }),
      expect.objectContaining({ kind: 'script', name: '1645668234609.funscript' }),
    ]) }))
  })

  it('coordinates matching compound axes while leaving an unrelated script name unchanged', async () => {
    const context = await setup(complete)
    await writeFile(join(context.directory, 'scene.mp4'), Buffer.from('existing'))
    await context.queue.enqueue(context.selection([
      candidate('video', 'video'),
      { ...candidate('stroke'), fileName: 'scene.funscript' },
      candidate('roll'),
      { ...candidate('other'), fileName: 'other.funscript' },
    ]))
    await expect.poll(() => context.queue.state().session.completed).toBe(4)
    expect(await readdir(context.directory)).toEqual(expect.arrayContaining(['scene (2).mp4', 'scene (2).funscript', 'scene (2).alternative.roll.funscript', 'other.funscript']))
  })

  it('retains explicit pairing of one video with one differently named script', async () => {
    const context = await setup(complete)
    await context.queue.enqueue(context.selection([candidate('video', 'video'), { ...candidate('script'), fileName: 'original.funscript' }]))
    await expect.poll(() => context.queue.state().session.completed).toBe(2)
    expect(await readFile(join(context.directory, 'scene.funscript'))).toEqual(SCRIPT)
    await expect(readFile(join(context.directory, 'original.funscript'))).rejects.toThrow()
  })

  it('bounds concurrency and does not manufacture aggregate byte progress for unknown sizes', async () => {
    const releases: (() => void)[] = []
    let count = 0
    let maximum = 0
    const hosts = new Set<string>()
    const context = await setup(async request => {
      count++; maximum = Math.max(maximum, count)
      expect(hosts.has(request.candidate.host)).toBe(false)
      hosts.add(request.candidate.host)
      request.onProgress({ receivedBytes: 100, totalBytes: null })
      await new Promise<void>(resolve => { releases.push(resolve); request.signal.addEventListener('abort', () => resolve(), { once: true }) })
      hosts.delete(request.candidate.host); count--
      return complete(request)
    })
    await context.queue.enqueue(context.selection([candidate('one', 'script', 'one.example'), { ...candidate('two', 'script', 'one.example'), fileName: 'two.funscript' }, { ...candidate('three', 'script', 'two.example'), fileName: 'three.funscript' }]))
    await expect.poll(() => releases.length).toBe(2)
    expect(context.queue.state().session.progress).toBeNull()
    releases.splice(0).forEach(release => release())
    await expect.poll(() => releases.length).toBe(1)
    releases.shift()!()
    await expect.poll(() => context.queue.state().session.completed).toBe(3)
    expect(maximum).toBeLessThanOrEqual(2)
  })

  it('recovers waiting work once in a new session, completed history is excluded', async () => {
    const context = await setup(async request => request.candidate.id === 'waiting' ? { status: 'waiting', reason: 'Sign in', tabId: 9 } : complete(request))
    await context.queue.enqueue(context.selection([candidate('done')]))
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    await context.queue.enqueue(context.selection([candidate('waiting', 'script', 'host.example')]))
    await settled(context.queue)
    await context.queue.destroy()
    const recovered = await DownloadQueue.open(context.options)
    resources.push({ directory: context.directory, queue: recovered })
    await settled(recovered)
    expect(recovered.state().session).toMatchObject({ completed: 0, total: 1 })
    expect(recovered.state().session.id).not.toBe(context.queue.state().session.id)
  })

  it('keeps private URLs out of disk when secure storage is unavailable', async () => {
    const openOrdinarySource = vi.fn()
    const context = await setup(async () => ({ status: 'waiting', reason: 'Sign in' }), vi.fn(async () => ({ mediaId: 42 })), { seal: () => null, unseal: () => null }, openOrdinarySource)
    await context.queue.enqueue(context.selection([candidate('secret')]))
    await settled(context.queue)
    expect(await readFile(join(context.directory, '.journal', 'queue.json'), 'utf8')).not.toContain('signature=private')
    await context.queue.destroy()
    const recovered = await DownloadQueue.open(context.options)
    resources.push({ directory: context.directory, queue: recovered })
    const file = recovered.state().batches[0]?.files[0]
    expect(file).toMatchObject({ phase: 'waiting', canContinue: false, canOpenSource: false, reason: 'Source details unavailable after restart' })
    await expect(recovered.openSource(file!.id)).rejects.toThrow('Browser download source is unavailable')
    expect(openOrdinarySource).not.toHaveBeenCalled()
  })

  it.each([
    { host: 'mega.nz', url: 'https://mega.nz/file/SANITIZED#Exact_Key%2FWith%2BBytes' },
    { host: 'files.example', url: 'https://files.example/scene.mp4?signature=%2fExact%2B&token=value&token=second#kept' },
  ])('opens the original $host source without retrying its download', async ({ host, url }) => {
    const transport = vi.fn(async () => ({ status: 'waiting' as const, reason: 'Sign in' }))
    const openOrdinarySource = vi.fn()
    const context = await setup(transport, vi.fn(async () => ({ mediaId: 42 })), codec, openOrdinarySource)
    await context.queue.enqueue(context.selection([{ ...candidate('source', 'video', host), url }]))
    await settled(context.queue)
    const before = context.queue.state()
    const file = before.batches[0]!.files[0]!
    expect(file.canOpenSource).toBe(true)
    await context.queue.openSource(file.id)
    expect(openOrdinarySource).toHaveBeenCalledExactlyOnceWith(url)
    expect(transport).toHaveBeenCalledOnce()
    expect(context.queue.state()).toEqual(before)
  })

  it('rejects unknown file and batch IDs when opening a source', async () => {
    const openOrdinarySource = vi.fn()
    const context = await setup(async () => ({ status: 'waiting', reason: 'Sign in' }), vi.fn(async () => ({ mediaId: 42 })), codec, openOrdinarySource)
    const batchId = await context.queue.enqueue(context.selection([candidate('source')]))
    await settled(context.queue)
    const before = context.queue.state()
    await expect(context.queue.openSource('missing-file')).rejects.toThrow('Browser download source is unavailable')
    await expect(context.queue.openSource(batchId)).rejects.toThrow('Browser download source is unavailable')
    expect(openOrdinarySource).not.toHaveBeenCalled()
    expect(context.queue.state()).toEqual(before)
  })

  it('disables source opening when no browser opener is available', async () => {
    const context = await setup(async () => ({ status: 'waiting', reason: 'Sign in' }))
    await context.queue.enqueue(context.selection([candidate('source')]))
    await settled(context.queue)
    const file = context.queue.state().batches[0]!.files[0]!
    expect(file.canOpenSource).toBe(false)
    await expect(context.queue.openSource(file.id)).rejects.toThrow('Browser download source is unavailable')
  })

  it.each([
    { original: 'Example: ride.mp4', saved: 'Example- ride.mp4' },
    { original: 'PRN.mp4', saved: '!PRN.mp4' },
  ])('accepts the original MEGA name $original saved as $saved', async ({ original, saved }) => {
    const context = await setup(async request => {
      await writeFile(request.stagingPath, VIDEO)
      return { status: 'complete', fileName: saved, totalBytes: VIDEO.length }
    })
    const source = { ...candidate('source', 'video', 'mega.nz'), url: 'https://mega.nz/file/SANITIZED#Exact_Key', fileName: original }
    await context.queue.enqueue(context.selection([source]))
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    expect(await readFile(join(context.directory, saved))).toEqual(VIDEO)
    expect(context.queue.state().batches[0]?.files[0]).toMatchObject({ fileName: saved, publishedName: saved, phase: 'complete' })
  })

  it('rejects a MEGA-style filename replacement returned by another host', async () => {
    const context = await setup(async request => {
      await writeFile(request.stagingPath, VIDEO)
      return { status: 'complete', fileName: 'Example- ride.mp4', totalBytes: VIDEO.length }
    })
    await context.queue.enqueue(context.selection([{ ...candidate('source', 'video'), fileName: 'Example: ride.mp4' }]))
    await settled(context.queue)
    expect(context.queue.state().batches[0]?.files[0]).toMatchObject({ phase: 'failed', reason: 'The source returned a different file' })
    expect(context.importPublished).not.toHaveBeenCalled()
    await expect(readFile(join(context.directory, 'Example- ride.mp4'))).rejects.toThrow()
  })

  it('refuses recovery metadata that would escape its staging directory', async () => {
    const context = await setup(async () => ({ status: 'waiting', reason: 'Fixture waiting' }))
    await context.queue.enqueue(context.selection([candidate('waiting')]))
    await settled(context.queue)
    await context.queue.destroy()
    const path = join(context.directory, '.journal', 'queue.json')
    const saved: { batches: { files: { stageName: string }[] }[] } = JSON.parse(await readFile(path, 'utf8'))
    saved.batches[0]!.files[0]!.stageName = '../../outside'
    await writeFile(path, JSON.stringify(saved))
    await expect(DownloadQueue.open(context.options)).rejects.toThrow('Invalid download recovery journal')
  })

  it('uses direct paths for documented providers before extension heuristics', async () => {
    const requests: TransferRequest[] = []
    const context = await setup(async request => { requests.push(request); return { status: 'waiting', reason: 'Fixture' } })
    const source = { ...candidate('pixeldrain'), url: 'https://pixeldrain.com/u/Synthetic?x=%2f&x=2#kept' }
    await context.queue.enqueue(context.selection([source]))
    await settled(context.queue)
    expect(requests[0]?.directUrl).toBe('https://pixeldrain.com/api/file/Synthetic?x=%2f&x=2&download#kept')
    expect(requests[0]?.candidate.url).toBe(source.url)
    expect(requests[0]?.topic.url).toBe('https://discuss.eroscripts.com/t/fixture/1?token=secret')
    expect(await readFile(join(context.directory, '.journal', 'queue.json'), 'utf8')).not.toContain('token=secret')
  })

  it('passes only selected script source names as video pairing hints', async () => {
    const requests: TransferRequest[] = []
    const context = await setup(async request => { requests.push(request); return { status: 'waiting', reason: 'Fixture' } })
    const video = { ...candidate('video', 'video', 'gofile.io'), url: 'https://gofile.io/d/folder', fileName: null }
    const selected = { ...candidate('selected'), fileName: '1641647055994.funscript' }
    const unselected = { ...candidate('unselected'), fileName: '1645668234609.funscript' }
    await context.queue.enqueue(context.selection([video, selected], [video, selected, unselected]))
    await settled(context.queue)
    expect(requests.find(request => request.candidate.id === video.id)?.scriptFileNames).toEqual(['1641647055994.funscript'])
    expect(await readFile(join(context.directory, '.journal', 'queue.json'), 'utf8')).not.toContain('scriptFileNames')
  })

  it('does not try another host for a local failure', async () => {
    const calls: string[] = []
    const context = await setup(async request => { calls.push(request.candidate.id); return { status: 'failed', reason: 'Disk full', scope: 'local' } })
    const first = candidate('first', 'script', 'one.example', 'mirror')
    const second = candidate('second', 'script', 'two.example', 'mirror')
    await context.queue.enqueue(context.selection([first], [first, second]))
    await settled(context.queue)
    expect(calls).toEqual(['first'])
    expect(context.queue.state().batches[0]?.files[0]?.reason).toBe('Disk full')
  })

  it('offers one explicit Dropbox browser attempt after a documented direct source fails', async () => {
    const requests: TransferRequest[] = []
    const context = await setup(async request => {
      requests.push(request)
      return request.directUrl ? { status: 'failed', reason: 'Remote transfer failed', scope: 'remote' } : complete(request)
    })
    const source = { ...candidate('dropbox'), host: 'www.dropbox.com', url: 'https://www.dropbox.com/s/token/scene.alternative.roll.funscript?dl=0' }
    const id = await context.queue.enqueue(context.selection([source]))
    await settled(context.queue)
    expect(context.queue.state().batches[0]?.files[0]).toMatchObject({ phase: 'waiting', canContinue: true })
    expect(requests).toHaveLength(1)
    await context.queue.continue(id)
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    expect(requests).toHaveLength(2)
    expect(requests[1]?.directUrl).toBeNull()
    expect(requests[1]?.candidate.url).toBe(source.url)
    expect(requests[0]?.fileId).toBe(requests[1]?.fileId)
    expect(context.queue.state().session.total).toBe(1)
  })

  it('automatically tries the ordinary Pixeldrain viewer after API refusal without another file count', async () => {
    const requests: TransferRequest[] = []
    const context = await setup(async request => {
      requests.push(request)
      return request.directUrl ? { status: 'failed', reason: 'HTTP 403 hotlink_detected', scope: 'remote' } : complete(request)
    })
    const source = { ...candidate('pixeldrain'), host: 'pixeldrain.com', url: 'https://pixeldrain.com/u/Synthetic' }
    await context.queue.enqueue(context.selection([source]))
    await settled(context.queue)
    expect(requests).toHaveLength(2)
    expect(requests[0]?.directUrl).toBe('https://pixeldrain.com/api/file/Synthetic?download')
    expect(requests[1]?.directUrl).toBeNull()
    expect(requests[1]?.candidate.url).toBe(source.url)
    expect(requests[1]?.fileId).toBe(requests[0]?.fileId)
    expect(requests[1]?.stagingPath).toBe(requests[0]?.stagingPath)
    expect(context.queue.state().session).toMatchObject({ completed: 1, total: 1 })
    expect(context.queue.state().batches[0]?.files[0]?.attempts).toHaveLength(2)
  })

  it.each(['waiting', 'failed'] as const)('bounds automatic Pixeldrain fallback when its viewer returns %s', async status => {
    const requests: TransferRequest[] = []
    const context = await setup(async request => {
      requests.push(request)
      return request.directUrl ? { status: 'failed', reason: 'HTTP 403', scope: 'remote' }
        : status === 'waiting' ? { status: 'waiting', reason: 'Pixeldrain requires CAPTCHA', tabId: 7 }
          : { status: 'failed', reason: 'Host connection failed', scope: 'remote' }
    })
    const source = { ...candidate('pixeldrain'), host: 'pixeldrain.com', url: 'https://pixeldrain.com/u/Synthetic' }
    await context.queue.enqueue(context.selection([source]))
    await settled(context.queue)
    expect(requests).toHaveLength(2)
    expect(context.queue.state().session).toMatchObject({ completed: 0, total: 1 })
    expect(context.queue.state().batches[0]?.files[0]).toMatchObject({ phase: status, canContinue: status === 'waiting' })
    if (status === 'waiting') expect(context.queue.state().batches[0]?.files[0]?.reason).toBe('Pixeldrain requires CAPTCHA')
  })

  it('lets an explicit retry start a new bounded Pixeldrain pass on the same file', async () => {
    const requests: TransferRequest[] = []
    let viewerAvailable = false
    const context = await setup(async request => {
      requests.push(request)
      return request.directUrl || !viewerAvailable ? { status: 'failed', reason: 'Host connection failed', scope: 'remote' } : complete(request)
    })
    const source = { ...candidate('pixeldrain'), host: 'pixeldrain.com', url: 'https://pixeldrain.com/u/Synthetic' }
    const id = await context.queue.enqueue(context.selection([source]))
    await settled(context.queue)
    expect(requests).toHaveLength(2)
    expect(context.queue.state().batches[0]?.files[0]?.phase).toBe('failed')
    viewerAvailable = true
    await context.queue.retry(id)
    await settled(context.queue)
    expect(requests).toHaveLength(4)
    expect(new Set(requests.map(request => request.fileId)).size).toBe(1)
    expect(context.queue.state().session).toMatchObject({ completed: 1, total: 1 })
  })

  it('counts a ZIP transfer once and discards it after extracting and importing its scripts', async () => {
    const bytes = await readFile(new URL('./fixtures/script-bundle.zip', import.meta.url))
    const context = await setup(async request => { await writeFile(request.stagingPath, bytes); return { status: 'complete', fileName: 'scene.zip', totalBytes: bytes.length } })
    await context.queue.enqueue(context.selection([{ ...candidate('bundle', 'archive'), fileName: 'scene.zip' }]))
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    expect(context.queue.state().session.total).toBe(1)
    await expect(readFile(join(context.directory, 'scene.zip'))).rejects.toThrow()
    expect(context.importPublished).toHaveBeenCalledWith(expect.objectContaining({ files: [expect.objectContaining({ kind: 'script', name: 'scene.funscript' }), expect.objectContaining({ kind: 'script', name: 'scene.alternative.roll.funscript' })] }))
  })

  it('rejects an HTML response and continues with the matching mirror', async () => {
    const context = await setup(async request => {
      if (request.candidate.id !== 'html') return complete(request)
      const bytes = Buffer.from('<!doctype html><html>Quota reached</html>')
      await writeFile(request.stagingPath, bytes)
      return { status: 'complete', fileName: 'scene.alternative.roll.funscript', totalBytes: bytes.length, mimeType: 'text/html' }
    })
    const first = candidate('html', 'script', 'one.example', 'mirror')
    const second = candidate('second', 'script', 'two.example', 'mirror')
    await context.queue.enqueue(context.selection([first], [first, second]))
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    expect(context.queue.state().batches[0]?.files[0]?.attempts[0]?.reason).toBe('The host returned a webpage')
  })

  it('rejects late progress and controls from a failed mirror attempt', async () => {
    const requests: TransferRequest[] = []
    const context = await setup(async request => {
      requests.push(request)
      if (requests.length === 1) return { status: 'failed', reason: 'Host failed', scope: 'remote' }
      request.onProgress({ receivedBytes: 10, totalBytes: SCRIPT.length })
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { status: 'failed', reason: 'Cancelled', scope: 'remote' }
    })
    const first = candidate('one', 'script', 'one.example', 'same')
    const second = candidate('two', 'script', 'two.example', 'same')
    const id = await context.queue.enqueue(context.selection([first], [first, second]))
    await expect.poll(() => requests.length).toBe(2)
    const oldCancel = vi.fn()
    requests[0]!.onProgress({ receivedBytes: 999, totalBytes: 999 })
    requests[0]!.onControl({ pause: vi.fn(), resume: vi.fn(), cancel: oldCancel })
    expect(context.queue.state().batches[0]?.files[0]?.receivedBytes).toBe(10)
    await context.queue.cancel(id)
    expect(oldCancel).not.toHaveBeenCalled()
    expect(context.queue.state().session).toMatchObject({ total: 1, cancelled: 1 })
  })

  it('cancels only unfinished staging and ignores late progress callbacks', async () => {
    let captured: TransferRequest | null = null
    const context = await setup(async request => {
      if (request.candidate.id === 'completed') return complete(request)
      captured = request
      await writeFile(request.stagingPath, SCRIPT.subarray(0, 10))
      request.onProgress({ receivedBytes: 10, totalBytes: SCRIPT.length })
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { status: 'failed', reason: 'Cancelled', scope: 'remote' }
    })
    await context.queue.enqueue(context.selection([candidate('completed')]))
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    await context.queue.enqueue(context.selection([candidate('unfinished', 'script', 'two.example')]))
    await expect.poll(() => captured !== null).toBe(true)
    await context.queue.cancelAll()
    const request: TransferRequest = captured!
    request.onProgress({ receivedBytes: 1000, totalBytes: 1000 })
    expect(context.queue.state().session).toMatchObject({ completed: 1, total: 2, cancelled: 1 })
    expect(context.queue.state().batches[1]?.files[0]?.phase).toBe('cancelled')
    expect(await readFile(join(context.directory, 'scene.alternative.roll.funscript'))).toEqual(SCRIPT)
    await expect(readFile(request.stagingPath)).rejects.toThrow()
  })

  it('pauses and resumes a real transfer control without queueing another file', async () => {
    let paused = false
    let finish: (() => void) | null = null
    const transport = vi.fn(async (request: TransferRequest) => {
      request.onControl({ pause: () => { paused = true }, resume: () => { paused = false }, cancel: () => finish?.() })
      request.onProgress({ receivedBytes: 10, totalBytes: SCRIPT.length, canPause: true })
      await new Promise<void>(resolve => { finish = resolve; request.signal.addEventListener('abort', () => resolve(), { once: true }) })
      return complete(request)
    })
    const context = await setup(transport)
    const id = await context.queue.enqueue(context.selection([candidate('pause')]))
    await expect.poll(() => context.queue.state().batches[0]?.files[0]?.phase).toBe('downloading')
    await context.queue.pause(id)
    expect(paused).toBe(true)
    expect(context.queue.state().batches[0]?.files[0]?.phase).toBe('paused')
    await context.queue.resume(id)
    expect(paused).toBe(false)
    finish!()
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    expect(transport).toHaveBeenCalledOnce()
    expect(context.queue.state().session.total).toBe(1)
  })

  it('downloads actual harmless fixture bytes over local HTTP into staging and publishes only after validation', async () => {
    const server = createServer((_request, response) => { response.setHeader('Content-Type', 'application/octet-stream'); response.end(SCRIPT) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server did not start')
    try {
      const context = await setup(async request => {
        const response = await fetch(`http://127.0.0.1:${address.port}/fixture`, { signal: request.signal })
        const bytes = Buffer.from(await response.arrayBuffer())
        await writeFile(request.stagingPath, bytes)
        return { status: 'complete', fileName: 'fixture.funscript', totalBytes: bytes.length }
      })
      await context.queue.enqueue(context.selection([{ ...candidate('http-fixture'), fileName: 'fixture.funscript' }]))
      await expect.poll(() => context.queue.state().session.completed).toBe(1)
      expect(await readFile(join(context.directory, 'fixture.funscript'))).toEqual(SCRIPT)
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
})

describe('destination and format safety', () => {
  it('rejects traversal and symlink destinations, preserves original v2 bytes', async () => {
    const context = await setup(complete)
    const root = context.options.getRoot()
    await expect(checkDestination(root, { rootId: 1, relativePath: '../outside' })).rejects.toThrow('Invalid destination')
    await symlink(context.directory, join(context.directory, 'alias'))
    await expect(checkDestination(root, { rootId: 1, relativePath: 'alias' })).rejects.toThrow('symbolic link')
    expect(() => safeFileName('CON.mp4')).toThrow('Invalid file name')
    expect(() => verifyFunscript(SCRIPT)).not.toThrow()
    expect(() => verifyFunscript(Buffer.from('{"actions":[{"at":"invalid","pos":100}]}'))).toThrow('Invalid script actions')
    expect(() => verifyFunscript(Buffer.from('{"actions":[{"at":0,"pos":1e999}]}'))).toThrow('Invalid script actions')
  })
})
