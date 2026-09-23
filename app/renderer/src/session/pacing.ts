import type { MessageKey } from '@shared/i18n'
import type { PacingKind, PacingSettings, Range, SessionPhase } from '@shared/session'
import { t } from '@/state/i18n'

export const PACING_LABEL_KEY: Record<PacingKind, MessageKey> = {
  random: 'session.pacing.random',
  busy: 'session.pacing.busy',
  rlgl: 'session.pacing.rlgl',
  ramp: 'session.pacing.ramp',
  waves: 'session.pacing.waves',
  custom: 'session.pacing.custom',
}

export type Rng = () => number

const draw = (r: Range, rng: Rng) => Math.max(1000, Math.round(r[0] + rng() * Math.max(0, r[1] - r[0])) * 1000)

export function buildPhases(pacing: PacingSettings, totalMs: number, rng: Rng = Math.random): SessionPhase[] {
  const phases: SessionPhase[] = []
  const end = () => phases[phases.length - 1]?.endMs ?? 0
  const push = (ms: number, from: number | null, to: number | null, hard: boolean, label: string) => {
    const startMs = end()
    phases.push({ startMs, endMs: Math.min(totalMs, startMs + ms), from, to, hard, label })
  }
  const filled = () => end() >= totalMs || phases.length >= 5000
  switch (pacing.kind) {
    case 'random':
      push(totalMs, null, null, false, t('session.phase.anywhere'))
      break
    case 'busy':
      push(totalMs, 1, 1, false, t('session.phase.busy'))
      break
    case 'ramp':
      push(totalMs, pacing.ramp.from, pacing.ramp.to, false, t('session.phase.ramp'))
      break
    case 'rlgl': {
      const p = pacing.rlgl
      let green = true
      while (!filled()) {
        push(draw(green ? p.fastS : p.slowS, rng), green ? p.fast : p.slow, green ? p.fast : p.slow, true, green ? t('session.phase.green') : t('session.phase.red'))
        green = !green
      }
      break
    }
    case 'waves': {
      const p = pacing.waves
      let rising = true
      while (!filled()) {
        push(draw(p.periodS, rng) / 2, rising ? p.low : p.high, rising ? p.high : p.low, false, rising ? t('session.phase.rising') : t('session.phase.falling'))
        rising = !rising
      }
      break
    }
    case 'custom': {
      const { steps, repeat } = pacing.custom
      if (steps.length === 0) {
        push(totalMs, 1, 1, false, t('session.phase.busy'))
        break
      }
      let i = 0
      while (!filled()) {
        const step = steps[i % steps.length]
        if (!step) break
        push(draw(step.lengthS, rng), step.intensity, step.intensity, true, t('session.phase.step', { n: (i % steps.length) + 1 }))
        i++
        if (!repeat && i >= steps.length) break
      }
      break
    }
  }
  const last = phases[phases.length - 1]
  if (last && last.endMs < totalMs) last.endMs = totalMs
  return phases
}

export function phaseAt(phases: SessionPhase[], tMs: number): number {
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i]
    if (p && tMs < p.endMs) return i
  }
  return Math.max(0, phases.length - 1)
}

export function intensityAt(phases: SessionPhase[], tMs: number): number | null {
  const p = phases[phaseAt(phases, tMs)]
  if (!p || p.from === null || p.to === null) return null
  const span = p.endMs - p.startMs
  const k = span > 0 ? Math.min(1, Math.max(0, (tMs - p.startMs) / span)) : 0
  return p.from + (p.to - p.from) * k
}
