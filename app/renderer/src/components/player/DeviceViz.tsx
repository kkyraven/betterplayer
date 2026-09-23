import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useDevices } from '@/state/devices'
import { useT } from '@/state/i18n'
import * as live from '@/state/live'
import { usePlayer } from '@/state/player'
import './DeviceViz.css'

const STROKER_AXES = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2', 'V0', 'V1']
const ELECTRODE_AXES = ['E1', 'E2', 'E3', 'E4']
const ELECTRODE_LABELS = ['A', 'B', 'C', 'D']
const RADIAL_AXES = ['EA', 'EB']

function useDrivenAxes(): Set<string> {
  const version = usePlayer((s) => s.snapshot.flagsVersion)
  return useMemo(() => new Set(live.axisIdsWith(live.FLAG_SCRIPT | live.FLAG_LIVE | live.FLAG_DERIVED | live.FLAG_TRACKED)), [version])
}

let previewHidden = false

export function DeviceViz() {
  const t = useT()
  const [hidden, setHidden] = useState(previewHidden)
  const axes = useDrivenAxes()
  const outputId = useDevices((s) => s.outputs.find((o) => o.config.profile === 'restim')?.id)
  const stroker = STROKER_AXES.some((a) => axes.has(a))
  if (hidden || (!stroker && outputId === undefined)) return null
  return (
    <div className="dviz">
      <button type="button" className="dviz-close" aria-label={t('player.deviceViz.hide')} title={t('player.deviceViz.hideUntilRestart')} onClick={() => { previewHidden = true; setHidden(true) }}>
        <X size={14} />
      </button>
      {stroker && <Stroker />}
      {outputId !== undefined && <RestimPreview key={outputId} outputId={outputId} />}
    </div>
  )
}

const CX = 60
const CY = 84
const TRAVEL = 52
const PITCH = 36
const ROLL = 28
const TWIST = 30

function Stroker() {
  const sleeve = useRef<SVGGElement>(null)
  const band = useRef<SVGRectElement>(null)
  const v0 = useRef<SVGGElement>(null)
  const v1 = useRef<SVGGElement>(null)
  useEffect(() => {
    const i = Object.fromEntries(STROKER_AXES.map((a) => [a, live.axisIndex(a)]))
    const at = (l: live.Live, a: string) => l.axisValues[i[a] ?? -1] ?? 0
    let last = ''
    const write = (l: live.Live) => {
      const key = STROKER_AXES.map((a) => at(l, a).toFixed(3)).join()
      if (key === last) return
      last = key
      const dy = (0.5 - at(l, 'L0')) * TRAVEL
      const dx = (at(l, 'L2') - 0.5) * 24
      const scale = 1 + (at(l, 'L1') - 0.5) * 0.3
      const pitch = (at(l, 'R2') - 0.5) * PITCH
      const roll = (0.5 - at(l, 'R1')) * ROLL
      sleeve.current?.setAttribute('transform', `translate(${CX + dx} ${CY + dy}) rotate(${pitch}) skewX(${roll}) scale(${scale})`)
      band.current?.setAttribute('x', String(-3 + (at(l, 'R0') - 0.5) * TWIST))
      v0.current?.setAttribute('opacity', at(l, 'V0').toFixed(2))
      v1.current?.setAttribute('opacity', at(l, 'V1').toFixed(2))
    }
    write(live.get())
    return live.subscribe(write)
  }, [])
  return (
    <svg className="dviz-stroker" viewBox="0 0 120 150" aria-hidden>
      <ellipse className="base" cx={CX} cy={134} rx={34} ry={9} />
      <line className="rail" x1={CX} y1={134} x2={CX} y2={30} />
      <g ref={v0} className="vibe" opacity={0}>
        <path d="M 22 66 q -9 18 0 36" />
        <path d="M 13 60 q -13 24 0 48" />
        <text x={16} y={126}>V0</text>
      </g>
      <g ref={v1} className="vibe" opacity={0}>
        <path d="M 98 66 q 9 18 0 36" />
        <path d="M 107 60 q 13 24 0 48" />
        <text x={104} y={126}>V1</text>
      </g>
      <g ref={sleeve} className="sleeve" transform={`translate(${CX} ${CY})`}>
        <clipPath id="dviz-sleeve">
          <rect x={-18} y={-30} width={36} height={60} rx={7} />
        </clipPath>
        <rect className="body" x={-18} y={-30} width={36} height={60} rx={7} />
        <rect ref={band} className="band" x={-3} y={-30} width={6} height={60} clipPath="url(#dviz-sleeve)" />
        <ellipse className="top" cx={0} cy={-30} rx={18} ry={6} />
      </g>
    </svg>
  )
}

const SENT_AXES = ['EV', 'C0', 'P0', 'P1', 'P2', 'P3']
const R = 34
const RC = 42

function RestimPreview({ outputId }: { outputId: number }) {
  const root = useRef<HTMLDivElement>(null)
  const dot = useRef<SVGCircleElement>(null)
  const radial = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const el = root.current
    if (!el) return
    const bars = ELECTRODE_AXES.map((axis) => ({ axis, row: el.querySelector<HTMLElement>(`[data-axis="${axis}"]`), fill: el.querySelector<HTMLElement>(`[data-axis="${axis}"] i`) }))
    const rows = SENT_AXES.map((axis) => ({ axis, row: el.querySelector<HTMLElement>(`[data-axis="${axis}"]`), fill: el.querySelector<HTMLElement>(`[data-axis="${axis}"] i`), text: el.querySelector<HTMLElement>(`[data-axis="${axis}"] b`) }))
    let last = ''
    const write = (state: live.Live) => {
      const output = state.outputs.find((o) => o.id === outputId)
      const sent = output?.status === 'connected' ? output.sentValues ?? {} : {}
      const key = [...RADIAL_AXES, ...ELECTRODE_AXES, ...SENT_AXES].map((axis) => sent[axis]?.toFixed(4) ?? '').join(',')
      if (key === last) return
      last = key
      el.hidden = Object.keys(sent).length === 0
      for (const { axis, row, fill } of bars) {
        const value = sent[axis]
        if (row) row.hidden = value === undefined
        fill?.style.setProperty('--p', String(value ?? 0))
      }
      for (const { axis, row, fill, text } of rows) {
        const value = sent[axis]
        if (row) row.hidden = value === undefined
        const percent = Math.round((value ?? 0) * 100)
        fill?.style.setProperty('transform', `scaleX(${value ?? 0})`)
        if (text && text.textContent !== `${percent}%`) text.textContent = `${percent}%`
      }
      const hasPosition = RADIAL_AXES.some((axis) => sent[axis] !== undefined)
      if (radial.current) radial.current.style.display = hasPosition ? '' : 'none'
      const a = (sent.EA ?? 0.5) * 2 - 1
      const b = (sent.EB ?? 0.5) * 2 - 1
      dot.current?.setAttribute('transform', `translate(${RC + a * R} ${RC - b * R})`)
      dot.current?.setAttribute('opacity', (0.35 + (sent.EV ?? 0) * 0.65).toFixed(2))
    }
    write(live.get())
    return live.subscribe(write)
  }, [outputId])
  const poles = [90, 210, 330].map((deg) => {
    const t = (deg * Math.PI) / 180
    return { x: RC + Math.cos(t) * R, y: RC - Math.sin(t) * R }
  })
  return (
    <div className="dviz-restim" ref={root} aria-hidden>
      <svg ref={radial} className="dviz-radial" viewBox="0 0 84 84">
        <circle className="ring" cx={RC} cy={RC} r={R} />
        <line className="axis" x1={RC - R} y1={RC} x2={RC + R} y2={RC} />
        <line className="axis" x1={RC} y1={RC - R} x2={RC} y2={RC + R} />
        {poles.map((p, k) => <circle key={k} className="pole" cx={p.x} cy={p.y} r={3} />)}
        <circle ref={dot} className="dot" r={5} />
      </svg>
      <div className="dviz-electrodes">
        {ELECTRODE_AXES.map((axis, i) => <span key={axis} data-axis={axis} className="eb" hidden><i /><b>{ELECTRODE_LABELS[i]}</b></span>)}
      </div>
      <div className="dviz-sent">
        {SENT_AXES.map((axis) => (
          <div key={axis} data-axis={axis} className="dviz-sent-row" hidden>
            <span>{axis === 'EV' ? 'V0' : axis}</span><span className="dviz-meter"><i /></span><b />
          </div>
        ))}
      </div>
    </div>
  )
}
