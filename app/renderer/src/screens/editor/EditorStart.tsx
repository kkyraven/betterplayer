import { ChevronDown, ChevronRight, Film, Folder, FolderOpen, History, Library, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { EditorFile, EditorFilePage } from '@shared/editor'
import type { FolderNode } from '@shared/library'
import { Button } from '@/components/ui/Button'
import { invoke, on } from '@/ipc'
import { cx } from '@/lib/cx'
import { fmtDuration, fmtWhen } from '@/lib/format'
import { useEditor } from '@/state/editor'
import { useT } from '@/state/i18n'
import './EditorStart.css'

type Source = 'recent' | 'library' | FolderNode
const EMPTY_PAGE: EditorFilePage = { files: [], hasMore: false }

function FolderBranch({ folder, source, select, depth = 0 }: { folder: FolderNode; source: Source; select: (source: Source) => void; depth?: number }) {
  const [expanded, setExpanded] = useState(depth === 0)
  if (folder.excluded) return null
  const selected = typeof source === 'object' && source.rootId === folder.rootId && source.folder === folder.folder
  const children = folder.children.filter((child) => !child.excluded)
  return (
    <li>
      <div className={cx('ed-start-folder', selected && 'on')} style={{ paddingInlineStart: 12 + depth * 14 }}>
        {children.length > 0 ? <button type="button" className="ed-start-expand" aria-label={folder.name} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronDown /> : <ChevronRight />}</button> : <span className="ed-start-expand" />}
        <button type="button" className="ed-start-folder-name" title={folder.name} aria-current={selected ? 'page' : undefined} onClick={() => select(folder)}><Folder /><span>{folder.name}</span></button>
      </div>
      {expanded && children.length > 0 && <ul>{children.map((child) => <FolderBranch key={child.folder} folder={child} source={source} select={select} depth={depth + 1} />)}</ul>}
    </li>
  )
}

function FileRow({ file, disabled }: { file: EditorFile; disabled: boolean }) {
  const t = useT()
  const axis = file.axes[0]
  const script = file.draft ? t('editor.draft.title') : file.saved ? t('editor.start.savedScript') : file.axes.length > 1 ? t('editor.start.axes', { count: file.axes.length }) : axis ? t(`axis.${axis}`) : t('media.noScript')
  return (
    <tr>
      <td>
        <button type="button" className="ed-start-file" disabled={disabled} title={file.path} onClick={() => void useEditor.getState().openEditor(file.path)}>
          <span className="ed-start-file-icon"><Film /></span>
          <span className="ed-start-file-label"><strong>{file.title}</strong><small>{file.folder}</small></span>
        </button>
      </td>
      <td className={cx((file.saved || file.draft || axis) && 'script')}>{script}</td>
      <td>{file.editedAt === null ? t('editor.start.notEdited') : <time dateTime={new Date(file.editedAt).toISOString()} title={new Date(file.editedAt).toLocaleString()}>{fmtWhen(file.editedAt)}</time>}</td>
      <td>{file.durationMs && file.durationMs > 0 ? fmtDuration(file.durationMs) : ''}</td>
    </tr>
  )
}

export function EditorStart() {
  const t = useT()
  const openingFile = useEditor((s) => s.openingFile)
  const message = useEditor((s) => s.message)
  const [source, setSource] = useState<Source>('recent')
  const [folders, setFolders] = useState<FolderNode[]>([])
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState(EMPTY_PAGE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [folderError, setFolderError] = useState(false)
  const [revision, setRevision] = useState(0)
  const [picking, setPicking] = useState(false)
  const mounted = useRef(false)
  const scroll = useRef<HTMLDivElement>(null)
  const busy = picking || openingFile !== null
  const heading = typeof source === 'object' ? source.name : t(source === 'recent' ? 'editor.start.recent' : 'editor.start.library')

  useEffect(() => {
    mounted.current = true
    const unsubscribe = on('library:changed', (change) => {
      if (change.kind === 'thumbs' || change.kind === 'tags') return
      setOffset(0)
      setRevision((value) => value + 1)
    })
    return () => { mounted.current = false; unsubscribe() }
  }, [])

  useEffect(() => {
    let disposed = false
    setFolderError(false)
    void invoke('editor:folders').then((next) => { if (!disposed) setFolders(next) }).catch(() => { if (!disposed) setFolderError(true) })
    return () => { disposed = true }
  }, [revision])

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError(false)
    const timer = window.setTimeout(() => {
      void invoke('editor:files', {
        source: source === 'recent' ? 'recent' : 'library',
        folder: typeof source === 'object' ? { rootId: source.rootId, folder: source.folder } : undefined,
        search,
        offset,
      }).then((next) => {
        if (!disposed) setPage((prev) => ({ files: offset === 0 ? next.files : [...prev.files, ...next.files], hasMore: next.hasMore }))
      }).catch(() => { if (!disposed) setError(true) }).finally(() => { if (!disposed) setLoading(false) })
    }, search ? 150 : 0)
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [source, search, offset, revision])

  const reset = () => {
    setOffset(0)
    setPage(EMPTY_PAGE)
    setLoading(true)
    setError(false)
    scroll.current?.scrollTo(0, 0)
  }
  const select = (next: Source) => {
    if (source === next && !search) return
    reset()
    setSource(next)
    setSearch('')
  }
  const retry = () => { reset(); setRevision((value) => value + 1) }
  const pickFile = async () => {
    setPicking(true)
    useEditor.getState().setMessage(null)
    try {
      const path = await invoke('dialog:openVideo')
      if (mounted.current && path) await useEditor.getState().openEditor(path)
    } catch {
      if (mounted.current) useEditor.getState().setMessage(t('editor.start.openFailed'))
    } finally {
      if (mounted.current) setPicking(false)
    }
  }

  return (
    <div className="ed-start">
      <aside className="side-list ed-start-side">
        <h1>{t('utilities.scriptEditor')}</h1>
        <Button variant="primary" className="ed-start-open" disabled={busy} onClick={() => void pickFile()}><FolderOpen />{t('editor.start.openFile')}</Button>
        <nav aria-label={t('utilities.scriptEditor')}>
          <button type="button" className={cx('side-row', source === 'recent' && 'on')} aria-current={source === 'recent' ? 'page' : undefined} onClick={() => select('recent')}><History />{t('editor.start.recent')}</button>
          <button type="button" className={cx('side-row', source === 'library' && 'on')} aria-current={source === 'library' ? 'page' : undefined} onClick={() => select('library')}><Library />{t('editor.start.library')}</button>
          <h2>{t('library.sidebar.folders')}</h2>
          {folderError ? (
            <div className="ed-start-folder-error">
              <span role="alert">{t('editor.start.unavailable')}</span>
              <Button variant="ghost" onClick={retry}>{t('common.retry')}</Button>
            </div>
          ) : <ul>{folders.map((folder) => <FolderBranch key={folder.rootId} folder={folder} source={source} select={select} />)}</ul>}
        </nav>
      </aside>
      <section className="ed-start-content" aria-label={heading}>
        <header className="ed-start-header">
          <h2>{heading}</h2>
          <label className="ed-start-search">
            <Search />
            <input type="search" aria-label={t('editor.start.find')} placeholder={t('editor.start.find')} value={search} onChange={(event) => { reset(); setSearch(event.target.value) }} />
          </label>
        </header>
        {message && <p className="ed-start-error" role="alert">{message}</p>}
        {openingFile && <p className="ed-start-notice" role="status">{t('editor.start.opening')}<Button variant="ghost" onClick={() => useEditor.getState().close()}>{t('common.cancel')}</Button></p>}
        <div className="ed-start-scroll" ref={scroll} aria-busy={loading}>
          {page.files.length > 0 && (
            <table className="ed-start-table">
              <thead><tr>
                <th scope="col">{t('library.sort.name')}</th>
                <th scope="col">{t('library.filter.script')}</th>
                <th scope="col">{t('editor.start.edited')}</th>
                <th scope="col">{t('library.sort.duration')}</th>
              </tr></thead>
              <tbody>{page.files.map((file) => <FileRow key={file.path} file={file} disabled={busy} />)}</tbody>
            </table>
          )}
          {error ? (
            <div className="ed-start-empty"><p role="alert">{t('editor.start.unavailable')}</p><Button onClick={retry}>{t('common.retry')}</Button></div>
          ) : loading ? (
            <div className="ed-start-empty" role="status">{t('library.empty.loading')}</div>
          ) : page.files.length === 0 ? (
            <div className="ed-start-empty">
              {source === 'recent' ? <History /> : <Library />}
              <p>{search ? t('editor.shortcuts.noMatches') : source === 'recent' ? t('editor.start.noRecent') : t('library.empty.nothing')}</p>
            </div>
          ) : page.hasMore && (
            <Button className="ed-start-more" onClick={() => { setLoading(true); setOffset(page.files.length) }}>{t('editor.start.more')}</Button>
          )}
        </div>
      </section>
    </div>
  )
}
