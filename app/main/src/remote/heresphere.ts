import { t } from '../i18n'
import type { MediaDetail, MediaIndexRow } from '@shared/library'
import type { Projection, ProjectionKind } from '@shared/projection'

export interface HereSphereIndex {
  access: number
  library: { name: string; list: string[] }[]
}

export interface HereSphereScene {
  access: number
  title: string
  description: string
  thumbnailImage: string
  dateAdded: string
  duration: number
  rating: number
  isFavorite: boolean
  projection: string
  stereo: string
  isEyeSwapped: boolean
  fov: number
  lens: string
  scripts: { name: string; url: string }[]
  tags: { name: string }[]
  media: { name: string; sources: { resolution: number; height: number; width: number; size: number; url: string }[] }[]
  writeFavorite: boolean
  writeRating: boolean
  writeTags: boolean
}

export interface HereSphereWrite {
  rating?: number
  isFavorite?: boolean
  tags?: string[]
}

const PROJECTIONS: Record<ProjectionKind, string> = {
  flat: 'perspective',
  equirect180: 'equirectangular',
  equirect360: 'equirectangular360',
  fisheye: 'fisheye',
}

const STEREO = { mono: 'mono', sbs: 'sbs', ou: 'tb' } as const

const LENSES = ['MKX200', 'MKX220', 'VRCA220'] as const

function lens(title: string): string {
  const upper = title.toUpperCase()
  return LENSES.find((l) => upper.includes(l)) ?? 'Linear'
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function hereSphereIndex(sections: { name: string; rows: MediaIndexRow[] }[], base: string): HereSphereIndex {
  return {
    access: 1,
    library: sections
      .filter((s) => s.rows.length > 0)
      .map((s) => ({ name: s.name, list: s.rows.map((row) => `${base}/heresphere/${row.id}`) })),
  }
}

export function hereSphereScene(detail: MediaDetail, projection: Projection, base: string): HereSphereScene {
  const scripts = detail.scripts
    .filter((s) => s.container === 'sibling')
    .sort((a, b) => Number(b.axis === 'L0') - Number(a.axis === 'L0'))
    .map((s) => ({ name: s.axis, url: `${base}/script/${detail.id}/${s.axis}.funscript` }))
  return {
    access: 1,
    title: detail.title,
    description: '',
    thumbnailImage: `${base}/thumb/${detail.id}`,
    dateAdded: isoDate(detail.addedAt),
    duration: detail.durationMs,
    rating: detail.rating,
    isFavorite: detail.favourite,
    projection: PROJECTIONS[projection.kind],
    stereo: STEREO[projection.layout],
    isEyeSwapped: projection.swapEyes,
    fov: projection.kind === 'fisheye' ? projection.fov : 180,
    lens: lens(detail.title),
    scripts,
    tags: detail.tags.map((name) => ({ name })),
    media: [
      {
        name: t('main.dialog.video'),
        sources: [
          {
            resolution: detail.height,
            height: detail.height,
            width: detail.width,
            size: detail.size,
            url: `${base}/media/${detail.id}`,
          },
        ],
      },
    ],
    writeFavorite: true,
    writeRating: true,
    writeTags: true,
  }
}

export function readWrite(body: unknown): HereSphereWrite | null {
  if (typeof body !== 'object' || body === null) return null
  const raw = body as Record<string, unknown>
  const write: HereSphereWrite = {}
  if (typeof raw.rating === 'number' && Number.isFinite(raw.rating)) write.rating = raw.rating
  if (typeof raw.isFavorite === 'boolean') write.isFavorite = raw.isFavorite
  if (Array.isArray(raw.tags)) {
    write.tags = raw.tags
      .map((t) => (typeof t === 'object' && t !== null ? (t as { name?: unknown }).name : t))
      .filter((name): name is string => typeof name === 'string')
  }
  return Object.keys(write).length > 0 ? write : null
}
