import { useRef, type KeyboardEvent } from 'react'
import type { EroTopic } from '@shared/eroscripts'
import { TopicFiles } from '@/screens/browser/TopicFiles'
import { useDownloads } from '@/state/downloads'
import { useT } from '@/state/i18n'
import { DownloadManager } from './DownloadManager'
import './downloads.css'

export function DownloadsDock({ topic, related }: { topic: EroTopic; related: boolean }) {
  const t = useT()
  const open = useDownloads((state) => state.managerOpen)
  const session = useDownloads((state) => state.state.session)
  const setOpen = useDownloads((state) => state.setManagerOpen)
  const filesTab = useRef<HTMLButtonElement>(null)
  const downloadsTab = useRef<HTMLButtonElement>(null)
  const select = (downloads: boolean, target: HTMLButtonElement | null) => {
    setOpen(downloads)
    queueMicrotask(() => { if (target?.isConnected) target.focus() })
  }
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const downloads = event.key === 'Home' ? false : event.key === 'End' ? true : !open
    select(downloads, downloads ? downloadsTab.current : filesTab.current)
  }
  const count = session.attention > 0 ? session.attention : session.total
  return (
    <aside className="downloads-dock downloads-topic-dock" aria-label={t('downloads.title')}>
      <div className="download-view-tabs" role="tablist" aria-label={t('downloads.title')} onKeyDown={navigate}>
        <button ref={filesTab} type="button" role="tab" id="ero-files-tab" aria-selected={!open} aria-controls="ero-files-panel" tabIndex={open ? -1 : 0} onClick={(event) => select(false, event.currentTarget)}>{t('eroscripts.files')}</button>
        <button ref={downloadsTab} type="button" role="tab" id="ero-downloads-tab" aria-selected={open} aria-controls="ero-downloads-panel" tabIndex={open ? 0 : -1} onClick={(event) => select(true, event.currentTarget)}>
          {t('downloads.title')}{count > 0 && <span className={session.attention > 0 ? 'download-view-count download-view-attention' : 'download-view-count'} title={session.attention > 0 ? t('downloads.attention') : undefined}>{count}</span>}
        </button>
      </div>
      <div className="download-view-panel" role="tabpanel" id="ero-files-panel" aria-labelledby="ero-files-tab" hidden={open}>
        <TopicFiles key={`${topic.tabId}-${topic.generation}`} topic={topic} related={related} active={!open} />
      </div>
      <div className="download-view-panel" role="tabpanel" id="ero-downloads-panel" aria-labelledby="ero-downloads-tab" hidden={!open}>
        <DownloadManager embedded active={open} />
      </div>
    </aside>
  )
}
