import { useEffect, useRef } from 'react'
import { analysis, useEditor } from '@/state/editor'
import type { Thumb } from '@/editor/analysis'
import { windowStart } from '@/editor/view'
import * as live from '@/state/live'
import { useT } from '@/state/i18n'

const bitmaps = new Map<number, ImageBitmap | Promise<ImageBitmap>>()

function bitmapFor(t: Thumb): ImageBitmap | null {
  const have = bitmaps.get(t.timeMs)
  if (have instanceof ImageBitmap) return have
  if (have) return null
  const rgba = new Uint8ClampedArray(t.width * t.height * 4)
  for (let i = 0, j = 0; i < t.rgb.length; i += 3, j += 4) {
    rgba[j] = t.rgb[i] ?? 0
    rgba[j + 1] = t.rgb[i + 1] ?? 0
    rgba[j + 2] = t.rgb[i + 2] ?? 0
    rgba[j + 3] = 255
  }
  const p = createImageBitmap(new ImageData(rgba, t.width, t.height))
  bitmaps.set(t.timeMs, p)
  void p.then((b) => bitmaps.set(t.timeMs, b))
  return null
}

export function Filmstrip() {
  const t = useT()
  const ref = useRef<HTMLCanvasElement>(null)
  const version = useEditor((s) => s.analysisVersion)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let handle = 0
    const draw = () => {
      handle = 0
      const ctx = canvas.getContext('2d')
      const s = useEditor.getState()
      if (!ctx) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dpr = window.devicePixelRatio
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const start = windowStart(s.view, live.get().timeMs, s.durationMs)
      const zoom = s.view.zoomMs
      for (const t of analysis.thumbs(start - 1000, start + zoom)) {
        const b = bitmapFor(t)
        const x = ((t.timeMs - start) / zoom) * w
        const tw = (b?.width ?? 96) * (h / (b?.height ?? 54))
        if (b) ctx.drawImage(b, x, 0, tw, h)
        else ctx.fillRect(x, 0, tw, h)
      }
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
  }, [version])
  return (
    <div className="ed-filmstrip" aria-label={t('editor.toolStrip.filmstrip')}>
      <canvas ref={ref} />
    </div>
  )
}
