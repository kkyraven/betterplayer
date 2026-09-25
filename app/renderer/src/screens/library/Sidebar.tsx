import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Activity,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Disc3,
  Ellipsis,
  EyeOff,
  FileQuestion,
  Flame,
  Folder,
  FolderOpen,
  FolderPlus,
  Headset,
  Heart,
  History,
  Layers,
  Library,
  ListVideo,
  MoveVertical,
  Orbit,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RectangleHorizontal,
  RefreshCw,
  RotateCw,
  Scan,
  Server,
  Sparkles,
  Tag,
  Timer,
  Trash2,
  Undo2,
  Waves,
  Zap,
} from 'lucide-react'
import { memo, createContext, useContext, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type DragEventHandler } from 'react'
import type { MessageKey } from '@shared/i18n'
import { CORE_SECTIONS, SECTIONS, type FolderNode, type MediaQuery, type Section, type Tag as TagRow } from '@shared/library'
import { IconButton } from '@/components/ui/IconButton'
import { Prompt } from '@/components/ui/Prompt'
import { invoke } from '@/ipc'
import { cx } from '@/lib/cx'
import { ipcMessage } from '@/lib/errors'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { useRemote } from '@/state/remote'
import { useSettings } from '@/state/settings'
import { dropKey, useSelect, type DropTarget } from '@/state/select'
import { ServerDialog } from './ServerDialog'
import { dropItem, flattenFolders, moveItem, orderedItems, sidebarKey } from './sidebarOrder'

const VIEW_DEFS: ReadonlyArray<{
  id: Section
  label: MessageKey
  icon: typeof Library
}> = [
  { id: 'all', label: 'library.section.all', icon: Library },
  { id: 'continue', label: 'library.section.continue', icon: History },
  { id: 'favourites', label: 'library.section.favourites', icon: Heart },
  { id: 'unscripted', label: 'library.section.unscripted', icon: FileQuestion },
  { id: 'newest', label: 'library.section.newest', icon: Sparkles },
  { id: 'mostWatched', label: 'library.section.mostWatched', icon: Flame },
  { id: 'multiAxis', label: 'library.section.multiAxis', icon: Layers },
  { id: 'singleAxis', label: 'library.section.singleAxis', icon: MoveVertical },
  { id: 'sr6', label: 'library.section.sr6', icon: Orbit },
  { id: 'osr2', label: 'library.section.osr2', icon: Disc3 },
  { id: 'twist', label: 'library.section.twist', icon: RotateCw },
  { id: 'estim', label: 'library.section.estim', icon: Zap },
  { id: 'focstim', label: 'library.section.focstim', icon: Waves },
  { id: 'restim', label: 'library.section.restim', icon: Activity },
  { id: 'vr', label: 'library.section.vr', icon: Headset },
  { id: '2d', label: 'library.section.2d', icon: RectangleHorizontal },
  { id: 'res1080', label: 'library.section.res1080', icon: Scan },
  { id: 'res1440', label: 'library.section.res1440', icon: Scan },
  { id: 'res4k', label: 'library.section.res4k', icon: Scan },
  { id: 'len0to2', label: 'library.section.len0to2', icon: Timer },
  { id: 'len2to5', label: 'library.section.len2to5', icon: Timer },
  { id: 'len5to15', label: 'library.section.len5to15', icon: Timer },
  { id: 'len15to30', label: 'library.section.len15to30', icon: Timer },
  { id: 'len30plus', label: 'library.section.len30plus', icon: Timer },
]
const VIEW_BY_ID = new Map(VIEW_DEFS.map((v) => [v.id, v]))
const TOP_TAGS = 5
const RowMenuContext = createContext<{
  rect: DOMRect | null
  anchor: HTMLElement | null
  show: (rect: DOMRect, anchor: HTMLElement) => void
  open: boolean
  onOpenChange: (open: boolean) => void
} | undefined>(undefined)

export function Sidebar() {
  const t = useT()
  const counts = useLibrary((s) => s.counts)
  const section = useLibrary((s) => s.section)
  const folder = useLibrary((s) => s.folder)
  const playlistId = useLibrary((s) => s.playlistId)
  const playlists = useLibrary((s) => s.playlists)
  const folders = useLibrary((s) => s.folders)
  const roots = useLibrary((s) => s.roots)
  const tags = useLibrary((s) => s.tags)
  const filters = useLibrary((s) => s.filters)
  const setFilters = useLibrary((s) => s.setFilters)
  const openTag = useLibrary((s) => s.openTag)
  const setSection = useLibrary((s) => s.setSection)
  const setPlaylist = useLibrary((s) => s.setPlaylist)
  const addRoot = useLibrary((s) => s.addRoot)
  const source = useRemote((s) => s.status.source)
  const createPlaylist = useLibrary((s) => s.createPlaylist)
  const addToPlaylist = useLibrary((s) => s.addToPlaylist)
  const deletePlaylist = useLibrary((s) => s.deletePlaylist)
  const pending = useSelect((s) => s.pendingPlaylist)
  const setPending = useSelect((s) => s.setPendingPlaylist)
  const open = useLibrary((s) => s.sidebarOpen)
  const dragging = useSelect((s) => s.drag !== null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [addingServer, setAddingServer] = useState(false)
  const closeNaming = () => {
    setName('')
    setNaming(false)
    setPending(null)
  }
  const submitPlaylist = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (n) void createPlaylist(n).then((p) => pending && addToPlaylist(p.id, pending))
    closeNaming()
  }
  const inSections = folder === null && playlistId === null
  const settings = useSettings((s) => s.settings)
  const updateSettings = useSettings((s) => s.update)
  const views = settings?.library.views ?? [...CORE_SECTIONS]
  const viewsOpen = settings?.library.viewsOpen ?? false
  const [viewDrag, setViewDrag] = useState<Section | null>(null)
  const [viewOver, setViewOver] = useState<{ id: Section; after: boolean } | null>(null)
  const setViews = (next: Section[]) =>
    void updateSettings((s) => ({
      ...s,
      library: { ...s.library, views: next },
    }))
  const addView = (id: Section) => setViews([...views, id])
  const removeView = (id: Section) => {
    const next = views.filter((v) => v !== id)
    const first = next[0]
    if (section === id && first) setSection(first)
    setViews(next)
  }

  const [playlistsOpen, setPlaylistsOpen] = useState(false)
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null)
  const [savingName, setSavingName] = useState(false)
  const renameInput = useRef<HTMLInputElement>(null)
  const pendingRename = useRef<{ id: number; name: string } | null>(null)
  const submitRename = async (event: FormEvent) => {
    event.preventDefault()
    if (!renaming || savingName || !renaming.name.trim()) return
    setSavingName(true)
    try {
      await invoke('library:renamePlaylist', renaming.id, renaming.name.trim())
      setRenaming(null)
      await useLibrary.getState().refresh()
    } catch (error) {
      renameInput.current?.setCustomValidity(ipcMessage(error))
      renameInput.current?.reportValidity()
    } finally {
      setSavingName(false)
    }
  }
  const [playlistDrag, setPlaylistDrag] = useState<number | null>(null)
  const [playlistOver, setPlaylistOver] = useState<{ id: number; after: boolean } | null>(null)
  const playlistKey = (id: number) => sidebarKey(source, id)
  const sortedPlaylists = orderedItems(playlists, settings?.library.playlistOrder ?? [], (p) => playlistKey(p.id))
  const hiddenPlaylists = settings?.library.hiddenPlaylists ?? []
  const visiblePlaylists = sortedPlaylists.filter((p) => !hiddenPlaylists.includes(playlistKey(p.id)))
  const hiddenPlaylistRows = sortedPlaylists.filter((p) => hiddenPlaylists.includes(playlistKey(p.id)))
  const savePlaylistOrder = (ids: number[]) => void updateSettings((s) => ({ ...s, library: {
    ...s.library,
    playlistOrder: [...ids.map(playlistKey), ...s.library.playlistOrder.filter((key) => !playlists.some((p) => playlistKey(p.id) === key))],
  } }))
  const movePlaylist = (id: number, position: number) => savePlaylistOrder(moveItem(visiblePlaylists.map((p) => p.id), id, position).concat(hiddenPlaylistRows.map((p) => p.id)))
  const togglePlaylist = (id: number) => void updateSettings((s) => ({ ...s, library: {
    ...s.library,
    hiddenPlaylists: s.library.hiddenPlaylists.includes(playlistKey(id)) ? s.library.hiddenPlaylists.filter((key) => key !== playlistKey(id)) : [...s.library.hiddenPlaylists, playlistKey(id)],
  } }))
  const playlistRow = (p: (typeof playlists)[number], hidden = false) => {
    const position = visiblePlaylists.findIndex((entry) => entry.id === p.id)
    return <DropRow key={p.id} contextMenu as="div" target={{ kind: 'playlist', id: p.id }}
      className={cx('sb-item', 'sb-playlist', playlistId === p.id && 'on', hidden && 'ghost', playlistOver?.id === p.id && (playlistOver.after ? 'sb-insert-after' : 'sb-insert-before'))}
      draggable={!hidden && renaming?.id !== p.id}
      onDragStart={(event) => {
        event.dataTransfer.setData('application/x-betterplayer-sidebar-playlist', String(p.id))
        event.dataTransfer.effectAllowed = 'move'
        setPlaylistDrag(p.id)
      }}
      onDragOver={(event) => {
        if (playlistDrag === null || hidden) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const rect = event.currentTarget.getBoundingClientRect()
        setPlaylistOver({ id: p.id, after: event.clientY > rect.top + rect.height / 2 })
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setPlaylistOver(null)
      }}
      onDrop={(event) => {
        if (playlistDrag === null || hidden) return
        event.preventDefault()
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        const after = event.clientY > rect.top + rect.height / 2
        const from = visiblePlaylists.findIndex((entry) => entry.id === playlistDrag)
        if (playlistDrag !== p.id) movePlaylist(playlistDrag, position + (after ? 1 : 0) - (from < position ? 1 : 0))
        setPlaylistDrag(null)
        setPlaylistOver(null)
      }}
      onDragEnd={() => { setPlaylistDrag(null); setPlaylistOver(null) }}>
      {renaming?.id === p.id ? (
        <form className="sb-fill sb-rename" onSubmit={(event) => void submitRename(event)}>
          <ListVideo />
          <input ref={renameInput} autoFocus className="input" aria-label={t('library.sidebar.playlistName')}
            value={renaming.name} readOnly={savingName}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              event.currentTarget.setCustomValidity('')
              setRenaming({ id: p.id, name: event.currentTarget.value })
            }}
            onBlur={() => { if (!savingName) setRenaming(null) }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Escape') {
                event.preventDefault()
                if (!savingName) setRenaming(null)
              }
              if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
            }} />
          <span className="n">{p.count}</span>
        </form>
      ) : (
        <button type="button" className="sb-fill" onClick={() => setPlaylist(p.id)}><ListVideo /><span className="sb-name" onDoubleClick={() => { if (!savingName) setRenaming({ id: p.id, name: p.name }) }}>{p.name}</span><span className="n">{p.count}</span></button>
      )}
      <SidebarMenu name={p.name} onClose={() => {
        if (pendingRename.current?.id !== p.id) return
        setRenaming(pendingRename.current)
        pendingRename.current = null
      }}>
        <DropdownMenu.Item className="item" disabled={savingName} onSelect={() => { pendingRename.current = { id: p.id, name: p.name } }}><Pencil />{t('common.rename')}</DropdownMenu.Item>
        <OrderActions hidden={hidden} first={position === 0} last={position === visiblePlaylists.length - 1}
          onPin={() => movePlaylist(p.id, 0)} onMove={(delta) => movePlaylist(p.id, position + delta)} onToggle={() => togglePlaylist(p.id)} />
        <DropdownMenu.Separator className="sep" />
        <DropdownMenu.Item className="item danger" onSelect={() => void deletePlaylist(p.id)}><Trash2 />{t('common.delete')}</DropdownMenu.Item>
      </SidebarMenu>
    </DropRow>
  }
  const pinnedFolderKeys = settings?.library.pinnedFolders ?? []
  const pinnedFolderNodes = orderedItems(flattenFolders(folders).filter((node) => !node.excluded && pinnedFolderKeys.includes(sidebarKey(source, node.rootId, node.folder))), pinnedFolderKeys, (node) => sidebarKey(source, node.rootId, node.folder))

  const [tagsOpen, setTagsOpen] = useState(false)
  const pinnedTags = settings?.library.pinnedTags ?? []
  const togglePin = (name: string) =>
    void updateSettings((s) => ({
      ...s,
      library: {
        ...s.library,
        pinnedTags: s.library.pinnedTags.includes(name) ? s.library.pinnedTags.filter((t) => t !== name) : [...s.library.pinnedTags, name],
      },
    }))
  const byCount = [...tags].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const pinned = pinnedTags.map((n) => tags.find((t) => t.name === n)).filter((t): t is TagRow => t !== undefined)
  const unpinned = byCount.filter((t) => !pinnedTags.includes(t.name))
  const fill = Math.max(0, TOP_TAGS - pinned.length)
  const tagRow = (t: TagRow) => {
    const isPinned = pinnedTags.includes(t.name)
    return (
      <DropRow key={t.name} contextMenu as="div" target={{ kind: 'tag', name: t.name }} className={cx('sb-item', 'sb-tag', filters.tag === t.name && 'on')}>
        <button type="button" className="sb-fill" onClick={() => (filters.tag === t.name ? setFilters({ ...filters, tag: undefined }) : openTag(t.name))}>
          {isPinned ? <Pin /> : <Tag />}
          <span className="sb-name">{t.name}</span>
          <span className="n">{t.count}</span>
        </button>
        <TagMenu name={t.name} count={t.count} pinned={isPinned} onTogglePin={() => togglePin(t.name)} />
      </DropRow>
    )
  }

  const viewRow = (id: Section, inDefaults: boolean) => {
    const def = VIEW_BY_ID.get(id)
    if (!def) return null
    const Icon = def.icon
    return (
      <DropRow key={id} contextMenu as="div" target={id === 'favourites' ? { kind: 'favourites' } : null}
        className={cx('sb-item', 'sb-view', inSections && section === id && 'on', viewOver?.id === id && (viewOver.after ? 'sb-insert-after' : 'sb-insert-before'))}
        draggable={inDefaults}
        onDragStart={(event) => {
          event.dataTransfer.setData('application/x-betterplayer-sidebar-view', id)
          event.dataTransfer.effectAllowed = 'move'
          setViewDrag(id)
        }}
        onDragOver={(event) => {
          if (viewDrag === null || !inDefaults) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          const rect = event.currentTarget.getBoundingClientRect()
          setViewOver({ id, after: event.clientY > rect.top + rect.height / 2 })
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setViewOver(null)
        }}
        onDrop={(event) => {
          if (viewDrag === null || !inDefaults) return
          event.preventDefault()
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          if (viewDrag !== id) setViews(dropItem(views, viewDrag, id, event.clientY > rect.top + rect.height / 2))
          setViewDrag(null)
          setViewOver(null)
        }}
        onDragEnd={() => { setViewDrag(null); setViewOver(null) }}>
        <button type="button" className="sb-fill" onClick={() => setSection(id)}>
          <Icon />
          {t(def.label)}
          <span className="n">{counts[id]}</span>
        </button>
        <SidebarMenu name={t(def.label)}>
          <DropdownMenu.Item className="item" onSelect={() => inDefaults ? removeView(id) : addView(id)}>
            {inDefaults ? <PinOff /> : <Pin />}{t(inDefaults ? 'library.tag.unpin' : 'library.tag.pin')}
          </DropdownMenu.Item>
          {inDefaults && <>
            <DropdownMenu.Item className="item" disabled={views.indexOf(id) === 0} onSelect={() => setViews(moveItem(views, id, views.indexOf(id) - 1))}><ArrowUp />{t('library.sidebar.moveUp')}</DropdownMenu.Item>
            <DropdownMenu.Item className="item" disabled={views.indexOf(id) === views.length - 1} onSelect={() => setViews(moveItem(views, id, views.indexOf(id) + 1))}><ArrowDown />{t('library.sidebar.moveDown')}</DropdownMenu.Item>
          </>}
        </SidebarMenu>
      </DropRow>
    )
  }

  return (
    <>
      <div className={cx('lib-sidebar-gap', !open && 'closed')} />
      <aside className={cx('lib-sidebar', !open && 'closed', !open && dragging && 'peek')} aria-hidden={!open && !dragging}>
        <div className="sb-section sb-views">
          <div className="sb-head">
            <div className="eyebrow">{t('library.sidebar.library')}</div>
            <button
              type="button"
              className="sb-toggle"
              aria-label={t('library.sidebar.moreViews')}
              aria-expanded={viewsOpen}
              onClick={() =>
                void updateSettings((s) => ({
                  ...s,
                  library: { ...s.library, viewsOpen: !viewsOpen },
                }))
              }
            >
              {viewsOpen ? <ChevronDown /> : <ChevronRight />}
            </button>
          </div>
          {views.map((id) => viewRow(id, true))}
          {viewsOpen && <div className="sb-pool disclosure-content">{SECTIONS.filter((id) => !views.includes(id)).map((id) => viewRow(id, false))}</div>}
        </div>
        <div className="sb-section">
          <div className="sb-head">
            <div className="eyebrow">{t('library.sidebar.playlists')}</div>
            {hiddenPlaylistRows.length > 0 && <button type="button" className="sb-toggle" aria-label={t('library.sidebar.morePlaylists')} aria-expanded={playlistsOpen} onClick={() => setPlaylistsOpen(!playlistsOpen)}>{playlistsOpen ? <ChevronDown /> : <ChevronRight />}</button>}
          </div>
          {visiblePlaylists.map((p) => playlistRow(p))}
          {playlistsOpen && hiddenPlaylistRows.length > 0 && <div className="sb-pool disclosure-content">{hiddenPlaylistRows.map((p) => playlistRow(p, true))}</div>}
          {naming || pending ? (
            <form className="sb-item sb-form" onSubmit={submitPlaylist}>
              <input
                autoFocus
                className="input"
                placeholder={t('common.name')}
                aria-label={t('library.sidebar.playlistName')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={closeNaming}
                onKeyDown={(e) => e.key === 'Escape' && closeNaming()}
              />
            </form>
          ) : (
            <DropRow as="button" target={{ kind: 'newPlaylist' }} className="sb-item ghost" onClick={() => setNaming(true)}>
              <Plus />
              {t('library.playlist.new')}
            </DropRow>
          )}
        </div>
        {tags.length > 0 && (
          <div className="sb-section">
            <div className="sb-head">
              <div className="eyebrow">{t('library.sidebar.tags')}</div>
              {unpinned.length > fill && (
                <button type="button" className="sb-toggle" aria-label={t('library.sidebar.moreTags')} aria-expanded={tagsOpen} onClick={() => setTagsOpen(!tagsOpen)}>
                  {tagsOpen ? <ChevronDown /> : <ChevronRight />}
                </button>
              )}
            </div>
            {pinned.map(tagRow)}
            {unpinned.slice(0, fill).map(tagRow)}
            {tagsOpen && <div className="sb-pool disclosure-content">{unpinned.slice(fill).map(tagRow)}</div>}
          </div>
        )}
        <div className="sb-section sb-tree">
          <div className="eyebrow">{t('library.sidebar.folders')}</div>
          {pinnedFolderNodes.map((node) => <FolderRow key={`pin:${node.rootId}:${node.folder}`} node={node} depth={0} pinnedCopy server={roots.find((r) => r.id === node.rootId)?.kind !== 'folder'} />)}
          {folders.map((node) => (
            <FolderRow key={`${node.rootId}:${node.folder}`} node={node} depth={0} server={roots.find((r) => r.id === node.rootId)?.kind !== 'folder'} />
          ))}
          {!source && (
            <button type="button" className="sb-item ghost" onClick={() => void addRoot()}>
              <FolderPlus />
              {t('library.sidebar.addFolder')}
            </button>
          )}
          {!source && (
            <button type="button" className="sb-item ghost" onClick={() => setAddingServer(true)}>
              <Server />
              {t('library.server.add')}
            </button>
          )}
          <ServerDialog open={addingServer} onOpenChange={setAddingServer} />
        </div>
        <SidebarProgress />
      </aside>
    </>
  )
}

function SidebarProgress() {
  const t = useT()
  const progress = useLibrary((s) => s.progress)
  return <>        {(progress.scanning || progress.thumbsPending > 0 || progress.tagsPending > 0) && (
          <div className="sb-foot">
            <div className="sb-foot-row">
              <span>{progress.scanning ? t('library.sidebar.scanning') : progress.thumbsPending > 0 ? t('library.sidebar.thumbnails') : t('library.sidebar.tagging')}</span>
              <span className="mono">{progress.scanning ? `${progress.done} / ${progress.total}` : progress.thumbsPending > 0 ? progress.thumbsPending : progress.tagsPending}</span>
            </div>
            <div className="sb-bar">
              <i style={{ width: progress.scanning && progress.total > 0 ? `${(progress.done / progress.total) * 100}%` : '100%' }} />
            </div>
          </div>
        )}</>
}

const FolderRow = memo(function FolderRow({ node, depth, server, pinnedCopy = false }: { node: FolderNode; depth: number; server: boolean; pinnedCopy?: boolean }) {
  const t = useT()
  const folder = useLibrary((s) => s.folder)
  const setFolder = useLibrary((s) => s.setFolder)
  const root = useLibrary((s) => (depth === 0 ? s.roots.find((r) => r.id === node.rootId) : undefined))
  const [open, setOpen] = useState(depth === 0)
  const on = folder?.rootId === node.rootId && folder.folder === node.folder
  const source = useRemote((s) => s.status.source)
  const pinnedFolders = useSettings((s) => s.settings?.library.pinnedFolders)
  const pinned = pinnedFolders?.includes(sidebarKey(source, node.rootId, node.folder)) ?? false
  const hasChildren = node.children.some((child) => child.excluded || !pinnedFolders?.includes(sidebarKey(source, child.rootId, child.folder)))
  if (pinned && !pinnedCopy && !node.excluded) return null
  return (
    <>
      <DropRow
        contextMenu
        as="div"
        target={
          node.excluded || server
            ? null
            : {
                kind: 'folder',
                folder: { rootId: node.rootId, folder: node.folder },
              }
        }
        className={cx('sb-item sb-folder', on && 'on', node.excluded && 'excluded')}
        style={{ paddingLeft: 18 + depth * 16 }}
        title={root?.error || undefined}
      >
        <button type="button" className="chev" aria-label={open ? t('common.collapse') : t('common.expand')} disabled={!hasChildren} onClick={() => setOpen(!open)}>
          {hasChildren ? open ? <ChevronDown /> : <ChevronRight /> : <span className="chev-gap" />}
        </button>
        <button type="button" className="sb-fill" disabled={node.excluded} onClick={() => setFolder({ rootId: node.rootId, folder: node.folder })}>
          {node.excluded ? <EyeOff /> : pinnedCopy ? <Pin /> : server ? <Server /> : open && hasChildren ? <FolderOpen /> : <Folder />}
          <span className="sb-name">{node.name}</span>
          {!node.excluded && <span className={cx('n', root?.error && 'sb-err')}>{root?.error ? '!' : node.count}</span>}
        </button>
        <FolderMenu node={node} server={server} />
      </DropRow>
      {open && node.children.map((c) => <FolderRow key={`${c.rootId}:${c.folder}`} node={c} depth={depth + 1} server={server} />)}
    </>
  )
})

function DropRow({
  as,
  target,
  className,
  children,
  contextMenu = false,
  ...rest
}: {
  as: 'div' | 'button'
  contextMenu?: boolean
  draggable?: boolean
  onDragStart?: DragEventHandler<HTMLElement>
  onDragOver?: DragEventHandler<HTMLElement>
  onDragLeave?: DragEventHandler<HTMLElement>
  onDrop?: DragEventHandler<HTMLElement>
  onDragEnd?: DragEventHandler<HTMLElement>
  target: DropTarget | null
  className?: string
  style?: CSSProperties
  title?: string
  onClick?: () => void
  children: ReactNode
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const show = (rect: DOMRect, anchor: HTMLElement) => { setRect(rect); setAnchor(anchor); setMenuOpen(true) }
  const key = target ? dropKey(target) : null
  const over = useSelect((s) => key !== null && s.dropTarget === key)
  const props = {
    className: cx(className, over && 'drop'),
    'data-drop': key ?? undefined,
    ...rest,
  }
  return as === 'button' ? (
    <button type="button" {...props}>
      {children}
    </button>
  ) : (
    <RowMenuContext.Provider value={{ open: menuOpen, onOpenChange: setMenuOpen, rect, anchor, show }}>
      <div
        {...props}
        onContextMenu={contextMenu ? (event) => {
          if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
          event.preventDefault()
          event.stopPropagation()
          show(new DOMRect(event.clientX, event.clientY, 0, 0), event.currentTarget.querySelector<HTMLButtonElement>('.sb-more') ?? event.currentTarget)
        } : undefined}
      >
        {children}
      </div>
    </RowMenuContext.Provider>
  )
}

function SidebarMenu({ name, children, onClose }: { name: string; children: ReactNode | (() => ReactNode); onClose?: () => void }) {
  const t = useT()
  const menu = useContext(RowMenuContext)
  if (!menu) return null
  return <DropdownMenu.Root open={menu.open} onOpenChange={menu.onOpenChange}>
    <IconButton label={t('library.options', { name })} size="sm" className="sb-more" aria-haspopup="menu" aria-expanded={menu.open} data-state={menu.open ? 'open' : 'closed'}
      onClick={(event) => menu.show(event.currentTarget.getBoundingClientRect(), event.currentTarget)}><Ellipsis /></IconButton>
    <DropdownMenu.Trigger asChild><span className="menu-anchor" tabIndex={-1} aria-hidden style={menu.rect ? { left: menu.rect.left, top: menu.rect.top, width: menu.rect.width, height: menu.rect.height } : undefined} /></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="menu" align="start" sideOffset={menu.rect?.width === 0 ? 0 : 4} collisionPadding={8}
      onCloseAutoFocus={(event) => { event.preventDefault(); menu.anchor?.focus(); onClose?.() }}>{menu.open ? typeof children === 'function' ? children() : children : null}</DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}

function OrderActions({ hidden, first, last, onPin, onMove, onToggle }: { hidden: boolean; first: boolean; last: boolean; onPin: () => void; onMove: (delta: number) => void; onToggle: () => void }) {
  const t = useT()
  return <>
    {!hidden && <>
      <DropdownMenu.Item className="item" disabled={first} onSelect={onPin}><Pin />{t('library.tag.pin')}</DropdownMenu.Item>
      <DropdownMenu.Item className="item" disabled={first} onSelect={() => onMove(-1)}><ArrowUp />{t('library.sidebar.moveUp')}</DropdownMenu.Item>
      <DropdownMenu.Item className="item" disabled={last} onSelect={() => onMove(1)}><ArrowDown />{t('library.sidebar.moveDown')}</DropdownMenu.Item>
    </>}
    <DropdownMenu.Item className="item" onSelect={onToggle}>{hidden ? <Plus /> : <EyeOff />}{t(hidden ? 'library.sidebar.show' : 'library.sidebar.hide')}</DropdownMenu.Item>
  </>
}

function TagMenu({ name, count, pinned, onTogglePin }: { name: string; count: number; pinned: boolean; onTogglePin: () => void }) {
  const t = useT()
  const renameTag = useLibrary((s) => s.renameTag)
  const deleteTag = useLibrary((s) => s.deleteTag)
  const updateSettings = useSettings((s) => s.update)
  const [ask, setAsk] = useState<'rename' | 'delete' | null>(null)
  const onRename = (to: string) =>
    void renameTag(name, to).then((renamed) => {
      if (pinned && renamed !== name)
        void updateSettings((s) => ({ ...s, library: { ...s.library, pinnedTags: s.library.pinnedTags.map((t) => (t === name ? renamed : t)) } }))
    })
  const onDelete = () => {
    if (pinned) onTogglePin()
    void deleteTag(name)
  }
  return (
    <>
      <SidebarMenu name={name}>
        <DropdownMenu.Item className="item" onSelect={onTogglePin}>
          {pinned ? <PinOff /> : <Pin />}
          {pinned ? t('library.tag.unpin') : t('library.tag.pin')}
        </DropdownMenu.Item>
        <DropdownMenu.Item className="item" onSelect={() => setAsk('rename')}>
          <Pencil />
          {t('common.rename')}
        </DropdownMenu.Item>
        <DropdownMenu.Item className="item danger" onSelect={() => setAsk('delete')}>
          <Trash2 />
          {t('common.delete')}
        </DropdownMenu.Item>
      </SidebarMenu>
      <Prompt
        open={ask === 'rename'}
        onOpenChange={() => setAsk(null)}
        title={t('library.tag.renameTitle', { name })}
        placeholder={t('library.tag.placeholder')}
        defaultValue={name}
        confirmLabel={t('common.rename')}
        onConfirm={onRename}
      />
      <Prompt
        open={ask === 'delete'}
        onOpenChange={() => setAsk(null)}
        title={t('library.tag.deleteTitle', { name })}
        body={t('library.tag.deleteBody', { count })}
        confirmLabel={t('common.delete')}
        danger
        onConfirm={onDelete}
      />
    </>
  )
}

type Ask = 'tag' | 'playlist' | 'remove' | 'exclude'

const EMPTY_TAGS: TagRow[] = []

function FolderMenu({ node, server }: { node: FolderNode; server: boolean }) {
  const t = useT()
  const menu = useContext(RowMenuContext)
  const source = useRemote((s) => s.status.source)
  const pinKey = sidebarKey(source, node.rootId, node.folder)
  const pinned = useSettings((s) => s.settings?.library.pinnedFolders.includes(pinKey) ?? false)
  const updateSettings = useSettings((s) => s.update)
  const togglePin = () => void updateSettings((s) => ({ ...s, library: { ...s.library, pinnedFolders: s.library.pinnedFolders.includes(pinKey) ? s.library.pinnedFolders.filter((key) => key !== pinKey) : [...s.library.pinnedFolders, pinKey] } }))
  const isStash = useLibrary((s) => s.roots.some((root) => root.id === node.rootId && root.kind === 'stash'))
  const [importingGroups, setImportingGroups] = useState(false)
  const [groupResult, setGroupResult] = useState('')
  useEffect(() => {
    if (menu?.open) setGroupResult('')
  }, [menu?.open])
  const [tagsOpen, setTagsOpen] = useState(false)
  const [ask, setAsk] = useState<Ask | null>(null)
  const tags = useLibrary((s) => tagsOpen || ask === 'tag' ? s.tags : EMPTY_TAGS)
  const playlists = useLibrary((s) => s.playlists)
  const tagFolder = useLibrary((s) => s.tagFolder)
  const addFolderToPlaylist = useLibrary((s) => s.addFolderToPlaylist)
  const createPlaylist = useLibrary((s) => s.createPlaylist)
  const removeRoot = useLibrary((s) => s.removeRoot)
  const excludeFolder = useLibrary((s) => s.excludeFolder)
  const includeFolder = useLibrary((s) => s.includeFolder)
  const folder: NonNullable<MediaQuery['folder']> = { rootId: node.rootId, folder: node.folder }
  const isRoot = node.folder === ''
  const videos = t('library.videos', { count: node.count })
  if (node.excluded) {
    return (
      <SidebarMenu name={node.name}>{() => <>
        <DropdownMenu.Item className="item" onSelect={() => void includeFolder(folder)}>
          <Undo2 />
          {t('library.folder.includeInLibrary')}
        </DropdownMenu.Item>
      </>}</SidebarMenu>
    )
  }

  return (
    <>
      <SidebarMenu name={node.name}>{() => <>
        <DropdownMenu.Item className="item" onSelect={togglePin}>{pinned ? <PinOff /> : <Pin />}{t(pinned ? 'library.tag.unpin' : 'library.tag.pin')}</DropdownMenu.Item>
        <DropdownMenu.Separator className="sep" />
        <DropdownMenu.Sub open={tagsOpen} onOpenChange={setTagsOpen}>
          <DropdownMenu.SubTrigger className="item">
            <Tag />
            {t('library.tag.add')}
            <ChevronRight className="right" />
          </DropdownMenu.SubTrigger>
          <DropdownMenu.Portal>
            <DropdownMenu.SubContent className="menu" sideOffset={6}>
              {tagsOpen && tags.map(({ name }) => (
                <DropdownMenu.Item key={name} className="item" onSelect={() => void tagFolder(folder, name)}>
                  {name}
                </DropdownMenu.Item>
              ))}
              {tags.length > 0 && <DropdownMenu.Separator className="sep" />}
              <DropdownMenu.Item className="item" onSelect={() => setAsk('tag')}>
                <Plus />
                {t('library.tag.new')}
              </DropdownMenu.Item>
            </DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger className="item">
            <ListVideo />
            {t('library.folder.addToPlaylist')}
            <ChevronRight className="right" />
          </DropdownMenu.SubTrigger>
          <DropdownMenu.Portal>
            <DropdownMenu.SubContent className="menu" sideOffset={6}>
              {playlists.map((p) => (
                <DropdownMenu.Item key={p.id} className="item" onSelect={() => void addFolderToPlaylist(p.id, folder)}>
                  {p.name}
                </DropdownMenu.Item>
              ))}
              {playlists.length > 0 && <DropdownMenu.Separator className="sep" />}
              <DropdownMenu.Item className="item" onSelect={() => setAsk('playlist')}>
                <Plus />
                {t('library.playlist.new')}
              </DropdownMenu.Item>
            </DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
        <DropdownMenu.Separator className="sep" />
        {server && (
          <DropdownMenu.Item className="item" onSelect={() => void invoke('library:scan', node.rootId)}>
            <RefreshCw />
            {t('library.folder.syncNow')}
          </DropdownMenu.Item>
        )}
        {isRoot && isStash && (
          <DropdownMenu.Item className="item" disabled={importingGroups} onSelect={(event) => {
            event.preventDefault()
            setImportingGroups(true)
            setGroupResult('')
            void invoke('library:importStashGroups', node.rootId).then((result) => {
              setGroupResult(result.skipped ? t('library.folder.importedSkipped', { count: result.created + result.updated, skipped: result.skipped }) : t('library.folder.imported', { count: result.created + result.updated }))
            }).catch((error: unknown) => setGroupResult(ipcMessage(error))).finally(() => setImportingGroups(false))
          }}>
            <ListVideo />
            <span role="status">{importingGroups ? t('library.folder.importingGroups') : groupResult || t('library.folder.importGroups')}</span>
          </DropdownMenu.Item>
        )}
        {isRoot ? (
          <DropdownMenu.Item className="item danger" onSelect={() => setAsk('remove')}>
            <Trash2 />
            {t('library.folder.removeFromLibrary')}
          </DropdownMenu.Item>
        ) : (
          <DropdownMenu.Item className="item" onSelect={() => setAsk('exclude')}>
            <EyeOff />
            {t('library.folder.excludeFromLibrary')}
          </DropdownMenu.Item>
        )}
      </>}</SidebarMenu>
      <Prompt
        open={ask === 'tag'}
        onOpenChange={() => setAsk(null)}
        title={t('library.folder.tagTitle', { videos, name: node.name })}
        placeholder={t('library.tag.placeholder')}
        suggestions={ask === 'tag' ? tags.map((tag) => tag.name) : undefined}
        confirmLabel={t('library.tag.add')}
        onConfirm={(tag) => void tagFolder(folder, tag.toLowerCase())}
      />
      <Prompt
        open={ask === 'playlist'}
        onOpenChange={() => setAsk(null)}
        title={t('library.folder.newPlaylistTitle', { videos, name: node.name })}
        placeholder={t('common.name')}
        confirmLabel={t('common.create')}
        onConfirm={(name) => void createPlaylist(name).then((p) => addFolderToPlaylist(p.id, folder))}
      />
      <Prompt
        open={ask === 'remove'}
        onOpenChange={() => setAsk(null)}
        title={t('library.folder.removeTitle', { name: node.name })}
        body={t(server ? 'library.folder.removeServerBody' : 'library.folder.removeFolderBody', { videos })}
        confirmLabel={t('common.remove')}
        danger
        onConfirm={() => void removeRoot(node.rootId)}
      />
      <Prompt
        open={ask === 'exclude'}
        onOpenChange={() => setAsk(null)}
        title={t('library.folder.excludeTitle', { name: node.name })}
        body={t('library.folder.excludeBody', { videos })}
        confirmLabel={t('library.folder.exclude')}
        onConfirm={() => void excludeFolder(folder)}
      />
    </>
  )
}
