import { ArrowLeft, Copy, Download, ExternalLink, FileArchive, FileJson2, FileQuestion, FileVideoCamera, FolderOpen, MoreHorizontal } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { EroSource, EroTopic } from '@shared/eroscripts'
import type { DownloadDestination, DownloadFile } from '@shared/downloads'
import { DestinationPicker, rootName } from '@/components/downloads/DestinationPicker'
import { Button } from '@/components/ui/Button'
import { invoke } from '@/ipc'
import { electron } from '@/node'
import { useBrowser } from '@/state/browser'
import { useDownloads } from '@/state/downloads'
import { useLibrary } from '@/state/library'
import { useT } from '@/state/i18n'
import { distinctTopicFiles, initialTopicSelection, topicFileSources, topicSourceJob, topicSourcesJob } from './topicSelection'

export function TopicFiles({ topic, related, active = true }: { topic: EroTopic; related: boolean; active?: boolean }) {
  const t = useT()
  const batches = useDownloads((state) => state.state.batches)
  const destination = useDownloads((state) => state.destination)
  const roots = useLibrary((state) => state.roots)
  const enqueue = useDownloads((state) => state.enqueue)
  const error = useDownloads((state) => state.error)
  const [selected, setSelected] = useState(() => initialTopicSelection(topic.sources))
  const [chooseFolder, setChooseFolder] = useState(false)
  const [pending, setPending] = useState<{ sourceIds: string[]; again?: boolean } | null>(null)
  const [starting, setStarting] = useState(false)
  const [folderFocus, setFolderFocus] = useState(0)
  const busy = useRef(false)
  const folderButton = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const group = useId()
  const root = roots.find((root) => root.id === destination?.rootId && root.kind === 'folder')
  const files = distinctTopicFiles(topic.sources)
  const videos = files.filter((source) => source.kind === 'video')
  const scripts = files.filter((source) => source.kind === 'script')
  const others = files.filter((source) => source.kind === 'archive' || source.kind === 'unknown')
  useEffect(() => { setSelected((ids) => ids.filter((id) => topic.sources.some((source) => source.id === id))) }, [topic.sources])
  const start = async (sourceIds: string[], again?: boolean, chosen = destination) => {
    if (!sourceIds.length || busy.current) return
    if (!chosen || !useLibrary.getState().roots.some((root) => root.id === chosen.rootId && root.kind === 'folder')) {
      setPending({ sourceIds: [...sourceIds], again })
      setChooseFolder(true)
      return
    }
    busy.current = true
    setStarting(true)
    try {
      const id = await enqueue({ tabId: topic.tabId, generation: topic.generation, sourceIds, destination: { ...chosen }, again })
      if (id) useDownloads.getState().setManagerOpen(true)
      setPending(null)
    } finally {
      busy.current = false
      setStarting(false)
    }
  }
  useLayoutEffect(() => {
    if (folderFocus > 0) (folderButton.current ?? panel.current?.querySelector<HTMLButtonElement>('.ero-download-selected'))?.focus()
  }, [folderFocus])
  useLayoutEffect(() => {
    if (chooseFolder) panel.current?.querySelector<HTMLSelectElement>('.download-destination select')?.focus()
  }, [chooseFolder])
  const focusFolder = () => setFolderFocus((request) => request + 1)
  const choose = (next: DownloadDestination) => {
    setChooseFolder(false)
    if (pending) void start(pending.sourceIds, pending.again, next)
    else focusFolder()
  }
  const toggle = (id: string) => setSelected((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id])
  const selectVideo = (id: string) => setSelected((ids) => [...ids.filter((value) => !videos.some((source) => source.id === value)), ...(id ? [id] : [])])
  const videoId = selected.find((id) => videos.some((source) => source.id === id)) ?? ''
  const back = async () => {
    if (useBrowser.getState().tabs.some((tab) => tab.id === topic.tabId)) await useBrowser.getState().activate(topic.tabId)
    else await useBrowser.getState().open(topic.url)
  }
  const openPost = async (postNumber: number) => {
    const url = new URL(topic.url)
    const path = url.pathname.match(/^(\/t\/(?:[^/]+\/)?\d+)/)?.[1]
    if (!path) return
    url.pathname = `${path}/${postNumber}`
    if (useBrowser.getState().tabs.some((tab) => tab.id === topic.tabId)) {
      await useBrowser.getState().activate(topic.tabId)
      await useBrowser.getState().navigate(url.href)
    } else await useBrowser.getState().open(url.href)
  }
  const choice = (source: EroSource) => {
    const sources = topicFileSources(source, topic.sources)
    const name = source.fileName ?? source.label
    const work = topicSourcesJob(topic, sources, batches)
    return (
      <div className="ero-file-entry" key={source.id}>
        <label className="ero-file-choice">
          <input type={source.kind === 'video' ? 'radio' : 'checkbox'} name={source.kind === 'video' ? group : undefined} checked={selected.includes(source.id)} disabled={starting} onChange={() => source.kind === 'video' ? selectVideo(source.id) : toggle(source.id)} />
          <FileIcon source={source} />
          <span className="ero-file-identity"><strong title={name}>{name}</strong><span className="ero-file-meta">{work?.file.host ?? source.host}{work && <span>{t(`downloads.phase.${work.file.phase}`)}</span>}</span></span>
        </label>
        <details className="ero-file-sources"><summary>{t('downloads.sources')}{sources.length > 1 && <span>{sources.length}</span>}</summary>{sources.map((entry) => {
          const job = topicSourceJob(topic, entry, batches)
          return <SourceRow key={entry.id} source={entry} job={job?.file} destinationName={job?.destinationName} onDownload={(again) => void start([entry.id], again)} onPost={() => void openPost(entry.postNumber)} disabled={starting} active={active} />
        })}</details>
      </div>
    )
  }
  return (
    <section ref={panel} className="ero-files" aria-labelledby="ero-topic-heading" onKeyDown={(event) => {
      if (active && event.key === 'Escape' && chooseFolder) {
        event.preventDefault()
        event.stopPropagation()
        setChooseFolder(false)
        setPending(null)
        focusFolder()
      }
    }}>
      <div className="ero-files-content">
        <div className="ero-topic-heading"><h3 id="ero-topic-heading" className="ero-topic-title">{topic.title}</h3><Button variant="ghost" icon aria-label={t('eroscripts.backToTopic')} title={t('eroscripts.backToTopic')} onClick={() => void back()}>{related ? <ArrowLeft /> : <ExternalLink />}</Button></div>
        {videos.length > 0 && <fieldset className="ero-file-selection"><legend>{t('eroscripts.video')}</legend>{videos.map(choice)}<label className="ero-no-video"><input type="radio" name={group} checked={!videoId} disabled={starting} onChange={() => selectVideo('')} />{t('eroscripts.noVideo')}</label></fieldset>}
        {scripts.length > 0 && <fieldset className="ero-file-selection"><legend>{t('eroscripts.scripts')}</legend>{scripts.map(choice)}</fieldset>}
        {others.length > 0 && <details className="ero-other-files"><summary>{t('eroscripts.otherFiles')}<span>{others.length}</span></summary>{others.map(choice)}</details>}
        <p className="ero-scope">{t('eroscripts.loadedPosts')}</p>
      </div>
      <footer className="ero-files-footer">
        {error && <p className="ero-error" role="alert">{error}</p>}
        {chooseFolder || !root ? <DestinationPicker onChoose={choose} /> : <div className="ero-destination"><FolderOpen /><span title={destination?.relativePath ? `${rootName(root)}/${destination.relativePath}` : root.path}>{rootName(root)}{destination?.relativePath && `/${destination.relativePath}`}</span><button ref={folderButton} type="button" aria-expanded={chooseFolder} onClick={() => { setPending(null); setChooseFolder(true) }}>{t('downloads.changeFolder')}</button></div>}
        <Button variant="primary" className="ero-download-selected" disabled={selected.length === 0 || starting} onClick={() => void start(selected)}><Download />{starting ? t('downloads.phase.resolving') : root ? t('downloads.download') : t('downloads.chooseFolder')}<span>{selected.length === 1 ? t('downloads.oneFile') : t('downloads.fileCount', { count: selected.length })}</span></Button>
      </footer>
    </section>
  )
}

function FileIcon({ source }: { source: EroSource }) {
  if (source.kind === 'video') return <FileVideoCamera aria-hidden />
  if (source.kind === 'script') return <FileJson2 aria-hidden />
  if (source.kind === 'archive') return <FileArchive aria-hidden />
  return <FileQuestion aria-hidden />
}

function SourceRow({ source, job, destinationName, onDownload, onPost, disabled, active }: { source: EroSource; job: DownloadFile | undefined; destinationName: string | undefined; onDownload: (again?: boolean) => void; onPost: () => void; disabled: boolean; active: boolean }) {
  const t = useT()
  const command = useDownloads((state) => state.command)
  const setOpen = useDownloads((state) => state.setManagerOpen)
  const [menu, setMenu] = useState(false)
  const options = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const jobActive = job && !['complete', 'cancelled', 'failed'].includes(job.phase)
  const closeMenu = () => { setMenu(false); options.current?.focus() }
  useEffect(() => { if (!active) setMenu(false) }, [active])
  useEffect(() => { if (active && menu) menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [active, menu])
  useEffect(() => {
    if (!active || !menu) return
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
    }
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !row.current?.contains(event.target)) setMenu(false)
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointerdown', pointer, true)
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', pointer, true) }
  }, [active, menu])
  return (
    <div className="ero-source" ref={row}>
      <div className="ero-source-main"><strong>{source.host}</strong><button className="ero-source-post" type="button" onClick={onPost}>{t('eroscripts.post', { number: source.postNumber })}</button>
        <Button variant="ghost" disabled={disabled} onClick={(event) => {
          if (job?.phase === 'failed') void command('retry', job.id)
          else if (job?.canContinue) void command('continue', job.id)
          else if (jobActive || job?.phase === 'complete') setOpen(true, event.currentTarget)
          else onDownload()
        }}>{job?.canContinue ? t('common.continue') : job?.phase === 'failed' ? t('common.retry') : jobActive || job?.phase === 'complete' ? t('downloads.title') : t('downloads.download')}</Button>
        <button ref={options} type="button" className="icon-btn icon-btn-sm" aria-label={`${t('eroscripts.sourceOptions')}: ${source.host}`} aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal /></button>
      </div>
      {job && destinationName && <p className="ero-source-destination">{destinationName}</p>}
      {job?.reason && <p className="download-file-reason">{job.reason}</p>}
      {menu && <div ref={menuRef} className="ero-source-menu">
        <Button variant="ghost" onClick={() => { closeMenu(); void invoke('browser:openSource', source.url) }}><ExternalLink />{t('eroscripts.openSource')}</Button>
        <Button variant="ghost" onClick={() => { electron.clipboard.writeText(source.url); closeMenu() }}><Copy />{t('eroscripts.copyLink')}</Button>
        {job?.phase === 'complete' && <Button variant="ghost" onClick={() => { closeMenu(); onDownload(true) }}><Download />{t('downloads.again')}</Button>}
      </div>}
    </div>
  )
}
