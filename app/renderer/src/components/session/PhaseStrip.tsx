import { useRef } from 'react'
import type { SessionPhase } from '@shared/session'
import * as live from '@/state/live'
import { sessionElapsedMs, useSession } from '@/state/session'
import './session.css'

export function phaseTone(intensity: number | null): 'high' | 'mid' | 'low' | 'none' {
  if (intensity === null) return 'none'
  return intensity >= 0.6 ? 'high' : intensity >= 0.35 ? 'mid' : 'low'
}

const W = 1000

export function PhaseStrip({ phases, totalMs }: { phases: SessionPhase[]; totalMs: number }) {
  const head = useRef<SVGLineElement>(null)
  const plan = useSession((s) => s.plan)
  const index = useSession((s) => s.index)
  live.useLive(
    (l) => {
      const x = totalMs > 0 ? (Math.min(totalMs, sessionElapsedMs(plan, index, l.timeMs)) / totalMs) * W : 0
      head.current?.setAttribute('transform', `translate(${x.toFixed(1)} 0)`)
    },
    [plan, index, totalMs],
  )
  return (
    <svg className="phase-strip" viewBox={`0 0 ${W} 8`} preserveAspectRatio="none" aria-hidden="true">
      {phases.map((p, i) => {
        const x = (p.startMs / totalMs) * W
        const w = ((p.endMs - p.startMs) / totalMs) * W
        const mid = p.from === null || p.to === null ? null : (p.from + p.to) / 2
        return <rect key={i} x={x.toFixed(1)} y="0" width={Math.max(0, w - 1).toFixed(1)} height="8" rx="1.5" className={`tone-${phaseTone(mid)}`} />
      })}
      <line ref={head} x1="0" x2="0" y1="-2" y2="10" className="phase-head" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
