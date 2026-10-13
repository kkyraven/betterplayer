import { lstat, open, readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { DownloadKind } from '@shared/downloads'

const MAX_SCRIPT_BYTES = 32 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_ACTIONS = 1_000_000
const MAX_ZIP_ENTRIES = 256

export class VerificationError extends Error {
  constructor(message: string, readonly unsupported = false) { super(message) }
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function actions(value: unknown): number {
  if (!Array.isArray(value) || value.length > MAX_ACTIONS) throw new VerificationError('Invalid script actions')
  for (const action of value) {
    if (!object(action) || typeof action.at !== 'number' || !Number.isFinite(action.at) || typeof action.pos !== 'number' || !Number.isFinite(action.pos)) throw new VerificationError('Invalid script actions')
  }
  return value.length
}

export function verifyFunscript(bytes: Buffer): number {
  if (!bytes.length || bytes.length > MAX_SCRIPT_BYTES) throw new VerificationError('Script exceeds the supported size')
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as unknown } catch { throw new VerificationError('Invalid funscript file') }
  if (!object(value)) throw new VerificationError('Invalid funscript file')
  if (value.inverted !== undefined && typeof value.inverted !== 'boolean') throw new VerificationError('Invalid script inversion')
  if (value.metadata !== undefined && value.metadata !== null) {
    if (!object(value.metadata)) throw new VerificationError('Invalid script metadata')
    for (const [field, strings] of [['chapters', ['name', 'startTime', 'endTime']], ['bookmarks', ['name', 'time']]] as const) {
      const entries = value.metadata[field]
      if (entries === undefined) continue
      if (!Array.isArray(entries) || entries.length > 100_000 || entries.some(entry => !object(entry) || strings.some(key => entry[key] !== undefined && typeof entry[key] !== 'string'))) throw new VerificationError('Invalid script metadata')
    }
  }
  let count = 0
  let hasActions = false
  if (value.actions !== undefined) { count += actions(value.actions); hasActions = true }
  if (value.channels !== undefined && value.channels !== null) {
    if (!object(value.channels) || Object.keys(value.channels).length > 64) throw new VerificationError('Invalid script channels')
    for (const channel of Object.values(value.channels)) {
      if (!object(channel)) throw new VerificationError('Invalid script channel')
      if (channel.inverted !== undefined && typeof channel.inverted !== 'boolean') throw new VerificationError('Invalid script inversion')
      if (channel.actions !== undefined) { count += actions(channel.actions); hasActions = true }
    }
  }
  if (value.axes !== undefined && value.axes !== null) {
    if (!Array.isArray(value.axes) || value.axes.length > 64) throw new VerificationError('Invalid script axes')
    for (const axis of value.axes) {
      if (!object(axis) || typeof axis.id !== 'string') throw new VerificationError('Invalid script axis')
      if (axis.inverted !== undefined && typeof axis.inverted !== 'boolean') throw new VerificationError('Invalid script inversion')
      if (axis.actions !== undefined) { count += actions(axis.actions); hasActions = true }
    }
  }
  if (!hasActions || count > MAX_ACTIONS) throw new VerificationError('Invalid script actions')
  return count
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function verifiedScriptEntries(bytes: Buffer): ReadonlyArray<{ name: string; bytes: Buffer }> {
  if (bytes.length > MAX_ARCHIVE_BYTES || bytes.length < 22) throw new VerificationError('Archive exceeds the supported size')
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break }
  }
  if (end < 0) throw new VerificationError('Invalid script archive')
  const entries = bytes.readUInt16LE(end + 10)
  const centralSize = bytes.readUInt32LE(end + 12)
  const centralStart = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || entries !== bytes.readUInt16LE(end + 8) || entries > MAX_ZIP_ENTRIES || centralStart + centralSize > end) throw new VerificationError('Unsupported script archive')
  let cursor = centralStart
  let expanded = 0
  let scripts = 0
  let actionCount = 0
  const scriptEntries: { name: string; bytes: Buffer }[] = []
  const names = new Set<string>()
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new VerificationError('Invalid script archive')
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const expectedCrc = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20)
    const size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16
    const local = bytes.readUInt32LE(cursor + 42)
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength
    if (cursor > centralStart + centralSize || !name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(part => part === '..') || (mode & 0xf000) === 0xa000 || names.has(name.toLowerCase())) throw new VerificationError('Unsafe archive path')
    names.add(name.toLowerCase())
    if (name.endsWith('/')) continue
    if (!/\.funscript$/i.test(name)) {
      if (/\.(txt|md|nfo|png|jpe?g)$/i.test(name)) continue
      throw new VerificationError('Choose files from this archive', true)
    }
    if (flags & 1 || ![0, 8].includes(method) || local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50) throw new VerificationError('Unsupported script archive')
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    expanded += size
    if (expanded > MAX_ARCHIVE_BYTES || size > MAX_SCRIPT_BYTES || start + compressed > centralStart || (compressed === 0 && size > 0) || size / Math.max(1, compressed) > 1000) throw new VerificationError('Archive expansion limit exceeded')
    const payload = bytes.subarray(start, start + compressed)
    let unpacked: Buffer
    try { unpacked = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: Math.min(size + 1, MAX_SCRIPT_BYTES) }) } catch { throw new VerificationError('Invalid script archive') }
    if (unpacked.length !== size || crc32(unpacked) !== expectedCrc) throw new VerificationError('Invalid archive checksum')
    actionCount += verifyFunscript(unpacked)
    if (actionCount > MAX_ACTIONS) throw new VerificationError('Archive action limit exceeded')
    scriptEntries.push({ name, bytes: unpacked })
    scripts++
  }
  if (!scripts || cursor !== centralStart + centralSize) throw new VerificationError('Archive contains no scripts')
  return scriptEntries
}

export function verifyScriptZip(bytes: Buffer): void { verifiedScriptEntries(bytes) }

export async function verifyDownloaded(path: string, name: string, expected: DownloadKind, mimeType?: string): Promise<DownloadKind> {
  const details = await lstat(path)
  if (details.isSymbolicLink() || !details.isFile() || details.size === 0) throw new VerificationError('Invalid downloaded file')
  const handle = await open(path, 'r')
  const head = Buffer.alloc(Math.min(512, details.size))
  try { await handle.read(head, 0, head.length, 0) } finally { await handle.close() }
  if (/text\/html/i.test(mimeType ?? '') || /^\s*(<!doctype\s+html|<html|<head|<body)/i.test(head.toString('utf8'))) throw new VerificationError('The host returned a webpage')
  const ext = extname(name).toLowerCase()
  if (ext === '.funscript') {
    if (expected === 'video' || details.size > MAX_SCRIPT_BYTES) throw new VerificationError('The source returned a different file')
    verifyFunscript(await readFile(path))
    return 'script'
  }
  if (ext === '.zip') {
    if (expected === 'video' || details.size > MAX_ARCHIVE_BYTES) throw new VerificationError('Choose files from this archive', true)
    verifyScriptZip(await readFile(path))
    return 'archive'
  }
  const mp4 = ['.mp4', '.m4v', '.mov'].includes(ext) && head.subarray(4, 8).toString('ascii') === 'ftyp'
  const ebml = ['.webm', '.mkv'].includes(ext) && head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3
  const avi = ext === '.avi' && head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'AVI '
  if ((mp4 || ebml || avi) && expected !== 'script') return 'video'
  throw new VerificationError('Unsupported or invalid file', true)
}
