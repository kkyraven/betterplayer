import type { MessageKey } from './i18n'

export const PROJECTION_KINDS = ['flat', 'equirect180', 'equirect360', 'fisheye'] as const
export type ProjectionKind = (typeof PROJECTION_KINDS)[number]

export const LAYOUTS = ['mono', 'sbs', 'ou'] as const
export type Layout = (typeof LAYOUTS)[number]

export interface Projection {
  kind: ProjectionKind
  layout: Layout
  fov: number
  swapEyes: boolean
}

export const FLAT: Projection = { kind: 'flat', layout: 'mono', fov: 190, swapEyes: false }

export const PROJECTION_LABELS: Record<ProjectionKind, MessageKey> = {
  flat: 'projection.flat',
  equirect180: 'projection.equirect180',
  equirect360: 'projection.equirect360',
  fisheye: 'projection.fisheye',
}

export const LAYOUT_LABELS: Record<Layout, MessageKey> = { mono: 'layout.mono', sbs: 'layout.sbs', ou: 'layout.ou' }

const VR_TOKENS = /^(180|360|180x180|360x180|fisheye\d{0,3}|mkx\d{3}|vrca\d{3}|rf52|sbs|ou|tb|lr|3dh|3dv)$/

export function detectProjection(fileName: string): Projection {
  const tokens = fileName.toLowerCase().split(/[\s_\-.()[\]]+/).filter((t) => VR_TOKENS.test(t))
  if (tokens.length === 0) return FLAT
  let kind: ProjectionKind = 'flat'
  let fov = 190
  let layout: Layout | null = null
  for (const t of tokens) {
    if (t === '360' || t === '360x180') kind = 'equirect360'
    else if (t === '180' || t === '180x180') kind = kind === 'fisheye' ? kind : 'equirect180'
    else if (t.startsWith('fisheye')) {
      kind = 'fisheye'
      fov = Number(t.slice(7)) || 190
    } else if (t.startsWith('mkx') || t.startsWith('vrca')) {
      kind = 'fisheye'
      fov = Number(t.replace(/\D/g, '')) || 200
    } else if (t === 'rf52') {
      kind = 'fisheye'
      fov = 190
    } else if (t === 'sbs' || t === 'lr' || t === '3dh') layout = 'sbs'
    else if (t === 'ou' || t === 'tb' || t === '3dv') layout = 'ou'
  }
  if (kind === 'flat') return layout ? { ...FLAT, layout } : FLAT
  return { kind, layout: layout ?? (kind === 'equirect360' ? 'mono' : 'sbs'), fov, swapEyes: false }
}

export function readProjection(raw: unknown): Projection | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const kind = PROJECTION_KINDS.find((k) => k === r.kind)
  const layout = LAYOUTS.find((l) => l === r.layout)
  if (!kind || !layout) return undefined
  return { kind, layout, fov: typeof r.fov === 'number' ? r.fov : 190, swapEyes: r.swapEyes === true }
}
