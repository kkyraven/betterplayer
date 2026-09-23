import type { AxisId } from '@shared/axes'
import type { EditorPoint, Pattern } from '@shared/editor'
import type { MessageKey, Translate } from '@shared/i18n'
import { clampPos, kinds, normalise } from './ops'

export type PresetPattern = Pattern & { name: MessageKey }

export const PATTERN_PRESETS: readonly PresetPattern[] = [
  { id: 'full', name: 'editor.presets.full', points: [[0, 0], [0.5, 100], [1, 0]], builtin: true },
  { id: 'shallow-top', name: 'editor.presets.shallowTop', points: [[0, 55], [0.5, 100], [1, 55]], builtin: true },
  { id: 'shallow-bottom', name: 'editor.presets.shallowBottom', points: [[0, 0], [0.5, 45], [1, 0]], builtin: true },
  { id: 'hold-top', name: 'editor.presets.holdTop', points: [[0, 0], [0.3, 100], [0.7, 100], [1, 0]], builtin: true },
  { id: 'hold-bottom', name: 'editor.presets.holdBottom', points: [[0, 0], [0.15, 0], [0.5, 100], [0.85, 0], [1, 0]], builtin: true },
  { id: 'double', name: 'editor.presets.double', points: [[0, 0], [0.25, 100], [0.5, 40], [0.75, 100], [1, 0]], builtin: true },
  { id: 'grind', name: 'editor.presets.grind', points: [[0, 0], [0.5, 35], [1, 0]], builtin: true },
  { id: 'ramp-up', name: 'editor.presets.rampUp', points: [[0, 0], [0.7, 100], [1, 0]], builtin: true },
]

export function patternName(pattern: Pattern, t: Translate): string {
  const preset = pattern.builtin ? PATTERN_PRESETS.find((p) => p.id === pattern.id) : undefined
  return preset ? t(preset.name) : pattern.name
}

export type OtherAxis = 'R1' | 'L2' | 'R0' | 'R2' | 'L1'
export const OTHER_AXES: readonly OtherAxis[] = ['R1', 'L2', 'R0', 'R2', 'L1']

export interface OtherAxisPreset {
  shift: number
  depth: number
  orbit: boolean
}

export const OTHER_AXIS_PRESETS: Record<OtherAxis, OtherAxisPreset> = {
  R1: { shift: 0.25, depth: 0.6, orbit: true },
  L2: { shift: 0.25, depth: 0.5, orbit: true },
  R0: { shift: 0.5, depth: 0.3, orbit: true },
  R2: { shift: 0, depth: 0.4, orbit: false },
  L1: { shift: 0, depth: 0.35, orbit: false },
}

export function otherAxis(stroke: EditorPoint[], preset: OtherAxisPreset): EditorPoint[] {
  const k = kinds(stroke)
  const bottoms: number[] = []
  k.forEach((kind, i) => {
    if (kind === 'bottom') bottoms.push(i)
  })
  const out: EditorPoint[] = []
  for (let n = 1; n < bottoms.length; n++) {
    const from = bottoms[n - 1] ?? 0
    const to = bottoms[n] ?? 0
    const a = stroke[from]
    const b = stroke[to]
    if (!a || !b) continue
    const period = b.at - a.at
    const sign = preset.orbit && n % 2 === 0 ? -1 : 1
    for (let i = from; i < to; i++) {
      const p = stroke[i]
      if (!p) continue
      out.push({ at: p.at + period * preset.shift, pos: clampPos(50 + (p.pos - 50) * preset.depth * sign) })
    }
  }
  return normalise(out)
}

export const isOtherAxis = (id: AxisId): id is OtherAxis => (OTHER_AXES as readonly string[]).includes(id)
