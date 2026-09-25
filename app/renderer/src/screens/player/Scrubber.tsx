import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Bookmark, Chapter } from 'bp-engine'
import { nearestBookmark } from '@/lib/bookmarks'
import { heatGradient } from '@/lib/heatmap'
import { fmtDuration } from '@/lib/format'
import { useT } from '@/state/i18n'
import * as live from '@/state/live'

interface Props {
  durationMs: number
  heatmap: readonly number[]
  heatDurationMs: number
  chapters: Chapter[]
  bookmarks: Bookmark[]
  strip?: string | null
  onSeek: (ms: number) => void
}

const STRIP_FRAMES = 20

const SEEK_THROTTLE_MS = 80

export function Scrubber({ durationMs, heatmap, heatDurationMs, chapters, bookmarks, strip, onSeek }: Props) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const dragRef = useRef<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const lastSeek = useRef(0)
  const pointerStart = useRef<{ x: number; fraction: number } | null>(null)

  const heat = useMemo(() => heatGradient(heatmap), [heatmap])
  const heatWidth = durationMs > 0 ? Math.min(1, heatDurationMs / durationMs) : 1

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let lastSecond = -1
    const write = (l: live.Live) => {
      const f = dragRef.current ?? (l.durationMs > 0 ? Math.min(1, l.timeMs / l.durationMs) : 0)
      el.style.setProperty('--p', f.toFixed(5))
      const second = Math.round(l.timeMs / 1000)
      if (second !== lastSecond) {
        lastSecond = second
        el.setAttribute('aria-valuenow', String(second))
      }
    }
    write(live.get())
    return live.subscribe(write)
  }, [])
  useEffect(() => {
    dragRef.current = drag
    if (drag !== null) ref.current?.style.setProperty('--p', drag.toFixed(5))
  }, [drag])

  const fractionAt = (clientX: number, snap = false) => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const bookmark = snap && durationMs > 0 ? nearestBookmark(bookmarks, fraction * durationMs, 12 / rect.width * durationMs, durationMs) : undefined
    return bookmark ? bookmark.atMs / durationMs : fraction
  }
  const seekTo = (fraction: number, force = false) => {
    const now = performance.now()
    if (!force && now - lastSeek.current < SEEK_THROTTLE_MS) return
    lastSeek.current = now
    onSeek(fraction * durationMs)
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || durationMs <= 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const f = fractionAt(e.clientX, true)
    pointerStart.current = { x: e.clientX, fraction: f }
    setDrag(f)
    seekTo(f, true)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const f = fractionAt(e.clientX)
    setHover(fractionAt(e.clientX, true))
    if (drag !== null && pointerStart.current && Math.abs(e.clientX - pointerStart.current.x) > 4) {
      setDrag(f)
      seekTo(f)
    }
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag === null) return
    const start = pointerStart.current
    seekTo(start && Math.abs(e.clientX - start.x) <= 4 ? start.fraction : fractionAt(e.clientX), true)
    pointerStart.current = null
    setDrag(null)
  }

  const pct = (f: number) => `${(f * 100).toFixed(3)}%`
  const hoverBookmark = hover === null ? undefined : nearestBookmark(bookmarks, hover * durationMs, 1, durationMs)
  const hoverChapter = hover === null ? null : chapters.find((c) => hover * durationMs >= c.startMs && hover * durationMs < c.endMs)

  return (
    <div
      ref={ref}
      className="scrubber"
      role="slider"
      aria-label={t('player.scrubber.position')}
      aria-valuemin={0}
      aria-valuemax={Math.round(durationMs / 1000)}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
    >
      <div className="heat" style={{ backgroundImage: heat, backgroundSize: `${(heatWidth * 100).toFixed(3)}% 100%` }} />
      <div className="unplayed" />
      {chapters.map((c, i) => (
        <div key={`c${i}`} className="chap" style={{ left: pct(durationMs > 0 ? c.startMs / durationMs : 0) }} title={c.name} />
      ))}
      {bookmarks.filter((b) => Number.isFinite(b.atMs) && b.atMs >= 0 && b.atMs <= durationMs).map((b, i) => (
        <div key={`b${i}`} className="bm" style={{ left: pct(durationMs > 0 ? b.atMs / durationMs : 0) }} title={b.name} />
      ))}
      <div className="head" />
      {hover !== null && drag === null && (
        <>
          <div className="hoverline" style={{ left: pct(hover) }} />
          <div className={strip ? 'preview' : 'hovertime'} style={{ left: pct(hover) }}>
            {strip && <div className="pt" style={{ backgroundImage: `url(${strip})`, backgroundPositionX: `${(Math.min(STRIP_FRAMES - 1, Math.floor(hover * STRIP_FRAMES)) / (STRIP_FRAMES - 1)) * 100}%` }} />}
            <div className="pl">
              <span>{fmtDuration(hover * durationMs)}</span>
              {(hoverBookmark || hoverChapter) && <span className="faint">{hoverBookmark?.name || hoverChapter?.name}</span>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
