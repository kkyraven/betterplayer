import { useEffect, useRef } from 'react'
import * as live from '@/state/live'
import './LiveMarker.css'

interface MarkerProps {
  axis: string
  min?: number
  max?: number
}

export function LiveMarker({ axis, min = 0, max = 1 }: MarkerProps) {
  const ref = useRef<HTMLElement>(null)
  const index = live.axisIndex(axis)
  useEffect(() => {
    const el = ref.current
    if (!el || index < 0) return
    let last = -1
    const write = (l: live.Live) => {
      const p = min + (l.axisValues[index] ?? 0) * (max - min)
      if (p === last) return
      last = p
      el.style.setProperty('--p', String(p))
    }
    write(live.get())
    return live.subscribe(write)
  }, [index, min, max])
  if (index < 0) return null
  return <em ref={ref} className="live-mark" />
}
