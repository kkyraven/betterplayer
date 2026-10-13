import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { WritableStream } from 'node:stream/web'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Reader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { ArchiveError, extractArchive, inspectArchive } from './archive'

const SCRIPT = Buffer.from(JSON.stringify({ version: '2.0', actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }], channels: { twist: { actions: [{ at: 100, pos: 25 }] } }, metadata: { title: 'Original creator metadata' } }))
const VIDEO = Buffer.from('\x00\x00\x00\x18ftypisomtest-original-video-bytes', 'binary')
const temporary: string[] = []
interface FixtureEntry { name: string; bytes?: Uint8Array; password?: string; zipCrypto?: boolean; attributes?: number; level?: number }
async function fixture(entries: readonly FixtureEntry[]) {
  const directory = await mkdtemp(join(tmpdir(), 'bp-archive-test-'))
  temporary.push(directory)
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const entry of entries) {
    await writer.add(entry.name, new Uint8ArrayReader(entry.bytes ?? SCRIPT), { password: entry.password, zipCrypto: entry.zipCrypto, level: entry.level ?? 0, externalFileAttributes: entry.attributes, versionMadeBy: entry.attributes === undefined ? undefined : 0x0314, useWebWorkers: false })
  }
  const bytes = Buffer.from(await writer.close())
  const path = join(directory, 'source.zip')
  await writeFile(path, bytes)
  return { directory, path, bytes }
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function expectPreserved(path: string, original: Uint8Array, directory: string) {
  expect(await readFile(path)).toEqual(Buffer.from(original))
  expect((await readdir(directory)).filter(name => name.startsWith('.archive-'))).toEqual([])
}

describe('safe streamed ZIP extraction', () => {
  it.each([true, false])('extracts original bytes with %s ZipCrypto and full integrity checks', async zipCrypto => {
    const context = await fixture([{ name: 'Variants/scene.MAX.FUNSCRIPT', password: 'published password', zipCrypto, level: 6 }, { name: 'readme.txt', bytes: Buffer.from('innocent text') }, { name: 'cover.jpg', bytes: Buffer.from('cover') }, { name: 'nested.zip', bytes: Buffer.from('never extract recursively') }, { name: 'run.exe', bytes: Buffer.from('never execute') }])
    const inspected = await inspectArchive(context.path)
    expect(inspected).toMatchObject({ encrypted: true, requiresSelection: false, skippedEntries: 4 })
    expect(inspected.entries[0]).toMatchObject({ name: 'Variants/scene.MAX.FUNSCRIPT', fileName: 'scene.MAX.FUNSCRIPT', kind: 'script', encryption: zipCrypto ? 'zipcrypto' : 'aes' })
    const result = await extractArchive(context.path, { passwords: ['wrong password', 'published password'] })
    expect(result.files).toHaveLength(1)
    expect(await readFile(result.files[0]!.path)).toEqual(SCRIPT)
    expect(await readdir(result.directory)).toEqual(['entry-0.funscript'])
    expect(await readFile(context.path)).toEqual(context.bytes)
  })

  it.each([true, false])('requires a password and retains the archive after wrong %s password', async zipCrypto => {
    const context = await fixture([{ name: 'scene.funscript', password: 'author supplied', zipCrypto }])
    await expect(extractArchive(context.path)).rejects.toMatchObject({ code: 'password-required' })
    await expectPreserved(context.path, context.bytes, context.directory)
    await expect(extractArchive(context.path, { passwords: ['incorrect'] })).rejects.toSatisfy((error: unknown) => error instanceof ArchiveError && (error.code === 'wrong-password' || (zipCrypto && error.code === 'corrupt')))
    await expectPreserved(context.path, context.bytes, context.directory)
  })

  it('supports explicitly published different passwords per entry without modifying scripts', async () => {
    const context = await fixture([{ name: 'scene.funscript', password: 'one', zipCrypto: true }, { name: 'scene.twist.funscript', password: 'two', zipCrypto: false }])
    const result = await extractArchive(context.path, { passwords: ['one', 'two'] })
    expect(result.files).toHaveLength(2)
    for (const file of result.files) expect(await readFile(file.path)).toEqual(SCRIPT)
  })

  it('automatically extracts one video plus root, variant and axis scripts from safe folders', async () => {
    const context = await fixture([{ name: 'scene/scene.mp4', bytes: VIDEO }, { name: 'scene/scene.funscript' }, { name: 'scene/scene.alternative.roll.funscript' }, { name: 'Variants/scene.MAX.funscript' }])
    const result = await extractArchive(context.path)
    expect(result.files.map(entry => entry.name)).toEqual(['scene/scene.mp4', 'scene/scene.funscript', 'scene/scene.alternative.roll.funscript', 'Variants/scene.MAX.funscript'])
    expect(await readFile(result.files[0]!.path)).toEqual(VIDEO)
    for (const file of result.files.slice(1)) expect(await readFile(file.path)).toEqual(SCRIPT)
  })

  it('requires an explicit entry selection for multiple videos', async () => {
    const context = await fixture([{ name: 'one.mp4', bytes: VIDEO }, { name: 'one.funscript' }, { name: 'two.mkv', bytes: VIDEO }, { name: 'two.funscript' }])
    const inspected = await inspectArchive(context.path)
    expect(inspected.requiresSelection).toBe(true)
    expect(inspected.defaultEntryIds).toEqual([])
    await expect(extractArchive(context.path)).rejects.toMatchObject({ code: 'selection-required' })
    await expectPreserved(context.path, context.bytes, context.directory)
    const result = await extractArchive(context.path, { entryIds: ['entry-0', 'entry-1'] })
    expect(result.files.map(entry => entry.fileName)).toEqual(['one.mp4', 'one.funscript'])
  })

  it.each(['../escape.funscript', '/absolute.funscript', 'C:/drive.funscript', 'folder/../escape.funscript', 'folder\\..\\escape.funscript', 'folder/NUL.funscript', 'scene.funscript:alternate', 'trailing./scene.funscript'])('rejects unsafe path %s even when irrelevant', async name => {
    const context = await fixture([{ name: 'scene.funscript' }, { name: name.replace(/funscript$/, 'txt') }])
    await expect(extractArchive(context.path)).rejects.toMatchObject({ code: 'unsafe' })
    await expectPreserved(context.path, context.bytes, context.directory)
  })

  it('rejects symlinks even if they would otherwise be skipped', async () => {
    const context = await fixture([{ name: 'scene.funscript' }, { name: 'cover.jpg', attributes: 0xa1ff0000, bytes: Buffer.from('/outside') }])
    await expect(extractArchive(context.path)).rejects.toMatchObject({ code: 'unsafe' })
    await expectPreserved(context.path, context.bytes, context.directory)
  })

  it.each([['scene.funscript', 'SCENE.FUNSCRIPT'], ['caf\u00e9.funscript', 'cafe\u0301.funscript'], ['folder', 'folder/scene.funscript']])('rejects path collisions %s / %s', async (first, second) => {
    const context = await fixture([{ name: first }, { name: second }])
    await expect(extractArchive(context.path)).rejects.toMatchObject({ code: 'unsafe' })
    await expectPreserved(context.path, context.bytes, context.directory)
  })

  it('rejects a corrupted CRC after extraction and removes all staging outputs', async () => {
    const context = await fixture([{ name: 'scene.funscript', level: 0 }])
    const damaged = Buffer.from(context.bytes)
    const local = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const central = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    damaged.writeUInt32LE((damaged.readUInt32LE(local + 14) ^ 1) >>> 0, local + 14)
    damaged.writeUInt32LE((damaged.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16)
    await writeFile(context.path, damaged)
    await expect(extractArchive(context.path)).rejects.toMatchObject({ code: 'corrupt' })
    await expectPreserved(context.path, damaged, context.directory)
  })

  it('rejects invalid AES authentication rather than accepting the password header', async () => {
    const context = await fixture([{ name: 'scene.funscript', password: 'correct', zipCrypto: false }])
    const damaged = Buffer.from(context.bytes)
    const local = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const central = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    const dataStart = local + 30 + damaged.readUInt16LE(local + 26) + damaged.readUInt16LE(local + 28)
    const dataLength = damaged.readUInt32LE(central + 20)
    damaged[dataStart + dataLength - 1] = damaged[dataStart + dataLength - 1]! ^ 1
    await writeFile(context.path, damaged)
    await expect(extractArchive(context.path, { passwords: ['correct'] })).rejects.toMatchObject({ code: 'corrupt' })
    await expectPreserved(context.path, damaged, context.directory)
  })

  it.each([{ maxEntries: 1 }, { maxExpandedBytes: SCRIPT.length + 1 }, { maxEntryBytes: SCRIPT.length - 1 }, { maxScriptBytes: SCRIPT.length - 1 }, { maxArchiveBytes: 22 }])('enforces metadata bounds %j before staging', async limits => {
    const context = await fixture([{ name: 'one.funscript' }, { name: 'two.funscript' }])
    await expect(extractArchive(context.path, { limits })).rejects.toMatchObject({ code: 'limit' })
    await expectPreserved(context.path, context.bytes, context.directory)
  })

  it('rejects excessive expansion ratios and recursively nested archives', async () => {
    const context = await fixture([{ name: 'large.funscript', bytes: Buffer.alloc(100_000, 65), level: 9 }])
    await expect(extractArchive(context.path, { limits: { maxCompressionRatio: 10 } })).rejects.toMatchObject({ code: 'limit' })
    await expectPreserved(context.path, context.bytes, context.directory)
    const nested = await fixture([{ name: 'nested.zip', bytes: context.bytes }])
    await expect(extractArchive(nested.path)).rejects.toMatchObject({ code: 'unsupported' })
    await expectPreserved(nested.path, nested.bytes, nested.directory)
  })

  it('honours cancellation and preserves the downloaded ZIP', async () => {
    const context = await fixture([{ name: 'scene.funscript' }])
    const controller = new AbortController()
    controller.abort()
    await expect(extractArchive(context.path, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
    await expectPreserved(context.path, context.bytes, context.directory)
  })

  it('refuses a symlink archive source', async () => {
    const context = await fixture([{ name: 'scene.funscript' }])
    const link = join(context.directory, 'linked.zip')
    await symlink(context.path, link)
    await expect(extractArchive(link)).rejects.toMatchObject({ code: 'unsafe' })
    await expectPreserved(context.path, context.bytes, context.directory)
  })

  it('rejects invalid selections without changing or publishing files', async () => {
    const context = await fixture([{ name: 'scene.funscript' }])
    for (const entryIds of [[], ['unknown'], ['entry-0', 'entry-0']]) {
      await expect(extractArchive(context.path, { entryIds })).rejects.toBeInstanceOf(ArchiveError)
      await expectPreserved(context.path, context.bytes, context.directory)
    }
  })

  it('streams a video larger than the old 64 MiB script-archive limit', async () => {
    const size = 65 * 1024 ** 2
    const directory = await mkdtemp(join(tmpdir(), 'bp-archive-large-'))
    temporary.push(directory)
    const path = join(directory, 'source.zip')
    const source = await open(path, 'wx')
    const writer = new ZipWriter(new WritableStream<Uint8Array>({ async write(chunk) { await source.writeFile(chunk) } }), { useWebWorkers: false })
    class RepeatingReader extends Reader<undefined> {
      constructor() { super(undefined); this.size = size }
      async readUint8Array(offset: number, length: number): Promise<Uint8Array> { return Buffer.alloc(Math.min(length, this.size - offset), 65) }
    }
    try { await writer.add('scene.mp4', new RepeatingReader(), { level: 0, useWebWorkers: false }); await writer.close() }
    finally { await source.close() }
    const result = await extractArchive(path)
    const extracted = result.files[0]!
    expect((await stat(extracted.path)).size).toBe(size)
    const actual = createHash('sha256')
    for await (const chunk of createReadStream(extracted.path)) actual.update(chunk)
    const expected = createHash('sha256')
    const oneMiB = Buffer.alloc(1024 ** 2, 65)
    for (let index = 0; index < 65; index++) expected.update(oneMiB)
    expect(actual.digest('hex')).toBe(expected.digest('hex'))
    expect((await stat(path)).size).toBeGreaterThan(size)
  })

  it('cleans every partial file when cancellation occurs during streamed output', async () => {
    const context = await fixture([{ name: 'scene.funscript', password: 'correct', zipCrypto: false }])
    const controller = new AbortController()
    let progress = 0
    await expect(extractArchive(context.path, { passwords: ['correct'], signal: controller.signal, onProgress(_entry, bytes) { progress = bytes; controller.abort() } })).rejects.toMatchObject({ code: 'cancelled' })
    expect(progress).toBeGreaterThan(0)
    await expectPreserved(context.path, context.bytes, context.directory)
  })

  it('enforces the elapsed-time bound during output and keeps the source archive', async () => {
    const context = await fixture([{ name: 'scene.funscript' }])
    await expect(extractArchive(context.path, { limits: { maxDurationMs: 20 }, onProgress() { const start = Date.now(); while (Date.now() - start < 25) { } } })).rejects.toMatchObject({ code: 'limit' })
    await expectPreserved(context.path, context.bytes, context.directory)
  })

})
