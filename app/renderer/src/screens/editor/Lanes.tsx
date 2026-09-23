import { EyeOff, Link, Plus } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { AXIS_LABEL, AXIS_NAME, type AxisId } from '@shared/axes'
import type { EditorLane, EditorPoint } from '@shared/editor'
import { indexAt, move as moveOp, normalise, valueAt } from '@/editor/ops'
import { tickStepMs, windowStart, xToTime, zoomAround } from '@/editor/view'
import { keyLabel } from '@/input/actions'
import { cx } from '@/lib/cx'
import { fmtTimecode } from '@/lib/format'
import { heatColor } from '@/lib/heatmap'
import { addableAxes, analysis, useEditor } from '@/state/editor'
import * as live from '@/state/live'
import { useT } from '@/state/i18n'

const RULER_H = 32
const COMPACT_H = 27
const FOCUSED_MIN_H = 80
const PAD_FOCUSED = 8
const PAD_COMPACT = 3
const HIT_PX = 7
const SCRUB_THROTTLE_MS = 40
const ACCENT = '#b7a3ff'
const ACCENT_SOFT = '#c8b7ff'

interface Row {
  axis: AxisId
  y: number
  h: number
  focused: boolean
}

function layoutRows(height: number, lanes: EditorLane[], focused: AxisId): Row[] {
  const total = Math.max(0, height - RULER_H)
  const n = lanes.length
  const focusedH = Math.max(FOCUSED_MIN_H, total - COMPACT_H * (n - 1))
  let y = RULER_H
  return lanes.map((l) => {
    const isFocused = l.axis === focused
    const h = isFocused ? focusedH : COMPACT_H
    const row = { axis: l.axis, y, h, focused: isFocused }
    y += h
    return row
  })
}

const padOf = (row: Row) => (row.focused ? PAD_FOCUSED : PAD_COMPACT)
const yOf = (row: Row, pos: number) => row.y + padOf(row) + (1 - pos / 100) * (row.h - padOf(row) * 2)
const posOf = (row: Row, y: number) => Math.min(100, Math.max(0, (1 - (y - row.y - padOf(row)) / (row.h - padOf(row) * 2)) * 100))

type Drag =
  | { kind: 'scrub'; last: number }
  | { kind: 'move'; x: number; y: number; row: Row; before: EditorPoint[]; selection: ReadonlySet<number>; startMs: number; zoomMs: number }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; row: Row; add: boolean }
  | { kind: 'adjust'; row: Row; at: number; before: EditorPoint[]; startMs: number; zoomMs: number }
  | { kind: 'pan'; x: number; startMs: number }

export function Lanes() {
  const t = useT()
  const lanes = useEditor((s) => s.lanes)
  const hidden = useEditor((s) => s.hidden)
  const focused = useEditor((s) => s.focused)
  const linked = useEditor((s) => s.linked)
  const tool = useEditor((s) => s.tool)
  const recording = useEditor((s) => s.recording)
  const shown = useMemo(() => lanes.filter((l) => !hidden.includes(l.axis)), [lanes, hidden])
  const addable = useMemo(() => addableAxes({ lanes }), [lanes])
  const plotRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [height, setHeight] = useState(0)
  const rows = useMemo(() => layoutRows(height, shown, focused), [height, shown, focused])
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const drag = useRef<Drag | null>(null)
  const [dragKind, setDragKind] = useState<Drag['kind'] | null>(null)
  const e = useEditor.getState

  useEffect(() => {
    const el = plotRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let handle = 0
    const draw = () => {
      handle = 0
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dpr = window.devicePixelRatio
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paint(ctx, w, h, rowsRef.current, drag.current)
    }
    const schedule = () => {
      if (!handle) handle = requestAnimationFrame(draw)
    }
    schedule()
    const unsubscribe = [useEditor.subscribe(schedule), live.subscribe(schedule)]
    const ro = new ResizeObserver(schedule)
    ro.observe(canvas)
    return () => {
      cancelAnimationFrame(handle)
      ro.disconnect()
      for (const u of unsubscribe) u()
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const s = e()
      const w = canvas.clientWidth
      if (ev.ctrlKey || ev.metaKey) {
        const start = windowStart(s.view, live.get().timeMs, s.durationMs)
        const anchorMs = xToTime(ev.offsetX, start, s.view.zoomMs, w)
        s.setView(zoomAround({ ...s.view, follow: false, startMs: start }, ev.deltaY > 0 ? 1.15 : 1 / 1.15, anchorMs, ev.offsetX / w, s.durationMs))
      } else {
        const delta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY
        s.panBy((delta / w) * s.view.zoomMs)
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [e])

  const local = (ev: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect()
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, w: rect.width }
  }
  const timeAt = (x: number, w: number) => {
    const s = e()
    return xToTime(x, windowStart(s.view, live.get().timeMs, s.durationMs), s.view.zoomMs, w)
  }
  const hitPoint = (row: Row, x: number, y: number, w: number): EditorPoint | null => {
    const lane = e().lanes.find((l) => l.axis === row.axis)
    if (!lane) return null
    const s = e()
    const start = windowStart(s.view, live.get().timeMs, s.durationMs)
    const zoom = s.view.zoomMs
    const t = timeAt(x, w)
    const slack = (HIT_PX / w) * zoom
    let best: EditorPoint | null = null
    let dist = HIT_PX + 1
    for (let i = indexAt(lane.points, t - slack); i < lane.points.length; i++) {
      const p = lane.points[i]
      if (!p || p.at > t + slack) break
      const dx = ((p.at - start) / zoom) * w - x
      const dy = yOf(row, p.pos) - y
      const d = Math.hypot(dx, dy)
      if (d < dist) {
        dist = d
        best = p
      }
    }
    return best
  }
  const begin = (ev: ReactPointerEvent<HTMLCanvasElement>, d: Drag) => {
    drag.current = d
    setDragKind(d.kind)
    ev.currentTarget.setPointerCapture(ev.pointerId)
  }

  const onPointerDown = (ev: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y, w } = local(ev)
    const s = e()
    if (ev.button === 1) {
      begin(ev, { kind: 'pan', x, startMs: windowStart(s.view, live.get().timeMs, s.durationMs) })
      return
    }
    if (y < RULER_H) {
      if (ev.button === 0) {
        s.seekTo(timeAt(x, w))
        begin(ev, { kind: 'scrub', last: performance.now() })
      }
      return
    }
    const row = rowsRef.current.find((r) => y >= r.y && y < r.y + r.h)
    if (!row) return
    if (!row.focused) {
      s.setFocused(row.axis)
      return
    }
    if (s.recording) return
    const hit = hitPoint(row, x, y, w)
    if (ev.button === 2) {
      if (hit) s.removePoint(hit.at)
      return
    }
    if (ev.button !== 0) return
    const start = windowStart(s.view, live.get().timeMs, s.durationMs)
    if (hit) {
      if (ev.shiftKey) s.select([hit.at], 'toggle')
      else if (!s.selection.has(hit.at)) s.select([hit.at])
      const lane = s.lanes.find((l) => l.axis === row.axis)
      if (!lane) return
      s.beginDrag()
      begin(ev, { kind: 'move', x, y, row, before: lane.points, selection: e().selection, startMs: start, zoomMs: s.view.zoomMs })
      return
    }
    if (s.tool === 'place') {
      const t = timeAt(x, w)
      s.placeAt(posOf(row, y), ev.altKey, t)
      const lane = e().lanes.find((l) => l.axis === row.axis)
      const placed = e().selection.values().next().value
      if (!lane || typeof placed !== 'number') return
      s.beginDrag()
      begin(ev, { kind: 'adjust', row, at: placed, before: lane.points, startMs: start, zoomMs: s.view.zoomMs })
      return
    }
    begin(ev, { kind: 'box', x0: x, y0: y, x1: x, y1: y, row, add: ev.shiftKey })
  }

  const onPointerMove = (ev: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y, w } = local(ev)
    const s = e()
    if (s.recording && s.recordInput === 'mouse') {
      const row = rowsRef.current.find((r) => r.focused)
      if (row) s.recordValue(posOf(row, y))
    }
    const d = drag.current
    if (!d) return
    switch (d.kind) {
      case 'scrub': {
        const now = performance.now()
        if (now - d.last < SCRUB_THROTTLE_MS) return
        d.last = now
        s.seekTo(timeAt(x, w))
        return
      }
      case 'pan':
        s.setView({ ...s.view, follow: false, startMs: d.startMs - ((x - d.x) / w) * s.view.zoomMs })
        return
      case 'move': {
        const dMs = ((x - d.x) / w) * d.zoomMs
        const dPos = posOf(d.row, y) - posOf(d.row, d.y)
        s.dragLane(moveOp(d.before, d.selection, dPos, dMs))
        return
      }
      case 'adjust': {
        const t = Math.round(xToTime(x, d.startMs, d.zoomMs, w))
        const pos = posOf(d.row, y)
        s.dragLane(normalise([...d.before.filter((p) => p.at !== d.at), { at: t, pos }]))
        return
      }
      case 'box':
        d.x1 = x
        d.y1 = y
        return
    }
  }

  const onPointerUp = (ev: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d) return
    const { w } = local(ev)
    const s = e()
    drag.current = null
    setDragKind(null)
    if (d.kind === 'move' || d.kind === 'adjust') {
      s.endDrag()
      if (d.kind === 'adjust') {
        const lane = e().lanes.find((l) => l.axis === d.row.axis)
        const t = Math.round(xToTime(local(ev).x, d.startMs, d.zoomMs, w))
        const placed = lane?.points.find((p) => Math.abs(p.at - t) <= 1)
        if (placed) s.select([placed.at])
      }
    } else if (d.kind === 'box') {
      const moved = Math.abs(d.x1 - d.x0) > 3 || Math.abs(d.y1 - d.y0) > 3
      if (!moved) {
        if (!d.add) s.selectNone()
        return
      }
      const t0 = timeAt(Math.min(d.x0, d.x1), w)
      const t1 = timeAt(Math.max(d.x0, d.x1), w)
      const p0 = posOf(d.row, Math.max(d.y0, d.y1))
      const p1 = posOf(d.row, Math.min(d.y0, d.y1))
      s.selectBox(t0, t1, p0, p1, d.add)
    }
  }

  return (
    <div className="ed-tl-body">
      <div className="ed-gutter">
        <div className="head">
          <button type="button" className={cx('ed-btn', linked && 'on')} aria-pressed={linked} title={t('editor.screen.withKey', { label: t('editor.lanes.linkedLanes'), key: keyLabel('Editor.Linked.Toggle') })} onClick={() => e().toggleLinked()}>
            <Link />
            {t('editor.lanes.linked')}
          </button>
          <span className="grow" />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="ed-btn square" aria-label={t('editor.lanes.addLane')} title={t('editor.lanes.addLane')} disabled={addable.length === 0}>
                <Plus />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" align="start" sideOffset={6}>
                {addable.map((axis) => (
                  <DropdownMenu.Item key={axis} className="item" onSelect={() => e().addLane(axis)}>
                    <span className="mono">{AXIS_LABEL[axis]}</span>
                    {t(AXIS_NAME[axis])}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        {rows.map((row) => (
          <LaneName key={row.axis} row={row} canHide={shown.length > 1} />
        ))}
      </div>
      <div ref={plotRef} className="ed-plot">
        <canvas
          ref={canvasRef}
          data-tool={tool}
          data-drag={dragKind ?? undefined}
          data-recording={recording || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(ev) => ev.preventDefault()}
        />
      </div>
    </div>
  )
}

function LaneName({ row, canHide }: { row: Row; canHide: boolean }) {
  const t = useT()
  const value = useRef<HTMLSpanElement>(null)
  const setFocused = useEditor((s) => s.setFocused)
  const hideLane = useEditor((s) => s.hideLane)
  live.useLive(
    (l) => {
      const lane = useEditor.getState().lanes.find((x) => x.axis === row.axis)
      const text = String(Math.round(valueAt(lane?.points ?? [], l.timeMs)))
      const el = value.current
      if (el && el.firstChild?.textContent !== text) {
        if (el.firstChild) el.firstChild.textContent = text
        else el.textContent = text
      }
    },
    [row.axis],
  )
  return (
    <div className={cx('ed-lane-name', row.focused && 'focused')} style={{ height: row.h }} role="button" tabIndex={0} aria-label={t('editor.lanes.focusAxis', { axis: t(AXIS_NAME[row.axis]) })} aria-pressed={row.focused} onClick={() => setFocused(row.axis)} onKeyDown={(ev) => ev.key === 'Enter' && setFocused(row.axis)}>
      <span className="code">{AXIS_LABEL[row.axis]}</span>
      <span className="label">{t(AXIS_NAME[row.axis])}</span>
      <span ref={value} className="value">
        {Math.round(valueAt(useEditor.getState().lanes.find((x) => x.axis === row.axis)?.points ?? [], live.get().timeMs))}
        {row.focused && <small> / 100</small>}
      </span>
      {canHide && (
        <button
          type="button"
          className="hide"
          aria-label={t('editor.lanes.hideAxis', { axis: t(AXIS_NAME[row.axis]) })}
          title={t('editor.lanes.hideLane')}
          onClick={(ev) => {
            ev.stopPropagation()
            hideLane(row.axis)
          }}
        >
          <EyeOff />
        </button>
      )}
    </div>
  )
}

const tickLabel = (ms: number, stepMs: number) => (stepMs >= 1000 ? fmtTimecode(ms).slice(0, 5) : fmtTimecode(ms).slice(0, 7))

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, rows: Row[], drag: Drag | null) {
  const s = useEditor.getState()
  const timeMs = live.get().timeMs
  const start = windowStart(s.view, timeMs, s.durationMs)
  const zoom = s.view.zoomMs
  const end = start + zoom
  const x = (t: number) => ((t - start) / zoom) * w
  ctx.clearRect(0, 0, w, h)

  for (const row of rows) {
    if (row.focused) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)'
      ctx.fillRect(0, row.y, w, row.h)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)'
      ctx.beginPath()
      for (const p of [0, 50, 100]) {
        const yy = Math.round(yOf(row, p)) + 0.5
        ctx.moveTo(0, yy)
        ctx.lineTo(w, yy)
      }
      ctx.stroke()
      ctx.fillStyle = 'rgba(146, 153, 166, 0.8)'
      ctx.font = '9px ui-monospace, Menlo, monospace'
      ctx.textBaseline = 'middle'
      ctx.fillText('100', 6, yOf(row, 100))
      ctx.fillText('50', 6, yOf(row, 50))
      ctx.fillText('0', 6, yOf(row, 0))
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.035)'
    ctx.fillRect(0, row.y + row.h - 1, w, 1)
  }
  ctx.fillStyle = '#0f1218'
  ctx.fillRect(0, 0, w, RULER_H)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.fillRect(0, RULER_H - 1, w, 1)

  if (s.loop.on && s.loop.inMs !== null && s.loop.outMs !== null) {
    ctx.fillStyle = 'rgba(94, 224, 160, 0.06)'
    ctx.fillRect(x(s.loop.inMs), RULER_H, x(s.loop.outMs) - x(s.loop.inMs), h - RULER_H)
  }

  const step = tickStepMs(zoom, w)
  ctx.font = '10px ui-monospace, Menlo, monospace'
  ctx.fillStyle = 'rgba(146, 153, 166, 1)'
  ctx.textBaseline = 'top'
  ctx.textAlign = 'center'
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
    const xx = x(t)
    ctx.fillText(tickLabel(t, step), xx, 9)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.19)'
    ctx.fillRect(Math.round(xx), 23, 1, 5)
    ctx.fillStyle = 'rgba(146, 153, 166, 1)'
  }
  const frameMs = 1000 / Math.max(1, s.fps)
  if ((frameMs / zoom) * w >= 6) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)'
    for (let t = Math.ceil(start / frameMs) * frameMs; t <= end; t += frameMs) ctx.fillRect(Math.round(x(t)), 27, 1, 3)
  }
  ctx.textAlign = 'left'
  for (const c of s.chapters) {
    if (c.endMs < start || c.startMs > end) continue
    const x0 = Math.max(0, x(c.startMs))
    const x1 = Math.min(w, x(Math.max(c.endMs, c.startMs + 1)))
    ctx.fillStyle = 'rgba(183, 163, 255, 0.22)'
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), 4)
    ctx.fillStyle = 'rgba(183, 163, 255, 0.9)'
    ctx.fillText(c.name, x0 + 3, 0)
  }
  for (const b of s.bookmarks) {
    if (b.atMs < start || b.atMs > end) continue
    ctx.fillStyle = ACCENT
    ctx.fillRect(Math.round(x(b.atMs)) - 1, RULER_H - 7, 3, 6)
  }
  ctx.fillStyle = '#ffb547'
  for (const f of s.flags) {
    if (f < start || f > end) continue
    const fx = Math.round(x(f))
    ctx.fillRect(fx, RULER_H - 13, 1, 12)
    ctx.beginPath()
    ctx.moveTo(fx + 1, RULER_H - 13)
    ctx.lineTo(fx + 9, RULER_H - 10)
    ctx.lineTo(fx + 1, RULER_H - 7)
    ctx.closePath()
    ctx.fill()
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
  ctx.beginPath()
  for (const c of analysis.cuts(start, end)) {
    const xx = Math.round(x(c)) + 0.5
    ctx.moveTo(xx, RULER_H)
    ctx.lineTo(xx, h)
  }
  ctx.stroke()
  if (s.beatGrid && s.beats) {
    ctx.strokeStyle = 'rgba(189, 173, 123, 0.19)'
    ctx.setLineDash([2, 4])
    ctx.beginPath()
    for (let i = indexAtNumber(s.beats, start); i < s.beats.length; i++) {
      const b = s.beats[i]
      if (b === undefined || b > end) break
      const xx = Math.round(x(b)) + 0.5
      ctx.moveTo(xx, RULER_H)
      ctx.lineTo(xx, h)
    }
    ctx.stroke()
    ctx.setLineDash([])
  }

  const selection = s.selection
  for (const row of rows) {
    const lane = s.lanes.find((l) => l.axis === row.axis)
    if (!lane) continue
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, row.y, w, row.h)
    ctx.clip()
    if (row.focused && s.trace) {
      const samples = analysis.samples(start, end)
      if (samples.length > 1) {
        ctx.beginPath()
        samples.forEach((sm, i) => {
          if (i === 0) ctx.moveTo(x(sm.t), yOf(row, sm.v))
          else ctx.lineTo(x(sm.t), yOf(row, sm.v))
        })
        ctx.strokeStyle = 'rgba(176, 185, 207, 0.28)'
        ctx.lineWidth = 1.2
        ctx.stroke()
        const last = samples[samples.length - 1]
        const first = samples[0]
        if (last && first) {
          ctx.lineTo(x(last.t), yOf(row, 0))
          ctx.lineTo(x(first.t), yOf(row, 0))
          ctx.closePath()
          ctx.fillStyle = 'rgba(177, 187, 213, 0.045)'
          ctx.fill()
        }
      }
    }
    const points = lane.points
    const selectedHere = row.focused || s.linked
    const from = Math.max(0, indexAt(points, start) - 1)
    ctx.lineWidth = row.focused ? 1.65 : 1.1
    let last: EditorPoint | undefined = points[from]
    for (let i = from + 1; i < points.length; i++) {
      const p = points[i]
      if (!p || !last) break
      const dt = p.at - last.at
      const speed = dt > 0 ? (Math.abs(p.pos - last.pos) * 1000) / dt : 0
      const both = selectedHere && selection.has(p.at) && selection.has(last.at)
      ctx.strokeStyle = both ? ACCENT : heatColor(speed)
      ctx.globalAlpha = row.focused ? 0.94 : 0.65
      ctx.beginPath()
      ctx.moveTo(x(last.at), yOf(row, last.pos))
      ctx.lineTo(x(p.at), yOf(row, p.pos))
      ctx.stroke()
      last = p
      if (p.at > end) break
    }
    ctx.globalAlpha = 1
    if (row.focused) {
      for (let i = Math.max(0, indexAt(points, start) - 1); i < points.length; i++) {
        const p = points[i]
        if (!p) break
        if (p.at > end) break
        const sel = selection.has(p.at)
        ctx.beginPath()
        ctx.arc(x(p.at), yOf(row, p.pos), sel ? 3 : 2.2, 0, Math.PI * 2)
        ctx.fillStyle = sel ? '#cbbaff' : '#11151f'
        ctx.fill()
        ctx.strokeStyle = sel ? '#e0d3ff' : 'rgba(210, 214, 225, 0.75)'
        ctx.lineWidth = 1.25
        ctx.stroke()
      }
    }
    const g = s.ghost
    const ghostHere = g && (g.axis === row.axis || g.extra?.some((ex) => ex.axis === row.axis))
    if (g && ghostHere) {
      const strokes = g.axis === row.axis ? s.ghostStrokes() : [g.extra?.find((ex) => ex.axis === row.axis)?.points ?? []]
      strokes.forEach((stroke, i) => {
        if (stroke.length === 0) return
        const active = g.walk === -1 || g.walk === i || g.axis !== row.axis
        if (g.walk === i && g.axis === row.axis) {
          ctx.fillStyle = 'rgba(183, 163, 255, 0.055)'
          ctx.fillRect(x(stroke[0]?.at ?? 0), row.y, x(stroke[stroke.length - 1]?.at ?? 0) - x(stroke[0]?.at ?? 0), row.h)
        }
        ctx.globalAlpha = active ? 1 : 0.38
        ctx.strokeStyle = g.kind === 'recording' ? '#f19ba8' : ACCENT_SOFT
        ctx.lineWidth = g.walk === i ? 2.4 : 1.8
        ctx.setLineDash([5, 4])
        ctx.beginPath()
        stroke.forEach((p, k) => {
          if (k === 0) ctx.moveTo(x(p.at), yOf(row, p.pos))
          else ctx.lineTo(x(p.at), yOf(row, p.pos))
        })
        ctx.stroke()
        ctx.setLineDash([])
        for (const p of stroke) {
          ctx.beginPath()
          ctx.arc(x(p.at), yOf(row, p.pos), 2.8, 0, Math.PI * 2)
          ctx.fillStyle = '#191b29'
          ctx.fill()
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      })
    }
    ctx.restore()
  }

  if (drag?.kind === 'box') {
    ctx.fillStyle = 'rgba(183, 163, 255, 0.08)'
    ctx.strokeStyle = 'rgba(183, 163, 255, 0.5)'
    const bx = Math.min(drag.x0, drag.x1)
    const by = Math.min(drag.y0, drag.y1)
    ctx.fillRect(bx, by, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0))
    ctx.strokeRect(bx + 0.5, by + 0.5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0))
  }

  const px = Math.round(x(timeMs)) + 0.5
  ctx.strokeStyle = '#d8ceff'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(px, 0)
  ctx.lineTo(px, h)
  ctx.stroke()
  const label = fmtTimecode(timeMs)
  ctx.font = '600 10px ui-monospace, Menlo, monospace'
  const tw = ctx.measureText(label).width + 12
  ctx.fillStyle = ACCENT
  ctx.beginPath()
  ctx.roundRect(px - tw / 2, 4, tw, 17, 4)
  ctx.fill()
  ctx.fillStyle = '#15102a'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, px, 12.5)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  if (s.trace && s.key) s.wantAnalysis(start, end)
}

function indexAtNumber(list: number[], t: number): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((list[mid] ?? Infinity) < t) lo = mid + 1
    else hi = mid
  }
  return lo
}
