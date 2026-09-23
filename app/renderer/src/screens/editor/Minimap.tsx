import { Minus, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { heatBuckets } from '@/editor/ops'
import { clampStart, windowStart } from '@/editor/view'
import { fmtDuration } from '@/lib/format'
import { heatGradient } from '@/lib/heatmap'
import * as live from '@/state/live'
import { useEditor } from '@/state/editor'
import { useT } from '@/state/i18n'

const BUCKETS = 240

export function Minimap() {
  const t = useT()
  const lanes = useEditor((s) => s.lanes)
  const focused = useEditor((s) => s.focused)
  const durationMs = useEditor((s) => s.durationMs)
  const flags = useEditor((s) => s.flags)
  const view = useEditor((s) => s.view)
  const setView = useEditor((s) => s.setView)
  const zoom = useEditor((s) => s.zoom)
  const seekTo = useEditor((s) => s.seekTo)
  const track = useRef<HTMLDivElement>(null)
  const win = useRef<HTMLDivElement>(null)
  const cursor = useRef<HTMLDivElement>(null)
  const drag = useRef<{ kind: 'move' | 'left' | 'right'; x: number; startMs: number; zoomMs: number } | null>(null)

  const heat = useMemo(() => {
    const lane = lanes.find((l) => l.axis === focused)
    return heatGradient(lane ? heatBuckets(lane.points, durationMs, BUCKETS) : [])
  }, [lanes, focused, durationMs])

  useEffect(() => {
    const write = (l: live.Live) => {
      if (durationMs <= 0) return
      const start = windowStart(view, l.timeMs, durationMs)
      const left = Math.max(0, start / durationMs)
      const right = Math.min(1, (start + view.zoomMs) / durationMs)
      if (win.current) {
        win.current.style.left = `${(left * 100).toFixed(3)}%`
        win.current.style.width = `${Math.max(0.3, (right - left) * 100).toFixed(3)}%`
      }
      if (cursor.current) cursor.current.style.left = `${((l.timeMs / durationMs) * 100).toFixed(3)}%`
    }
    write(live.get())
    return live.subscribe(write)
  }, [view, durationMs])

  const fraction = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }
  const onDown = (e: ReactPointerEvent<HTMLElement>, kind: 'move' | 'left' | 'right') => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { kind, x: e.clientX, startMs: windowStart(view, live.get().timeMs, durationMs), zoomMs: view.zoomMs }
  }
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    const rect = track.current?.getBoundingClientRect()
    if (!d || !rect || rect.width === 0) return
    const dMs = ((e.clientX - d.x) / rect.width) * durationMs
    if (d.kind === 'move') setView({ ...view, follow: false, startMs: clampStart(d.startMs + dMs, d.zoomMs, durationMs) })
    else if (d.kind === 'left') {
      const zoomMs = Math.max(400, d.zoomMs - dMs)
      setView({ ...view, follow: false, zoomMs, startMs: clampStart(d.startMs + d.zoomMs - zoomMs, zoomMs, durationMs) })
    } else setView({ ...view, follow: false, zoomMs: Math.max(400, d.zoomMs + dMs), startMs: d.startMs })
  }
  const onUp = () => {
    drag.current = null
  }
  return (
    <section className="ed-overview" aria-label={t('editor.minimap.wholeVideo')}>
      <div className="top">
        <span>{t('editor.minimap.wholeVideo')}</span>
        <span className="grow" />
        <span>
          {t('editor.minimap.visible')}<b>{view.zoomMs >= 1000 ? `${Math.round(view.zoomMs / 1000)} s` : `${Math.round(view.zoomMs)} ms`}</b>
        </span>
        <button type="button" className="ed-btn" aria-label={t('editor.minimap.zoomOut')} title={t('editor.minimap.zoomOut')} onClick={() => zoom(1.5)}>
          <Minus />
        </button>
        <button type="button" className="ed-btn" aria-label={t('editor.minimap.zoomIn')} title={t('editor.minimap.zoomIn')} onClick={() => zoom(1 / 1.5)}>
          <Plus />
        </button>
      </div>
      <div ref={track} className="ed-track" onPointerDown={(e) => e.button === 0 && seekTo(fraction(e.clientX) * durationMs)}>
        <div className="ed-heat" style={{ backgroundImage: heat }} />
        {durationMs > 0 && flags.map((f) => <i key={f} className="ed-flag" style={{ left: `${((f / durationMs) * 100).toFixed(3)}%` }} />)}
        <div ref={cursor} className="ed-cursor" />
        <div ref={win} className="ed-window" title={t('editor.minimap.visibleRange')} onPointerDown={(e) => onDown(e, 'move')} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <i className="l" onPointerDown={(e) => onDown(e, 'left')} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
          <i className="r" onPointerDown={(e) => onDown(e, 'right')} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
        </div>
      </div>
      <div className="ed-times">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <span key={f}>{fmtDuration(f * durationMs)}</span>
        ))}
      </div>
    </section>
  )
}
