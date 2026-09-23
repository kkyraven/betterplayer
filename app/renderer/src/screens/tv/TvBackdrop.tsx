import { useEffect, useState, type RefObject } from 'react'
import { cx } from '@/lib/cx'
import { useSettings } from '@/state/settings'
import { useUi } from '@/state/ui'

const DEBOUNCE_MS = 150

export function TvBackdrop({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const enabled = useSettings((s) => s.settings?.tv.backdrop ?? false)
  const reduce = useUi((s) => s.reduceTransparency)
  const on = enabled && !reduce
  const [layers, setLayers] = useState<{ a: string | null; b: string | null; front: 'a' | 'b' }>({ a: null, b: null, front: 'a' })
  useEffect(() => {
    const el = container.current
    if (!on || !el) return
    let timer = 0
    const onFocus = (e: FocusEvent) => {
      const card = e.target instanceof Element ? e.target.closest('.card') : null
      const src = card?.querySelector<HTMLImageElement>('img.poster')?.src ?? null
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        setLayers((l) => {
          const current = l.front === 'a' ? l.a : l.b
          if (current === src) return l
          const back = l.front === 'a' ? 'b' : 'a'
          return { ...l, [back]: src, front: back }
        })
      }, DEBOUNCE_MS)
    }
    el.addEventListener('focusin', onFocus)
    return () => {
      window.clearTimeout(timer)
      el.removeEventListener('focusin', onFocus)
    }
  }, [on, container])
  if (!on) return null
  return (
    <div className="tv-backdrop" aria-hidden>
      {layers.a && <img src={layers.a} alt="" className={cx(layers.front === 'a' && 'on')} />}
      {layers.b && <img src={layers.b} alt="" className={cx(layers.front === 'b' && 'on')} />}
    </div>
  )
}
