import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ForwardedChannel } from '@shared/peer'
import { mediaIdFromUrl, mediaUrl, PATH_CHANNELS } from '@shared/peer'
import { isPlaylist, type LibraryRoot, type MediaDetail, type MediaPage } from '@shared/library'

export const contains = (root: string, path: string): boolean => {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const FILE_CHANNELS: readonly ForwardedChannel[] = ['subtitles:find', 'subtitles:read']

export function permitted(channel: ForwardedChannel, args: unknown[], roots: LibraryRoot[]): boolean {
  if (!FILE_CHANNELS.includes(channel)) return true
  const [path] = args
  if (typeof path !== 'string') return false
  return roots.some((root) => root.kind === 'folder' && contains(root.path, path))
}

const withUrl = <T extends { id: number; path: string }>(row: T, base: string): T => ({ ...row, path: mediaUrl(base, row.id) })

export function outbound(channel: ForwardedChannel, result: unknown, base: string): unknown {
  switch (channel) {
    case 'library:query': {
      const page = result as MediaPage
      return { ...page, rows: page.rows.map((row) => (isPlaylist(row) ? row : withUrl(row, base))) }
    }
    case 'library:media':
    case 'library:byPath':
    case 'library:byTitle': {
      const detail = result as MediaDetail | null
      return detail ? withUrl(detail, base) : null
    }
    default:
      return result
  }
}

export function inbound(channel: ForwardedChannel, args: unknown[], pathOf: (id: number) => string | null): unknown[] {
  if (!PATH_CHANNELS.includes(channel)) return args
  const [first, ...rest] = args
  if (typeof first !== 'string') return args
  const id = mediaIdFromUrl(first)
  const path = id === null ? null : pathOf(id)
  return path ? [path, ...rest] : args
}
