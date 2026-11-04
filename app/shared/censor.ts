import type { MessageKey } from './i18n'
import { DETECT_CLOTHED, type Clothing, type DenialSettings, type DetectKindId, type CensorSettings } from './settings'

export const MODEL_SIZES = ['tiny', 'small', 'medium', 'big', 'huge'] as const
export type ModelSize = (typeof MODEL_SIZES)[number]
export const DEFAULT_MODEL_SIZE: ModelSize = 'medium'
export const MODEL_SIZE_LABELS: Record<ModelSize, MessageKey> = { tiny: 'modelSize.tiny', small: 'modelSize.small', medium: 'modelSize.medium', big: 'modelSize.big', huge: 'modelSize.huge' }
export const detectorId = (size: ModelSize) => `nevermore-${size}`
export const skinId = (size: ModelSize) => `latex-${size}`
export function sizeOf(detector: string | null | undefined): ModelSize | null {
  return MODEL_SIZES.find((size) => detectorId(size) === detector) ?? null
}

export type ChasterState = 'locked' | 'unlocked' | 'unknown'

export function censorLocked(g: CensorSettings, now: number, chaster: ChasterState): boolean {
  if (!g.lock) return false
  if (g.lock.kind === 'until') return g.lock.endsAt > now
  return chaster !== 'unlocked'
}

export function restrictCensor(current: CensorSettings, next: CensorSettings, locked: boolean): CensorSettings {
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
