import * as Popover from '@radix-ui/react-popover'
import { ArrowUpRight, ChevronRight, FolderOpen, MoreHorizontal, Pause, Play, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { DownloadBatch } from '@shared/downloads'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { cx } from '@/lib/cx'
import { electron } from '@/node'
import { useDownloads } from '@/state/downloads'
import { useT } from '@/state/i18n'
import { DownloadButton } from './DownloadButton'
import { openBatchTopic } from './batchActions'
import { canCancelDownload, downloadBatchGroup, formatDownloadBytes, hostName, manualStep, orderedBatches, reasonText, summarizeFiles } from './downloadPresentation'
import './downloads.css'
import './downloads-menu.css'

export function DownloadsMenu({ className }: { className?: string }) {
  const t = useT()
  const open = useDownloads((state) => state.managerOpen)
  const setOpen = useDownloads((state) => state.setManagerOpen)
  const state = useDownloads((state) => state.state)
  const error = useDownloads((state) => state.error)
  const [overflow, setOverflow] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const batches = orderedBatches(state.batches)
  const groups = [
    { kind: 'attention', label: t('downloads.attention') },
    { kind: 'active', label: t('downloads.inProgress') },
    { kind: 'finished', label: t('downloads.finished') },
  ] as const
  const change = (next: boolean) => {
    if (!next) { setOverflow(false); setConfirmCancel(false) }
    setOpen(next)
  }
  return (
    <Popover.Root open={open} onOpenChange={change}>
      <Popover.Anchor asChild><span ref={anchor} className="downloads-anchor"><DownloadButton className={className} /></span></Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className="downloads-menu"
          id="downloads-manager"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          aria-label={t('downloads.title')}
          onInteractOutside={(event) => { if (event.target instanceof Node && anchor.current?.contains(event.target)) event.preventDefault() }}
        >
          <header className="downloads-menu-head">
            <h2>{t('downloads.title')}</h2>
            <Button variant="ghost" disabled={!state.canClear} onClick={() => void useDownloads.getState().clear()}>{t('downloads.clearFinished')}</Button>
            <IconButton size="sm" label={t('common.more')} aria-expanded={overflow} onClick={() => setOverflow(!overflow)}><MoreHorizontal /></IconButton>
          </header>
          {overflow && <div className="download-inline-menu"><Button variant="ghost" className="btn-danger" disabled={state.cancellable === 0} onClick={() => { setOverflow(false); setConfirmCancel(true) }}>{t('downloads.cancelAll')}</Button></div>}
          {confirmCancel && <div className="download-confirm"><p>{t('downloads.cancelCount', { count: state.cancellable })}</p><div>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>{t('common.cancel')}</Button>
            <Button className="btn-danger" disabled={state.cancellable === 0} onClick={() => { setConfirmCancel(false); void useDownloads.getState().cancelAll() }}>{t('downloads.cancelAll')}</Button>
          </div></div>}
          {error && <div className="download-error" role="alert"><span>{error}</span><IconButton size="sm" label={t('common.close')} onClick={() => useDownloads.getState().dismissError()}><X /></IconButton></div>}
          <div className="downloads-menu-list">
            {batches.length === 0 && <p className="download-empty">{t('downloads.empty')}</p>}
            {groups.map((group) => {
              const matching = batches.filter((batch) => downloadBatchGroup(batch) === group.kind)
              if (!matching.length) return null
              return <section key={group.kind} aria-label={group.label}>
                <h3 className={cx('downloads-menu-group', group.kind === 'attention' && 'warn')}>{group.label}<span>{matching.length}</span></h3>
                {matching.map((batch) => <Entry key={batch.id} batch={batch} onOpenTopic={() => { change(false); void openBatchTopic(batch) }} />)}
              </section>
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Entry({ batch, onOpenTopic }: { batch: DownloadBatch; onOpenTopic: () => void }) {
  const t = useT()
  const command = useDownloads((state) => state.command)
  const summary = summarizeFiles(batch.files)
  const lead = summary.lead
  const topic = batch.origin !== 'browser'
  const title = topic ? batch.title : lead?.publishedName ?? lead?.fileName ?? batch.title
  let status = ''
  if (lead && summary.tone === 'attention') status = manualStep(lead) ? t('downloads.manual.needs', { host: hostName(lead.host) }) : lead.reason ? reasonText(t, lead.reason, lead.host) : t(`downloads.phase.${lead.phase}`)
  else if (summary.tone === 'done') status = `${t('downloads.phase.complete')} · ${batch.destinationName}`
  else if (lead) status = summary.totalBytes !== null && summary.receivedBytes > 0 ? `${formatDownloadBytes(summary.receivedBytes)} / ${formatDownloadBytes(summary.totalBytes)}` : t(`downloads.phase.${lead.phase}`)
  const body = <>
    <strong title={title}>{title}</strong>
    <small className={cx(summary.tone === 'attention' && 'warn')} title={status}>{status}</small>
    {summary.progress !== null && <span className="download-progress" role="progressbar" aria-label={title} aria-valuenow={Math.round(summary.progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${summary.progress * 100}%` }} /></span>}
  </>
  if (topic) return <button type="button" className="downloads-menu-entry" onClick={onOpenTopic}>{body}<ChevronRight className="downloads-menu-go" /></button>
  return (
    <div className="downloads-menu-entry">
      {body}
      <span className="downloads-menu-actions">
        {lead?.canContinue && <IconButton size="sm" label={t('downloads.manual.open', { host: hostName(lead.host) })} onClick={() => void command('continue', lead.id)}><ArrowUpRight /></IconButton>}
        {lead?.canPause && lead.phase === 'downloading' && <IconButton size="sm" label={t('common.pause')} onClick={() => void command('pause', lead.id)}><Pause /></IconButton>}
        {lead?.phase === 'paused' && <IconButton size="sm" label={t('downloads.resume')} onClick={() => void command('resume', lead.id)}><Play /></IconButton>}
        {summary.tone === 'done' && batch.savedPath && <IconButton size="sm" label={t('downloads.showFolder')} onClick={() => batch.savedPath && electron.shell.showItemInFolder(batch.savedPath)}><FolderOpen /></IconButton>}
        {lead && canCancelDownload(lead) && <IconButton size="sm" label={t('common.cancel')} onClick={() => void command('cancel', lead.id)}><X /></IconButton>}
      </span>
    </div>
  )
}
