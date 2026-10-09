export interface DomClip {
  id: number
  start_seconds: number
  end_seconds: number
}

export interface DomRange {
  start_seconds: number
  end_seconds?: number
}

export function videoRange(args: Record<string, unknown>, durationMs: number, queued: true): Pick<DomClip, 'start_seconds' | 'end_seconds'> | string
export function videoRange(args: Record<string, unknown>, durationMs: number, queued: false): DomRange | string
export function videoRange(args: Record<string, unknown>, durationMs: number, queued: boolean): DomRange | string {
  const start = args.start_seconds ?? (queued ? undefined : 0)
  const end = args.end_seconds ?? (queued ? undefined : durationMs / 1000)
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) return 'start_seconds must be a finite number at least 0.'
  if (!queued && Number.isFinite(durationMs) && durationMs <= 0 && args.end_seconds === undefined) return { start_seconds: start }
  if (typeof end !== 'number' || !Number.isFinite(end) || end <= start) return 'end_seconds must be a finite number greater than start_seconds.'
  if (!Number.isFinite(durationMs) || durationMs <= 0 || end > durationMs / 1000) return 'The timestamp range must be within the video duration.'
  return { start_seconds: start, end_seconds: end }
}
