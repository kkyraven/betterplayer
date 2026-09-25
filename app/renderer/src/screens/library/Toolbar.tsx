import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Popover from '@radix-ui/react-popover'
import { ArrowUpDown, Check, ChevronDown, ListVideo, Play, Grid2x2, Grid3x3, LayoutGrid, List, PanelLeft, Rows3, Search, Shuffle, SlidersHorizontal, X } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { MessageKey } from '@shared/i18n'
import type { MediaFilters, Sort } from '@shared/library'
import { SEARCH_MAX_LENGTH } from '@shared/search'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Slider } from '@/components/ui/Slider'
import { cx } from '@/lib/cx'
import { ipcMessage } from '@/lib/errors'
import { invoke } from '@/ipc'
import { useT } from '@/state/i18n'
import { GRID_SIZE, useLibrary, type View } from '@/state/library'
import { useUi } from '@/state/ui'
import { usePlayer } from '@/state/player'

const SORT_LABELS: Record<Sort, MessageKey> = {
  recommended: 'library.sort.recommended',
  added: 'library.sort.added',
  name: 'library.sort.name',
  modified: 'library.sort.modified',
  duration: 'library.sort.duration',
  speed: 'library.sort.speed',
  rating: 'library.sort.rating',
  lastPlayed: 'library.sort.lastPlayed',
  plays: 'library.sort.plays',
}

const VIEWS: ReadonlyArray<{ value: View; label: MessageKey; icon: ComponentType }> = [
  { value: 'grid', label: 'library.view.grid', icon: LayoutGrid },
  { value: 'list', label: 'library.view.list', icon: List },
  { value: 'condensed', label: 'library.view.condensed', icon: Rows3 },
]

export function Toolbar({ title }: { title: string }) {
  const t = useT()
  const total = useLibrary((s) => s.total)
  const playlistId = useLibrary(s => s.playlistId)
  const playlistCount = useLibrary(s => s.playlists.find(p => p.id === s.playlistId)?.count ?? 0)
  const playlistError = useLibrary(s => s.playlistError)
  const movingPlaylist = useLibrary(s => s.movingPlaylist)
  const [starting, setStarting] = useState(false)
  const [playError, setPlayError] = useState<string | null>(null)
  useEffect(() => { setPlayError(null) }, [playlistId])
  const playPlaylist = async (shuffled: boolean) => {
    if (playlistId === null || starting) return
    setStarting(true)
    setPlayError(null)
    try { await usePlayer.getState().openPlaylist(playlistId, shuffled) }
    catch { if (useLibrary.getState().playlistId === playlistId) setPlayError(t('library.playlist.playError')) }
    finally { setStarting(false) }
  }
  const search = useLibrary((s) => s.search)
  const setSearch = useLibrary((s) => s.setSearch)
  const sort = useLibrary((s) => s.sort)
  const desc = useLibrary((s) => s.desc)
  const setSort = useLibrary((s) => s.setSort)
  const filters = useLibrary((s) => s.filters)
  const setFilters = useLibrary((s) => s.setFilters)
  const tags = useLibrary((s) => s.tags)
  const view = useLibrary((s) => s.view)
  const setView = useLibrary((s) => s.setView)
  const gridSize = useLibrary((s) => s.gridSize)
  const setGridSize = useLibrary((s) => s.setGridSize)
  const sidebarOpen = useLibrary((s) => s.sidebarOpen)
  const setSidebarOpen = useLibrary((s) => s.setSidebarOpen)
  const searchRef = useRef<HTMLInputElement>(null)
  const setScreen = useUi((s) => s.setScreen)
  const active = Object.values(filters).filter((v) => v !== undefined).length
  const label = (value: Sort) => search.trim() && value === 'recommended' ? t('library.sort.bestMatch') : t(SORT_LABELS[value])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target
      const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLElement && target.isContentEditable
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !editing) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const patch = (p: Partial<MediaFilters>) => setFilters({ ...filters, ...p })
  const ViewIcon = VIEWS.find((v) => v.value === view)?.icon ?? LayoutGrid

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setSearch('')
      e.currentTarget.blur()
    } else if (e.key === 'Enter' && search.startsWith('#')) {
      const name = search.slice(1).trim().toLowerCase()
      if (tags.some((tag) => tag.name === name)) {
        patch({ tag: name })
        setSearch('')
      }
    } else if (e.key === 'Backspace' && search === '' && filters.tag) patch({ tag: undefined })
  }

  return (
    <>
    {playlistId !== null && <div className="playlist-heading">
      <div><span className="eyebrow">{t('library.playlist.label')}</span><PlaylistTitle key={playlistId} id={playlistId} title={title} count={playlistCount} /></div>
      <div className="playlist-play">
        <Button variant="primary" disabled={starting || !playlistCount || movingPlaylist !== null} onClick={() => void playPlaylist(false)}><Play />{t('library.playlist.play')}</Button>
        <DropdownMenu.Root><DropdownMenu.Trigger asChild><Button variant="primary" className="playlist-play-more" aria-label={t('library.playlist.playbackOptions')} disabled={starting || !playlistCount || movingPlaylist !== null}><ChevronDown /></Button></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className="menu" align="end" sideOffset={6}><DropdownMenu.Item className="item" onSelect={() => void playPlaylist(true)}><Shuffle />{t('library.playlist.playShuffled')}</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>}
    <div className={cx('lib-toolbar', playlistId !== null && 'playlist-toolbar', search.trim() && 'searching')}>
      <IconButton label={sidebarOpen ? t('library.toolbar.hideSidebar') : t('library.toolbar.showSidebar')} className="lib-sidebar-toggle" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}>
        <PanelLeft />
      </IconButton>
      {playlistId !== null ? <span className="playlist-order-label"><ListVideo />{t('library.playlist.order')}</span> : <h1>
        {title}
        {!search.trim() && <span className="count">{total}</span>}
      </h1>}
      <div className="spacer" />
      <label className="search">
        <Search />
        {filters.tag && (
          <button type="button" className="chip on tagf" title={t('common.remove')} onClick={() => patch({ tag: undefined })}>
            #{filters.tag}
            <X />
          </button>
        )}
        <input ref={searchRef} aria-label={t('library.toolbar.search')} maxLength={SEARCH_MAX_LENGTH} placeholder={filters.tag ? '' : t('library.toolbar.search')} value={search} list={search.startsWith('#') ? 'search-tags' : undefined} onChange={(e) => setSearch(e.target.value)} onKeyDown={onSearchKey} />
        <datalist id="search-tags">
          {tags.map((tag) => (
            <option key={tag.name} value={`#${tag.name}`} />
          ))}
        </datalist>
        <span className="kbd">/</span>
      </label>
      {playlistId === null && <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button>
            <ArrowUpDown />
            {label(sort)}
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="end" sideOffset={6}>
            {(Object.keys(SORT_LABELS) as Sort[]).map((s) => (
              <DropdownMenu.Item key={s} className="item" onSelect={() => setSort(s, s === sort ? !desc : undefined)}>
                {label(s)}
                {s === sort && s !== 'recommended' && <span className="right">{desc ? t('library.sort.desc') : t('library.sort.asc')}</span>}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>}
      <Popover.Root>
        <Popover.Trigger asChild>
          <Button className={cx(active > 0 && 'active')}>
            <SlidersHorizontal />
            {t('library.toolbar.filter')}
            {active > 0 && <span className="n">{active}</span>}
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="sheet filter-pop" align="end" sideOffset={6}>
            <FilterGroup label={t('library.filter.script')} value={filters.script} options={[['stroke', t('library.filter.stroke')], ['multi', t('library.filter.multi')], ['estim', t('library.filter.estim')], ['missing', t('library.filter.missing')]]} onChange={(script) => patch({ script })} />
            <FilterGroup label={t('library.filter.type')} value={filters.type} options={[['2d', t('library.section.2d')], ['vr', t('library.section.vr')]]} onChange={(type) => patch({ type })} />
            <FilterGroup label={t('library.filter.watched')} value={filters.watched} options={[['yes', t('library.filter.watched')], ['no', t('library.filter.unwatched')]]} onChange={(watched) => patch({ watched })} />
            <FilterGroup label={t('library.sort.rating')} value={filters.minRating === undefined ? undefined : String(filters.minRating)} options={[['3', '3+'], ['4', '4+'], ['5', '5']]} onChange={(v) => patch({ minRating: v === undefined ? undefined : Number(v) })} />
            {tags.length > 0 && <FilterGroup label={t('library.filter.tag')} value={filters.tag} options={tags.map((tag) => [tag.name, tag.name])} onChange={(tag) => patch({ tag })} />}
            <FilterGroup label={t('library.filter.excluded')} value={filters.hidden} options={[['yes', t('library.filter.excludedVideos')]]} onChange={(hidden) => patch({ hidden })} />
            {active > 0 && (
              <Button variant="ghost" onClick={() => setFilters({})}>
                {t('library.toolbar.clearFilters')}
              </Button>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <Popover.Root>
        <Popover.Trigger asChild>
          <Button icon aria-label={t('library.toolbar.view')} title={t('library.toolbar.view')}>
            <ViewIcon />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="menu view-menu" align="end" sideOffset={6}>
            {VIEWS.map(({ value, label, icon: Icon }) => (
              <Fragment key={value}>
                <Popover.Close asChild>
                  <button type="button" className={cx('item', value === view && 'on')} onClick={() => setView(value)}>
                    <Icon />
                    {t(label)}
                    {value === view && (
                      <span className="right">
                        <Check />
                      </span>
                    )}
                  </button>
                </Popover.Close>
                {value === 'grid' && view === 'grid' && (
                  <div className="size">
                    <Grid3x3 />
                    <Slider value={[gridSize]} min={GRID_SIZE.min} max={GRID_SIZE.max} step={GRID_SIZE.step} label={t('library.toolbar.thumbnailSize')} onValueChange={(v) => setGridSize(v[0] ?? gridSize)} />
                    <Grid2x2 />
                  </div>
                )}
              </Fragment>
            ))}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {playlistId === null && <Button variant="primary" onClick={() => setScreen('session')}>
        <Shuffle />
        {t('library.toolbar.session')}
      </Button>}
    </div>
    {(playlistError || playError) && <div className="playlist-error" role="alert">{playlistError || playError}</div>}
    </>
  )
}

function PlaylistTitle({ id, title, count }: { id: number; title: string; count: number }) {
  const t = useT()
  const [name, setName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const save = async () => {
    if (saving || !name?.trim()) return
    setSaving(true)
    try {
      await invoke('library:renamePlaylist', id, name.trim())
      await useLibrary.getState().refresh()
      setName(null)
    } catch (error) {
      input.current?.setCustomValidity(ipcMessage(error))
      input.current?.reportValidity()
    } finally {
      setSaving(false)
    }
  }
  return <h1>
    {name === null ? <span onDoubleClick={() => setName(title)}>{title}</span> : (
      <input ref={input} autoFocus className="input playlist-title-input" aria-label={t('library.sidebar.playlistName')}
        value={name} readOnly={saving}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          event.currentTarget.setCustomValidity('')
          setName(event.currentTarget.value)
        }}
        onBlur={() => { if (!saving) setName(null) }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            void save()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            if (!saving) setName(null)
          }
        }} />
    )}
    <span className="count">{count}</span>
  </h1>
}

function FilterGroup<T extends string>({ label, value, options, onChange }: { label: string; value: T | undefined; options: ReadonlyArray<readonly [T, string]>; onChange: (v: T | undefined) => void }) {
  return (
    <div className="filter-group">
      <div className="eyebrow">{label}</div>
      <div className="filter-chips">
        {options.map(([v, l]) => (
          <button key={v} type="button" className={cx('chip', value === v && 'on')} aria-pressed={value === v} onClick={() => onChange(value === v ? undefined : v)}>
            {value === v && <Check />}
            {l}
          </button>
        ))}
      </div>
    </div>
  )
}
