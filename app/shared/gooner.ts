import { DETECT_CLOTHED, type Clothing, type DenialSettings, type DetectKindId, type GoonerSettings } from './settings'

export type ChasterState = 'locked' | 'unlocked' | 'unknown'

export function goonerLocked(g: GoonerSettings, now: number, chaster: ChasterState): boolean {
  if (!g.lock) return false
  if (g.lock.kind === 'until') return g.lock.endsAt > now
  return chaster !== 'unlocked'
}

export function restrictGooner(current: GoonerSettings, next: GoonerSettings, locked: boolean): GoonerSettings {
  if (!locked) return next
  const kinds = [...current.kinds, ...next.kinds.filter((k) => !current.kinds.includes(k))]
  return { ...next, enabled: true, lock: current.lock, kinds, strength: Math.max(current.strength, next.strength) }
}

export function restrictDenial(current: DenialSettings, next: DenialSettings, locked: boolean): DenialSettings {
  if (!locked) return next
  const kinds = [...current.kinds, ...next.kinds.filter((k) => !current.kinds.includes(k))]
  return { ...current, enabled: current.enabled || next.enabled, kinds, axes: { ...next.axes, ...current.axes }, holdMs: Math.max(current.holdMs, next.holdMs) }
}

export function detectKindIds(kinds: readonly DetectKindId[], clothing: Clothing): string[] {
  const ids = new Set<string>()
  for (const k of kinds) {
    if (clothing !== 'clothed') ids.add(k)
    const clothed = DETECT_CLOTHED[k]
    if (clothing !== 'exposed' && clothed) ids.add(clothed)
  }
  return [...ids]
}

export function denialFires(d: Pick<DenialSettings, 'when' | 'holdMs'>, now: number, lastSeenAt: number | null, ran: boolean): boolean {
  const seen = lastSeenAt !== null && now - lastSeenAt <= d.holdMs
  return d.when === 'seen' ? seen : ran && !seen
}
