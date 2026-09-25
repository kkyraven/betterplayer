import { create } from 'zustand'
import type { DropResult, FolderNode, GridEntry, LibraryCounts, LibraryRoot, MediaDetail, MediaFilters, MediaQuery, MediaRow, Playlist, ScanProgress, Section, Sort, Tag } from '@shared/library'
import { isPlaylist, SECTIONS } from '@shared/library'
import { movePlaylistItems, type PlaylistMove } from '@shared/playlist'
import type { ServerInput } from '@shared/remote'
import type { SearchInfo } from '@shared/search'
import { invoke, on } from '@/ipc'
import { t } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { useUi } from '@/state/ui'

export type View = 'grid' | 'list' | 'condensed'

export const GRID_SIZE = { min: 160, max: 400, step: 10, default: 260 } as const
const VIEW_KEY = 'library.view'
const GRID_SIZE_KEY = 'library.gridSize'
const SIDEBAR_KEY = 'library.sidebar'

const storedView = (): View => {
  const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(VIEW_KEY)
  return v === 'grid' || v === 'list' || v === 'condensed' ? v : 'grid'
}
const storedGridSize = (): number => {
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(GRID_SIZE_KEY)
  const n = stored?.trim() ? Number(stored) : NaN
  return Number.isFinite(n) ? Math.min(GRID_SIZE.max, Math.max(GRID_SIZE.min, n)) : GRID_SIZE.default
}
const storedSidebarOpen = (): boolean => typeof localStorage === 'undefined' || localStorage.getItem(SIDEBAR_KEY) !== '0'

const PAGE = 120

export const countVideos = (rows: GridEntry[]) => rows.reduce((n, e) => (isPlaylist(e) ? n : n + 1), 0)

export type LibraryUser = 'library' | 'session'

type QueryMode = 'reset' | 'more' | 'shown'

interface LibraryState {
  roots: LibraryRoot[]
  counts: LibraryCounts
  folders: FolderNode[]
  playlists: Playlist[]
  tags: Tag[]
  tagEdits: Record<number, { tags: string[]; error: boolean }>
  progress: ScanProgress
  loaded: boolean
  section: Section
  folder: MediaQuery['folder'] | null
  playlistId: number | null
  movingPlaylist: number | null
  playlistError: string | null
  search: string
  searchInfo: SearchInfo | null
  sort: Sort
  desc: boolean
  filters: MediaFilters
  view: View
  gridSize: number
  sidebarOpen: boolean
  rows: GridEntry[]
  total: number
  rev: number | null
  continueRows: MediaRow[]
  loading: boolean
  selectedId: number | null
  detail: MediaDetail | null
  init: () => void
  mount: (user: LibraryUser) => () => void
  refresh: () => Promise<void>
  query: (mode?: QueryMode) => Promise<void>
  loadMore: () => Promise<void>
  allIds: () => Promise<number[]>
  jumpTo: (prefix: string) => Promise<{ index: number; id: number } | null>
  setSection: (section: Section) => void
  setFolder: (folder: MediaQuery['folder'] | null) => void
  setPlaylist: (id: number | null) => void
  setSearch: (search: string) => void
  setSort: (sort: Sort, desc?: boolean) => void
  setFilters: (filters: MediaFilters) => void
  openTag: (name: string) => void
  setView: (view: View) => void
  setGridSize: (px: number) => void
  setSidebarOpen: (open: boolean) => void
  select: (id: number | null) => Promise<void>
  setRating: (id: number, rating: number) => Promise<void>
  setTags: (id: number, tags: string[]) => Promise<void>
  setTitle: (id: number, title: string) => Promise<void>
  setPinned: (ids: number[], pinned: boolean) => Promise<void>
  setHidden: (ids: number[], hidden: boolean) => Promise<void>
  setFavourite: (ids: number[], favourite: boolean) => Promise<void>
  moveToFolder: (ids: number[], folder: NonNullable<MediaQuery['folder']>) => Promise<void>
  addTag: (ids: number[], tag: string) => Promise<void>
  renameTag: (from: string, to: string) => Promise<string>
  deleteTag: (name: string) => Promise<void>
  excludeFolder: (folder: NonNullable<MediaQuery['folder']>) => Promise<void>
  includeFolder: (folder: NonNullable<MediaQuery['folder']>) => Promise<void>
  addRoot: () => Promise<LibraryRoot[]>
  addPaths: (paths: string[]) => Promise<DropResult>
  addServer: (input: ServerInput) => Promise<void>
  removeRoot: (id: number) => Promise<void>
  setRootSessions: (id: number, sessions: boolean) => Promise<void>
  scan: () => Promise<void>
  createPlaylist: (name: string) => Promise<Playlist>
  deletePlaylist: (id: number) => Promise<void>
  addToPlaylist: (id: number, mediaIds: number[]) => Promise<void>
  movePlaylistItems: (id: number, move: PlaylistMove) => Promise<void>
  tagFolder: (folder: NonNullable<MediaQuery['folder']>, tag: string) => Promise<void>
  addFolderToPlaylist: (playlistId: number, folder: NonNullable<MediaQuery['folder']>) => Promise<void>
}

const EMPTY_COUNTS: LibraryCounts = Object.fromEntries(SECTIONS.map((s) => [s, 0])) as LibraryCounts
const IDLE: ScanProgress = { scanning: false, done: 0, total: 0, thumbsPending: 0, tagsPending: 0 }

const SECTION_SORT: Partial<Record<Section, { sort: Sort; desc: boolean }>> = {
  newest: { sort: 'added', desc: true },
  mostWatched: { sort: 'plays', desc: true },
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i])

function sameRow(a: MediaRow, b: MediaRow): boolean {
  return (
    a.path === b.path &&
    a.title === b.title &&
    a.titleSet === b.titleSet &&
    a.folder === b.folder &&
    a.height === b.height &&
    a.projection === b.projection &&
    a.thumb === b.thumb &&
    a.strip === b.strip &&
    a.durationMs === b.durationMs &&
    a.watchedMs === b.watchedMs &&
    a.rating === b.rating &&
    a.favourite === b.favourite &&
    a.pinned === b.pinned &&
    a.playlistPosition === b.playlistPosition &&
    a.hidden === b.hidden &&
    JSON.stringify(a.searchMatch) === JSON.stringify(b.searchMatch) &&
    JSON.stringify(a.performers) === JSON.stringify(b.performers) &&
    sameList(a.axes, b.axes) &&
    sameList(a.tags, b.tags) &&
    sameList(a.heat, b.heat)
  )
}

const entryKey = (e: GridEntry) => (isPlaylist(e) ? `p${e.id}` : `v${e.id}`)

function sameEntry(a: GridEntry, b: GridEntry): boolean {
  if (isPlaylist(a) || isPlaylist(b)) {
    return isPlaylist(a) && isPlaylist(b) && a.id === b.id && a.name === b.name && a.count === b.count && sameList(a.thumbs, b.thumbs)
  }
  return sameRow(a, b)
}

function mergeRows<T extends GridEntry>(held: T[], incoming: T[]): T[] {
  const byKey = new Map(held.map((e) => [entryKey(e), e]))
  const merged = incoming.map((e) => {
    const old = byKey.get(entryKey(e))
    return old && sameEntry(old, e) ? old : e
  })
  return sameList(held, merged) ? held : merged
}

function mergeFolders(previous: FolderNode[], incoming: FolderNode[]): FolderNode[] {
  const byKey = new Map(previous.map((node) => [`${node.rootId}:${node.folder}`, node]))
  const merged = incoming.map((node) => {
    const old = byKey.get(`${node.rootId}:${node.folder}`)
    if (!old) return node
    const children = mergeFolders(old.children, node.children)
    return JSON.stringify({ ...old, children: [] }) === JSON.stringify({ ...node, children: [] }) && children === old.children
      ? old : { ...node, children }
  })
  return merged.length === previous.length && merged.every((node, i) => node === previous[i]) ? previous : merged
}

export const useLibrary = create<LibraryState>()((set, get) => {
  const tagWrites = new Map<number, { confirmed: string[]; latest: string[]; tail: Promise<void> }>()
  const publishTags = (id: number, tags: string[], error = false) => set((s) => ({
    tagEdits: { ...s.tagEdits, [id]: { tags, error } },
    rows: s.rows.map((row) => !isPlaylist(row) && row.id === id ? { ...row, tags } : row),
    continueRows: s.continueRows.map((row) => row.id === id ? { ...row, tags } : row),
    detail: s.detail?.id === id ? { ...s.detail, tags } : s.detail,
  }))
  const pendingTags = <T extends GridEntry>(rows: T[]): T[] => rows.map((row) => {
    const pending = !isPlaylist(row) && tagWrites.get(row.id)
    return pending ? { ...row, tags: pending.latest } : row
  })
  let queryId = 0
  let searchTimer = 0
  let browsingSort: { sort: Sort; desc: boolean } | null = null
  const users = new Set<LibraryUser>()
  let listsStale = false
  let pageStale = false
  let playedSince = false

  const showsContinueRow = () => {
    const s = get()
    return (useSettings.getState().settings?.library.continueRow ?? false) && s.section === 'all' && !s.folder && s.playlistId === null && !s.search
  }

  const buildQuery = (offset: number, limit: number): MediaQuery => {
    const s = get()
    return {
      section: s.section,
      folder: s.folder ?? undefined,
      playlistId: s.playlistId ?? undefined,
      search: s.search || undefined,
      sort: s.sort,
      desc: s.desc,
      filters: s.filters,
      limit,
      offset,
      continueRow: showsContinueRow() || undefined,
    }
  }

  const requery = () => void get().query('reset')

  const refreshDetail = () => {
    const { selectedId } = get()
    if (selectedId !== null) void invoke('library:media', selectedId).then((detail) => set({ detail: detail ? pendingTags([detail])[0]! : null }))
  }

  const structuralChange = () => {
    if (users.size > 0) void get().refresh()
    else listsStale = true
    if (users.has('library')) {
      void get().query('shown')
      refreshDetail()
    } else pageStale = true
  }

  const thumbsChange = (ids: number[]) => {
    if (!users.has('library')) {
      pageStale = true
      return
    }
    const s = get()
    if (s.rows.some(isPlaylist)) {
      void get().query('shown')
      return
    }
    const held = new Set([...s.rows, ...s.continueRows].map((r) => r.id))
    const wanted = ids.filter((id) => held.has(id) || id === s.selectedId)
    if (wanted.length === 0) return
    void Promise.all(wanted.map((id) => invoke('library:media', id))).then((details) => {
      const fresh = new Map<number, MediaDetail>()
      for (const d of pendingTags(details.filter((detail): detail is MediaDetail => detail !== null))) fresh.set(d.id, d)
      set((state) => ({
        rows: mergeRows(state.rows, state.rows.map((r) => (isPlaylist(r) ? r : fresh.has(r.id) ? { ...fresh.get(r.id)!, playlistPosition: r.playlistPosition, searchMatch: r.searchMatch, performers: r.performers } : r))),
        continueRows: mergeRows(state.continueRows, state.continueRows.map((r) => fresh.get(r.id) ?? r)),
        detail: state.detail ? (fresh.get(state.detail.id) ?? state.detail) : null,
      }))
    })
  }

  return {
    roots: [],
    counts: EMPTY_COUNTS,
    folders: [],
    playlists: [],
    tags: [],
    tagEdits: {},
    progress: IDLE,
    loaded: false,
    section: 'all',
    folder: null,
    playlistId: null,
    movingPlaylist: null,
    playlistError: null,
    search: '',
    searchInfo: null,
    sort: 'recommended',
    desc: true,
    filters: {},
    view: storedView(),
    gridSize: storedGridSize(),
    sidebarOpen: storedSidebarOpen(),
    rows: [],
    total: 0,
    rev: null,
    continueRows: [],
    loading: false,
    selectedId: null,
    detail: null,

    init: () => {
      void get().refresh()
      void get().query('reset')
      on('library:progress', (progress) => {
        const finished = get().progress.scanning && !progress.scanning
        set({ progress })
        if (finished && users.size > 0) void invoke('library:roots').then((roots) => set({ roots }))
      })
      on('library:changed', (change) => {
        if (change.kind === 'thumbs') {
          thumbsChange(change.ids)
          if (users.size > 0) void invoke('library:roots').then((roots) => set({ roots }))
          else listsStale = true
        }
        else if (change.kind === 'tags') {
          if (get().search.trim() || get().filters.tag) {
            structuralChange()
            return
          }
          thumbsChange(change.ids)
          if (users.size > 0) void get().refresh()
          else listsStale = true
        } else structuralChange()
      })
      useUi.subscribe((ui, prev) => {
        if (ui.screen !== prev.screen && (prev.screen === 'player' || prev.screen === 'session')) playedSince = true
      })
      useSettings.subscribe((s, prev) => {
        if ((s.settings?.library.continueRow ?? false) === (prev.settings?.library.continueRow ?? false)) return
        if (users.has('library')) void get().query('shown')
        else pageStale = true
      })
    },

    mount: (user) => {
      users.add(user)
      if (listsStale) {
        listsStale = false
        void get().refresh()
      }
      if (user === 'library') {
        if (pageStale) {
          void get().query('shown')
          refreshDetail()
        } else if (playedSince) {
          void invoke('library:counts').then((counts) => set({ counts }))
          void get().query('shown')
        }
        pageStale = false
        playedSince = false
      }
      return () => {
        users.delete(user)
      }
    },

    refresh: async () => {
      try {
        const [roots, counts, folders, playlists, tags, progress] = await Promise.all([
          invoke('library:roots'),
          invoke('library:counts'),
          invoke('library:folders'),
          invoke('library:playlists'),
          invoke('library:tags'),
          invoke('library:progress'),
        ])
        set((state) => ({ roots, counts, folders: mergeFolders(state.folders, folders), playlists, tags, progress, loaded: true }))
      } catch (error) {
        void invoke('app:reportError', `library refresh: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      }
    },

    query: async (mode = 'reset') => {
      if (mode !== 'reset' && get().movingPlaylist !== null && get().movingPlaylist === get().playlistId) return
      const id = ++queryId
      set({ loading: true })
      const shown = get().rows.length
      const offset = mode === 'more' ? shown : 0
      const limit = mode === 'shown' ? Math.max(PAGE, shown) : PAGE
      const wantContinue = mode !== 'more' && showsContinueRow()
      try {
        const [page, cont] = await Promise.all([
          invoke('library:query', buildQuery(offset, limit)),
          wantContinue ? invoke('library:query', { ...buildQuery(0, 8), section: 'continue', sort: 'lastPlayed', desc: true, continueRow: undefined }) : Promise.resolve(null),
        ])
        if (id !== queryId) return
        if (mode === 'more' && page.rev !== undefined && page.rev !== get().rev) {
          void get().query('reset')
          return
        }
        set((s) => ({
          rows: mode === 'more' ? [...s.rows, ...pendingTags(page.rows)] : mergeRows(s.rows, pendingTags(page.rows)),
          total: page.total ?? s.total,
          rev: mode === 'more' ? s.rev : (page.rev ?? null),
          searchInfo: page.search ?? null,
          continueRows: cont ? mergeRows(s.continueRows, pendingTags(cont.rows.filter((e): e is MediaRow => !isPlaylist(e)))) : mode === 'more' ? s.continueRows : [],
          loading: false,
        }))
      } catch {
        if (id === queryId) set({ loading: false, rows: [], total: 0, continueRows: [], searchInfo: { query: get().search, conditions: [], corrections: [], error: t('library.search.unavailable') } })
      }
    },
    loadMore: async () => {
      const { rows, total, loading } = get()
      if (loading || countVideos(rows) >= total) return
      await get().query('more')
    },
    allIds: () => invoke('library:queryIds', buildQuery(0, 0)),
    jumpTo: async (prefix) => {
      const id = ++queryId
      const hit = await invoke('library:jump', buildQuery(0, 0), prefix)
      if (id !== queryId || !hit) return null
      if (get().rows.length <= hit.index) {
        const page = await invoke('library:query', buildQuery(0, hit.index + 1))
        if (id !== queryId) return null
        set((s) => ({ rows: mergeRows(s.rows, pendingTags(page.rows)), total: page.total ?? s.total }))
      }
      return hit
    },

    setSection: (section) => {
      set({ section, folder: null, playlistId: null, playlistError: null, ...(get().playlistId !== null ? { view: storedView() } : {}), ...SECTION_SORT[section] })
      requery()
    },
    setFolder: (folder) => {
      set({ folder, section: 'all', playlistId: null, playlistError: null, ...(get().playlistId !== null ? { view: storedView() } : {}) })
      requery()
    },
    setPlaylist: (playlistId) => {
      window.clearTimeout(searchTimer)
      browsingSort = null
      set({ playlistId, section: 'all', folder: null, search: '', filters: {}, playlistError: null, view: playlistId === null ? storedView() : 'list' })
      requery()
    },
    setSearch: (search) => {
      const state = get()
      const entering = search.trim() !== '' && state.search.trim() === ''
      const leaving = search.trim() === '' && state.search.trim() !== ''
      if (entering) browsingSort = { sort: state.sort, desc: state.desc }
      queryId++
      set({ search, searchInfo: null, loading: true, ...(entering ? { sort: 'recommended' as const, desc: true } : leaving && browsingSort ? browsingSort : {}) })
      if (leaving) browsingSort = null
      window.clearTimeout(searchTimer)
      searchTimer = window.setTimeout(requery, 150)
    },
    setSort: (sort, desc) => {
      set({ sort, desc: desc ?? (sort === 'name' ? false : true) })
      requery()
    },
    setFilters: (filters) => {
      set({ filters })
      requery()
    },
    openTag: (name) => {
      set((s) => ({ section: 'all', folder: null, playlistId: null, playlistError: null, ...(s.playlistId !== null ? { view: storedView() } : {}), ...SECTION_SORT.all, filters: { ...s.filters, tag: name } }))
      requery()
    },
    setView: (view) => {
      if (get().playlistId === null) localStorage.setItem(VIEW_KEY, view)
      set({ view })
    },
    setGridSize: (px) => {
      const gridSize = Math.min(GRID_SIZE.max, Math.max(GRID_SIZE.min, Math.round(px)))
      localStorage.setItem(GRID_SIZE_KEY, String(gridSize))
      set({ gridSize })
    },
    setSidebarOpen: (sidebarOpen) => {
      localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? '1' : '0')
      set({ sidebarOpen })
    },

    select: async (id) => {
      set({ selectedId: id, detail: id === null ? null : get().detail?.id === id ? get().detail : null })
      if (id !== null) {
        const detail = await invoke('library:media', id)
        set({ detail: detail ? pendingTags([detail])[0]! : null })
      }
    },
    setRating: async (id, rating) => {
      await invoke('library:setRating', id, rating)
      set((s) => ({
        rows: s.rows.map((r) => (!isPlaylist(r) && r.id === id ? { ...r, rating } : r)),
        detail: s.detail?.id === id ? { ...s.detail, rating } : s.detail,
      }))
    },
    setTags: (id, values) => {
      const tags = [...new Set(values.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
      const state = get()
      const row = state.rows.find((row): row is MediaRow => !isPlaylist(row) && row.id === id) ?? state.continueRows.find((row) => row.id === id)
      const write = tagWrites.get(id) ?? { confirmed: row?.tags ?? (state.detail?.id === id ? state.detail.tags : state.tagEdits[id]?.tags ?? []), latest: tags, tail: Promise.resolve() }
      write.latest = tags
      tagWrites.set(id, write)
      publishTags(id, tags)
      const saving = write.tail.then(async () => {
        try {
          await invoke('library:setTags', id, tags)
          write.confirmed = tags
        } catch (error) {
          if (write.latest === tags) { write.latest = write.confirmed; publishTags(id, write.confirmed, true) }
          throw error
        }
      })
      const settled = saving.catch(() => {}).then(() => {
        if (write.tail === settled) {
          tagWrites.delete(id)
          if (!get().tagEdits[id]?.error) set((s) => {
            const { [id]: completed, ...tagEdits } = s.tagEdits
            return { tagEdits }
          })
        }
      })
      write.tail = settled
      void saving.then(() => invoke('library:tags')).then((tags) => set({ tags })).catch(() => {})
      return saving
    },
    setTitle: async (id, title) => {
      await invoke('library:setTitle', id, title)
      const [media, { usePlayer }, { useEditor }] = await Promise.all([
        invoke('library:media', id), import('./player'), import('./editor'),
      ])
      if (!media) return
      set((s) => ({
        rows: s.rows.map((row) => !isPlaylist(row) && row.id === id ? { ...row, title: media.title, titleSet: media.titleSet } : row),
        continueRows: s.continueRows.map((row) => row.id === id ? { ...row, title: media.title, titleSet: media.titleSet } : row),
        detail: s.detail?.id === id ? { ...s.detail, title: media.title, titleSet: media.titleSet } : s.detail,
      }))
      const player = usePlayer.getState()
      if (player.path === media.path) usePlayer.setState({ media, title: media.titleSet ? media.title : player.audio?.title ?? media.title })
      if (useEditor.getState().key === media.path) useEditor.setState({ title: media.title })
    },
    setPinned: (ids, pinned) => invoke('library:setPinned', ids, pinned),
    setHidden: (ids, hidden) => invoke('library:setHidden', ids, hidden),
    setFavourite: async (ids, favourite) => {
      await invoke('library:setFavourite', ids, favourite)
      const hit = new Set(ids)
      set((s) => ({
        rows: s.rows.map((r) => (!isPlaylist(r) && hit.has(r.id) ? { ...r, favourite } : r)),
        continueRows: s.continueRows.map((r) => (hit.has(r.id) ? { ...r, favourite } : r)),
        detail: s.detail && hit.has(s.detail.id) ? { ...s.detail, favourite } : s.detail,
      }))
    },
    moveToFolder: (ids, folder) => invoke('library:moveToFolder', ids, folder),
    addTag: async (ids, tag) => {
      await invoke('library:addTag', ids, tag)
      await get().refresh()
    },
    renameTag: async (from, to) => {
      const name = await invoke('library:renameTag', from, to)
      const { filters, setFilters } = get()
      if (filters.tag === from && name !== from) setFilters({ ...filters, tag: name })
      await get().refresh()
      return name
    },
    deleteTag: async (name) => {
      await invoke('library:deleteTag', name)
      const { filters, setFilters } = get()
      if (filters.tag === name) setFilters({ ...filters, tag: undefined })
      await get().refresh()
    },
    excludeFolder: async (folder) => {
      await invoke('library:excludeFolder', folder)
      const shown = get().folder
      if (shown?.rootId === folder.rootId && (shown.folder === folder.folder || shown.folder.startsWith(`${folder.folder}/`))) set({ folder: null })
    },
    includeFolder: (folder) => invoke('library:includeFolder', folder),
    addRoot: async () => {
      const roots = await invoke('library:addRoot')
      if (roots.length > 0) await get().refresh()
      return roots
    },
    addPaths: async (paths) => {
      const result = await invoke('library:addPaths', paths)
      await get().refresh()
      return result
    },
    addServer: async (input) => {
      await invoke('library:addServer', input)
      await get().refresh()
    },
    removeRoot: async (id) => {
      await invoke('library:removeRoot', id)
      if (get().folder?.rootId === id) set({ folder: null })
      await get().refresh()
      requery()
    },
    setRootSessions: async (id, sessions) => {
      await invoke('library:setRootSessions', id, sessions)
      await get().refresh()
    },
    scan: () => invoke('library:scan'),
    createPlaylist: async (name) => {
      const playlist = await invoke('library:createPlaylist', name)
      await get().refresh()
      return playlist
    },
    deletePlaylist: async (id) => {
      await invoke('library:deletePlaylist', id)
      if (get().playlistId === id) set({ playlistId: null, view: storedView(), playlistError: null })
      await get().refresh()
      requery()
    },
    addToPlaylist: async (id, mediaIds) => {
      await invoke('library:addToPlaylist', id, mediaIds)
      await get().refresh()
    },
    movePlaylistItems: async (id, move) => {
      const state = get()
      if (state.movingPlaylist !== null || state.playlistId !== id || state.search.trim() || Object.values(state.filters).some(v => v !== undefined && (!Array.isArray(v) || v.length > 0))) return
      const rows = state.rows.filter((r): r is MediaRow => !isPlaylist(r))
      const byId = new Map(rows.map(r => [r.id, r]))
      const loadedMove = { ...move, mediaIds: move.mediaIds.filter(mediaId => byId.has(mediaId)) }
      const order = movePlaylistItems(rows.map(r => r.id), loadedMove, t)
      if (order.every((mediaId, i) => mediaId === rows[i]?.id) && loadedMove.mediaIds.length === move.mediaIds.length) return
      const optimistic = order.map((mediaId, i) => ({ ...byId.get(mediaId)!, playlistPosition: rows[i]?.playlistPosition }))
      queryId++
      set({ rows: optimistic, movingPlaylist: id, playlistError: null, loading: false })
      try {
        await invoke('library:movePlaylistItems', id, move)
      } catch {
        if (get().playlistId === id) set({ playlistError: t('library.playlist.reorderError'), ...(get().rows === optimistic ? { rows: state.rows } : {}) })
      } finally {
        set({ movingPlaylist: null })
        if (get().playlistId === id) await get().query('shown')
      }
    },
    tagFolder: async (folder, tag) => {
      await invoke('library:addTag', await invoke('library:folderMedia', folder), tag)
      await get().refresh()
    },
    addFolderToPlaylist: async (playlistId, folder) => {
      await invoke('library:addToPlaylist', playlistId, await invoke('library:folderMedia', folder))
      await get().refresh()
    },
  }
})
