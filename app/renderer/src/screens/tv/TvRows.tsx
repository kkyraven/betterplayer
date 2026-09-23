import { Folder, LayoutGrid, ListVideo, Tag } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { MessageKey } from '@shared/i18n'
import type { MediaQuery, MediaRow } from '@shared/library'
import { isPlaylist } from '@shared/library'
import { MediaCard } from '@/components/media/MediaCard'
import { invoke, on } from '@/ipc'
import { useT } from '@/state/i18n'
import { usePlayer } from '@/state/player'
import { useSettings } from '@/state/settings'
import { useUi } from '@/state/ui'
import { tileOptionsKey } from './tvCards'

interface RowSpec {
  label: MessageKey
  query: MediaQuery
  resume?: boolean
}

const BASE: MediaQuery = { section: 'all', sort: 'added', desc: true, filters: {}, limit: 12, offset: 0 }

const ROWS: Record<'library' | 'continue', RowSpec[]> = {
  library: [
    { label: 'tv.rows.recommended', query: { ...BASE, sort: 'recommended' } },
    { label: 'tv.rows.continueWatching', query: { ...BASE, section: 'continue', sort: 'lastPlayed' }, resume: true },
    { label: 'tv.rows.recentlyAdded', query: BASE },
    { label: 'tv.rows.favourites', query: { ...BASE, section: 'favourites' } },
    { label: 'tv.rows.fastest', query: { ...BASE, sort: 'speed', filters: { script: 'stroke' } } },
  ],
  continue: [
    { label: 'tv.rows.continueWatching', query: { ...BASE, section: 'continue', sort: 'lastPlayed', limit: 24 }, resume: true },
    { label: 'tv.rows.playedRecently', query: { ...BASE, sort: 'lastPlayed', filters: { watched: 'yes' }, limit: 24 } },
  ],
}

const BROWSE_AFTER = 1

const noop = () => undefined

export function TvRows({ kind }: { kind: 'library' | 'continue' }) {
  const t = useT()
  const [rows, setRows] = useState<Array<{ spec: RowSpec; items: MediaRow[] }> | null>(null)
  const shownIds = useRef(new Set<number>())
  const open = usePlayer((s) => s.open)
  const setTvTab = useUi((s) => s.setTvTab)
  const continueRow = useSettings((s) => s.settings?.library.continueRow) ?? false
  useEffect(() => {
    let alive = true
    const load = async () => {
      const specs = kind === 'library' && !continueRow ? ROWS.library.filter((spec) => !spec.resume) : ROWS[kind]
      const pages = await Promise.all(specs.map((spec) => invoke('library:query', continueRow && spec.query.sort === 'recommended' ? { ...spec.query, continueRow: true } : spec.query)))
      if (!alive) return
      const next = specs.map((spec, i) => ({ spec, items: (pages[i]?.rows ?? []).filter((e): e is MediaRow => !isPlaylist(e)) })).filter((r) => r.items.length > 0)
      shownIds.current = new Set(next.flatMap((r) => r.items.map((row) => row.id)))
      setRows(next)
    }
    void load()
    const off = on('library:changed', (change) => {
      if (change.kind === 'scan' || change.kind === 'meta' || change.ids.some((id) => shownIds.current.has(id))) void load()
    })
    return () => {
      alive = false
      off()
    }
  }, [kind, continueRow])
  const play = (row: MediaRow) => {
    void open(row.path)
    setTvTab('nowplaying')
  }
  if (!rows) return <div className="tv-body" data-nav-main />
  const all = rows.flatMap((r) => r.items)
  const section = ({ spec, items }: { spec: RowSpec; items: MediaRow[] }) => (
    <section key={spec.label} className="tv-sec">
      <span className="eyebrow">{t(spec.label)}</span>
      <div className="tv-row">
        {items.map((row) => (
          <MediaCard key={row.id} row={row} density="tenfoot" resume={spec.resume} onSelect={noop} onPlay={play} />
        ))}
      </div>
    </section>
  )
  const children = kind === 'library' ? [...rows.slice(0, BROWSE_AFTER).map(section), <BrowseRow key="browse" />, ...rows.slice(BROWSE_AFTER).map(section)] : rows.map(section)
  return (
    <div className="tv-body" data-nav-main onKeyDown={(e) => tileOptionsKey(e, all)}>
      {rows.length === 0 && kind === 'continue' && <p className="tv-empty">{t('tv.rows.empty')}</p>}
      {children}
    </div>
  )
}

interface Counts {
  all: number
  folders: number
  tags: number
  playlists: number
}

function BrowseRow() {
  const t = useT()
  const [counts, setCounts] = useState<Counts | null>(null)
  const pushTvView = useUi((s) => s.pushTvView)
  useEffect(() => {
    let alive = true
    const load = async () => {
      const [c, folders, tags, playlists] = await Promise.all([invoke('library:counts'), invoke('library:folders'), invoke('library:tags'), invoke('library:playlists')])
      const countFolders = (nodes: typeof folders): number => nodes.reduce((n, f) => n + (f.excluded ? 0 : 1 + countFolders(f.children)), 0)
      if (alive) setCounts({ all: c.all, folders: countFolders(folders), tags: tags.length, playlists: playlists.length })
    }
    void load()
    const off = on('library:changed', (change) => (change.kind === 'scan' || change.kind === 'meta') && void load())
    return () => {
      alive = false
      off()
    }
  }, [])
  const n = (v: number | undefined, key: MessageKey) => (v === undefined ? '' : t(key, { count: v, n: v.toLocaleString() }))
  return (
    <section className="tv-sec">
      <span className="eyebrow">{t('tv.rows.browse')}</span>
      <div className="tv-tiles">
        <button type="button" className="tv-tile" data-focus-key="browse:all" onClick={() => pushTvView({ kind: 'grid', source: { title: t('tv.rows.allVideos') } })}>
          <LayoutGrid />
          <div>
            <span className="name">{t('tv.rows.allVideos')}</span>
            <small>{n(counts?.all, 'tv.browse.videos')}</small>
          </div>
        </button>
        <button type="button" className="tv-tile" data-focus-key="browse:folders" onClick={() => pushTvView({ kind: 'browse', what: 'folders' })}>
          <Folder />
          <div>
            <span className="name">{t('tv.browse.folders')}</span>
            <small>{n(counts?.folders, 'tv.rows.folderCount')}</small>
          </div>
        </button>
        <button type="button" className="tv-tile" data-focus-key="browse:tags" onClick={() => pushTvView({ kind: 'browse', what: 'tags' })}>
          <Tag />
          <div>
            <span className="name">{t('tv.browse.tags')}</span>
            <small>{n(counts?.tags, 'tv.rows.tagCount')}</small>
          </div>
        </button>
        <button type="button" className="tv-tile" data-focus-key="browse:playlists" onClick={() => pushTvView({ kind: 'browse', what: 'playlists' })}>
          <ListVideo />
          <div>
            <span className="name">{t('tv.browse.playlists')}</span>
            <small>{n(counts?.playlists, 'tv.rows.playlistCount')}</small>
          </div>
        </button>
      </div>
    </section>
  )
}
