import type { MessageKey } from './i18n'
export type AxisKind = 'position' | 'rotation' | 'intensity' | 'aux' | 'estimPosition' | 'estimIntensity' | 'estimParam'
export type AxisNamespace = 'tcode' | 'estim' | 'shock'

export const AXES = [
  { id: 'L0', name: 'axis.L0', kind: 'position', namespace: 'tcode', defaultValue: 0.5 },
  { id: 'L1', name: 'axis.L1', kind: 'position', namespace: 'tcode', defaultValue: 0.5 },
  { id: 'L2', name: 'axis.L2', kind: 'position', namespace: 'tcode', defaultValue: 0.5 },
  { id: 'R0', name: 'axis.R0', kind: 'rotation', namespace: 'tcode', defaultValue: 0.5 },
  { id: 'R1', name: 'axis.R1', kind: 'rotation', namespace: 'tcode', defaultValue: 0.5 },
  { id: 'R2', name: 'axis.R2', kind: 'rotation', namespace: 'tcode', defaultValue: 0.5 },
  { id: 'V0', name: 'axis.V0', kind: 'intensity', namespace: 'tcode', defaultValue: 0 },
  { id: 'V1', name: 'axis.V1', kind: 'intensity', namespace: 'tcode', defaultValue: 0 },
  { id: 'A0', name: 'axis.A0', kind: 'aux', namespace: 'tcode', defaultValue: 0 },
  { id: 'A1', name: 'axis.A1', kind: 'aux', namespace: 'tcode', defaultValue: 0 },
  { id: 'A2', name: 'axis.A2', kind: 'aux', namespace: 'tcode', defaultValue: 0 },
  { id: 'EA', name: 'axis.EA', kind: 'estimPosition', namespace: 'estim', defaultValue: 0.5 },
  { id: 'EB', name: 'axis.EB', kind: 'estimPosition', namespace: 'estim', defaultValue: 0.5 },
  { id: 'EV', name: 'axis.EV', kind: 'estimIntensity', namespace: 'estim', defaultValue: 0 },
  { id: 'C0', name: 'axis.C0', kind: 'estimParam', namespace: 'estim', defaultValue: 0.5 },
  { id: 'P0', name: 'axis.P0', kind: 'estimParam', namespace: 'estim', defaultValue: 0.5 },
  { id: 'P1', name: 'axis.P1', kind: 'estimParam', namespace: 'estim', defaultValue: 0.5 },
  { id: 'P2', name: 'axis.P2', kind: 'estimParam', namespace: 'estim', defaultValue: 0.5 },
  { id: 'P3', name: 'axis.P3', kind: 'estimParam', namespace: 'estim', defaultValue: 0.5 },
  { id: 'E1', name: 'axis.E1', kind: 'estimIntensity', namespace: 'estim', defaultValue: 0 },
  { id: 'E2', name: 'axis.E2', kind: 'estimIntensity', namespace: 'estim', defaultValue: 0 },
  { id: 'E3', name: 'axis.E3', kind: 'estimIntensity', namespace: 'estim', defaultValue: 0 },
  { id: 'E4', name: 'axis.E4', kind: 'estimIntensity', namespace: 'estim', defaultValue: 0 },
  { id: 'S0', name: 'axis.S0', kind: 'intensity', namespace: 'shock', defaultValue: 0 },
] as const satisfies ReadonlyArray<{ id: string; name: MessageKey; kind: AxisKind; namespace: AxisNamespace; defaultValue: number }>

export type AxisDef = (typeof AXES)[number]
export type AxisId = AxisDef['id']

export const AXIS_IDS: readonly AxisId[] = AXES.map((a) => a.id)
export const TCODE_AXES = AXES.filter((a) => a.namespace === 'tcode')
export const ESTIM_AXES = AXES.filter((a) => a.namespace === 'estim')
export const AXIS_NAME: Record<AxisId, MessageKey> = axisRecord((id) => AXES.find((a) => a.id === id)!.name)

export const AXIS_LABEL: Record<AxisId, string> = axisRecord((id) => {
  switch (id) {
    case 'EA': return 'L0'
    case 'EB': return 'L1'
    case 'EV': return 'V0'
    default: return id
  }
})

export function axesForProfile(profile: 'stroker' | 'restim'): AxisDef[] {
  return profile === 'restim' ? ESTIM_AXES : TCODE_AXES
}

export const RULE_AXES: readonly AxisId[] = [...TCODE_AXES.map((a) => a.id), 'EA', 'EB', 'EV']

export function isAxisId(id: string): id is AxisId {
  return AXES.some((a) => a.id === id)
}

export function axisRecord<T>(make: (id: AxisId) => T): Record<AxisId, T> {
  return {
    L0: make('L0'),
    L1: make('L1'),
    L2: make('L2'),
    R0: make('R0'),
    R1: make('R1'),
    R2: make('R2'),
    V0: make('V0'),
    V1: make('V1'),
    A0: make('A0'),
    A1: make('A1'),
    A2: make('A2'),
    EA: make('EA'),
    EB: make('EB'),
    EV: make('EV'),
    C0: make('C0'),
    P0: make('P0'),
    P1: make('P1'),
    P2: make('P2'),
    P3: make('P3'),
    E1: make('E1'),
    E2: make('E2'),
    E3: make('E3'),
    E4: make('E4'),
    S0: make('S0'),
  }
}
