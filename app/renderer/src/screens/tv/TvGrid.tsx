import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react'
import type { MessageKey } from '@shared/i18n'
import { isPlaylist, type MediaQuery, type MediaRow, type Sort } from '@shared/library'
import { MediaCard } from '@/components/media/MediaCard'
import { TvRow } from '@/components/tv/TvRow'
import { invoke, on } from '@/ipc'
import { useT } from '@/state/i18n'
import { usePlayer } from '@/state/player'
import { useUi } from '@/state/ui'
import type { TvGridSource } from '@/state/tvNav'
import { tileOptionsKey } from './tvCards'

const PAGE = 48
const COLUMNS = 4
const AHEAD = COLUMNS * 2

const SORT_OPTIONS: ReadonlyArray<{ value: Sort; label: MessageKey }> = [
  { value: 'recommended', label: 'tv.grid.sort.recommended' },
  { value: 'added', label: 'tv.grid.sort.added' },
  { value: 'name', label: 'tv.grid.sort.name' },
  { value: 'duration', label: 'tv.grid.sort.duration' },
  { value: 'speed', label: 'tv.grid.sort.speed' },
  { value: 'rating', label: 'tv.grid.sort.rating' },
  { value: 'lastPlayed', label: 'tv.grid.sort.lastPlayed' },
]

const noop = () => undefined

export function TvGrid({ source }: { source: TvGridSource }) {
  const t = useT()
  const [sort, setSort] = useState<Sort>('recommended')
  const [rows, setRows] = useState<MediaRow[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const loading = useRef(false)
  const done = useRef(false)
  const count = useRef(0)
  const open = usePlayer((s) => s.open)
  const setTvTab = useUi((s) => s.setTvTab)

  const query = useCallback(
    (offset: number): MediaQuery => ({
      section: 'all',
      folder: source.folder,
      playlistId: source.playlistId,
      sort,
      desc: sort !== 'name',
      filters: source.tag ? { tag: source.tag } : {},
      limit: PAGE,
      offset,
    }),
    [source, sort],
  )

  const loadMore = useCallback(async () => {
    if (loading.current || done.current) return
    loading.current = true
    const offset = rows.length
    const page = await invoke('library:query', query(offset))
    loading.current = false
    const more = page.rows.filter((e): e is MediaRow => !isPlaylist(e))
    if (page.rows.length < PAGE) done.current = true
    if (offset === 0 && page.total !== null) setTotal(page.total)
    count.current = offset + more.length
    setRows((r) => (offset === 0 ? more : [...r, ...more]))
  }, [query, rows.length])

  useEffect(() => {
    let alive = true
    const reload = async () => {
      loading.current = true
      const want = Math.max(PAGE, count.current)
      const page = await invoke('library:query', { ...query(0), limit: want })
      loading.current = false
      if (!alive) return
      done.current = page.rows.length < want
      if (page.total !== null) setTotal(page.total)
      const shown = page.rows.filter((e): e is MediaRow => !isPlaylist(e))
      count.current = shown.length
      setRows(shown)
    }
    count.current = 0
    void reload()
    const off = on('library:changed', () => void reload())
    return () => {
      alive = false
      off()
    }
  }, [query])

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const id = Number(e.target.getAttribute('data-media-id'))
    const i = rows.findIndex((r) => r.id === id)
    if (i >= 0 && i >= rows.length - AHEAD) void loadMore()
  }
  const play = (row: MediaRow) => {
    void open(row.path)
    setTvTab('nowplaying')
  }
  return (
    <div className="tv-body tv-gridview" data-nav-main onKeyDown={(e) => tileOptionsKey(e, rows)}>
      <div className="tv-gridhd">
        <h2>{source.title}</h2>
        {total !== null && <span className="n">{total.toLocaleString()}</span>}
        <TvRow kind="options" className="sort" label={t('tv.grid.sort')} options={SORT_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))} value={sort} onChange={setSort} />
      </div>
      {rows.length === 0 && done.current && <p className="tv-empty">{t('tv.grid.empty')}</p>}
      <div className="tv-grid" onFocus={onFocus}>
        {rows.map((row) => (
          <MediaCard key={row.id} row={row} density="tenfoot" onSelect={noop} onPlay={play} />
        ))}
      </div>
    </div>
  )
}
