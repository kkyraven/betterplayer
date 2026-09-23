import type { Span } from 'bp-engine'

export const GAP_TAIL_MS = 500

export function nextGapEnd(gaps: readonly Span[], timeMs: number): number | null {
  return gaps.find((g) => g.endMs - timeMs > GAP_TAIL_MS)?.endMs ?? null
}

export function currentGapEnd(gaps: readonly Span[], timeMs: number): number | null {
  return gaps.find((g) => g.startMs <= timeMs && g.endMs - timeMs > GAP_TAIL_MS)?.endMs ?? null
}
