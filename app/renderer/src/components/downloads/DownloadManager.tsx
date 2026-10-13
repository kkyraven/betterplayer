import { ArrowUpRight, FolderOpen, Link, MoreHorizontal, Pause, Play, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DownloadBatch, DownloadFile } from '@shared/downloads'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { invoke } from '@/ipc'
import { useBrowser } from '@/state/browser'
import { useDownloads } from '@/state/downloads'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { usePlayer } from '@/state/player'
import { useUi } from '@/state/ui'
import { useMatcher } from '@/state/matcher'
import { electron } from '@/node'
import { cx } from '@/lib/cx'
import { canCancelDownload, downloadBatchGroup, fileProgress, formatDownloadBytes, orderedBatches, sessionTransferProgress } from './downloadPresentation'
import { ArchiveControls } from './ArchiveControls'
import { archiveView } from './archiveView'
import { topicTab } from './topicTab'
import './downloads.css'

export function DownloadManager({ embedded = false, active = true }: { embedded?: boolean; active?: boolean }) {
  const t = useT()
  const state = useDownloads((store) => store.state)
  const initialized = useDownloads((store) => store.initialized)
  const error = useDownloads((store) => store.error)
  const close = useDownloads((store) => store.setManagerOpen)
  const clear = useDownloads((store) => store.clear)
  const cancelAll = useDownloads((store) => store.cancelAll)
  const [overflow, setOverflow] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [videoOnlyFor, setVideoOnlyFor] = useState<string | null>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const wasActive = useRef(false)
  const wrongPassword = state.batches.some((batch) => batch.files.some((file) => file.phase === 'waiting' && file.archive?.state === 'wrong-password'))
  useEffect(() => {
    if (active && !wasActive.current && !embedded && !wrongPassword) title.current?.focus()
    wasActive.current = active
  }, [active, embedded, wrongPassword])
  useEffect(() => {
    if (!active) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      if (confirmCancel) setConfirmCancel(false)
      else if (videoOnlyFor !== null) setVideoOnlyFor(null)
      else if (overflow) setOverflow(false)
      else close(false)
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [active, close, confirmCancel, overflow, videoOnlyFor])
  const { session } = state
  const progress = sessionTransferProgress(state)
  const batches = orderedBatches(state.batches)
  const groups = [
    { kind: 'attention', label: t('downloads.attention') },
    { kind: 'active', label: t('downloads.inProgress') },
    { kind: 'finished', label: t('downloads.finished') },
  ] as const
  return (
    <aside className={embedded ? 'download-manager-embedded' : 'downloads-dock'} id="downloads-manager" aria-labelledby={embedded ? undefined : 'downloads-heading'} aria-label={embedded ? t('downloads.title') : undefined}>
      <header className="download-panel-header">
        {!embedded && <h2 id="downloads-heading" tabIndex={-1} ref={title}>{t('downloads.title')}</h2>}
        <Button variant="ghost" disabled={!state.canClear} title={t('downloads.clearFinished')} onClick={() => void clear()}>{t('downloads.clearFinished')}</Button>
        <IconButton size="sm" label={t('common.more')} aria-expanded={overflow} onClick={() => setOverflow(!overflow)}><MoreHorizontal /></IconButton>
        {!embedded && <IconButton size="sm" label={t('common.close')} onClick={() => close(false)}><X /></IconButton>}
      </header>
      {overflow && <div className="download-inline-menu"><Button variant="ghost" className="btn-danger" disabled={state.cancellable === 0} onClick={() => { setOverflow(false); setConfirmCancel(true) }}>{t('downloads.cancelAll')}</Button></div>}
      {confirmCancel && <div className="download-confirm"><p>{t('downloads.cancelCount', { count: state.cancellable })}</p><div><Button variant="ghost" onClick={() => setConfirmCancel(false)}>{t('common.cancel')}</Button><Button className="btn-danger" disabled={state.cancellable === 0} onClick={() => { setConfirmCancel(false); void cancelAll() }}>{t('downloads.cancelAll')}</Button></div></div>}
      <div className="download-session">
        <span>{t('downloads.thisSession')}</span><strong>{session.completed}/{session.total}</strong>
        {progress !== null && session.total > 0 && <div className="download-progress" role="progressbar" aria-label={t('downloads.byteProgress')} aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} /></div>}
        {session.failed + session.cancelled > 0 && <p>{[session.failed > 0 && t('downloads.failedCount', { count: session.failed }), session.cancelled > 0 && t('downloads.cancelledCount', { count: session.cancelled })].filter(Boolean).join(' · ')}</p>}
      </div>
      {error && <div className="download-error" role="alert"><span>{error}</span><IconButton size="sm" label={t('common.close')} onClick={() => useDownloads.getState().dismissError()}><X /></IconButton></div>}
      <div className="download-list">
        {!initialized && <p className="download-empty">{t('downloads.loading')}</p>}
        {initialized && state.batches.length === 0 && <p className="download-empty">{t('downloads.empty')}</p>}
        {groups.map((group) => {
          const matching = batches.filter((batch) => downloadBatchGroup(batch) === group.kind)
          if (!matching.length) return null
          return <section key={group.kind} className={cx('download-group', group.kind === 'attention' && 'download-group-attention')} aria-labelledby={`download-group-${group.kind}`}>
            <h3 className="download-group-heading" id={`download-group-${group.kind}`}>{group.label}<span>{matching.length}</span></h3>
            {matching.map((batch) => <Batch key={batch.id} batch={batch} active={active} confirmVideoOnly={videoOnlyFor === batch.id} onConfirmVideoOnly={(confirm) => setVideoOnlyFor(confirm ? batch.id : null)} />)}
          </section>
        })}
      </div>
    </aside>
  )
}

function Batch({ batch, active, confirmVideoOnly, onConfirmVideoOnly }: { batch: DownloadBatch; active: boolean; confirmVideoOnly: boolean; onConfirmVideoOnly: (confirm: boolean) => void }) {
  const t = useT()
  const complete = batch.files.every((file) => file.phase === 'complete')
  const library = batch.origin !== 'browser'
  const media = batch.files.find((file) => file.phase === 'complete' && file.mediaId !== null)
  const openTopic = async () => {
    const tab = topicTab(batch, useBrowser.getState().tabs)
    if (tab !== null) await useBrowser.getState().activate(tab)
    else await useBrowser.getState().open(batch.topicUrl)
    useUi.getState().setScreen('browser')
  }
  const openLibrary = () => {
    useLibrary.getState().setSearch('')
    useLibrary.getState().setFilters({})
    useLibrary.getState().setFolder({ rootId: batch.destination.rootId, folder: batch.destination.relativePath })
    useUi.getState().setScreen('library')
  }
  const play = async () => {
    if (media?.mediaId === null || media?.mediaId === undefined) return
    const detail = await invoke('library:media', media.mediaId)
    if (detail) await usePlayer.getState().open(detail.path)
  }
  return (
    <section className="download-batch">
      <div className="download-batch-heading"><h3 title={batch.title}>{batch.title}</h3><IconButton size="sm" label={t('downloads.openTopic')} onClick={() => void openTopic()}><ArrowUpRight /></IconButton></div>
      <p className="download-batch-destination" title={batch.destinationName}>{batch.destinationName}</p>
      {(complete || media) && <div className="download-batch-actions">{media && <Button variant="primary" onClick={() => void play()}><Play />{t('common.play')}</Button>}{library && <Button variant="ghost" onClick={openLibrary}><FolderOpen />{t('downloads.openLibrary')}</Button>}{!library && batch.savedPath && <Button variant="ghost" onClick={() => batch.savedPath && electron.shell.showItemInFolder(batch.savedPath)}><FolderOpen />{t('downloads.showFolder')}</Button>}{library && complete && !media && batch.files.some((file) => file.kind === 'script' || file.kind === 'archive') && <Button variant="ghost" onClick={() => { useUi.getState().setScreen('utilities'); void useMatcher.getState().scan() }}><Link />{t('downloads.matchVideo')}</Button>}</div>}
      {confirmVideoOnly && <div className="download-confirm"><p>{t('downloads.skipScripts')}</p><div><Button variant="ghost" onClick={() => onConfirmVideoOnly(false)}>{t('common.cancel')}</Button><Button disabled={!batch.canImportVideoOnly} onClick={() => { onConfirmVideoOnly(false); void useDownloads.getState().videoOnly(batch.id) }}>{t('downloads.videoOnly')}</Button></div></div>}
      {batch.files.map((file) => <File key={file.id} file={file} active={active} onOpenTopic={() => void openTopic()} />)}
      {batch.canImportVideoOnly && !confirmVideoOnly && <Button variant="ghost" onClick={() => onConfirmVideoOnly(true)}>{t('downloads.videoOnly')}</Button>}
    </section>
  )
}

function File({ file, active, onOpenTopic }: { file: DownloadFile; active: boolean; onOpenTopic: () => void }) {
  const t = useT()
  const command = useDownloads((state) => state.command)
  const progress = fileProgress(file)
  const archive = archiveView(file)
  const step = archive?.kind
  const status = step === 'password' ? t('settings.source.passwordRequired') : step === 'select' ? t('downloads.chooseFiles') : t(`downloads.phase.${file.phase}`)
  const transferred = ['downloading', 'paused', 'verifying', 'staged', 'publishing', 'importing', 'complete'].includes(file.phase)
  const attention = file.phase === 'waiting' || file.phase === 'failed'
  return (
    <div className={cx('download-file', attention && 'download-file-attention')}>
      <strong title={file.publishedName ?? file.fileName}>{file.publishedName ?? file.fileName}</strong>
      <div className="download-file-meta"><span>{file.host}</span><span>{status}</span></div>
      {file.reason && step !== 'password' && step !== 'select' && <p className="download-file-reason">{file.reason}</p>}
      {transferred && <div className="download-bytes">{formatDownloadBytes(file.receivedBytes)}{file.totalBytes !== null && ` / ${formatDownloadBytes(file.totalBytes)}`}</div>}
      {file.phase === 'downloading' && progress !== null && <div className="download-progress" role="progressbar" aria-label={file.fileName} aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress * 100}%` }} /></div>}
      {archive && <ArchiveControls id={file.id} view={archive} active={active} onBackToTopic={onOpenTopic} />}
      <div className="download-file-actions">
        {file.canPause && file.phase === 'downloading' && <Button variant="ghost" onClick={() => void command('pause', file.id)}><Pause />{t('common.pause')}</Button>}
        {file.phase === 'paused' && <Button variant="ghost" onClick={() => void command('resume', file.id)}><Play />{t('downloads.resume')}</Button>}
        {file.canContinue && <Button variant="ghost" onClick={() => { useUi.getState().setScreen('browser'); void command('continue', file.id) }}><ArrowUpRight />{t('common.continue')}</Button>}
        {file.phase === 'failed' && file.canRetry !== false && <Button variant="ghost" onClick={() => void command('retry', file.id)}><RotateCcw />{t('common.retry')}</Button>}
        {canCancelDownload(file) && <IconButton size="sm" label={t('common.cancel')} onClick={() => void command('cancel', file.id)}><X /></IconButton>}
      </div>
      {file.attempts.length > 1 && <details className="download-attempts"><summary>{t('downloads.sources')}</summary><ol>{file.attempts.map((attempt, index) => <li key={`${attempt.at}-${index}`}><span>{attempt.host}</span><span>{attempt.reason ?? t(`downloads.attempt.${attempt.outcome}`)}</span></li>)}</ol></details>}
    </div>
  )
}
