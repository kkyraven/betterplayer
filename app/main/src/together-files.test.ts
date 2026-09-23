import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, link, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FILE_CHUNK_BYTES } from '@shared/together'
import { TogetherFiles } from './together-files'

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, link: vi.fn(fs.link), copyFile: vi.fn(fs.copyFile) }
})

let dir: string
let sender: TogetherFiles
let receiver: TogetherFiles
let destination: string
beforeEach(async () => {
  vi.clearAllMocks()
  dir = await mkdtemp(join(tmpdir(), 'bp-transfer-'))
  destination = join(dir, 'saved.mp4')
  sender = new TogetherFiles(async () => null)
  receiver = new TogetherFiles(async () => destination)
})
afterEach(async () => { await sender.clear(); await receiver.clear(); await rm(dir, { recursive: true, force: true }) })

async function share(bytes = Buffer.alloc(FILE_CHUNK_BYTES * 3 + 7, 42)) {
  const path = join(dir, 'source.mp4')
  await writeFile(path, bytes)
  const video = await sender.allow(path)
  if (!video) throw Error('No offer')
  return { video, bytes }
}

it('streams exact chunks to a separate file and verifies the complete SHA-256', async () => {
  const { video, bytes } = await share()
  const outgoing = await sender.sendStart(video.id)
  const incoming = (await receiver.receiveStart(video))!
  let offset = 0
  for (;;) {
    const chunk = await sender.read(outgoing)
    if (chunk.digest) {
      expect(chunk.digest).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(await receiver.complete(incoming, chunk.digest)).toBe(destination)
      break
    }
    expect(chunk.data.length).toBeLessThanOrEqual(FILE_CHUNK_BYTES)
    await receiver.write(incoming, offset, chunk.data)
    offset += chunk.data.length
  }
  expect(await readFile(destination)).toEqual(bytes)
  expect((await readdir(dir)).some(name => name.endsWith('.part'))).toBe(false)
})

it('revokes existing read handles and refuses unapproved files', async () => {
  const { video } = await share()
  await expect(sender.sendStart('unapproved')).rejects.toThrow()
  const outgoing = await sender.sendStart(video.id)
  await sender.allow(null)
  await expect(sender.read(outgoing)).rejects.toThrow()
  await expect(sender.sendStart(video.id)).rejects.toThrow()
})

it('rejects reordered and oversized chunks and removes partial files on cancellation', async () => {
  const { video } = await share()
  const incoming = (await receiver.receiveStart(video))!
  await expect(receiver.write(incoming, 1, Buffer.from([1]))).rejects.toThrow()
  await expect(receiver.write(incoming, 0, Buffer.alloc(FILE_CHUNK_BYTES + 1))).rejects.toThrow()
  await receiver.write(incoming, 0, Buffer.from([1]))
  await receiver.cancel(incoming)
  expect((await readdir(dir)).some(name => name.endsWith('.part'))).toBe(false)
  await expect(readFile(destination)).rejects.toThrow()
})

it('refuses corrupt data even when its length matches', async () => {
  const { video, bytes } = await share(Buffer.alloc(16, 1))
  const incoming = (await receiver.receiveStart(video))!
  await receiver.write(incoming, 0, Buffer.alloc(16, 2))
  await expect(receiver.complete(incoming, createHash('sha256').update(bytes).digest('hex'))).rejects.toThrow()
  await expect(readFile(destination)).rejects.toThrow()
})

it('does not overwrite a destination created during the download', async () => {
  const { video, bytes } = await share(Buffer.alloc(16, 1))
  const incoming = (await receiver.receiveStart(video))!
  await receiver.write(incoming, 0, bytes)
  await writeFile(destination, 'keep this')
  await expect(receiver.complete(incoming, createHash('sha256').update(bytes).digest('hex'))).rejects.toThrow()
  expect(await readFile(destination, 'utf8')).toBe('keep this')
})

it('does not create a file when a save dialog resolves after session cleanup', async () => {
  const { video } = await share()
  let choose!: (path: string) => void
  receiver = new TogetherFiles(() => new Promise(resolve => { choose = resolve }))
  const pending = receiver.receiveStart(video)
  await receiver.clear()
  choose(destination)
  expect(await pending).toBeNull()
  expect((await readdir(dir)).some(name => name.endsWith('.part'))).toBe(false)
})


it('publishes through exclusive copy when the destination filesystem cannot hard-link', async () => {
  const { video, bytes } = await share(Buffer.alloc(16, 1))
  const incoming = (await receiver.receiveStart(video))!
  await receiver.write(incoming, 0, bytes)
  vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('Unsupported'), { code: 'ENOTSUP' }))
  await receiver.complete(incoming, createHash('sha256').update(bytes).digest('hex'))
  expect(copyFile).toHaveBeenCalledOnce()
  expect(await readFile(destination)).toEqual(bytes)
})

it('removes a newly published destination when cancellation races final completion', async () => {
  const { video, bytes } = await share(Buffer.alloc(16, 1))
  const incoming = (await receiver.receiveStart(video))!
  await receiver.write(incoming, 0, bytes)
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let published!: () => void
  let release!: () => void
  const ready = new Promise<void>(resolve => { published = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  vi.mocked(link).mockImplementationOnce(async (source, target) => { await real.link(source, target); published(); await hold })
  const completion = receiver.complete(incoming, createHash('sha256').update(bytes).digest('hex'))
  await ready
  await receiver.cancel(incoming)
  release()
  await expect(completion).rejects.toThrow('Transfer cancelled')
  await expect(readFile(destination)).rejects.toThrow()
})

it('keeps queued file offers stable while revoking removed files', async () => {
  const a = join(dir, 'a.mp4'), b = join(dir, 'b.mp4'), c = join(dir, 'c.mp4')
  await Promise.all([writeFile(a, Buffer.alloc(80, 1)), writeFile(b, Buffer.alloc(90, 2)), writeFile(c, Buffer.alloc(100, 3))])
  const first = await sender.allowQueue([a, b])
  const aSend = await sender.sendStart(first[0]!.id)
  const bSend = await sender.sendStart(first[1]!.id)
  const next = await sender.allowQueue([b, c])
  expect(next[0]).toEqual(first[1])
  await expect(sender.read(aSend)).rejects.toThrow('Sharing unavailable')
  expect((await sender.read(bSend)).data.byteLength).toBe(90)
  await sender.allowQueue([])
  await expect(sender.sendStart(next[1]!.id)).rejects.toThrow('Sharing unavailable')
})
