import { mkdir, mkdtemp, readFile, readdir, rm, lstat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter, ERR_INVALID_PASSWORD } from '@zip.js/zip.js'
import type { DownloadState } from '@shared/downloads'
import { DownloadQueue } from './index'
import type { DownloadQueueOptions } from './index'
import type { DownloadCandidate, TrustedDownloadSelection } from './transport'
import type { SecretCodec } from './journal'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
const SCRIPT = Buffer.from(JSON.stringify({ version: '2.0', actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }], channels: { twist: { actions: [{ at: 0, pos: 25 }] } }, metadata: { creator: 'Original fixture author' } }))
const VIDEO = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)])
const PASSWORD = 'published archive password'
const secureCodec: SecretCodec = { seal: text => Buffer.from(text).toString('hex'), unseal: text => Buffer.from(text, 'hex').toString('utf8') }
const noCodec: SecretCodec = { seal: () => null, unseal: () => null }
const resources: { directory: string; queue: DownloadQueue }[] = []
interface Entry { name: string; bytes?: Uint8Array }
async function zip(entries: Entry[], password?: string, zipCrypto = true, level = 6): Promise<Buffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const entry of entries) await writer.add(entry.name, new Uint8ArrayReader(entry.bytes ?? SCRIPT), { password, zipCrypto, level, useWebWorkers: false })
  return Buffer.from(await writer.close())
}
function source(id = 'zip', hints?: string[], kind: DownloadCandidate['kind'] = 'archive'): DownloadCandidate {
  return { id, url: `https://fixture.example/${id}?signature=private`, label: id, host: 'fixture.example', kind, fileName: kind === 'video' ? 'scene.mp4' : 'bundle.zip', postNumber: 1, controlId: null, mirrorKey: null, archivePasswords: hints }
}
function selection(sources: DownloadCandidate[]): TrustedDownloadSelection {
  return { topic: { tabId: 1, generation: 1, url: 'https://discuss.eroscripts.com/t/fixture/1', title: 'Fixture' }, sources, availableSources: sources, destination: { rootId: 1, relativePath: '' } }
}
async function setup(bytes: Buffer, configuration: { codec?: SecretCodec; importPublished?: DownloadQueueOptions['importPublished']; onState?: (state: DownloadState) => void; responseName?: string; completedControlCancel?: () => void; stalledSourceId?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bp-zip-queue-'))
  const root = { id: 1, kind: 'folder', path: directory, name: 'Fixtures' }
  const transfers: string[] = []
  let stagePath = ''
  const importPublished = vi.fn<DownloadQueueOptions['importPublished']>(configuration.importPublished ?? (async () => ({ mediaId: 42 })))
  const options: DownloadQueueOptions = {
    journalDir: join(directory, '.journal'), getRoot: () => root, codec: configuration.codec ?? secureCodec,
    importPublished, onState: configuration.onState ?? (() => {}),
    transport: async request => {
      transfers.push(request.candidate.id)
      if (configuration.completedControlCancel) request.onControl({ pause() {}, resume() {}, cancel: configuration.completedControlCancel })
      if (request.candidate.id === configuration.stalledSourceId) {
        request.onProgress({ receivedBytes: 1, totalBytes: null })
        await new Promise<void>(resolve => { if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true }) })
        return { status: 'failed', reason: 'Cancelled', scope: 'remote' }
      }
      const payload = request.candidate.kind === 'video' ? VIDEO : bytes
      if (request.candidate.kind !== 'video') stagePath = request.stagingPath
      await writeFile(request.stagingPath, payload)
      return { status: 'complete', fileName: request.candidate.kind === 'video' ? request.candidate.fileName! : configuration.responseName ?? 'bundle.zip', totalBytes: payload.length }
    },
  }
  const queue = await DownloadQueue.open(options)
  resources.push({ directory, queue })
  return { directory, queue, options, transfers, importPublished, stagePath: () => stagePath }
}
const first = (queue: DownloadQueue) => queue.state().batches[0]!.files[0]!
async function waiting(queue: DownloadQueue) { await expect.poll(() => first(queue).phase, { timeout: 4000 }).toBe('waiting') }
async function complete(queue: DownloadQueue) { await expect.poll(() => first(queue).phase, { timeout: 4000 }).toBe('complete') }
async function gone(path: string) {
  await expect.poll(async () => { try { await lstat(path); return false } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true; throw error } }, { timeout: 3000 }).toBe(true)
}
afterEach(async () => { for (const resource of resources.splice(0)) { await resource.queue.destroy(); await rm(resource.directory, { recursive: true, force: true }) } })

describe('ZIP download integration', () => {
  it.each([true, false])('automatically unlocks %s ZipCrypto using frozen author hints and counts one physical transfer', async zipCrypto => {
    const bytes = await zip([{ name: 'scene.funscript' }, { name: 'scene.MAX.twist.funscript' }, { name: 'scene.mp4', bytes: VIDEO }, { name: 'cover.gif', bytes: Buffer.from('unused') }], PASSWORD, zipCrypto)
    const context = await setup(bytes)
    const candidate = source('zip', [PASSWORD])
    await context.queue.enqueue(selection([candidate]))
    candidate.archivePasswords![0] = 'mutated after enqueue'
    await complete(context.queue)
    expect(context.transfers).toEqual(['zip'])
    expect(context.queue.state().session).toMatchObject({ completed: 1, total: 1 })
    expect(first(context.queue).archive).toMatchObject({ state: 'ready', skippedEntries: 1 })
    expect(await readFile(join(context.directory, 'scene.funscript'))).toEqual(SCRIPT)
    expect(await readFile(join(context.directory, 'scene.MAX.twist.funscript'))).toEqual(SCRIPT)
    expect(await readFile(join(context.directory, 'scene.mp4'))).toEqual(VIDEO)
    await gone(context.stagePath())
    expect(context.importPublished.mock.calls[0]![0].files.map(file => file.kind)).toEqual(['script', 'script', 'video'])
    expect(JSON.stringify(context.queue.state())).not.toContain(PASSWORD)
    expect(await readFile(join(context.directory, '.journal', 'queue.json'), 'utf8')).not.toContain(PASSWORD)
  })

  it('waits for missing or wrong passwords, reuses the ZIP, and never journals a manual password', async () => {
    const bytes = await zip([{ name: 'scene.funscript' }], PASSWORD, false)
    const context = await setup(bytes, { codec: noCodec })
    await context.queue.enqueue(selection([source()]))
    await waiting(context.queue)
    expect(first(context.queue).archive?.state).toBe('password-required')
    expect(await readFile(context.stagePath())).toEqual(bytes)
    await context.queue.unlock(first(context.queue).id, 'incorrect manual password')
    await waiting(context.queue)
    expect(first(context.queue).archive?.state).toBe('wrong-password')
    expect(await readFile(context.stagePath())).toEqual(bytes)
    await context.queue.unlock(first(context.queue).id, PASSWORD)
    await complete(context.queue)
    expect(context.transfers).toEqual(['zip'])
    expect(await readFile(join(context.directory, '.journal', 'queue.json'), 'utf8')).not.toContain('incorrect manual password')
    expect(await readFile(join(context.directory, '.journal', 'queue.json'), 'utf8')).not.toContain(PASSWORD)
  })

  it('recovers a complete ZIP without a decryptable source codec and asks for its password again', async () => {
    const bytes = await zip([{ name: 'scene.funscript' }], PASSWORD, false)
    const context = await setup(bytes, { codec: noCodec })
    await context.queue.enqueue(selection([source()]))
    await waiting(context.queue)
    const id = first(context.queue).id
    await context.queue.unlock(id, 'incorrect manual password')
    await waiting(context.queue)
    await context.queue.destroy()
    const recovered = await DownloadQueue.open(context.options)
    resources.push({ directory: context.directory, queue: recovered })
    await waiting(recovered)
    expect(first(recovered).archive?.state).toBe('password-required')
    await recovered.unlock(id, PASSWORD)
    await complete(recovered)
    expect(context.transfers).toEqual(['zip'])
    expect(await readFile(join(context.directory, 'scene.funscript'))).toEqual(SCRIPT)
  })

  it('keeps the original ZIP through an import failure and retries indexing without extraction or network', async () => {
    const bytes = await zip([{ name: 'scene.funscript' }, { name: 'scene.mp4', bytes: VIDEO }], PASSWORD)
    let fail = true
    const context = await setup(bytes, { importPublished: async () => { expect(await readFile(context.stagePath())).toEqual(bytes); if (fail) throw new Error('Temporary import failure'); return { mediaId: 42 } } })
    await context.queue.enqueue(selection([source('zip', [PASSWORD])]))
    await expect.poll(() => first(context.queue).phase).toBe('failed')
    expect(await readFile(context.stagePath())).toEqual(bytes)
    fail = false
    await context.queue.retry(first(context.queue).id)
    await complete(context.queue)
    expect(context.transfers).toEqual(['zip'])
    expect(context.importPublished).toHaveBeenCalledTimes(2)
    await gone(context.stagePath())
    expect((await readdir(context.directory)).filter(name => name.endsWith('.mp4'))).toEqual(['scene.mp4'])
  })

  it('recovers published artifact identities after an import failure with no source codec', async () => {
    const bytes = await zip([{ name: 'scene.funscript' }], PASSWORD, false)
    let fail = true
    const context = await setup(bytes, { codec: noCodec, importPublished: async () => { if (fail) throw new Error('Temporary import failure'); return { mediaId: null } } })
    await context.queue.enqueue(selection([source()]))
    await waiting(context.queue)
    const id = first(context.queue).id
    await context.queue.unlock(id, PASSWORD)
    await expect.poll(() => first(context.queue).phase).toBe('failed')
    await context.queue.destroy()
    fail = false
    const recovered = await DownloadQueue.open(context.options)
    resources.push({ directory: context.directory, queue: recovered })
    await recovered.retry(id)
    await complete(recovered)
    expect(context.transfers).toEqual(['zip'])
    expect((await readdir(context.directory)).filter(name => name.endsWith('.funscript'))).toEqual(['scene.funscript'])
    await gone(context.stagePath())
  })

  it('requires a multi-video selection and imports only its selected video and matching scripts', async () => {
    const bytes = await zip([{ name: 'one.mp4', bytes: VIDEO }, { name: 'one.funscript' }, { name: 'two.mp4', bytes: VIDEO }, { name: 'two.funscript' }, { name: 'two.roll.funscript' }], PASSWORD)
    const context = await setup(bytes)
    await context.queue.enqueue(selection([source('zip', [PASSWORD])]))
    await waiting(context.queue)
    expect(first(context.queue).archive?.state).toBe('selection-required')
    await expect(context.queue.selectArchive(first(context.queue).id, ['entry-999'])).rejects.toThrow('Invalid archive selection')
    await context.queue.selectArchive(first(context.queue).id, ['entry-2', 'entry-3', 'entry-4'])
    await complete(context.queue)
    expect((await readdir(context.directory)).filter(name => /\.(mp4|funscript)$/.test(name)).sort()).toEqual(['two.funscript', 'two.mp4', 'two.roll.funscript'])
    expect(context.transfers).toEqual(['zip'])
    expect(first(context.queue).archive?.entries.filter(entry => entry.publishedName).map(entry => entry.id)).toEqual(['entry-2', 'entry-3', 'entry-4'])
  })

  it('coordinates collision names for duplicate nested video/script groups without overwriting existing media', async () => {
    const bytes = await zip([{ name: 'first/scene.mp4', bytes: VIDEO }, { name: 'first/scene.funscript' }, { name: 'first/scene.MAX.funscript' }, { name: 'second/scene.mp4', bytes: VIDEO }, { name: 'second/scene.funscript' }, { name: 'second/scene.roll.funscript' }])
    const context = await setup(bytes)
    await writeFile(join(context.directory, 'SCENE.MP4'), 'existing user video')
    await context.queue.enqueue(selection([source()]))
    await waiting(context.queue)
    await context.queue.selectArchive(first(context.queue).id, first(context.queue).archive!.entries.map(entry => entry.id))
    await complete(context.queue)
    expect(await readFile(join(context.directory, 'SCENE.MP4'), 'utf8')).toBe('existing user video')
    expect((await readdir(context.directory)).filter(name => /\.(mp4|funscript)$/i.test(name)).sort()).toEqual(['SCENE.MP4', 'scene (2).MAX.funscript', 'scene (2).funscript', 'scene (2).mp4', 'scene (3).funscript', 'scene (3).mp4', 'scene (3).roll.funscript'])
  })

  it('preserves variants in different folders and gives duplicate base versions distinct variant names', async () => {
    const bytes = await zip([{ name: 'folder/variants/scene.funscript' }, { name: 'folder/scene.mp4', bytes: VIDEO }, { name: 'folder/scene.funscript' }, { name: 'MAX/scene.MAX.twist.funscript' }, { name: 'other/scene.roll.funscript' }])
    const context = await setup(bytes)
    await context.queue.enqueue(selection([source()]))
    await complete(context.queue)
    expect((await readdir(context.directory)).filter(name => name.endsWith('.funscript')).sort()).toEqual(['scene.MAX.twist.funscript', 'scene.funscript', 'scene.roll.funscript', 'scene.variants.funscript'])
    for (const name of (await readdir(context.directory)).filter(name => name.endsWith('.funscript'))) expect(await readFile(join(context.directory, name))).toEqual(SCRIPT)
  })

  it('pairs a normal video with matching scripts from a ZIP while leaving an unrelated script base intact', async () => {
    const bytes = await zip([{ name: 'Scene.FUNSCRIPT' }, { name: 'variants/Scene.alternative.roll.funscript' }, { name: 'unrelated.funscript' }], PASSWORD)
    const context = await setup(bytes)
    await context.queue.enqueue(selection([source('zip', [PASSWORD]), source('video', undefined, 'video')]))
    await complete(context.queue)
    expect(context.queue.state().session).toMatchObject({ completed: 2, total: 2 })
    expect((await readdir(context.directory)).filter(name => /\.(mp4|funscript)$/i.test(name)).sort()).toEqual(['scene.FUNSCRIPT', 'scene.alternative.roll.funscript', 'scene.mp4', 'unrelated.funscript'])
    expect(context.importPublished).toHaveBeenCalledTimes(1)
  })

  it('keeps a cancelled complete ZIP when video-only import clears its sibling staging and history', async () => {
    const bytes = await zip([{ name: 'scene.funscript' }], PASSWORD)
    const context = await setup(bytes)
    const batchId = await context.queue.enqueue(selection([source(), source('video', undefined, 'video')]))
    await waiting(context.queue)
    await expect.poll(() => context.queue.state().batches[0]!.files.find(file => file.kind === 'video')?.phase).toBe('staged')
    await context.queue.videoOnly(batchId)
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
    expect(await readFile(context.stagePath())).toEqual(bytes)
    await context.queue.clear()
    expect(context.queue.state().batches).toEqual([])
    expect(await readFile(context.stagePath())).toEqual(bytes)
    await context.queue.destroy()
    const recovered = await DownloadQueue.open(context.options)
    resources.push({ directory: context.directory, queue: recovered })
    expect(await readFile(context.stagePath())).toEqual(bytes)
    expect(context.transfers).toEqual(['zip', 'video'])
  })

  it('lets Cancel interrupt extraction without deleting the completed ZIP or blocking the command queue', async () => {
    const bytes = await zip([{ name: 'scene.funscript' }], PASSWORD)
    let cancellation: Promise<void> | undefined
    const completedControlCancel = vi.fn(() => { throw new Error('DownloadItem was destroyed') })
    const context = await setup(bytes, { completedControlCancel, onState: state => { const file = state.batches[0]?.files[0]; if (file?.phase === 'extracting' && !cancellation) cancellation = context.queue.cancel(file.id) } })
    await context.queue.enqueue(selection([source('zip', [PASSWORD])]))
    await expect.poll(() => first(context.queue).phase).toBe('cancelled')
    await cancellation
    expect(completedControlCancel).not.toHaveBeenCalled()
    expect(context.importPublished).not.toHaveBeenCalled()
    expect(await readFile(context.stagePath())).toEqual(bytes)
    expect(context.transfers).toEqual(['zip'])
  })

  it('detects an unknown-kind ZIP by signature and retains a ZIP with invalid script content', async () => {
    const bytes = await zip([{ name: 'scene.funscript' }])
    const context = await setup(bytes, { responseName: 'download.bin' })
    await context.queue.enqueue(selection([{ ...source('zip', undefined, 'unknown'), fileName: null }]))
    await complete(context.queue)
    expect(first(context.queue).kind).toBe('archive')
    expect(first(context.queue).fileName).toBe('download.bin.zip')
    const invalid = await zip([{ name: 'scene.funscript', bytes: Buffer.from('invalid JSON') }])
    const broken = await setup(invalid)
    await broken.queue.enqueue(selection([source()]))
    await expect.poll(() => first(broken.queue).phase).toBe('failed')
    expect(broken.importPublished).not.toHaveBeenCalled()
    expect(await readFile(broken.stagePath())).toEqual(invalid)
    expect((await readdir(broken.directory)).filter(name => name.endsWith('.funscript'))).toEqual([])
  })

  it('rejects a journal artifact containing an arbitrary staging path', async () => {
    const bytes = await zip([{ name: 'scene.funscript' }])
    const context = await setup(bytes, { importPublished: async () => { throw new Error('Temporary import failure') } })
    await context.queue.enqueue(selection([source()]))
    await expect.poll(() => first(context.queue).phase).toBe('failed')
    await context.queue.destroy()
    const path = join(context.directory, '.journal', 'queue.json')
    const saved = JSON.parse(await readFile(path, 'utf8')) as { batches: { files: { archiveArtifacts: { stageName: string }[] }[] }[] }
    saved.batches[0]!.files[0]!.archiveArtifacts[0]!.stageName = '../outside'
    await writeFile(path, JSON.stringify(saved))
    await expect(DownloadQueue.open(context.options)).rejects.toThrow('Invalid download recovery journal')
    expect(await readFile(context.stagePath())).toEqual(bytes)
  })

  it('retains an unknown-kind completed ZIP when cancelled during initial verification', async () => {
    const bytes = await zip([{ name: 'scene.funscript' }])
    let cancellation: Promise<void> | undefined
    const context = await setup(bytes, { responseName: 'download.bin', onState: state => { const file = state.batches[0]?.files[0]; if (file?.phase === 'verifying' && !cancellation) cancellation = context.queue.cancel(file.id) } })
    await context.queue.enqueue(selection([{ ...source('zip', undefined, 'unknown'), fileName: null }]))
    await expect.poll(() => first(context.queue).phase).toBe('cancelled')
    await cancellation
    expect(await readFile(context.stagePath())).toEqual(bytes)
    expect(context.importPublished).not.toHaveBeenCalled()
  })

  it('finishes ZIP cleanup after recovering a snapshot written after indexing but before deletion', async () => {
    const bytes = await zip([{ name: 'scene.funscript' }])
    let snapshot = ''
    const context = await setup(bytes, { onState: state => { if (state.batches[0]?.files[0]?.phase === 'complete' && !snapshot) snapshot = readFileSync(join(context.directory, '.journal', 'queue.json'), 'utf8') } })
    await context.queue.enqueue(selection([source()]))
    await complete(context.queue)
    await context.queue.destroy()
    expect(snapshot).toBeTruthy()
    await mkdir(dirname(context.stagePath()), { recursive: true })
    await writeFile(context.stagePath(), bytes)
    await writeFile(join(context.directory, '.journal', 'queue.json'), snapshot)
    const recovered = await DownloadQueue.open(context.options)
    resources.push({ directory: context.directory, queue: recovered })
    await gone(context.stagePath())
    expect(await readFile(join(context.directory, 'scene.funscript'))).toEqual(SCRIPT)
    expect(context.transfers).toEqual(['zip'])
    expect(context.importPublished).toHaveBeenCalledTimes(1)
  })


  it('offers a manual password after an incorrect synthetic ZipCrypto key passes its header but fails CRC', async () => {
    const bytes = await zip([{ name: 'scene.funscript' }], PASSWORD, true, 0)
    const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false })
    const entry = (await reader.getEntries())[0]
    if (!entry || entry.directory) throw new Error('Invalid synthetic fixture')
    let collision: string | undefined
    try {
      for (let index = 0; index < 4096; index++) {
        const candidate = `incorrect synthetic fixture ${index}`
        try { await entry.getData(new Uint8ArrayWriter(), { password: candidate, checkPasswordOnly: true, useWebWorkers: false }); collision = candidate; break }
        catch (error) { if (!(error instanceof Error) || error.message !== ERR_INVALID_PASSWORD) throw error }
      }
    } finally { await reader.close() }
    if (!collision) throw new Error('Synthetic collision was not found')
    const context = await setup(bytes)
    await context.queue.enqueue(selection([source('zip', [collision])]))
    await waiting(context.queue)
    expect(first(context.queue)).toMatchObject({ reason: 'Archive verification failed', archive: { state: 'password-required' } })
    expect(context.importPublished).not.toHaveBeenCalled()
    expect(await readFile(context.stagePath())).toEqual(bytes)
    await context.queue.unlock(first(context.queue).id, PASSWORD)
    await complete(context.queue)
    expect(await readFile(join(context.directory, 'scene.funscript'))).toEqual(SCRIPT)
    expect(context.transfers).toEqual(['zip'])
  })

  it('lets an unrelated Cancel command finish while video-only indexing waits', async () => {
    const bytes = await zip([{ name: 'scene.funscript' }], PASSWORD)
    let started = false
    let release: (() => void) | undefined
    const context = await setup(bytes, { stalledSourceId: 'stalled', importPublished: async () => { started = true; await new Promise<void>(resolve => { release = resolve }); return { mediaId: 42 } } })
    const batch = await context.queue.enqueue(selection([source(), source('video', undefined, 'video')]))
    await expect.poll(() => context.queue.state().batches[0]?.canImportVideoOnly).toBe(true)
    const other = await context.queue.enqueue(selection([source('stalled', undefined, 'script')]))
    await expect.poll(() => context.queue.state().batches[1]?.files[0]?.phase).toBe('downloading')
    try {
      await context.queue.videoOnly(batch)
      await expect.poll(() => started).toBe(true)
      await context.queue.cancel(other)
      expect(context.queue.state().batches[1]?.files[0]?.phase).toBe('cancelled')
    } finally { release?.() }
    await expect.poll(() => context.queue.state().session.completed).toBe(1)
  })

  it.each([{ title: 'Scene'.repeat(44), existing: 'Scene'.repeat(40) + 'S.mp4' }, { title: '界'.repeat(90), existing: '界'.repeat(67) + '.mp4' }])('preserves a bounded common video/script stem and compound suffix for $title', async ({ title, existing }) => {
    const bytes = await zip([{ name: `${title}.mp4`, bytes: VIDEO }, { name: `${title}.MAX.roll.funscript` }])
    const context = await setup(bytes)
    await writeFile(join(context.directory, existing), 'existing user media')
    await context.queue.enqueue(selection([source()]))
    await complete(context.queue)
    const files = context.importPublished.mock.calls[0]![0].files
    const video = files.find(file => file.kind === 'video')!
    const script = files.find(file => file.kind === 'script')!
    const stem = basename(video.name, extname(video.name))
    expect(script.name).toBe(`${stem}.MAX.roll.funscript`)
    expect(stem.endsWith(' (2)')).toBe(true)
    expect(Buffer.byteLength(video.name)).toBeLessThanOrEqual(220)
    expect(Buffer.byteLength(script.name)).toBeLessThanOrEqual(220)
    expect(await readFile(join(context.directory, video.name))).toEqual(VIDEO)
    expect(await readFile(join(context.directory, script.name))).toEqual(SCRIPT)
    expect(await readFile(join(context.directory, existing), 'utf8')).toBe('existing user media')
  })

  it('preserves script delimiters when Unicode case folding expands a video stem', async () => {
    const bytes = await zip([{ name: 'İ.mp4', bytes: VIDEO }, { name: 'İ.roll.funscript' }])
    const context = await setup(bytes)
    await context.queue.enqueue(selection([source()]))
    await complete(context.queue)
    expect((await readdir(context.directory)).filter(name => /\.(mp4|funscript)$/.test(name)).sort()).toEqual(['İ.mp4', 'İ.roll.funscript'])
    expect(await readFile(join(context.directory, 'İ.roll.funscript'))).toEqual(SCRIPT)
  })


  it('rejects an overlong original archive path before persisting an unrecoverable journal', async () => {
    const bytes = await zip([{ name: `${'folder/'.repeat(600)}scene.funscript` }])
    const context = await setup(bytes)
    await context.queue.enqueue(selection([source()]))
    await expect.poll(() => first(context.queue).phase).toBe('failed')
    expect(first(context.queue).reason).toBe('Archive path limit')
    expect(first(context.queue).archive).toBeUndefined()
    expect(context.importPublished).not.toHaveBeenCalled()
    expect(await readFile(context.stagePath())).toEqual(bytes)
    await context.queue.destroy()
    const recovered = await DownloadQueue.open(context.options)
    resources.push({ directory: context.directory, queue: recovered })
    expect(first(recovered).phase).toBe('failed')
    expect(await readFile(context.stagePath())).toEqual(bytes)
  })


  it('preserves EroScripts max/plus hyphen variants beside their base script and collided video stem', async () => {
    const bytes = await zip([{ name: 'scene.mp4', bytes: VIDEO }, { name: 'scene.funscript' }, { name: 'scene-max.funscript' }, { name: 'scene-plus.funscript' }], PASSWORD)
    const context = await setup(bytes)
    await writeFile(join(context.directory, 'scene.mp4'), 'existing user media')
    await context.queue.enqueue(selection([source('zip', [PASSWORD])]))
    await complete(context.queue)
    expect((await readdir(context.directory)).filter(name => /\.(mp4|funscript)$/.test(name)).sort()).toEqual(['scene (2)-max.funscript', 'scene (2)-plus.funscript', 'scene (2).funscript', 'scene (2).mp4', 'scene.mp4'])
    expect(await readFile(join(context.directory, 'scene.mp4'), 'utf8')).toBe('existing user media')
    for (const name of ['scene (2).funscript', 'scene (2)-max.funscript', 'scene (2)-plus.funscript']) expect(await readFile(join(context.directory, name))).toEqual(SCRIPT)
    await gone(context.stagePath())
  })

})
