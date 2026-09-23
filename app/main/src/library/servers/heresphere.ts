import { t } from '../../i18n'
import { createHash } from 'node:crypto'
import { detectProjection, type Projection } from '@shared/projection'
import { normalizeSearch, type ImportedPerformer } from '@shared/search'
import type { ServerRoot } from '../db'
import type { Adapter, RemoteEntry, RemoteScene, RemoteWrite } from './adapter'
import { baseUrl, mapLanes, request } from './http'

const LANES = 8

interface Index {
  access?: number
  library?: { name?: string; list?: string[] }[]
}

interface SceneTag {
  name?: string
  start?: number
  end?: number
  track?: number
  rating?: number
}

interface SceneDoc {
  access?: number
  writeRating?: boolean
  writeFavorite?: boolean
  writeTags?: boolean
  eventServer?: string
  title?: string
  description?: string
  thumbnailImage?: string
  dateAdded?: string
  duration?: number
  rating?: number
  isFavorite?: boolean
  projection?: string
  stereo?: string
  isEyeSwapped?: boolean
  fov?: number
  scripts?: { name?: string; url?: string }[]
  tags?: SceneTag[]
  media?: { name?: string; sources?: { resolution?: number; height?: number; width?: number; size?: number; url?: string }[] }[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const OWN_PREFIX = /^(category|tag):\s*/i
const OTHER_PREFIX = /^[^:]+:/
const STUDIO_PREFIX = /^studio:\s*/i

const normalizedTags = (tags: string[]) => JSON.stringify([...new Set(tags.map((tag) => tag.trim().toLowerCase()))].sort())

const isCuepoint = (t: SceneTag) => (t.start ?? 0) > 0 || t.end !== undefined || t.track !== undefined

function ownTagName(tag: SceneTag): string | null {
  if (typeof tag.name !== 'string') return null
  const name = tag.name.trim()
  if (name.startsWith('#:')) {
    const value = name.slice(2).trim()
    return value && !value.startsWith('#') ? value : null
  }
  if (isCuepoint(tag)) return null
  if (OWN_PREFIX.test(name)) return name.replace(OWN_PREFIX, '').trim() || null
  return !OTHER_PREFIX.test(name) && name ? name : null
}

export function ownTags(tags: SceneTag[]): string[] {
  return tags.map(ownTagName).filter((name): name is string => name !== null)
}

export function studioOf(tags: SceneTag[]): string {
  const studio = tags.find((t) => typeof t.name === 'string' && STUDIO_PREFIX.test(t.name))
  return studio?.name?.replace(STUDIO_PREFIX, '').trim() ?? ''
}

export function performersOf(tags: SceneTag[]): ImportedPerformer[] {
  const people = new Map<string, ImportedPerformer>()
  for (const tag of tags) {
    if (typeof tag.name !== 'string') continue
    const match = tag.name.trim().match(/^(?:talent|performer|@):\s*(.+)$/i)
    if (!match) continue
    const name = match[1]!.trim()
    if (!name) continue
    const key = `name:${normalizeSearch(name)}`
    people.set(key, { key, name, aliases: [] })
  }
  return [...people.values()]
}

export function mergedTags(current: SceneTag[], ours: string[], stashVr = false): SceneTag[] {
  const prefixed = current.find((t) => ownTagName(t) !== null && typeof t.name === 'string' && OWN_PREFIX.test(t.name))
  const stashPrefixed = stashVr || current.some((t) => typeof t.name === 'string' && (/^(#|@:)/.test(t.name) || (STUDIO_PREFIX.test(t.name) && t.track !== undefined)))
  const serverPrefixed = current.some((t) => typeof t.name === 'string' && !isCuepoint(t) && OTHER_PREFIX.test(t.name))
  const prefix = stashPrefixed ? '#:' : prefixed?.name?.match(OWN_PREFIX)?.[0] ?? (serverPrefixed ? 'Category:' : '')
  const kept = current.filter((t) => ownTagName(t) === null)
  return [...kept, ...ours.map((name) => ({ name: `${prefix}${name}` }))]
}

const PROJECTIONS: Record<string, Projection['kind']> = {
  perspective: 'flat',
  equirectangular: 'equirect180',
  equirectangular360: 'equirect360',
  fisheye: 'fisheye',
}
const LAYOUTS: Record<string, Projection['layout']> = { mono: 'mono', sbs: 'sbs', tb: 'ou' }

export function sceneProjection(doc: SceneDoc): Projection | null {
  const kind = doc.projection ? PROJECTIONS[doc.projection] : undefined
  const layout = doc.stereo ? LAYOUTS[doc.stereo] : undefined
  if (!kind || !layout) return null
  return { kind, layout, fov: kind === 'fisheye' && typeof doc.fov === 'number' && Number.isFinite(doc.fov) && doc.fov > 0 ? doc.fov : 190, swapEyes: doc.isEyeSwapped === true }
}

export function sceneRating(doc: SceneDoc): number {
  return typeof doc.rating === 'number' && Number.isFinite(doc.rating) ? Math.max(0, Math.min(5, Math.round(doc.rating))) : 0
}

export class HereSphereAdapter implements Adapter {
  readonly kind = 'heresphere' as const
  readonly headers: Record<string, string>
  private readonly base: string
  private readonly credentials: { username: string; password: string } | null

  constructor(root: Pick<ServerRoot, 'url' | 'username' | 'secret'>) {
    this.base = baseUrl(root.url)
    this.credentials = root.username ? { username: root.username, password: root.secret } : null
    this.headers = { 'HereSphere-JSON-Version': '1' }
    if (this.credentials) this.headers.Authorization = `Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}`
  }

  private async post(url: string, body: Record<string, unknown> = {}): Promise<unknown> {
    const res = await request(url, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(this.credentials ?? {}), ...body }),
    })
    const json: unknown = await res.json()
    if (isObject(json) && typeof json.access === 'number' && json.access <= 0) throw new Error(json.access < 0 ? t('library.server.error.signInFailed') : t('library.server.error.signInRequired'))
    return json
  }

  private async index(): Promise<Index> {
    let last: unknown
    for (const url of [`${this.base}/heresphere`, `${this.base}/heresphere/`]) {
      try {
        const json = await this.post(url)
        if (isObject(json) && Array.isArray(json.library)) return json as Index
        last = new Error(t('library.server.error.libraryAt', { url }))
      } catch (e) {
        last = e
        if (e instanceof Error && [t('library.server.error.signInFailed'), t('library.server.error.signInRequired')].includes(e.message)) throw e
      }
    }
    throw last instanceof Error ? last : new Error(t('library.server.error.noLibrary'))
  }

  async probe(): Promise<string> {
    await this.index()
    return new URL(this.base).hostname
  }

  async *scenes(known: Map<string, string>, total: (n: number) => void): AsyncGenerator<RemoteEntry[]> {
    const index = await this.index()
    const urls = [...new Set((index.library ?? []).flatMap((l) => l.list ?? []).filter((u): u is string => typeof u === 'string'))]
    total(urls.length)
    for (let i = 0; i < urls.length; i += LANES * 4) {
      const chunk = urls.slice(i, i + LANES * 4)
      const entries = await mapLanes(chunk, LANES, async (url): Promise<RemoteEntry | null> => {
        try {
          const doc = await this.post(url)
          if (!isObject(doc)) return null
          const scene = this.scene(url, doc as SceneDoc)
          return scene ? { key: url, stamp: hashDoc(doc), scene } : null
        } catch (e) {
          if (e instanceof Error && [t('library.server.error.signInFailed'), t('library.server.error.signInRequired')].includes(e.message)) throw e
          process.stderr.write(`heresphere ${url}: ${e instanceof Error ? e.message : String(e)}\n`)
          return { key: url, stamp: known.get(url) ?? '', scene: null }
        }
      })
      yield entries.filter((e): e is RemoteEntry => e !== null)
    }
  }

  private scene(url: string, doc: SceneDoc): RemoteScene | null {
    const sources = (doc.media ?? []).flatMap((m) => m.sources ?? []).filter((s) => typeof s.url === 'string' && s.url.length > 0)
    const best = sources.sort((a, b) => (b.height ?? b.resolution ?? 0) - (a.height ?? a.resolution ?? 0))[0]
    if (!best?.url) return null
    const tags = doc.tags ?? []
    const title = typeof doc.title === 'string' && doc.title.trim() ? doc.title.trim() : url.split('/').filter(Boolean).pop() ?? url
    const addedAt = doc.dateAdded ? Date.parse(doc.dateAdded) : NaN
    return {
      key: url,
      title,
      folder: studioOf(tags),
      addedAt: Number.isFinite(addedAt) ? addedAt : Date.now(),
      mtime: Number.isFinite(addedAt) ? addedAt : 0,
      size: typeof best.size === 'number' ? best.size : 0,
      durationMs: typeof doc.duration === 'number' && doc.duration > 0 ? Math.round(doc.duration) : 0,
      width: best.width ?? 0,
      height: best.height ?? best.resolution ?? 0,
      codec: '',
      projection: sceneProjection(doc) ?? detectProjection(title),
      rating: sceneRating(doc),
      favourite: doc.isFavorite === true,
      tags: ownTags(tags),
      performers: performersOf(tags),
      description: typeof doc.description === 'string' ? doc.description : '',
      filename: '',
      stream: best.url,
      scripts: (doc.scripts ?? []).filter((s): s is { name: string; url: string } => typeof s.url === 'string' && s.url.length > 0).map((s) => ({ name: s.name ?? '', url: s.url })),
      thumb: typeof doc.thumbnailImage === 'string' && doc.thumbnailImage ? doc.thumbnailImage : null,
    }
  }

  async writeBack(key: string, write: RemoteWrite): Promise<void> {
    const doc = await this.post(key)
    if (!isObject(doc)) throw new Error(t('library.server.error.invalidScene'))
    const current = Array.isArray(doc.tags) ? (doc.tags as SceneTag[]) : []
    const body: Record<string, unknown> = {}
    const tagsChanged = normalizedTags(ownTags(current)) !== normalizedTags(write.tags)
    if (tagsChanged) {
      if (doc.writeTags === false) throw new Error(t('library.server.error.tagsUnsupported'))
      const stashVr = typeof doc.eventServer === 'string' && doc.eventServer.includes('/heresphere/events/')
      body.tags = mergedTags(current, write.tags, stashVr)
    }
    if (sceneRating(doc as SceneDoc) !== write.rating) {
      if (doc.writeRating === false) throw new Error(t('library.server.error.ratingUnsupported'))
      body.rating = write.rating
    }
    if ((doc.isFavorite === true) !== write.favourite) {
      if (doc.writeFavorite === false) throw new Error(t('library.server.error.favouritesUnsupported'))
      body.isFavorite = write.favourite
    }
    if (Object.keys(body).length === 0) return
    const verify = (updated: unknown): string | null => {
      if (!isObject(updated)) return t('library.server.error.invalidUpdatedScene')
      if ('tags' in body && (!Array.isArray(updated.tags) || normalizedTags(ownTags(updated.tags as SceneTag[])) !== normalizedTags(write.tags))) return t('library.server.error.tagsNotSaved')
      if ('rating' in body && sceneRating(updated as SceneDoc) !== write.rating) return t('library.server.error.ratingNotSaved')
      if ('isFavorite' in body && (updated.isFavorite === true) !== write.favourite) return t('library.server.error.favouritesNotSaved')
      return null
    }
    let error = verify(await this.post(key, body))
    for (const delay of [100, 250, 500, 1000, 1000]) {
      if (!error) return
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
      error = verify(await this.post(key))
    }
    if (error) throw new Error(error)
  }
}

function hashDoc(doc: Record<string, unknown>): string {
  const { title, thumbnailImage, dateAdded, duration, rating, isFavorite, projection, stereo, isEyeSwapped, fov, scripts, tags, media } = doc
  return createHash('sha1').update(JSON.stringify({ title, thumbnailImage, dateAdded, duration, rating, isFavorite, projection, stereo, isEyeSwapped, fov, scripts, tags, media })).digest('hex')
}
