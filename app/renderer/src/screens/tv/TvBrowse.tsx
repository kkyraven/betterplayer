import { Folder, ListVideo, Tag } from 'lucide-react'
import { useEffect, useState, type ComponentType } from 'react'
import type { MessageKey } from '@shared/i18n'
import type { FolderNode } from '@shared/library'
import { invoke, on } from '@/ipc'
import { t, useT } from '@/state/i18n'
import { useUi } from '@/state/ui'
import type { TvBrowseKind, TvGridSource } from '@/state/tvNav'

interface Tile {
  key: string
  name: string
  sub: string
  source: TvGridSource
}

const ICONS: Record<TvBrowseKind, ComponentType> = { folders: Folder, tags: Tag, playlists: ListVideo }
const TITLES: Record<TvBrowseKind, MessageKey> = { folders: 'tv.browse.folders', tags: 'tv.browse.tags', playlists: 'tv.browse.playlists' }

const videos = (n: number) => t('tv.browse.videos', { count: n, n: n.toLocaleString() })

function flattenFolders(nodes: FolderNode[], out: Tile[] = []): Tile[] {
  for (const n of nodes) {
    if (n.excluded) continue
    const name = n.folder || n.name
    out.push({ key: `${n.rootId}:${n.folder}`, name, sub: videos(n.count), source: { title: n.name, folder: { rootId: n.rootId, folder: n.folder } } })
    flattenFolders(n.children, out)
  }
  return out
}

async function loadTiles(what: TvBrowseKind): Promise<Tile[]> {
  if (what === 'folders') return flattenFolders(await invoke('library:folders'))
  if (what === 'tags') return (await invoke('library:tags')).map((t) => ({ key: t.name, name: t.name, sub: videos(t.count), source: { title: t.name, tag: t.name } }))
  return (await invoke('library:playlists')).map((p) => ({ key: String(p.id), name: p.name, sub: videos(p.count), source: { title: p.name, playlistId: p.id } }))
}

export function TvBrowse({ what }: { what: TvBrowseKind }) {
  const t = useT()
  const [tiles, setTiles] = useState<Tile[] | null>(null)
  const pushTvView = useUi((s) => s.pushTvView)
  useEffect(() => {
    let alive = true
    const load = () => void loadTiles(what).then((t) => alive && setTiles(t))
    load()
    const off = on('library:changed', (c) => (c.kind === 'scan' || c.kind === 'meta') && load())
    return () => {
      alive = false
      off()
    }
  }, [what])
  const Icon = ICONS[what]
  return (
    <div className="tv-body" data-nav-main>
      <div className="tv-gridhd">
        <h2>{t(TITLES[what])}</h2>
        {tiles && <span className="n">{tiles.length.toLocaleString()}</span>}
      </div>
      {tiles?.length === 0 && <p className="tv-empty">{t('tv.rows.empty')}</p>}
      <div className="tv-tiles-grid">
        {tiles?.map((tile, i) => (
          <button key={tile.key} type="button" className="tv-tile" data-focus-key={`tile:${tile.key}`} data-nav-first={i === 0 ? '' : undefined} onClick={() => pushTvView({ kind: 'grid', source: tile.source })}>
            <Icon />
            <div>
              <span className="name">{tile.name}</span>
              <small>{tile.sub}</small>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
