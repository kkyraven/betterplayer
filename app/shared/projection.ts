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

export function detectProjection(fileName: string): Projection {
  return resolveProjection({ name: fileName, width: 0, height: 0 }).projection
}

export function readProjection(raw: unknown): Projection | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const kind = PROJECTION_KINDS.find((k) => k === r.kind)
  const layout = LAYOUTS.find((l) => l === r.layout)
  if (!kind || !layout) return undefined
  return { kind, layout, fov: typeof r.fov === 'number' ? r.fov : 190, swapEyes: r.swapEyes === true }
}

export const PROJECTION_SOURCES = ['user', 'metadata', 'name', 'picture', 'none'] as const
export type ProjectionSource = (typeof PROJECTION_SOURCES)[number]

export interface ResolvedProjection {
  projection: Projection
  source: ProjectionSource
}

export const PROJECTION_SOURCE_LABELS: Record<ProjectionSource, MessageKey | null> = {
  user: 'projection.from.user',
  metadata: 'projection.from.metadata',
  name: 'player.sideSheet.fromFileName',
  picture: 'projection.from.picture',
  none: null,
}

export interface ContainerFacts {
  sphere?: 'equirect' | 'half' | 'fisheye' | 'flat' | 'other'
  cover?: number
  stereo?: Layout | 'views'
  swap?: boolean
}

export interface PictureFacts {
  lr: number
  tb: number
  wrap: number | null
  corner: number | null
  frames: number
}

export interface DetectInput {
  name: string
  width: number
  height: number
  container?: ContainerFacts | null
  picture?: PictureFacts | null
  user?: Projection | null
}

interface Guess {
  kind?: ProjectionKind
  layout?: Layout
  fov?: number
  swap?: boolean
  weakLayout?: boolean
  byShape?: boolean
}

const near = (r: number, target: number) => Math.abs(r / target - 1) <= 0.03
const ratio = (w: number, h: number) => (w > 0 && h > 0 ? w / h : 0)
const eyeAspect = (w: number, h: number, layout: Layout) => {
  const r = ratio(w, h)
  return layout === 'sbs' ? r / 2 : layout === 'ou' ? r * 2 : r
}
const vrShape = (w: number, h: number) => {
  const r = ratio(w, h)
  return r === 0 || near(r, 2) || near(r, 1) || near(r, 0.5) || near(r, 4)
}
const lookShape = (w: number, h: number) => {
  const r = ratio(w, h)
  return w >= 1920 && r > 0 && (vrShape(w, h) || near(r, 32 / 9) || near(r, 8 / 9))
}

function metaGuess(c: ContainerFacts | null | undefined): Guess | null {
  if (!c) return null
  const g: Guess = {}
  if (c.sphere === 'half') g.kind = 'equirect180'
  else if (c.sphere === 'fisheye') {
    g.kind = 'fisheye'
    g.fov = 180
  }
  else if (c.sphere === 'flat' || (c.sphere === undefined && c.stereo === 'views')) g.kind = 'flat'
  else if (c.sphere === 'equirect') {
    if (c.cover !== undefined) g.kind = c.cover <= 0.6 ? 'equirect180' : 'equirect360'
    else {
      g.kind = 'equirect360'
      g.byShape = true
    }
  }
  if (c.stereo === 'sbs' || c.stereo === 'ou') g.layout = c.stereo
  else if (c.stereo === 'views') g.layout = 'mono'
  else if (c.stereo === 'mono') {
    g.layout = 'mono'
    g.weakLayout = true
  }
  if (c.swap) g.swap = true
  return Object.keys(g).length > 0 ? g : null
}

const LAYOUT_TAGS = new Map<string, [Layout, boolean]>([
  ['sbs', ['sbs', false]], ['lr', ['sbs', false]], ['3dh', ['sbs', false]], ['hsbs', ['sbs', false]], ['rl', ['sbs', true]],
  ['ou', ['ou', false]], ['tb', ['ou', false]], ['3dv', ['ou', false]], ['hou', ['ou', false]], ['overunder', ['ou', false]], ['bt', ['ou', true]],
  ['mono', ['mono', false]],
])
const NEEDS_COMPANY = new Set(['ou', 'rl', 'bt', 'mono'])
const STRONG_180 = new Set(['vr180', '180vr', '180x180'])
const STRONG_360 = new Set(['vr360', '360vr', '360x180'])

function nameGuess(fileName: string, w: number, h: number): Guess | null {
  const tokens = fileName.toLowerCase().split(/[\s_\-.()[\]°]+/).filter(Boolean)
  let kind: ProjectionKind | undefined
  let fov: number | undefined
  let weakKind: ProjectionKind | undefined
  const layoutHits: [Layout, boolean, string][] = []
  let company = false
  for (const t of tokens) {
    const lens = t.match(/^(?:fisheye(\d{3})?|f180|180f|mkx(\d{3})|vrca(\d{3})|rf52)$/)
    if (lens) {
      kind = 'fisheye'
      fov = Number(lens[1] ?? lens[2] ?? lens[3]) || (t === 'rf52' ? 190 : 180)
      company = true
    } else if (STRONG_360.has(t)) {
      if (kind !== 'fisheye') kind = 'equirect360'
      company = true
    } else if (STRONG_180.has(t)) {
      kind ??= 'equirect180'
      company = true
    } else if (t === '360') weakKind = 'equirect360'
    else if (t === '180') weakKind ??= 'equirect180'
    else if (t === '3d' || t === 'vr' || t === 'half') company = true
    else {
      const tag = LAYOUT_TAGS.get(t)
      if (tag) layoutHits.push([...tag, t])
    }
  }
  const strongLayouts = layoutHits.filter(([, , t]) => !NEEDS_COMPANY.has(t))
  if (!kind && weakKind && (company || strongLayouts.length > 0 || vrShape(w, h))) kind = weakKind
  const usable = kind || company ? layoutHits : strongLayouts
  const g: Guess = {}
  if (kind) g.kind = kind
  if (fov) g.fov = fov
  const hit = usable[usable.length - 1]
  if (hit) {
    g.layout = hit[0]
    if (hit[1]) g.swap = true
  }
  return Object.keys(g).length > 0 ? g : null
}

const WRAPS = 2

function pictureGuess(p: PictureFacts | null | undefined, w: number, h: number): Guess | null {
  if (!p || p.frames < 1) return null
  const layout: Layout = p.lr >= 0.6 && p.lr - p.tb >= 0.2 ? 'sbs' : p.tb >= 0.6 && p.tb - p.lr >= 0.2 ? 'ou' : 'mono'
  if (p.wrap !== null && p.wrap <= WRAPS && near(eyeAspect(w, h, layout), 2)) return { kind: 'equirect360', layout }
  return layout === 'mono' ? null : { layout }
}

function layoutFor(kind: ProjectionKind, w: number, h: number): Layout {
  const r = ratio(w, h)
  if (kind === 'flat') return 'mono'
  if (kind === 'equirect360') return near(r, 1) ? 'ou' : near(r, 4) ? 'sbs' : 'mono'
  if (kind === 'fisheye' && near(r, 1)) return 'mono'
  return near(r, 1) || near(r, 0.5) ? 'ou' : 'sbs'
}

export function resolveProjection(input: DetectInput): ResolvedProjection {
  if (input.user) return { projection: input.user, source: 'user' }
  const { width: w, height: h } = input
  const ranked: [ProjectionSource, Guess | null][] = [
    ['metadata', metaGuess(input.container)],
    ['name', nameGuess(input.name, w, h)],
    ['picture', pictureGuess(input.picture, w, h)],
  ]
  const first = <K extends keyof Guess>(key: K, skip?: (g: Guess) => boolean): [Guess[K] | undefined, ProjectionSource] => {
    for (const [source, g] of ranked) if (g && g[key] !== undefined && !skip?.(g)) return [g[key], source]
    return [undefined, 'none']
  }
  let [kindFound, kindSource] = first('kind')
  let [layout, layoutSource] = first('layout', (g) => g.weakLayout === true)
  if (layout === undefined) [layout, layoutSource] = first('layout')
  if (kindFound === undefined && (layout === 'sbs' || layout === 'ou')) {
    kindFound = Math.abs(eyeAspect(w, h, layout) - 1) <= 0.1 ? 'equirect180' : 'flat'
    kindSource = layoutSource
  }
  let kind: ProjectionKind = kindFound ?? 'flat'
  layout ??= layoutFor(kind, w, h)
  if (ranked.find(([source]) => source === kindSource)?.[1]?.byShape && w > 0) kind = Math.abs(eyeAspect(w, h, layout) - 1) < 0.3 ? 'equirect180' : 'equirect360'
  const [fov] = first('fov')
  const [swap] = first('swap')
  const projection: Projection = kind === 'flat' && layout === 'mono'
    ? FLAT
    : { kind, layout, fov: kind === 'fisheye' ? fov ?? 190 : 190, swapEyes: layout !== 'mono' && swap === true }
  const source: ProjectionSource = kind !== 'flat' || (kindSource !== 'none' && layout === 'mono') ? kindSource : layout !== 'mono' ? layoutSource : 'none'
  return { projection, source }
}

export function needsLook(input: DetectInput): boolean {
  const { source } = resolveProjection({ ...input, picture: null, user: null })
  return source === 'none' && lookShape(input.width, input.height)
}

export function worthProbing(name: string, width: number, height: number): boolean {
  return lookShape(width, height) || width >= 3840 || nameGuess(name, width, height) !== null
}

function parseRecord(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const SPHERES = ['equirect', 'half', 'fisheye', 'flat', 'other'] as const
const STEREOS = ['mono', 'sbs', 'ou', 'views'] as const
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function readContainerFacts(raw: string): ContainerFacts | undefined {
  const r = parseRecord(raw)
  if (!r) return undefined
  const out: ContainerFacts = {}
  const sphere = SPHERES.find((s) => s === r.sphere)
  if (sphere) out.sphere = sphere
  if (finite(r.cover) && r.cover > 0 && r.cover <= 1) out.cover = r.cover
  const stereo = STEREOS.find((s) => s === r.stereo)
  if (stereo) out.stereo = stereo
  if (r.swap === true) out.swap = true
  return out
}

export function readPictureFacts(raw: string): PictureFacts | undefined {
  const r = parseRecord(raw)
  if (!r || !finite(r.lr) || !finite(r.tb) || !finite(r.frames)) return undefined
  return { lr: r.lr, tb: r.tb, wrap: finite(r.wrap) ? r.wrap : null, corner: finite(r.corner) ? r.corner : null, frames: r.frames }
}

export function flatEye(p: Projection, width: number, height: number): { width: number; height: number } {
  if (p.layout === 'sbs' && width / 2 / height >= 1.2) return { width: width / 2, height }
  if (p.layout === 'ou' && (width * 2) / height <= 2.5) return { width, height: height / 2 }
  return { width, height }
}
