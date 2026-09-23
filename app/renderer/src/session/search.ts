import type { FolderNode, LibraryCounts, MediaRow, Playlist, Tag } from '@shared/library'
import { EXTRA_SECTIONS, type Section } from '@shared/library'
import type { Translate } from '@shared/i18n'
import { SECTION_NAME, type SourceRef } from '@shared/session'

export interface SourceHit {
  ref: SourceRef
  count: number | null
  sub?: string
}

export const SESSION_SECTIONS: readonly Section[] = ['all', 'favourites', ...EXTRA_SECTIONS]

const norm = (s: string) => s.trim().toLowerCase()

export function localHits(query: string, folders: FolderNode[], tags: Tag[], playlists: Playlist[], counts: LibraryCounts, t: Translate): SourceHit[] {
  const q = norm(query)
  const has = (name: string) => q === '' || norm(name).includes(q)
  const hits: SourceHit[] = []
  const walk = (nodes: FolderNode[], path: string[]) => {
    for (const n of nodes) {
      if (n.excluded) continue
      if (has(n.name)) hits.push({ ref: { kind: 'folder', rootId: n.rootId, folder: n.folder, name: n.name }, count: n.count, sub: path.join(' / ') })
      walk(n.children, [...path, n.name])
    }
  }
  walk(folders, [])
  for (const t of tags) if (has(t.name)) hits.push({ ref: { kind: 'tag', name: t.name }, count: t.count })
  for (const s of SESSION_SECTIONS) if (has(t(SECTION_NAME[s]))) hits.push({ ref: { kind: 'section', section: s }, count: counts[s] })
  for (const p of playlists) if (has(p.name)) hits.push({ ref: { kind: 'playlist', id: p.id, name: p.name }, count: p.count })
  return hits
}

export function videoHit(row: MediaRow): SourceHit {
  return { ref: { kind: 'video', id: row.id, title: row.title }, count: null, sub: row.folder }
}
