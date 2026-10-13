import { Download } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { useDownloads } from '@/state/downloads'
import { useT } from '@/state/i18n'
import { cx } from '@/lib/cx'
import { downloadCountGeometry, downloadTone } from './downloadPresentation'
import './downloads.css'

export function DownloadButton({ className }: { className?: string }) {
  const t = useT()
  const state = useDownloads((state) => state.state)
  const session = state.session
  const open = useDownloads((state) => state.managerOpen)
  const setOpen = useDownloads((state) => state.setManagerOpen)
  const { count, width, tray } = downloadCountGeometry(session)
  const progress = session.progress === null ? null : Math.min(100, Math.max(0, session.progress * 100))
  const phases = [...new Set(state.batches.flatMap((batch) => batch.files).map((file) => file.phase).filter((phase) => !['complete', 'cancelled'].includes(phase)))]
  const tone = downloadTone(session, phases)
  const label = [t('downloads.title'), count, ...phases.map((phase) => t(`downloads.phase.${phase}`)), session.attention > 0 ? t('downloads.attention') : ''].filter(Boolean).join(', ')
  return (
    <IconButton className={cx('downloads-button', `downloads-${tone}`, open && 'on', className)} label={label} aria-expanded={open} aria-controls="downloads-manager" onClick={(event) => setOpen(!open, event.currentTarget)}>
      {session.total === 0 ? <Download /> : (
        <svg className="downloads-glyph" style={{ width }} viewBox={`0 0 ${width} 17`} aria-hidden>
          <text x={width / 2} y="9.3" textAnchor="middle">{count}</text>
          {progress !== null && <path className="downloads-tray-track" d={tray} />}
          {progress === null ? <path className="downloads-tray-value" d={tray} pathLength={100} strokeDasharray="0 4.6" strokeLinecap="round" />
            : progress > 0 && <path className="downloads-tray-value" d={tray} pathLength={100} strokeDasharray={`${progress} 100`} strokeLinecap={progress >= 100 ? 'round' : 'butt'} />}
        </svg>
      )}
    </IconButton>
  )
}
