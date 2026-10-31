import { useEffect, useRef, type ReactNode } from 'react'
import { focusFirst } from '@/input/spatialNav'
import { useUi } from '@/state/ui'
import './tv.css'

interface Props {
  title: string
  children: ReactNode
}

export function TvSheet({ title, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement
    const el = ref.current
    if (el) focusFirst(el)
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true })
    }
  }, [])
  return (
    <>
      <div className="tv-scrim" onClick={() => useUi.getState().setTvOverlay('none')} />
      <div ref={ref} className="tv-sheet" role="dialog" aria-label={title} data-nav-trap>
        <h2>{title}</h2>
        <div className="tv-sheet-body">{children}</div>
      </div>
    </>
  )
}
