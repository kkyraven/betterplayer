import { useId, useMemo } from 'react'
import type { SessionPhase } from '@shared/session'
import './session.css'

interface Props {
  phases: SessionPhase[]
  totalMs: number
  height?: number
}

const W = 1000
const PAD = 2

export function PacingCurve({ phases, totalMs, height = 56 }: Props) {
  const fillId = useId()
  const paths = useMemo(() => {
    if (totalMs <= 0 || phases.length === 0) return null
    const y = (v: number) => PAD + (1 - v) * (height - PAD * 2)
    const x = (ms: number) => (ms / totalMs) * W
    if (phases.every((p) => p.from === null)) return { line: `M0 ${y(0.5)} H${W}`, area: null }
    const pts = phases.flatMap((p) => [
      [x(p.startMs), y(p.from ?? 0.5)],
      [x(p.endMs), y(p.to ?? 0.5)],
    ])
    const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px?.toFixed(1)} ${py?.toFixed(1)}`).join(' ')
    return { line, area: `M0 ${height} ${pts.map(([px, py]) => `L${px?.toFixed(1)} ${py?.toFixed(1)}`).join(' ')} L${W} ${height} Z` }
  }, [phases, totalMs, height])
  return (
    <svg className="pace" viewBox={`0 0 ${W} ${height}`} height={height} preserveAspectRatio="none" aria-hidden="true">
      {paths?.area && (
        <>
          <defs>
            <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.55" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0.06" />
            </linearGradient>
          </defs>
          <path d={paths.area} fill={`url(#${fillId})`} />
        </>
      )}
      {paths && <path d={paths.line} className={paths.area ? 'pace-line' : 'pace-line dashed'} vectorEffect="non-scaling-stroke" />}
    </svg>
  )
}
