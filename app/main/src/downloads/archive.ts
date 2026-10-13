import { constants } from 'node:fs'
import { lstat, mkdtemp, open, rm, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { WritableStream } from 'node:stream/web'
import { Reader, ZipReader, ERR_INVALID_PASSWORD, ERR_ENCRYPTED, ERR_INVALID_AUTHENTICATION_CODE, ERR_UNSUPPORTED_COMPRESSION, ERR_UNSUPPORTED_ENCRYPTION, ERR_UNSAFE_FILENAME } from '@zip.js/zip.js'
import type { Entry, FileEntry } from '@zip.js/zip.js'

export type ArchiveErrorCode = 'password-required' | 'wrong-password' | 'selection-required' | 'unsupported' | 'corrupt' | 'unsafe' | 'limit' | 'cancelled' | 'io'

export class ArchiveError extends Error {
  constructor(readonly code: ArchiveErrorCode, message: string) { super(message); this.name = 'ArchiveError' }
}

export interface ArchiveLimits {
  maxArchiveBytes: number
  maxEntries: number
  maxEntryBytes: number
  maxScriptBytes: number
  maxExpandedBytes: number
  maxCompressionRatio: number
  maxDurationMs: number
}

const DEFAULT_LIMITS: Readonly<ArchiveLimits> = {
  maxArchiveBytes: 32 * 1024 ** 3,
  maxEntries: 2048,
  maxEntryBytes: 16 * 1024 ** 3,
  maxScriptBytes: 32 * 1024 ** 2,
  maxExpandedBytes: 64 * 1024 ** 3,
  maxCompressionRatio: 1000,
  maxDurationMs: 30 * 60 * 1000,
}
const VIDEO = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi'])
const MAX_READ_BYTES = 16 * 1024 ** 2
const MAX_PASSWORDS = 8

export interface ArchiveEntry {
  id: string
  name: string
  fileName: string
  kind: 'video' | 'script'
  compressedBytes: number
  bytes: number
  encrypted: boolean
  encryption: 'none' | 'zipcrypto' | 'aes'
}
export interface ArchiveInspection {
  entries: readonly ArchiveEntry[]
  encrypted: boolean
  requiresSelection: boolean
  defaultEntryIds: readonly string[]
  skippedEntries: number
}
export interface ArchiveOptions {
  signal?: AbortSignal
  limits?: Partial<ArchiveLimits>
}
export interface ExtractArchiveOptions extends ArchiveOptions {
  entryIds?: readonly string[]
  passwords?: readonly string[]
  onProgress?: (entry: ArchiveEntry, extractedBytes: number, totalBytes: number) => void
}
export interface ExtractedArchiveEntry extends ArchiveEntry { path: string }
export interface ExtractedArchive {
  directory: string
  files: readonly ExtractedArchiveEntry[]
}

function limitsFor(options: ArchiveOptions): ArchiveLimits {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new ArchiveError('limit', 'Invalid archive limits')
  return limits
}

function operation(options: ArchiveOptions, limits: ArchiveLimits) {
  const controller = new AbortController()
  const deadline = Date.now() + limits.maxDurationMs
  const abort = () => controller.abort(new ArchiveError('cancelled', 'Archive extraction cancelled'))
  if (options.signal?.aborted) abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new ArchiveError('limit', 'Archive processing took too long')), limits.maxDurationMs)
  timer.unref()
  return {
    signal: controller.signal,
    check() {
      if (Date.now() >= deadline && !controller.signal.aborted) controller.abort(new ArchiveError('limit', 'Archive processing took too long'))
      if (controller.signal.aborted) throw controller.signal.reason
    },
    close() { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) },
  }
}

class FileReader extends Reader<FileHandle> {
  constructor(private readonly file: FileHandle, size: number, private readonly check: () => void) { super(file); this.size = size }
  async readUint8Array(offset: number, length: number): Promise<Uint8Array> {
    this.check()
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > MAX_READ_BYTES) throw new ArchiveError('limit', 'Archive metadata exceeds the supported size')
    const count = Math.min(length, Math.max(0, this.size - offset))
    const bytes = Buffer.alloc(count)
    let read = 0
    while (read < count) {
      this.check()
      const result = await this.file.read(bytes, read, count - read, offset + read)
      if (!result.bytesRead) throw new ArchiveError('corrupt', 'Truncated archive')
      read += result.bytesRead
    }
    return bytes
  }
}

async function archiveFile(path: string, limits: ArchiveLimits): Promise<FileHandle> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new ArchiveError('unsafe', 'Invalid archive file')
  if (before.size < 22) throw new ArchiveError('corrupt', 'Invalid ZIP archive')
  if (before.size > limits.maxArchiveBytes) throw new ArchiveError('limit', 'Archive exceeds the supported size')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const actual = await file.stat()
    if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size) throw new ArchiveError('unsafe', 'Archive changed while opening')
    return file
  } catch (error) { await file.close(); throw error }
}

function safeName(entry: Entry): string {
  const name = entry.filename.replace(/\\/g, '/')
  const parts = name.replace(/\/$/, '').split('/')
  const mode = entry.externalFileAttributes >>> 16
  const type = mode & 0xf000
  if (!name || name.startsWith('/') || /[\x00-\x1f\x7f<>:"|?*]/.test(name) || parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || (type !== 0 && type !== 0x8000 && type !== 0x4000) || (type === 0x4000 && !entry.directory)) {
    throw new ArchiveError('unsafe', 'Unsafe archive entry')
  }
  return name
}

async function inspect(reader: ZipReader<FileHandle>, limits: ArchiveLimits, check: () => void) {
  const files = new Map<string, FileEntry>()
  const entries: ArchiveEntry[] = []
  const paths = new Map<string, boolean>()
  let count = 0
  let declaredBytes = 0
  let skippedEntries = 0
  for await (const entry of reader.getEntriesGenerator()) {
    check()
    if (++count > limits.maxEntries) throw new ArchiveError('limit', 'Archive contains too many entries')
    const name = safeName(entry)
    const key = name.replace(/\/$/, '').normalize('NFC').toLowerCase()
    if (paths.has(key)) throw new ArchiveError('unsafe', 'Archive contains conflicting paths')
    paths.set(key, entry.directory)
    if (entry.directory) continue
    const size = entry.uncompressedSize
    const compressed = entry.compressedSize
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(compressed) || size < 0 || compressed < 0 || size > limits.maxEntryBytes || size / Math.max(1, compressed) > limits.maxCompressionRatio) throw new ArchiveError('limit', 'Archive expansion limit exceeded')
    declaredBytes += size
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > limits.maxExpandedBytes) throw new ArchiveError('limit', 'Archive expansion limit exceeded')
    const extension = extname(name).toLowerCase()
    const kind = extension === '.funscript' ? 'script' : VIDEO.has(extension) ? 'video' : null
    if (!kind) { skippedEntries++; continue }
    if (!size) throw new ArchiveError('corrupt', 'Archive contains an empty player file')
    if (kind === 'script' && size > limits.maxScriptBytes) throw new ArchiveError('limit', 'Archived script exceeds the supported size')
    if (![0, 8].includes(entry.compressionMethod)) throw new ArchiveError('unsupported', 'Unsupported ZIP compression')
    const id = `entry-${count - 1}`
    const descriptor: ArchiveEntry = { id, name, fileName: basename(name), kind, compressedBytes: compressed, bytes: size, encrypted: entry.encrypted, encryption: entry.encrypted ? entry.zipCrypto ? 'zipcrypto' : 'aes' : 'none' }
    entries.push(descriptor)
    files.set(id, entry)
  }
  for (const key of paths.keys()) {
    const parts = key.split('/')
    while (parts.length > 1) {
      parts.pop()
      if (paths.get(parts.join('/')) === false) throw new ArchiveError('unsafe', 'Archive contains conflicting paths')
    }
  }
  if (!entries.length) throw new ArchiveError('unsupported', 'Archive contains no player files')
  const requiresSelection = entries.filter(entry => entry.kind === 'video').length > 1
  const inspection: ArchiveInspection = { entries, encrypted: entries.some(entry => entry.encrypted), requiresSelection, defaultEntryIds: requiresSelection ? [] : entries.map(entry => entry.id), skippedEntries }
  return { inspection, files }
}

function translated(error: unknown, signal: AbortSignal): ArchiveError {
  if (signal.aborted && signal.reason instanceof ArchiveError) return signal.reason
  if (error instanceof ArchiveError) return error
  if (error instanceof Error) {
    if (error.message === ERR_INVALID_PASSWORD) return new ArchiveError('wrong-password', 'Incorrect archive password')
    if (error.message === ERR_UNSAFE_FILENAME) return new ArchiveError('unsafe', 'Unsafe archive entry')
    if (error.message === ERR_ENCRYPTED) return new ArchiveError('password-required', 'Archive password required')
    if ([ERR_UNSUPPORTED_COMPRESSION, ERR_UNSUPPORTED_ENCRYPTION].includes(error.message)) return new ArchiveError('unsupported', 'Unsupported ZIP format')
    if ('code' in error && typeof error.code === 'string' && /^(EACCES|EPERM|ENOSPC|EROFS|EIO|EMFILE|ENOENT)$/.test(error.code)) return new ArchiveError('io', 'Unable to read or extract archive')
  }
  return new ArchiveError('corrupt', 'Invalid or damaged ZIP archive')
}

export async function inspectArchive(path: string, options: ArchiveOptions = {}): Promise<ArchiveInspection> {
  const limits = limitsFor(options)
  const task = operation(options, limits)
  let file: FileHandle | undefined
  let reader: ZipReader<FileHandle> | undefined
  try {
    task.check()
    file = await archiveFile(path, limits)
    reader = new ZipReader(new FileReader(file, (await file.stat()).size, task.check), { useWebWorkers: false, strictness: 'strict', checkCrc32: true, checkAuthenticationCode: true, checkOverlappingEntry: true })
    return (await inspect(reader, limits, task.check)).inspection
  } catch (error) { throw translated(error, task.signal) }
  finally { task.close(); await reader?.close(); await file?.close() }
}

export async function extractArchive(path: string, options: ExtractArchiveOptions = {}): Promise<ExtractedArchive> {
  const limits = limitsFor(options)
  const task = operation(options, limits)
  let file: FileHandle | undefined
  let reader: ZipReader<FileHandle> | undefined
  let directory: string | undefined
  try {
    task.check()
    file = await archiveFile(path, limits)
    reader = new ZipReader(new FileReader(file, (await file.stat()).size, task.check), { useWebWorkers: false, strictness: 'strict', checkCrc32: true, checkAuthenticationCode: true, checkOverlappingEntry: true })
    const { inspection, files } = await inspect(reader, limits, task.check)
    if (inspection.requiresSelection && !options.entryIds) throw new ArchiveError('selection-required', 'Choose files from this archive')
    const selected = options.entryIds ?? inspection.defaultEntryIds
    if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !files.has(id))) throw new ArchiveError('selection-required', 'Invalid archive file selection')
    const passwords = [...new Set(options.passwords ?? [])].filter(password => password.length > 0)
    if (passwords.length > MAX_PASSWORDS || passwords.some(password => password.length > 1024)) throw new ArchiveError('limit', 'Too many archive passwords')
    if (selected.some(id => files.get(id)?.encrypted) && !passwords.length) throw new ArchiveError('password-required', 'Archive password required')
    directory = await mkdtemp(join(dirname(path), '.archive-'))
    const extracted: ExtractedArchiveEntry[] = []
    const totalBytes = inspection.entries.filter(entry => selected.includes(entry.id)).reduce((total, entry) => total + entry.bytes, 0)
    let expanded = 0
    for (const id of selected) {
      task.check()
      const entry = files.get(id)
      const descriptor = inspection.entries.find(value => value.id === id)
      if (!entry || !descriptor) throw new ArchiveError('selection-required', 'Invalid archive file selection')
      const target = join(directory, `${id}${extname(descriptor.fileName).toLowerCase()}`)
      const candidates = entry.encrypted ? passwords : [undefined]
      let lastError: unknown
      let integrityError: unknown
      let extractedBytes = 0
      let success = false
      for (const password of candidates) {
        task.check()
        const destination = await open(target, 'wx', 0o600)
        let bytes = 0
        try {
          const writable = new WritableStream<Uint8Array>({ async write(chunk) {
            task.check()
            bytes += chunk.byteLength
            if (bytes > descriptor.bytes || bytes > limits.maxEntryBytes || expanded + bytes > limits.maxExpandedBytes) throw new ArchiveError('limit', 'Archive expansion limit exceeded')
            let written = 0
            while (written < chunk.byteLength) {
              task.check()
              const result = await destination.write(chunk, written, chunk.byteLength - written)
              if (!result.bytesWritten) throw new ArchiveError('io', 'Unable to extract archive')
              written += result.bytesWritten
            }
            options.onProgress?.(descriptor, expanded + bytes, totalBytes)
            task.check()
          } })
          await entry.getData(writable, { password, signal: task.signal, useWebWorkers: false, checkCrc32: true, checkAuthenticationCode: true, checkOverlappingEntry: true, strictness: 'strict' })
          if (bytes !== descriptor.bytes) throw new ArchiveError('corrupt', 'Invalid archive entry length')
          await destination.sync()
          extractedBytes = bytes
          success = true
        } catch (error) {
          lastError = error
        } finally { await destination.close() }
        if (success) break
        await unlink(target)
        const message = lastError instanceof Error ? lastError.message : ''
        const corrupt = translated(lastError, task.signal).code === 'corrupt'
        if (message !== ERR_INVALID_PASSWORD && !(entry.zipCrypto && corrupt) && message !== ERR_INVALID_AUTHENTICATION_CODE) throw lastError
        if (corrupt) integrityError = lastError
      }
      if (!success) throw integrityError ?? lastError
      expanded += extractedBytes
      extracted.push({ ...descriptor, path: target })
    }
    task.check()
    return { directory, files: extracted }
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true })
    throw translated(error, task.signal)
  } finally { task.close(); await reader?.close(); await file?.close() }
}
