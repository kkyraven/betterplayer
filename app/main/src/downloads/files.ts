import { constants } from 'node:fs'
import { access, lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { parseScriptName } from '@shared/matcher'
import type { DownloadDestination } from '@shared/downloads'

export interface WritableRoot { id: number; path: string; kind: string; name: string }
export interface CheckedDestination { rootPath: string; directory: string }

function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export async function checkDestination(root: WritableRoot | null, destination: DownloadDestination, pinned?: CheckedDestination): Promise<CheckedDestination> {
  if (!root || root.id !== destination.rootId || root.kind !== 'folder') throw new Error('Choose a folder library')
  const subfolder = destination.relativePath
  if (typeof subfolder !== 'string' || subfolder.length > 2000 || isAbsolute(subfolder) || subfolder.includes('\\') || subfolder.split('/').some(part => part === '..' || part === '.' || part.startsWith('.bp-')) || subfolder.includes('\0')) throw new Error('Invalid destination folder')
  const rootPath = await realpath(root.path)
  const requested = join(rootPath, subfolder)
  let cursor = rootPath
  for (const part of subfolder.split('/').filter(Boolean)) {
    cursor = join(cursor, part)
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Destination contains a symbolic link')
  }
  const directory = await realpath(requested)
  if (!contained(rootPath, directory) || !(await stat(directory)).isDirectory()) throw new Error('Destination is outside its library')
  if (pinned && (pinned.rootPath !== rootPath || pinned.directory !== directory)) throw new Error('Destination folder changed')
  await access(directory, constants.W_OK)
  return { rootPath, directory }
}

export function truncateFileStem(value: string, maximumBytes: number): string {
  let bytes = 0
  let result = ''
  for (const character of value) {
    const size = Buffer.byteLength(character)
    if (bytes + size > maximumBytes) break
    bytes += size; result += character
  }
  return result
}

export function fullFileName(value: string): string {
  const cleaned = basename(value.replaceAll('\\', '/')).normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '')
  if (!cleaned || cleaned.length > 4096 || cleaned === '.' || cleaned === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) || cleaned.startsWith('.')) throw new Error('Invalid file name')
  return cleaned
}

export function scriptNameParts(name: string): { stem: string; suffix: string } {
  const extension = extname(name)
  const originalStem = basename(name, extension)
  let stem = originalStem
  if (/\.funscript$/i.test(extension)) {
    for (let count = 0; count < 64; count++) {
      const parsed = parseScriptName(`${stem}${extension}`)
      if (!parsed?.suffix) break
      stem = parsed.stem
    }
  }
  return { stem, suffix: `${originalStem.slice(stem.length)}${extension}` }
}

export function safeFileName(value: string): string {
  const cleaned = fullFileName(value)
  if (Buffer.byteLength(cleaned) <= 220) return cleaned
  const { stem, suffix } = scriptNameParts(cleaned)
  const available = 220 - Buffer.byteLength(suffix)
  if (available <= 0) throw new Error('Invalid file name')
  return fullFileName(`${truncateFileStem(stem, available)}${suffix}`)
}

export async function stagingDirectory(destination: CheckedDestination, batchId: string): Promise<string> {
  if (!/^[a-f0-9-]{36}$/i.test(batchId)) throw new Error('Invalid batch identity')
  const directory = join(destination.directory, `.bp-downloads-${batchId}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Unsafe staging folder')
  return directory
}
