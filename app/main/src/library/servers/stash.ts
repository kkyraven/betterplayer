import { t } from '../../i18n'
import { basename } from 'node:path'
import { detectProjection } from '@shared/projection'
import type { ServerRoot } from '../db'
import type { Adapter, RemoteEntry, RemoteGroup, RemoteScene, RemoteWrite } from './adapter'
import { baseUrl, request } from './http'

const CHUNK = 100
const TAGS_TTL_MS = 60_000

interface Listed {
  id: string
  updated_at: string
}

interface Scene extends Listed {
  title: string | null
  date: string | null
  created_at: string
  rating100: number | null
  interactive: boolean
  paths: { stream: string | null; funscript: string | null; screenshot: string | null; preview?: string | null; sprite?: string | null; vtt?: string | null }
  files: { path: string; duration: number | null; width: number | null; height: number | null; size: number | null; video_codec: string | null }[]
  tags: { name: string }[]
  studio: { name: string } | null
  details: string | null
  performers: { id: string; name: string; alias_list: string[] }[]
}

interface Tag {
  id: string
  name: string
  aliases: string[]
}

const SCENE_FIELDS = `id title date created_at updated_at rating100 interactive
  paths { stream funscript screenshot preview sprite vtt }
  files { path duration width height size video_codec }
  tags { name } studio { name } details performers { id name alias_list }`

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function stripKey(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.delete('apikey')
    return u.toString()
  } catch {
    return url
  }
}

export class StashAdapter implements Adapter {
  readonly kind = 'stash' as const
  readonly headers: Record<string, string>
  private readonly base: string
  private tagCache: { at: number; byName: Map<string, string> } | null = null

  constructor(root: Pick<ServerRoot, 'url' | 'secret'>) {
    this.base = baseUrl(root.url)
    this.headers = root.secret ? { ApiKey: root.secret } : {}
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await request(`${this.base}/graphql`, {
      method: 'POST',
      signal,
      headers: { ...this.headers, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    const json: unknown = await res.json().catch(() => null)
    if (!isObject(json)) throw new Error(t('library.server.error.notStash'))
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      const first: unknown = json.errors[0]
      const message = isObject(first) && typeof first.message === 'string' ? first.message : t('library.server.error.graphql')
      throw new Error(/unauthori[sz]ed|api key|login/i.test(message) ? t('library.server.error.signInFailed') : message)
    }
    if (!isObject(json.data)) throw new Error(t('library.server.error.notStash'))
    return json.data as T
  }

  async preview(key: string, range: string | null, signal?: AbortSignal): Promise<Response> {
    const data = await this.gql<{ findScene: { paths: { preview: string | null } } | null }>(
      'query($id: ID!) { findScene(id: $id) { paths { preview } } }', { id: key }, signal,
    )
    const path = data.findScene?.paths.preview
    if (!path) return new Response(null, { status: 404 })
    const url = new URL(path, `${this.base}/`)
    url.searchParams.delete('apikey')
    if (url.origin !== new URL(this.base).origin) return new Response(null, { status: 404 })
    const response = await fetch(url.toString(), {
      headers: { ...this.headers, ...(range ? { Range: range } : {}) },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
    const headers = new Headers({ 'Cache-Control': 'no-store' })
    for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
      const value = response.headers.get(name)
      if (value) headers.set(name, value)
    }
    return new Response(response.body, { status: response.status, headers })
  }

  async probe(): Promise<string> {
    await this.gql<{ version: { version: string | null } }>('{ version { version } }')
    return new URL(this.base).hostname
  }

  async groups(): Promise<RemoteGroup[]> {
    const groups: RemoteGroup[] = []
    for (let page = 1; ; page++) {
      const data = await this.gql<{ findGroups: { count: number; groups: {
        id: string; name: string; scenes: { id: string; groups: { group: { id: string }; scene_index: number | null }[] }[]
      }[] } }>(`query($filter: FindFilterType) { findGroups(filter: $filter) { count groups {
        id name scenes { id groups { group { id } scene_index } }
      } } }`, { filter: { page, per_page: CHUNK, sort: 'id', direction: 'ASC' } })
      const result = data.findGroups
      if (!result.groups.length && groups.length < result.count) throw new Error(t('library.server.error.incompleteGroups'))
      for (const group of result.groups) {
        const members = group.scenes.flatMap((scene) => {
          const membership = scene.groups.find((g) => g.group.id === group.id)
          return membership ? [{ key: scene.id, index: membership.scene_index ?? Infinity }] : []
        }).sort((a, b) => a.index - b.index || a.key.localeCompare(b.key, 'en', { numeric: true }))
        groups.push({ key: group.id, name: group.name, sceneKeys: members.map((m) => m.key) })
      }
      if (groups.length >= result.count) return groups
    }
  }

  async *scenes(known: Map<string, string>, total: (n: number) => void): AsyncGenerator<RemoteEntry[]> {
    const listed = await this.gql<{ findScenes: { count: number; scenes: Listed[] } }>(
      'query($filter: FindFilterType) { findScenes(filter: $filter) { count scenes { id updated_at } } }',
      { filter: { per_page: -1, sort: 'id', direction: 'ASC' } },
    )
    const all = listed.findScenes.scenes
    total(all.length)
    const unchanged = all.filter((s) => known.get(s.id) === s.updated_at)
    if (unchanged.length > 0) yield unchanged.map((s) => ({ key: s.id, stamp: s.updated_at, scene: null }))
    const changed = all.filter((s) => known.get(s.id) !== s.updated_at)
    for (let i = 0; i < changed.length; i += CHUNK) {
      const ids = changed.slice(i, i + CHUNK).map((s) => s.id)
      const page = await this.gql<{ findScenes: { scenes: Scene[] } }>(`query($ids: [ID!], $filter: FindFilterType) { findScenes(ids: $ids, filter: $filter) { scenes { ${SCENE_FIELDS} } } }`, {
        ids,
        filter: { per_page: -1 },
      })
      yield page.findScenes.scenes.map((s) => ({ key: s.id, stamp: s.updated_at, scene: this.scene(s) })).filter((e): e is RemoteEntry => e.scene !== null)
    }
  }

  private scene(s: Scene): RemoteScene | null {
    const file = s.files[0]
    if (!file || !s.paths.stream) return null
    const fileName = basename(file.path.replace(/\\/g, '/'))
    const title = s.title?.trim() || fileName.replace(/\.[^.]+$/, '')
    const added = Date.parse(s.created_at) || Date.now()
    return {
      key: s.id,
      title,
      folder: s.studio?.name ?? '',
      addedAt: added,
      mtime: Date.parse(s.updated_at) || added,
      size: file.size ?? 0,
      durationMs: Math.round((file.duration ?? 0) * 1000),
      width: file.width ?? 0,
      height: file.height ?? 0,
      codec: file.video_codec ?? '',
      projection: detectProjection(fileName),
      rating: s.rating100 === null ? 0 : Math.max(0, Math.min(5, Math.round(s.rating100 / 20))),
      tags: s.tags.map((t) => t.name),
      description: s.details ?? '',
      performers: (s.performers ?? []).map((p) => ({ key: p.id, name: p.name, aliases: p.alias_list ?? [] })),
      filename: fileName,
      stream: stripKey(s.paths.stream),
      scripts: s.interactive && s.paths.funscript ? [{ name: '', url: stripKey(s.paths.funscript) }] : [],
      thumb: s.paths.screenshot ? stripKey(s.paths.screenshot) : null,
      preview: {
        sprite: s.paths.sprite ? stripKey(s.paths.sprite) : null,
        vtt: s.paths.vtt ? stripKey(s.paths.vtt) : null,
        video: s.paths.preview ? stripKey(s.paths.preview) : null,
      },
    }
  }

  private async tagIds(names: string[]): Promise<string[]> {
    let byName = await this.tagList()
    const ids: string[] = []
    for (const name of names) {
      let id = byName.get(name.toLowerCase())
      if (id === undefined) {
        try {
          const created = await this.gql<{ tagCreate: { id: string } | null }>('mutation($input: TagCreateInput!) { tagCreate(input: $input) { id } }', { input: { name } })
          if (!created.tagCreate) throw new Error(t('library.server.error.tagNotCreated'))
          id = created.tagCreate.id
          byName.set(name.toLowerCase(), id)
        } catch (e) {
          this.tagCache = null
          byName = await this.tagList()
          id = byName.get(name.toLowerCase())
          if (id === undefined) throw e
        }
      }
      if (!ids.includes(id)) ids.push(id)
    }
    return ids
  }

  private async tagList(): Promise<Map<string, string>> {
    if (!this.tagCache || Date.now() - this.tagCache.at > TAGS_TTL_MS) {
      const data = await this.gql<{ findTags: { tags: Tag[] } }>('query($filter: FindFilterType) { findTags(filter: $filter) { tags { id name aliases } } }', { filter: { per_page: -1 } })
      const byName = new Map<string, string>()
      for (const t of data.findTags.tags) {
        for (const alias of t.aliases) byName.set(alias.toLowerCase(), t.id)
        byName.set(t.name.toLowerCase(), t.id)
      }
      this.tagCache = { at: Date.now(), byName }
    }
    return this.tagCache.byName
  }

  async writeBack(key: string, write: RemoteWrite): Promise<void> {
    const tag_ids = await this.tagIds(write.tags)
    const result = await this.gql<{ sceneUpdate: { id: string } | null }>('mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }', {
      input: { id: key, rating100: write.rating > 0 ? write.rating * 20 : null, tag_ids },
    })
    if (!result.sceneUpdate) throw new Error(t('library.server.error.sceneNotUpdated'))
  }
}
