import { ArrowLeft, Check, ChevronDown, ChevronRight, CircleAlert, Copy, Download, ExternalLink, FileArchive, FileJson2, FileQuestion, FileVideoCamera, Folder, FolderOpen, Link, MoreHorizontal, Pause, Play, RotateCcw, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { EroSource, EroTopic } from '@shared/eroscripts'
import type { DownloadBatch, DownloadDestination, DownloadFile } from '@shared/downloads'
import { ArchiveControls } from '@/components/downloads/ArchiveControls'
import { archiveView, extractionProgress } from '@/components/downloads/archiveView'
import { matchVideo, openBatchLibrary, openBatchTopic, playMedia } from '@/components/downloads/batchActions'
import { DestinationPicker, rootName } from '@/components/downloads/DestinationPicker'
import { canCancelDownload, formatDownloadBytes, orderedBatches, summarizeFiles } from '@/components/downloads/downloadPresentation'
import { isTopicBatch } from '@/components/downloads/topicTab'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { invoke } from '@/ipc'
import { cx } from '@/lib/cx'
import { electron } from '@/node'
import { useBrowser } from '@/state/browser'
import { useDownloads } from '@/state/downloads'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { distinctTopicFiles, initialTopicSelection, scriptSets, topicFileSources, topicSourceJob, topicSourcesJob, type ScriptSet } from './topicSelection'

const TRANSFER: ReadonlySet<DownloadFile['phase']> = new Set(['queued', 'resolving', 'attempting', 'downloading', 'paused', 'verifying', 'extracting', 'staged', 'publishing', 'importing'])

export function TopicCard({ topic, related, hidden = false }: { topic: EroTopic; related: boolean; hidden?: boolean }) {
  const t = useT()
  const batches = useDownloads((state) => state.state.batches)
  const destination = useDownloads((state) => state.destination)
  const enqueue = useDownloads((state) => state.enqueue)
  const command = useDownloads((state) => state.command)
  const error = useDownloads((state) => state.error)
  const roots = useLibrary((state) => state.roots)
  const [initial] = useState(() => initialTopicSelection(topic.sources))
  const [selected, setSelected] = useState(initial)
  const [editing, setEditing] = useState(initial.length === 0)
  const [noVideo, setNoVideo] = useState(false)
  const [chooseFolder, setChooseFolder] = useState(false)
  const [pending, setPending] = useState<{ sourceIds: string[]; again?: boolean } | null>(null)
  const [starting, setStarting] = useState(false)
  const busy = useRef(false)
  const card = useRef<HTMLElement>(null)
  const folderButton = useRef<HTMLButtonElement>(null)
  const group = useId()
  const root = roots.find((entry) => entry.id === destination?.rootId && entry.kind === 'folder')

  const files = distinctTopicFiles(topic.sources)
  const videos = files.filter((source) => source.kind === 'video')
  const sets = scriptSets(files.filter((source) => source.kind === 'script'), videos)
  const others = files.filter((source) => source.kind === 'archive' || source.kind === 'unknown')
  const jobsByFile = new Map(files.map((file) => {
    const job = topicSourcesJob(topic, topicFileSources(file, topic.sources), batches)?.file
    return [file.id, job && job.phase !== 'cancelled' ? job : undefined] as const
  }))
  const jobOf = (file: EroSource) => jobsByFile.get(file.id)
  const shown = (file: EroSource) => selected.includes(file.id) || jobOf(file) !== undefined
  const videoRows = videos.filter(shown)
  const setRows = sets.map((set) => ({ set, scripts: set.scripts.filter((script) => shown(script.source)) })).filter((row) => row.scripts.length > 0)
  const otherRows = others.filter(shown)
  const rowFiles = [...videoRows, ...setRows.flatMap((row) => row.scripts.map((script) => script.source)), ...otherRows]
  const jobs = rowFiles.flatMap((file) => jobOf(file) ?? [])
  const toStart = selected.filter((id) => {
    const file = files.find((entry) => entry.id === id)
    return file !== undefined && jobOf(file) === undefined
  })
  const notices = jobs.filter((job) => job.phase === 'waiting' || job.phase === 'failed')
  const transferring = jobs.filter((job) => TRANSFER.has(job.phase))
  const done = jobs.length > 0 && jobs.every((job) => job.phase === 'complete')
  const batchOf = (job: DownloadFile) => batches.find((batch) => batch.id === job.batchId)
  const mediaId = jobs.find((job) => job.phase === 'complete' && job.mediaId !== null)?.mediaId ?? null
  const doneBatch = jobs[0] && batchOf(jobs[0])

  useEffect(() => { setSelected((ids) => ids.filter((id) => topic.sources.some((source) => source.id === id))) }, [topic.sources])
  const setTopicCard = useDownloads((state) => state.setTopicCard)
  useEffect(() => {
    setTopicCard({ tabId: topic.tabId, url: topic.url })
    return () => setTopicCard(null)
  }, [setTopicCard, topic.tabId, topic.url])
  useLayoutEffect(() => {
    if (chooseFolder) card.current?.querySelector<HTMLSelectElement>('.download-destination select')?.focus()
  }, [chooseFolder])

  const start = async (sourceIds: string[], again?: boolean, chosen = destination) => {
    if (!sourceIds.length || busy.current) return
    if (!chosen || !useLibrary.getState().roots.some((entry) => entry.id === chosen.rootId && entry.kind === 'folder')) {
      setPending({ sourceIds: [...sourceIds], again })
      setChooseFolder(true)
      return
    }
    busy.current = true
    setStarting(true)
    try {
      const id = await enqueue({ tabId: topic.tabId, generation: topic.generation, sourceIds, destination: { ...chosen }, again })
      if (id) {
        setPending(null)
        setEditing(false)
        card.current?.focus()
      }
    } finally {
      busy.current = false
      setStarting(false)
    }
  }
  const choose = (next: DownloadDestination) => {
    setChooseFolder(false)
    if (pending) void start(pending.sourceIds, pending.again, next)
    else folderButton.current?.focus()
  }
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
  const run = (action: 'pause' | 'resume' | 'cancel', when: (job: DownloadFile) => boolean) => {
    for (const job of transferring) if (when(job)) void command(action, job.id)
  }
  const pausable = (job: DownloadFile) => job.canPause && job.phase === 'downloading'
  const paused = (job: DownloadFile) => job.phase === 'paused'
  const toggle = (id: string) => setSelected((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id])
  const selectVideo = (id: string) => {
    setNoVideo(!id)
    setSelected((ids) => [...ids.filter((value) => !videos.some((video) => video.id === value)), ...(id ? [id] : [])])
  }
  const videoId = selected.find((id) => videos.some((video) => video.id === id)) ?? ''
  const canClose = selected.length > 0 || jobs.length > 0
  const hosts = (file: EroSource) => {
    const count = topicFileSources(file, topic.sources).length - 1
    return count > 0 ? t('eroscripts.mirrors', { host: file.host, count }) : file.host
  }
  const axisLabel = (script: ScriptSet['scripts'][number]) => script.variant ?? t(`axis.${script.axis}`)
  const sourceList = (list: EroSource[], named = false) => <SourceList sources={list} topic={topic} batches={batches} named={named} disabled={starting} onDownload={(id, again) => void start([id], again)} onPost={(post) => void openPost(post)} />

  return (
    <aside ref={card} tabIndex={-1} className="downloads-dock topic-card" hidden={hidden} aria-labelledby="topic-card-title" onKeyDown={(event) => {
      if (hidden || event.key !== 'Escape') return
      if (chooseFolder) { setChooseFolder(false); setPending(null); folderButton.current?.focus() }
      else if (editing && canClose) setEditing(false)
      else return
      event.preventDefault()
      event.stopPropagation()
    }}>
      <div className="topic-card-body">
        <div className="topic-card-heading">
          <h3 id="topic-card-title">{topic.title}</h3>
          {related && <IconButton size="sm" label={t('eroscripts.backToTopic')} onClick={() => void back()}><ArrowLeft /></IconButton>}
        </div>

        {!editing && notices.map((job) => <Notice key={job.id} job={job} batch={batchOf(job)} active={!hidden} onBackToTopic={related ? () => void back() : undefined} />)}

        {editing ? (
          <div className="topic-choose">
            {videos.length > 0 && <fieldset className="topic-choose-group"><legend>{t('eroscripts.video')}</legend>
              {videos.map((video) => <Option key={video.id} type="radio" name={group} checked={videoId === video.id} disabled={starting} onChange={() => selectVideo(video.id)} title={video.fileName ?? video.label} detail={hosts(video)} sources={sourceList(topicFileSources(video, topic.sources))} />)}
              <Option type="radio" name={group} checked={noVideo && !videoId} disabled={starting} onChange={() => selectVideo('')} title={t('eroscripts.noVideo')} />
            </fieldset>}
            {sets.length > 0 && <fieldset className="topic-choose-group"><legend>{t('eroscripts.scripts')}</legend>
              {sets.map((set) => <ScriptChips key={set.key} set={set} named={sets.length > 1} selected={selected} disabled={starting} label={axisLabel} onToggle={toggle} sources={sourceList(set.scripts.flatMap((script) => topicFileSources(script.source, topic.sources)), true)} />)}
            </fieldset>}
            {others.length > 0 && <fieldset className="topic-choose-group"><legend>{t('eroscripts.otherFiles')}</legend>
              {others.map((file) => <Option key={file.id} type="checkbox" checked={selected.includes(file.id)} disabled={starting} onChange={() => toggle(file.id)} title={file.fileName ?? file.label} detail={hosts(file)} sources={sourceList(topicFileSources(file, topic.sources))} />)}
            </fieldset>}
            <p className="topic-scope">{t('eroscripts.loadedPosts')}</p>
          </div>
        ) : (
          <div className="topic-summary" aria-live="polite">
            {videoRows.map((video) => <Row key={video.id} icon={<FileVideoCamera />} title={video.fileName ?? video.label} detail={hosts(video)} jobs={jobOf(video) ? [jobOf(video)!] : []} />)}
            {setRows.map(({ set, scripts }) => {
              const count = scripts.length === 1 ? t('eroscripts.oneScript') : t('eroscripts.scriptCount', { count: scripts.length })
              const axes = scripts.map(axisLabel).join(', ')
              return <Row key={set.key} icon={<FileJson2 />} title={setRows.length > 1 ? set.name : count} detail={setRows.length > 1 ? `${count} · ${axes}` : axes} jobs={scripts.flatMap((script) => jobOf(script.source) ?? [])} keepDetail />
            })}
            {otherRows.map((file) => <Row key={file.id} icon={file.kind === 'archive' ? <FileArchive /> : <FileQuestion />} title={file.fileName ?? file.label} detail={hosts(file)} jobs={jobOf(file) ? [jobOf(file)!] : []} />)}
          </div>
        )}

        <div className="topic-card-foot">
          {toStart.length > 0 || !jobs.length
            ? <button ref={folderButton} type="button" className="topic-folder" aria-expanded={chooseFolder} disabled={starting} onClick={() => { setPending(null); setChooseFolder(!chooseFolder) }}>
              <Folder />{root ? <span>{rootName(root)}{destination?.relativePath && `/${destination.relativePath}`}</span> : <span>{t('downloads.chooseFolder')}</span>}<ChevronDown />
            </button>
            : <span className="topic-folder topic-folder-fixed"><Folder /><span>{doneBatch?.destinationName}</span></span>}
          {!editing && <Button variant="ghost" onClick={() => setEditing(true)}><SlidersHorizontal />{t('eroscripts.change')}</Button>}
        </div>
        {chooseFolder && <DestinationPicker onChoose={choose} />}

        {error && <p className="ero-error" role="alert">{error}</p>}

        <div className="topic-actions">
          {editing && <div className="topic-actions-row">
            <Button variant="ghost" disabled={!canClose} onClick={() => setEditing(false)}>{t('common.done')}</Button>
            <Button variant="primary" disabled={!toStart.length || starting} onClick={() => void start(toStart)}><Download />{t('downloads.download')}</Button>
          </div>}
          {!editing && toStart.length > 0 && <Button variant="primary" className="topic-primary" disabled={starting} onClick={() => void start(toStart)}><Download />{starting ? t('downloads.phase.resolving') : t('downloads.download')}</Button>}
          {!editing && transferring.length > 0 && <div className="topic-actions-row">
            {transferring.some(paused)
              ? <Button onClick={() => run('resume', paused)}><Play />{t('downloads.resume')}</Button>
              : transferring.some(pausable) && <Button onClick={() => run('pause', pausable)}><Pause />{t('common.pause')}</Button>}
            {transferring.some(canCancelDownload) && <Button onClick={() => run('cancel', canCancelDownload)}><X />{t('common.cancel')}</Button>}
          </div>}
          {!editing && done && toStart.length === 0 && <>
            {mediaId !== null && <Button variant="primary" className="topic-primary" onClick={() => void playMedia(mediaId)}><Play />{t('common.play')}</Button>}
            {doneBatch && <Button variant="ghost" onClick={() => openBatchLibrary(doneBatch)}><FolderOpen />{t('downloads.openLibrary')}</Button>}
            {mediaId === null && jobs.some((job) => job.kind === 'script' || job.kind === 'archive') && <Button variant="ghost" onClick={matchVideo}><Link />{t('downloads.matchVideo')}</Button>}
          </>}
        </div>
      </div>
      <OtherDownloads batches={batches.filter((batch) => !isTopicBatch(topic, batch))} />
    </aside>
  )
}

function Row({ icon, title, detail, jobs, keepDetail = false }: { icon: ReactNode; title: string; detail: string; jobs: DownloadFile[]; keepDetail?: boolean }) {
  const t = useT()
  const summary = summarizeFiles(jobs)
  const lead = summary.lead
  const extracting = lead?.phase === 'extracting' && lead.archive ? extractionProgress(lead.archive) : null
  const progress = summary.progress ?? extracting
  let status = detail
  if (summary.tone === 'attention' && lead) status = t(`downloads.phase.${lead.phase}`)
  else if (summary.tone === 'done' && !keepDetail) status = formatDownloadBytes(summary.totalBytes ?? summary.receivedBytes)
  else if (summary.tone === 'active' && lead) {
    if (summary.progress !== null && summary.totalBytes !== null) status = `${formatDownloadBytes(summary.receivedBytes)} / ${formatDownloadBytes(summary.totalBytes)}${jobs.length === 1 ? ` · ${t('downloads.via', { host: lead.host })}` : ''}`
    else status = lead.phase === 'attempting' ? `${t('downloads.phase.attempting')} · ${lead.host}` : t(`downloads.phase.${lead.phase}`)
  }
  return (
    <div className={cx('topic-row', `topic-row-${summary.tone}`)}>
      <span className="topic-row-icon">{summary.tone === 'done' ? <Check /> : summary.tone === 'attention' ? <CircleAlert /> : icon}</span>
      <strong title={title}>{title}</strong>
      {progress !== null && <span className="topic-row-percent">{Math.round(progress * 100)}%</span>}
      <span className="topic-row-detail" title={status}>{status}</span>
      {progress !== null && <div className="download-progress" role="progressbar" aria-label={title} aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress * 100}%` }} /></div>}
    </div>
  )
}

function Notice({ job, batch, active, onBackToTopic }: { job: DownloadFile; batch: DownloadBatch | undefined; active: boolean; onBackToTopic?: () => void }) {
  const t = useT()
  const command = useDownloads((state) => state.command)
  const [confirmVideoOnly, setConfirmVideoOnly] = useState(false)
  const archive = archiveView(job)
  const step = archive?.kind
  const title = step === 'password' ? t('settings.source.passwordRequired') : step === 'select' ? t('downloads.chooseFiles') : t(`downloads.phase.${job.phase}`)
  const videoOnly = batch?.canImportVideoOnly && job.kind !== 'video'
  return (
    <div className="topic-notice" role="group" aria-label={title}>
      <CircleAlert />
      <strong>{title}</strong>
      <span className="topic-notice-detail">{step === 'password' || step === 'select' || !job.reason ? job.publishedName ?? job.fileName : job.reason}</span>
      {archive && (step === 'password' || step === 'select')
        ? <div className="topic-notice-body"><ArchiveControls id={job.id} view={archive} active={active} onBackToTopic={onBackToTopic} /></div>
        : confirmVideoOnly && batch
          ? <div className="topic-notice-body"><p>{t('downloads.skipScripts')}</p><div className="topic-notice-actions">
            <Button variant="primary" onClick={() => { setConfirmVideoOnly(false); void useDownloads.getState().videoOnly(batch.id) }}>{t('downloads.videoOnly')}</Button>
            <Button variant="ghost" onClick={() => setConfirmVideoOnly(false)}>{t('common.cancel')}</Button>
          </div></div>
          : <div className="topic-notice-actions">
            {job.canContinue && <Button variant="primary" onClick={() => void command('continue', job.id)}>{t('common.continue')}</Button>}
            {job.phase === 'failed' && job.canRetry !== false && <Button variant="primary" onClick={() => void command('retry', job.id)}><RotateCcw />{t('common.retry')}</Button>}
            {videoOnly && <Button variant="ghost" onClick={() => setConfirmVideoOnly(true)}>{t('downloads.videoOnly')}</Button>}
            {job.canOpenSource === true && <Button variant="ghost" onClick={() => void invoke('downloads:openSource', job.id)}><ExternalLink />{t('eroscripts.openSource')}</Button>}
            {canCancelDownload(job) && <Button variant="ghost" onClick={() => void command('cancel', job.id)}>{t('common.cancel')}</Button>}
          </div>}
    </div>
  )
}

function Option({ type, name, checked, disabled, onChange, title, detail, sources }: { type: 'radio' | 'checkbox'; name?: string; checked: boolean; disabled: boolean; onChange: () => void; title: string; detail?: string; sources?: ReactNode }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className={cx('topic-option', checked && 'on')}>
      <label>
        <input type={type} name={name} checked={checked} disabled={disabled} onChange={onChange} />
        <span><strong title={title}>{title}</strong>{detail && <small>{detail}</small>}</span>
      </label>
      {sources && <IconButton size="sm" label={`${t('downloads.sources')}: ${title}`} aria-expanded={open} onClick={() => setOpen(!open)}><MoreHorizontal /></IconButton>}
      {open && sources}
    </div>
  )
}

function ScriptChips({ set, named, selected, disabled, label, onToggle, sources }: { set: ScriptSet; named: boolean; selected: string[]; disabled: boolean; label: (script: ScriptSet['scripts'][number]) => string; onToggle: (id: string) => void; sources: ReactNode }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="topic-set">
      {named && <span className="topic-set-name" title={set.name}>{set.name}</span>}
      <div className="topic-chips">
        {set.scripts.map((script) => <button key={script.source.id} type="button" className="topic-chip" aria-pressed={selected.includes(script.source.id)} disabled={disabled} title={script.source.fileName ?? script.source.label} onClick={() => onToggle(script.source.id)}>{label(script)}</button>)}
        <IconButton size="sm" label={`${t('downloads.sources')}: ${set.name}`} aria-expanded={open} onClick={() => setOpen(!open)}><MoreHorizontal /></IconButton>
      </div>
      {open && sources}
    </div>
  )
}

function SourceList({ sources, topic, batches, named, disabled, onDownload, onPost }: { sources: EroSource[]; topic: EroTopic; batches: DownloadBatch[]; named: boolean; disabled: boolean; onDownload: (id: string, again?: boolean) => void; onPost: (postNumber: number) => void }) {
  const t = useT()
  const [copied, setCopied] = useState<string | null>(null)
  return (
    <ul className="topic-sources">
      {sources.map((source) => {
        const job = topicSourceJob(topic, source, batches)?.file
        const complete = job?.phase === 'complete'
        const running = job && !['complete', 'cancelled', 'failed'].includes(job.phase)
        return (
          <li key={source.id}>
            <span className="topic-source-name">{named && <span title={source.fileName ?? source.label}>{source.fileName ?? source.label}</span>}<strong>{source.host}</strong>
              <button type="button" className="topic-source-post" onClick={() => onPost(source.postNumber)}>{t('eroscripts.post', { number: source.postNumber })}</button></span>
            {running ? <span className="topic-source-phase">{t(`downloads.phase.${job.phase}`)}</span>
              : <Button variant="ghost" disabled={disabled} onClick={() => onDownload(source.id, complete)}>{complete ? t('downloads.again') : t('downloads.download')}</Button>}
            <IconButton size="sm" label={`${t('eroscripts.openSource')}: ${source.host}`} onClick={() => void invoke('browser:openSource', source.url)}><ExternalLink /></IconButton>
            <IconButton size="sm" label={copied === source.id ? t('common.copied') : `${t('eroscripts.copyLink')}: ${source.host}`} onClick={() => { electron.clipboard.writeText(source.url); setCopied(source.id) }}>{copied === source.id ? <Check /> : <Copy />}</IconButton>
          </li>
        )
      })}
    </ul>
  )
}

function OtherDownloads({ batches }: { batches: DownloadBatch[] }) {
  const t = useT()
  if (!batches.length) return null
  const ordered = orderedBatches(batches)
  const attention = batches.some((batch) => batch.files.some((file) => file.phase === 'waiting' || file.phase === 'failed'))
  return (
    <details className="topic-others">
      <summary><ChevronRight />{t('downloads.other')}<span className={cx(attention && 'warn')}>{batches.length}</span></summary>
      <ul>
        {ordered.map((batch) => {
          const live = batch.files.filter((file) => file.phase !== 'cancelled')
          const summary = summarizeFiles(live)
          const finished = live.filter((file) => file.phase === 'complete').length
          const mediaId = live.find((file) => file.phase === 'complete' && file.mediaId !== null)?.mediaId ?? null
          return (
            <li key={batch.id}>
              <button type="button" className="topic-other-title" title={batch.title} onClick={() => void openBatchTopic(batch)}>{batch.title}</button>
              {summary.tone === 'attention' ? <CircleAlert className="warn" aria-label={t('downloads.attention')} />
                : mediaId !== null ? <Button variant="ghost" onClick={() => void playMedia(mediaId)}><Play />{t('common.play')}</Button>
                  : summary.progress !== null && <span className="topic-other-percent">{Math.round(summary.progress * 100)}%</span>}
              <span className="topic-other-detail">{finished}/{live.length} · {batch.destinationName}</span>
              {summary.progress !== null && <div className="download-progress"><span style={{ width: `${summary.progress * 100}%` }} /></div>}
            </li>
          )
        })}
      </ul>
    </details>
  )
}
