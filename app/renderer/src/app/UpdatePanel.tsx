import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/Button'
import { t, useT } from '@/state/i18n'
import './UpdatePanel.css'

const OPEN_DELAY = 150
const CLOSE_DELAY = 200

function Notes({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  let items: string[] = []
  const flush = () => {
    if (items.length > 0) blocks.push(<ul key={blocks.length}>{items.map((item, i) => <li key={i}>{item}</li>)}</ul>)
    items = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('- ')) items.push(line.slice(2))
    else {
      flush()
      blocks.push(<p key={blocks.length}>{line}</p>)
    }
  }
  flush()
  return <>{blocks}</>
}

const megabytes = (bytes: number) => t('format.megabytes', { value: Math.round(bytes / 1048576) })

interface Props {
  version: string
  notes: string
  bytes: number | null
  anchor: HTMLElement | null
  onInstall: () => void
}

export function UpdatePanel({ version, notes, bytes, anchor, onInstall }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!anchor) return
    const later = (next: boolean) => {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setOpen(next), next ? OPEN_DELAY : CLOSE_DELAY)
    }
    const enter = (event: PointerEvent) => { if (event.pointerType !== 'touch') later(true) }
    const leave = () => later(false)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { clearTimeout(timer.current); setOpen(false) } }
    anchor.addEventListener('pointerenter', enter)
    anchor.addEventListener('pointerleave', leave)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', leave)
    return () => {
      clearTimeout(timer.current)
      anchor.removeEventListener('pointerenter', enter)
      anchor.removeEventListener('pointerleave', leave)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', leave)
    }
  }, [anchor])

  useLayoutEffect(() => {
    if (!open || !anchor || !panel.current) return
    const bounds = anchor.getBoundingClientRect()
    const height = panel.current.getBoundingClientRect().height
    panel.current.style.left = `${bounds.right + 9}px`
    panel.current.style.top = `${Math.max(8, Math.min(bounds.top + (bounds.height - height) / 2, window.innerHeight - height - 8))}px`
  })

  if (!open) return null
  const keep = () => clearTimeout(timer.current)
  const release = () => { timer.current = setTimeout(() => setOpen(false), CLOSE_DELAY) }
  return createPortal(
    <div ref={panel} className="update-panel" role="dialog" aria-label={t('update.to', { version })} onPointerEnter={keep} onPointerLeave={release}>
      <div className="update-panel-head">
        <b>{t('update.panel.ready', { version })}</b>
        {bytes !== null && <span>{megabytes(bytes)}</span>}
      </div>
      {notes && (
        <>
          <div className="update-panel-eyebrow">{t('update.panel.whatsNew')}</div>
          <div className="update-panel-notes"><Notes text={notes} /></div>
        </>
      )}
      <div className="update-panel-actions">
        <Button variant="primary" onClick={onInstall}>{t('update.panel.restart')}</Button>
      </div>
    </div>,
    document.body,
  )
}
