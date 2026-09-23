import { Check, Film, FolderPlus, Plus, Server, X } from 'lucide-react'
import { memo, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { MessageKey } from '@shared/i18n'
import { isPlaylist, titleStartsWith, type MediaRow, type Section } from '@shared/library'
import { FavButton } from '@/components/media/FavButton'
import { MediaCard, type Density } from '@/components/media/MediaCard'
import { MediaRow as MediaRowView } from '@/components/media/MediaRow'
import { PlaylistCard, PlaylistRow } from '@/components/media/PlaylistCard'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { invoke } from '@/ipc'
import { cx } from '@/lib/cx'
import { useDevices } from '@/state/devices'
import { useT } from '@/state/i18n'
import { countVideos, useLibrary } from '@/state/library'
import { usePlayer } from '@/state/player'
import { useSettings } from '@/state/settings'
import { useSelect } from '@/state/select'
import { useUi } from '@/state/ui'
import { DetailSheet } from './DetailSheet'
import { MediaMenu, MediaMenuButton, openMediaContextMenu } from './MediaMenu'
import { consumeSuppressedClick, pressDown } from './pressDrag'
import { SelectBar } from './SelectBar'
import { PlaylistOrder, PlaylistInsertion } from './PlaylistOrder'
import { ServerDialog } from './ServerDialog'
import { Sidebar } from './Sidebar'
import { Toolbar } from './Toolbar'
import { SearchSummary } from './SearchSummary'
import { useVirtualGrid } from './virtualGrid'
import './LibraryScreen.css'
import './library.css'
const SECTION_TITLES: Record<Section, MessageKey> = {
  all: 'library.section.all',
  continue: 'library.section.continueWatching',
  favourites: 'library.section.favourites',
  unscripted: 'library.section.unscripted',
  newest: 'library.section.newest',
  mostWatched: 'library.section.mostWatched',
  multiAxis: 'library.section.multiAxis',
  singleAxis: 'library.section.singleAxis',
  sr6: 'library.section.sr6',
  osr2: 'library.section.osr2',
  twist: 'library.section.twist',
  estim: 'library.section.estim',
  focstim: 'library.section.focstim',
  restim: 'library.section.restim',
  vr: 'library.section.vr',
  '2d': 'library.section.2d',
  res1080: 'library.section.res1080',
  res1440: 'library.section.res1440',
  res4k: 'library.section.res4k',
  len0to2: 'library.section.len0to2',
  len2to5: 'library.section.len2to5',
  len5to15: 'library.section.len5to15',
  len15to30: 'library.section.len15to30',
  len30plus: 'library.section.len30plus',
}

export function LibraryScreen() {
  const mount = useLibrary((s) => s.mount)
  useEffect(() => mount('library'), [mount])

  return (
    <div className="lib">
      <Sidebar />
      <section className="lib-content">
        <Grid />
        <SelectBar />
      </section>
      <DetailSheet />
      <MediaMenu />
      <DragGhost />
      <PlaylistInsertion />
    </div>
  )
}

const selectRow = (id: number | null) => {
  if (consumeSuppressedClick()) return
  const select = useSelect.getState()
  if (select.on && id !== null) select.toggle(id)
  else void useLibrary.getState().select(id)
}
const playRow = (row: MediaRow) => void usePlayer.getState().openLibraryMedia(row)

const openPlaylist = (id: number) => void useLibrary.getState().setPlaylist(id)

const GridCard = memo(function GridCard({ row, density, resume = false }: { row: MediaRow; density: Density; resume?: boolean }) {
  const selected = useLibrary((s) => s.selectedId === row.id)
  const checked = useSelect((s) => (s.on ? s.ids.has(row.id) : undefined))
  const playlist = useLibrary(s => s.playlistId !== null)
  return <MediaCard order={playlist && !resume ? <PlaylistOrder row={row} /> : undefined} row={row} density={density} resume={resume} selected={selected} checked={checked} onSelect={selectRow} onPlay={playRow} onPointerDown={pressDown} onContextMenu={openMediaContextMenu} menu={<><FavButton id={row.id} favourite={row.favourite} /><MediaMenuButton row={row} /></>} />
})

const RowCard = memo(function RowCard({ row, condensed }: { row: MediaRow; condensed: boolean }) {
  const selected = useLibrary((s) => s.selectedId === row.id)
  const checked = useSelect((s) => (s.on ? s.ids.has(row.id) : undefined))
  const playlist = useLibrary(s => s.playlistId !== null)
  return <MediaRowView order={playlist ? <PlaylistOrder row={row} /> : undefined} row={row} condensed={condensed} selected={selected} checked={checked} onSelect={selectRow} onPlay={playRow} onPointerDown={pressDown} onContextMenu={openMediaContextMenu} menu={<><FavButton id={row.id} favourite={row.favourite} /><MediaMenuButton row={row} /></>} />
})

function DragGhost() {
  const drag = useSelect((s) => s.drag)
  if (!drag) return null
  return (
    <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>
      {drag.thumbs.map((thumb, i) => (
        <div key={i} className={`g g${i}`} style={thumb ? { backgroundImage: `url(${thumb})` } : undefined} />
      ))}
      {drag.ids.length > 1 && <span className="gn mono">{drag.ids.length}</span>}
    </div>
  )
}


function Grid() {
  const t = useT()
  const rows = useLibrary((s) => s.rows)
  const hasMore = useLibrary((s) => countVideos(s.rows) < s.total)
  const continueRow = useSettings((s) => s.settings?.library.continueRow) ?? false
  const continueRows = useLibrary((s) => s.continueRows)
  const section = useLibrary((s) => s.section)
  const filters = useLibrary((s) => s.filters)
  const folder = useLibrary((s) => s.folder)
  const playlistId = useLibrary((s) => s.playlistId)
  const playlists = useLibrary((s) => s.playlists)
  const folders = useLibrary((s) => s.folders)
  const view = useLibrary((s) => s.view)
  const gridSize = useLibrary((s) => s.gridSize)
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const { range, scrollToIndex } = useVirtualGrid(scrollRef, gridRef, rows.length, `${view}:${gridSize}`)
  useTypeAhead(gridRef, scrollToIndex)
  const title = playlistId !== null ? (playlists.find((p) => p.id === playlistId)?.name ?? t('library.playlist.label')) : folder ? (folder.folder.split('/').pop() || folders.find((f) => f.rootId === folder.rootId)?.name || t('library.folder.fallback')) : section === 'all' && filters.tag ? `#${filters.tag}` : t(SECTION_TITLES[section])
  const isGrid = view === 'grid'
  const density = gridSize < 200 ? 'compact' : 'comfortable'
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') selectRow(null)
  }

  return (
    <div ref={scrollRef} className={cx('lib-scroll', playlistId !== null && 'lib-playlist')} onKeyDown={onKey}>
      <div className="lib-sticky">
        <Toolbar title={title} />
        <SearchSummary />
      </div>
      <Setup />
      {continueRow && continueRows.length > 0 && (
        <>
          <div className="sec-hd">
            <span className="eyebrow">{t('library.section.continueWatching')}</span>
          </div>
          <div className="lib-row">
            {continueRows.slice(0, 4).map((row) => (
              <GridCard key={row.id} row={row} density="comfortable" resume />
            ))}
          </div>
          <div className="sec-hd">
            <span className="eyebrow">{t('library.section.all')}</span>
          </div>
        </>
      )}
      {rows.length === 0 && <EmptyNote />}
      <div ref={gridRef} data-playlist-grid={playlistId !== null ? '' : undefined} className={cx(isGrid ? 'lib-grid' : 'lib-rows', view === 'condensed' && 'condensed')} style={{ '--tile': `${gridSize}px`, paddingTop: range.padTop, paddingBottom: range.padBottom } as CSSProperties} role="listbox" aria-label={title}>
        {rows.slice(range.start, range.end).map((entry) => {
          if (isPlaylist(entry)) return isGrid ? <PlaylistCard key={`p${entry.id}`} entry={entry} density={density} onOpen={openPlaylist} /> : <PlaylistRow key={`p${entry.id}`} entry={entry} condensed={view === 'condensed'} onOpen={openPlaylist} />
          return isGrid ? <GridCard key={entry.id} row={entry} density={density} /> : <RowCard key={entry.id} row={entry} condensed={view === 'condensed'} />
        })}
      </div>
      {hasMore && <LoadMore />}
    </div>
  )
}

function LoadMore() {
  const loadMore = useLibrary((s) => s.loadMore)
  const count = useLibrary((s) => s.rows.length)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore()
      },
      { root: el.closest('.lib-scroll'), rootMargin: '600px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore, count])
  return <div ref={ref} className="lib-more" aria-hidden />
}

function EmptyNote() {
  const t = useT()
  const loaded = useLibrary((s) => s.loaded)
  const loading = useLibrary((s) => s.loading)
  const scanning = useLibrary((s) => s.progress.scanning)
  const hasRoots = useLibrary((s) => s.roots.length > 0)
  const searching = useLibrary((s) => s.search !== '' || Object.values(s.filters).some((v) => v !== undefined))
  const search = useLibrary((s) => s.search)
  const setSearch = useLibrary((s) => s.setSearch)
  const setFilters = useLibrary((s) => s.setFilters)
  const filtered = useLibrary((s) => Object.values(s.filters).some((v) => v !== undefined))
  const addRoot = useLibrary((s) => s.addRoot)
  const [addingServer, setAddingServer] = useState(false)
  if (!loaded || loading) return <p className="faint lib-empty">{t('library.empty.loading')}</p>
  if (scanning) return <p className="faint lib-empty">{t('library.sidebar.scanning')}</p>
  if (!hasRoots && !searching)
    return (
      <div className="lib-empty">
        <Button onClick={() => void addRoot()}>
          <FolderPlus />
          {t('library.sidebar.addFolder')}
        </Button>
        <Button onClick={() => setAddingServer(true)}>
          <Server />
          {t('library.server.add')}
        </Button>
        <ServerDialog open={addingServer} onOpenChange={setAddingServer} />
      </div>
    )
  return (
    <div className="lib-empty lib-search-empty">
      <p className="faint">{t('library.empty.nothing')}</p>
      {search && <Button variant="ghost" onClick={() => setSearch('')}>{t('library.empty.clearSearch')}</Button>}
      {filtered && <Button variant="ghost" onClick={() => setFilters({})}>{t('library.toolbar.clearFilters')}</Button>}
    </div>
  )
}

function Setup() {
  const t = useT()
  const loaded = useLibrary((s) => s.loaded)
  const inPlaylist = useLibrary((s) => s.playlistId !== null)
  const hasRoots = useLibrary((s) => s.roots.length > 0)
  const hasDevice = useDevices((s) => s.outputs.length > 0)
  const dismissed = useSettings((s) => s.settings?.general.setupDismissed ?? true)
  const update = useSettings((s) => s.update)
  const open = usePlayer((s) => s.open)
  const setDeviceWizard = useUi((s) => s.setDeviceWizard)
  const addRoot = useLibrary((s) => s.addRoot)
  if (!loaded || inPlaylist || dismissed || (hasRoots && hasDevice)) return null
  const dismiss = () =>
    void update((s) => ({
      ...s,
      general: { ...s.general, setupDismissed: true },
    }))
  const openDialog = async () => {
    const path = await invoke('dialog:openVideo')
    if (path) await open(path)
  }

  return (
    <div className="setup">
      <div className="setup-hd">
        <span className="eyebrow">{t('library.setup.title')}</span>
        <IconButton label={t('library.setup.close')} size="sm" className="setup-close" onClick={dismiss}>
          <X />
        </IconButton>
      </div>
      <div className="setup-steps">
        <SetupStep n={1} title={t('library.setup.addFolders')} sub={t('library.setup.addFoldersSub')} dim={hasRoots} next={!hasRoots}>
          <Button variant={hasRoots ? 'default' : 'primary'} onClick={() => void addRoot()}>
            <FolderPlus />
            {t('library.setup.addFolders')}
          </Button>
        </SetupStep>
        <SetupStep n={2} title={t('library.setup.addDevice')} sub={t('library.setup.addDeviceSub')} dim={hasDevice} next={hasRoots && !hasDevice}>
          <Button variant={hasRoots && !hasDevice ? 'primary' : 'default'} onClick={() => setDeviceWizard(true)}>
            <Plus />
            {t('library.setup.addDeviceButton')}
          </Button>
        </SetupStep>
        <SetupStep n={3} title={t('library.setup.openVideo')} sub={t('library.setup.openVideoSub')}>
          <Button onClick={() => void openDialog()}>
            <Film />
            {t('common.open')}
          </Button>
        </SetupStep>
      </div>
    </div>
  )
}

function SetupStep({ n, title, sub, dim = false, next = false, children }: { n: number; title: string; sub: string; dim?: boolean; next?: boolean; children: ReactNode }) {
  return (
    <div className={cx('step', dim && 'dim', next && 'next')}>
      <span className="num mono">{dim ? <Check /> : n}</span>
      <div className="txt">
        <b>{title}</b>
        <span className="sub">{sub}</span>
      </div>
      {children}
    </div>
  )
}

function useTypeAhead(grid: RefObject<HTMLDivElement | null>, scrollToIndex: (index: number) => void) {
  useEffect(() => {
    let buffer = ''
    let lastKey = ''
    let last = -1
    let timer = 0
    let run = 0

    const show = (index: number, mediaId: number, id: number) => {
      scrollToIndex(index)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (id !== run) return
          const el = grid.current?.querySelector(`[data-media-id="${mediaId}"]`)
          if (el instanceof HTMLElement) {
            el.scrollIntoView({ block: 'center' })
            el.focus({ preventScroll: true })
          }
        }),
      )
    }

    const jump = async (prefix: string, from: number) => {
      const id = ++run
      const lib = useLibrary.getState()
      let i = lib.rows.findIndex((r, n) => n >= from && !isPlaylist(r) && titleStartsWith(r.title, prefix))
      if (i === -1 && from > 0) i = lib.rows.findIndex((r) => !isPlaylist(r) && titleStartsWith(r.title, prefix))
      if (i !== -1) {
        last = i
        const row = lib.rows[i]!
        if (!isPlaylist(row)) show(i, row.id, id)
        return
      }
      const hit = await lib.jumpTo(prefix)
      if (id !== run || !hit) return
      last = hit.index
      show(hit.index, hit.id, id)
    }

    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.length !== 1) return
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
      if (t instanceof HTMLElement && (t.isContentEditable || t.closest('[data-radix-popper-content-wrapper], [role="dialog"]'))) return
      const key = e.key.toLowerCase()
      if (key === ' ') {
        if (buffer === '') return
        e.preventDefault()
      }
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        buffer = ''
      }, 900)
      if (key === lastKey && (buffer === '' || buffer === key.repeat(buffer.length))) {
        buffer = key
        void jump(key, last + 1)
      } else {
        buffer += key
        last = -1
        void jump(buffer, 0)
      }
      lastKey = key
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(timer)
    }
  }, [grid, scrollToIndex])
}
