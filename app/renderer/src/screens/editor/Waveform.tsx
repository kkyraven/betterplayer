import { useEffect, useRef } from 'react'
import { windowStart } from '@/editor/view'
import { useEditor } from '@/state/editor'
import * as live from '@/state/live'
import { useT } from '@/state/i18n'

export function Waveform() {
  const t = useT()
  const ref = useRef<HTMLCanvasElement>(null)
  const peaks = useEditor((s) => s.peaks)
  const ensurePeaks = useEditor((s) => s.ensurePeaks)
  useEffect(() => {
    void ensurePeaks()
  }, [ensurePeaks])
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let handle = 0
    const draw = () => {
      handle = 0
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const s = useEditor.getState()
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dpr = window.devicePixelRatio
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (!peaks) return
      const start = windowStart(s.view, live.get().timeMs, s.durationMs)
      const zoom = s.view.zoomMs
      ctx.fillStyle = 'rgba(169, 178, 197, 0.35)'
      const perBin = 1000 / peaks.hz
      for (let x = 0; x < w; x += 2) {
        const t0 = start + (x / w) * zoom
        const t1 = start + ((x + 2) / w) * zoom
        let m = 0
        for (let i = Math.floor(t0 / perBin); i <= Math.floor(t1 / perBin); i++) m = Math.max(m, peaks.peaks[i] ?? 0)
        const bar = Math.max(1, m * (h - 2))
        ctx.fillRect(x, (h - bar) / 2, 1.5, bar)
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
  }, [peaks])
  return (
    <div className="ed-waveform" aria-label={t('editor.toolStrip.waveform')}>
      <canvas ref={ref} />
    </div>
  )
}
