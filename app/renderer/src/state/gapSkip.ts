import type { EngineState, ScriptInfo, Span } from 'bp-engine'
import { currentGapEnd, nextGapEnd } from '@/lib/gaps'
import * as live from './live'
import { usePlayer } from './player'
import { useSettings } from './settings'

export const GAP_MIN_MS = 5000

let cached: { scripts: ScriptInfo[]; gaps: Span[] } | null = null
function strokeGaps(): Span[] {
  const { scripts } = usePlayer.getState()
  if (cached?.scripts !== scripts) {
    const stroke = scripts.find((s) => s.axis === 'L0' && s.selected)
    cached = { scripts, gaps: (stroke?.gaps ?? []).filter((g) => g.endMs - g.startMs >= GAP_MIN_MS) }
  }
  return cached.gaps
}

function active(auto: boolean): boolean {
  const settings = useSettings.getState().settings
  const mode = settings?.playback.gapSkip ?? 'off'
  if (mode === 'off' || (auto && mode !== 'auto')) return false
  const player = usePlayer.getState()
  if (!player.snapshot.loaded) return false
  if (((live.get().axisFlags[live.axisIndex('L0')] ?? 0) & live.FLAG_SCRIPT) === 0) return false
  return (player.video.axes.L0 ?? settings?.axesDefault.L0)?.enabled ?? true
}

export function skipGap() {
  if (!active(false)) return
  const end = nextGapEnd(strokeGaps(), live.get().timeMs)
  if (end !== null) usePlayer.getState().seek(end / 1000)
}

let pending: { endMs: number; at: number } | null = null

export function autoSkipGap(state: EngineState) {
  if (state.paused || state.following || !active(true)) return
  const end = currentGapEnd(strokeGaps(), state.timeMs)
  if (end === null) return
  if (pending && pending.endMs === end && performance.now() - pending.at < 1000) return
  pending = { endMs: end, at: performance.now() }
  usePlayer.getState().seek(end / 1000)
}
