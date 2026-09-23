import { useMemo } from 'react'
import { heatGradient } from '@/lib/heatmap'
import './HeatStrip.css'

interface Props {
  heat: readonly number[]
  className?: string
}

export function HeatStrip({ heat, className }: Props) {
  const backgroundImage = useMemo(() => heatGradient(heat), [heat])
  return <div className={className ? `heat-strip ${className}` : 'heat-strip'} style={{ backgroundImage }} aria-hidden="true" />
}
