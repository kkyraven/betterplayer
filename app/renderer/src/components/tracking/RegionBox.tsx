import { Check } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Rect, Region } from '@shared/browser'
import { REGION_TARGET_LABEL, zoneName } from '@shared/tracking'
import { useT } from '@/state/i18n'
import { usePlayer } from '@/state/player'
import { useSettings } from '@/state/settings'
import { targetLabel, useTracking } from '@/state/tracking'
import { cx } from '@/lib/cx'
import './RegionBox.css'

type Corner = 'nw' | 'ne' | 'sw' | 'se'
const CORNERS: readonly Corner[] = ['nw', 'ne', 'sw', 'se']
const MIN_REGION = 0.05
const MIN_ZONE = 0.01
const ZONE_SETTLE_MS = 10_000

const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v)

function fitRect(stage: HTMLElement, vw: number, vh: number): Rect | null {
  if (!vw || !vh) return null
  const W = stage.clientWidth
  const H = stage.clientHeight
  const scale = Math.min(W / vw, H / vh)
  const w = vw * scale
  const h = vh * scale
  return { x: (W - w) / 2, y: (H - h) / 2, w, h }
}

interface DragBoxProps {
  region: Region
  label: string
  fixed?: boolean
  gone?: boolean
  kind?: 'region' | 'zone' | 'effect'
  active?: boolean
  min?: number
  onChange: (region: Region) => void
  onDrag?: (active: boolean) => void
  action?: ReactNode
}

export function DragBox({ region, label, fixed = false, gone = false, kind = 'region', active = false, min = MIN_REGION, onChange, onDrag, action }: DragBoxProps) {
  const flat = usePlayer((s) => s.projection.kind === 'flat')
  const vw = usePlayer((s) => s.snapshot.videoWidth)
  const vh = usePlayer((s) => s.snapshot.videoHeight)
  const root = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<Rect | null>(null)
  const [live, setLive] = useState<Region | null>(null)
  const drag = useRef<{ corner: Corner | null; x: number; y: number; from: Region; rect: Rect } | null>(null)

  useEffect(() => {
    if (!flat) return
    const stage = root.current?.parentElement
    if (!stage) return
    const measure = () => setBox(fitRect(stage, vw, vh))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [flat, vw, vh])

  if (!flat || !box) return <div ref={root} hidden />
  const shown = live ?? region

  const start = (e: ReactPointerEvent, corner: Corner | null) => {
    if (e.button !== 0 || fixed) return
    e.preventDefault()
    e.stopPropagation()
    drag.current = { corner, x: e.clientX, y: e.clientY, from: region, rect: box }
    e.currentTarget.setPointerCapture(e.pointerId)
    onDrag?.(true)
  }
  const move = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x) / d.rect.w
    const dy = (e.clientY - d.y) / d.rect.h
    const from = d.from
    if (!d.corner) {
      setLive({ ...from, x: clamp(from.x + dx, 0, 1 - from.w), y: clamp(from.y + dy, 0, 1 - from.h) })
      return
    }
    const west = d.corner === 'nw' || d.corner === 'sw'
    const north = d.corner === 'nw' || d.corner === 'ne'
    const left = west ? clamp(from.x + dx, 0, from.x + from.w - min) : from.x
    const top = north ? clamp(from.y + dy, 0, from.y + from.h - min) : from.y
    const right = west ? from.x + from.w : clamp(from.x + from.w + dx, from.x + min, 1)
    const bottom = north ? from.y + from.h : clamp(from.y + from.h + dy, from.y + min, 1)
    setLive({ x: left, y: top, w: right - left, h: bottom - top })
  }
  const end = () => {
    if (!drag.current) return
    drag.current = null
    if (live) onChange(live)
    setLive(null)
    onDrag?.(false)
  }

  const left = box.x + shown.x * box.w
  const top = box.y + shown.y * box.h
  const width = shown.w * box.w
  const height = shown.h * box.h
  return (
    <div ref={root} className={cx('region-layer', gone && 'gone')}>
      {!fixed && kind === 'region' && (
        <>
          <i className="region-shade" style={{ left: 0, top: 0, right: 0, height: top }} />
          <i className="region-shade" style={{ left: 0, top: top + height, right: 0, bottom: 0 }} />
          <i className="region-shade" style={{ left: 0, top, width: left, height }} />
          <i className="region-shade" style={{ left: left + width, top, right: 0, height }} />
        </>
      )}
      <div
        className={cx('region-box', fixed && 'auto', gone && 'gone', kind !== 'region' && kind, active && 'on')}
        style={{ left, top, width, height }}
        onPointerDown={(e) => start(e, null)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <span>{label}</span>
        {action && (
          <div className="region-action" onPointerDown={(e) => e.stopPropagation()}>
            {action}
          </div>
        )}
        {!fixed && CORNERS.map((c) => <b key={c} className={c} onPointerDown={(e) => start(e, c)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />)}
      </div>
    </div>
  )
}

export function RegionBox() {
  const t = useT()
  const source = useTracking((s) => s.source)
  const regionSource = useTracking((s) => s.regionSource)
  const picked = useTracking((s) => s.region)
  const shown = useTracking((s) => s.regionShown)
  const ax = useTracking((s) => s.state?.region?.x)
  const ay = useTracking((s) => s.state?.region?.y)
  const aw = useTracking((s) => s.state?.region?.w)
  const ah = useTracking((s) => s.state?.region?.h)
  const autoRegion = useMemo<Region | null>(() => (ax === undefined || ay === undefined || aw === undefined || ah === undefined ? null : { x: ax, y: ay, w: aw, h: ah }), [ax, ay, aw, ah])
  const found = useTracking((s) => targetLabel(s.state?.detector.found?.class))
  const target = useTracking((s) => s.regionTarget)
  const showBox = useSettings((s) => s.settings?.tracking.showBox ?? true)
  const setRegion = useTracking((s) => s.setRegion)
  const auto = regionSource === 'auto'
  const [dragging, setDragging] = useState(false)
  const region = auto ? (showBox ? autoRegion : null) : regionSource === 'pick' ? picked : null
  if (source !== 'player' || !region) return null
  return <DragBox region={region} label={auto ? (found ?? (target ? t(REGION_TARGET_LABEL[target]) : t('common.auto'))) : t('tracking.region')} fixed={auto} gone={!shown && !dragging} onChange={setRegion} onDrag={setDragging} />
}

function useZoneMode(shown: boolean) {
  const t = useT()
  const editing = useTracking((s) => s.zoneEdit)
  const setEditing = useTracking((s) => s.setZoneEdit)
  const settle = useRef(0)
  const dragging = useRef(false)
  const arm = (active: boolean) => {
    dragging.current = active
    window.clearTimeout(settle.current)
    if (!active) settle.current = window.setTimeout(() => setEditing(false), ZONE_SETTLE_MS)
  }
  useEffect(() => {
    if (!editing || !shown) return
    if (!dragging.current) arm(false)
    return () => {
      window.clearTimeout(settle.current)
      setEditing(false)
    }
  }, [editing, shown])
  const onDrag = (active: boolean) => {
    if (active) setEditing(true)
    arm(active)
  }
  const done = editing ? (
    <button type="button" className="zone-done" aria-label={t('common.done')} title={t('common.done')} onClick={() => setEditing(false)}>
      <Check />
      {t('common.done')}
    </button>
  ) : null
  return { editing, onDrag, done }
}

export function ZoneBox() {
  const t = useT()
  const source = useTracking((s) => s.source)
  const zone = useTracking((s) => s.heroZone)
  const hero = useTracking((s) => Object.values(s.axes).some((a) => a.source === 'hero' || (s.heroMusic.enabled && a.source === 'ai-music')))
  const setZone = useTracking((s) => s.setHeroZone)
  const shown = source === 'player' && hero && !!zone
  const { onDrag, done } = useZoneMode(shown)
  if (!shown) return null
  return <DragBox region={zone} label={t('tracking.zone')} kind="zone" min={MIN_ZONE} onChange={setZone} onDrag={onDrag} action={done} />
}

export function ZoneBoxes() {
  const t = useT()
  const source = useTracking((s) => s.source)
  const zones = useTracking((s) => s.zones)
  const matches = useTracking((s) => s.zoneMatches)
  const wanted = useTracking((s) => s.zonesShown)
  const editing = useTracking((s) => s.zoneEdit)
  const update = useTracking((s) => s.updateZone)
  const shown = source === 'player' && zones.enabled && zones.zones.length > 0 && (wanted || editing)
  const { onDrag, done } = useZoneMode(shown)
  if (!shown) return null
  return (
    <>
      {zones.zones.map((z, i) => (
        <DragBox key={z.id} region={z.region} label={zoneName(i, t)} kind="effect" active={matches.find((m) => m.id === z.id)?.active ?? false} min={MIN_ZONE} onChange={(region) => update(z.id, { region })} onDrag={onDrag} action={i === 0 ? done : null} />
      ))}
    </>
  )
}
