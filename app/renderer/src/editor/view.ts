export interface View {
  zoomMs: number
  startMs: number
  follow: boolean
  centre: boolean
}

export const PLAYHEAD_FRACTION = 0.35
export const ZOOM_MIN_MS = 400
export const ZOOM_MAX_MS = 20 * 60_000
export const ZOOM_DEFAULT_MS = 8000
export const ZOOM_STEP = 1.5

export const defaultView = (): View => ({ zoomMs: ZOOM_DEFAULT_MS, startMs: 0, follow: true, centre: false })

export const playheadFraction = (view: View) => (view.centre ? 0.5 : PLAYHEAD_FRACTION)

export function windowStart(view: View, timeMs: number, durationMs: number): number {
  const start = view.follow ? timeMs - view.zoomMs * playheadFraction(view) : view.startMs
  return clampStart(start, view.zoomMs, durationMs)
}

export function clampStart(startMs: number, zoomMs: number, durationMs: number): number {
  const slack = zoomMs * 0.1
  const max = Math.max(-slack, durationMs - zoomMs + slack)
  return Math.min(max, Math.max(-slack, startMs))
}

export const timeToX = (t: number, startMs: number, zoomMs: number, width: number) => ((t - startMs) / zoomMs) * width
export const xToTime = (x: number, startMs: number, zoomMs: number, width: number) => startMs + (x / width) * zoomMs

const clampZoom = (ms: number) => Math.min(ZOOM_MAX_MS, Math.max(ZOOM_MIN_MS, ms))

export function zoomAround(view: View, factor: number, anchorMs: number, anchorFraction: number, durationMs: number): View {
  const zoomMs = clampZoom(view.zoomMs * factor)
  if (view.follow) return { ...view, zoomMs }
  const startMs = clampStart(anchorMs - zoomMs * anchorFraction, zoomMs, durationMs)
  return { ...view, zoomMs, startMs }
}

export function zoomAboutPlayhead(view: View, factor: number, timeMs: number, durationMs: number): View {
  const start = windowStart(view, timeMs, durationMs)
  const fraction = (timeMs - start) / view.zoomMs
  return zoomAround(view, factor, timeMs, fraction, durationMs)
}

export function zoomToRange(view: View, startMs: number, endMs: number, durationMs: number): View {
  const span = Math.max(ZOOM_MIN_MS, endMs - startMs)
  const zoomMs = clampZoom(span * 1.2)
  return { ...view, follow: false, zoomMs, startMs: clampStart(startMs - (zoomMs - span) / 2, zoomMs, durationMs) }
}

export function fitAll(view: View, durationMs: number): View {
  const zoomMs = clampZoom(Math.max(ZOOM_MIN_MS, durationMs))
  return { ...view, follow: false, zoomMs, startMs: 0 }
}

export function pan(view: View, deltaMs: number, timeMs: number, durationMs: number): View {
  const start = windowStart(view, timeMs, durationMs)
  return { ...view, follow: false, startMs: clampStart(start + deltaMs, view.zoomMs, durationMs) }
}

export function tickStepMs(zoomMs: number, width: number, minPx = 70): number {
  const steps = [50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000]
  const perPx = zoomMs / Math.max(1, width)
  return steps.find((s) => s / perPx >= minPx) ?? 600_000
}
