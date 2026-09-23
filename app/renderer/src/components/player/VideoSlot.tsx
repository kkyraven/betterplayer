import { useEffect, useRef } from 'react'
import { AudioArt } from './AudioArt'
import { videoStage } from './stage'
import { Subtitles } from './Subtitles'
import './VideoSlot.css'

interface Props {
  onClick?: () => void
  onDoubleClick?: () => void
  subtitles?: boolean
  compact?: boolean
}

export function VideoSlot({ onClick, onDoubleClick, subtitles = false, compact = false }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pointer = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  useEffect(() => () => clearTimeout(clickTimer.current), [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stage = videoStage()
    stage.attach(el)
    return () => stage.detach(el)
  }, [])
  return (
    <div ref={ref} className="video-slot"
      onPointerDown={(event) => {
        clearTimeout(clickTimer.current)
        pointer.current = event.button === 0 ? { x: event.clientX, y: event.clientY, moved: false } : null
      }}
      onPointerMove={(event) => {
        const start = pointer.current
        if (start && (event.buttons & 1) && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) {
          start.moved = true
          clearTimeout(clickTimer.current)
        }
      }}
      onPointerCancel={() => { pointer.current = null }}
      onClick={(event) => {
        if (!onClick || !pointer.current || pointer.current.moved || event.detail > 1) return
        clearTimeout(clickTimer.current)
        if (onDoubleClick) clickTimer.current = setTimeout(onClick, 300)
        else onClick()
      }}
      onDoubleClick={() => {
        clearTimeout(clickTimer.current)
        if (!pointer.current?.moved) onDoubleClick?.()
      }}
    >
      <AudioArt compact={compact} />
      {subtitles && <Subtitles />}
    </div>
  )
}
