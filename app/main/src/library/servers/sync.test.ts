import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FOLDED_STAMP, LibraryDb, type ServerRoot } from '../db'
import { ScriptScanner } from '../scripts'
import type { TagJob } from '../tagger'
import { HereSphereAdapter } from './heresphere'
import { StashAdapter } from './stash'
import { ServerSync, type SyncState } from './sync'
import { ASSET_RECHECK_MS } from './images'
import { ASSET_RETRY_MS } from './assets'

const ENGINE = resolve(__dirname, '../../../../../engine/index.js')
const FUNSCRIPT = '{"actions":[{"at":0,"pos":0},{"at":1000,"pos":100}]}'
const JPEG_BYTES = readFileSync(join(__dirname, 'fixtures/poster.jpg'))

interface Req {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: string
}
type Handler = (req: Req, res: ServerResponse) => void

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const bytes = (res: ServerResponse, buf: Buffer, type: string) => {
  res.writeHead(200, { 'Content-Type': type })
  res.end(buf)
}
const status = (res: ServerResponse, code: number) => {
  res.writeHead(code)
  res.end()
}
const parse = (body: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(body)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function startServer(handler: Handler) {
  const counts = new Map<string, number>()
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x')
      counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1)
      handler({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body: Buffer.concat(chunks).toString() }, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    hits: (prefix: string) => [...counts].filter(([p]) => p.startsWith(prefix)).reduce((n, [, c]) => n + c, 0),
    close: () => {
      server.closeAllConnections()
      return new Promise<void>((r) => server.close(() => r()))
    },
  }
}

interface HsScene {
  tags?: { name: string; start?: number; end?: number; track?: number }[]
  isFavorite?: boolean
  name: string
  rating: number
  file: string
}

function hereSphereMock() {
  const mock = {
    base: '',
    password: 'p',
    scenes: [
      { name: 'one', rating: 3, file: 'a' },
      { name: 'two', rating: 3, file: 'a' },
    ] as HsScene[],
    listed: ['one', 'two'],
    writes: [] as { name: string; body: Record<string, unknown> }[],
    onScene: undefined as (() => void) | undefined,
    sceneUrl: (name: string) => `${mock.base}/scene/${name}`,
    streamUrl: (s: HsScene) => `${mock.base}/stream/${s.name}/${s.file}.mp4`,
    doc(s: HsScene) {
      return {
        access: 1,
        title: `Scene ${s.name}`,
        thumbnailImage: `${mock.base}/thumb/${s.name}`,
        dateAdded: '2024-05-06',
        duration: 90_000,
        rating: s.rating,
        isFavorite: s.isFavorite ?? true,
        projection: 'equirectangular',
        stereo: 'sbs',
        scripts: [
          { name: 'clip.funscript', url: `${mock.base}/script/${s.name}/clip.funscript` },
          { name: 'clip.pitch.funscript', url: `${mock.base}/script/${s.name}/clip.pitch.funscript` },
        ],
        tags: s.tags ?? [{ name: 'Studio:Acme' }, { name: 'Talent:Jane' }, { name: 'Category:anal' }, { name: 'Category:pov' }, { name: 'Jane', start: 1000, end: 2000, track: 0 }],
        media: [{ name: 'Video', sources: [{ resolution: 1080, height: 1080, width: 1920, size: 123, url: mock.streamUrl(s) }] }],
      }
    },
    handle(req: Req, res: ServerResponse) {
      const body = parse(req.body)
      const signedIn = body.username === 'u' && body.password === mock.password
      const [, route, name] = req.path.split('/')
      if (req.path === '/heresphere/' && req.method === 'POST') {
        return json(res, signedIn ? { access: 1, library: [{ name: 'All', list: mock.listed.map(mock.sceneUrl) }] } : { access: 0, library: [] })
      }
      const scene = mock.scenes.find((s) => s.name === name)
      if (route === 'scene' && scene && req.method === 'POST') {
        if (!signedIn) return json(res, { access: 0 })
        mock.onScene?.()
        if ('tags' in body) mock.writes.push({ name: scene.name, body })
        if (typeof body.rating === 'number') scene.rating = body.rating
        if (typeof body.isFavorite === 'boolean') scene.isFavorite = body.isFavorite
        if (Array.isArray(body.tags)) scene.tags = body.tags as NonNullable<HsScene['tags']>
        return json(res, mock.doc(scene))
      }
      if (route === 'thumb' && scene) return bytes(res, JPEG_BYTES, 'image/jpeg')
      if (route === 'script' && scene) return bytes(res, Buffer.from(FUNSCRIPT), 'application/json')
      status(res, 404)
    },
  }
  return mock
}

function stashMock() {
  const mock = {
    base: '',
    updatedAt: '2024-01-01T00:00:00Z',
    rating100: 80,
    failAsset: '',
    holdAsset: '',
    held: null as ServerResponse | null,
    onAsset: () => {},
    script: FUNSCRIPT,
    poster: JPEG_BYTES,
    preview: null as Buffer | null,
    updates: [] as Record<string, unknown>[],
    created: [] as string[],
    counts: { list: 0, full: 0 },
    scene() {
      return {
        id: '5',
        title: 'Stash Scene',
        date: '2023-01-02',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: mock.updatedAt,
        rating100: mock.rating100,
        interactive: true,
        paths: { stream: `${mock.base}/scene/5/stream?apikey=k`, funscript: `${mock.base}/scene/5/funscript?apikey=k`, screenshot: `${mock.base}/scene/5/screenshot`, sprite: `${mock.base}/scene/5/sprite`, vtt: `${mock.base}/scene/5/vtt`, preview: `${mock.base}/scene/5/preview?apikey=k` },
        files: [{ path: '/x/Stash Scene_180_sbs.mp4', duration: 61.5, width: 3840, height: 1920, size: 999, video_codec: 'hevc' }],
        tags: [{ name: 'Anal' }],
        studio: { name: 'Acme' },
        details: 'A fictional coast scene.',
        performers: [{ id: 'person-1', name: 'Mira Vale', alias_list: ['MV'] }],
      }
    },
    handle(req: Req, res: ServerResponse) {
      if (req.headers.apikey !== 'k') return status(res, 401)
      if (req.path.startsWith('/scene/5/')) mock.onAsset()
      if (mock.holdAsset && req.path === `/scene/5/${mock.holdAsset}`) { mock.held = res; return }
      if (mock.failAsset && req.path === `/scene/5/${mock.failAsset}`) return status(res, 503)
      if (req.path === '/scene/5/funscript') return bytes(res, Buffer.from(mock.script), 'application/json')
      if (req.path === '/scene/5/preview') return mock.preview ? bytes(res, mock.preview, 'video/mp4') : status(res, 404)
      if (req.path === '/scene/5/screenshot') return bytes(res, mock.poster, 'image/jpeg')
      if (req.path !== '/graphql' || req.method !== 'POST') return status(res, 404)
      const { query, variables } = parse(req.body)
      const vars = typeof variables === 'object' && variables !== null ? (variables as Record<string, unknown>) : {}
      const input = typeof vars.input === 'object' && vars.input !== null ? (vars.input as Record<string, unknown>) : {}
      const q = typeof query === 'string' ? query : ''
      if (q.includes('sceneUpdate')) {
        mock.updates.push(input)
        return json(res, { data: { sceneUpdate: { id: input.id } } })
      }
      if (q.includes('tagCreate')) {
        mock.created.push(String(input.name))
        return json(res, { data: { tagCreate: { id: '9' } } })
      }
      if (q.includes('findTags')) return json(res, { data: { findTags: { tags: [{ id: '1', name: 'Anal', aliases: [] }] } } })
      if (q.includes('findScenes')) {
        if (Array.isArray(vars.ids)) {
          mock.counts.full++
          return json(res, { data: { findScenes: { scenes: vars.ids.includes('5') ? [mock.scene()] : [] } } })
        }
        mock.counts.list++
        return json(res, { data: { findScenes: { count: 1, scenes: [{ id: '5', updated_at: mock.updatedAt }] } } })
      }
      if (q.includes('version')) return json(res, { data: { version: { version: 'v0.27' } } })
      json(res, { errors: [{ message: `unknown query: ${q}` }] })
    },
  }
  return mock
}

describe('ServerSync', () => {
  let tmp: string
  let db: LibraryDb
  let sync: ServerSync
  const posterFile = (id: number) => join(tmp, 'posters', `${id}.jpg`)
  const remoteDir = () => join(tmp, 'remote')
  const servers: { close: () => Promise<void> }[] = []

  const serve = async (handler: Handler) => {
    const server = await startServer(handler)
    servers.push(server)
    return server
  }
  const run = async (root: ServerRoot) => {
    const state: SyncState = { done: 0, total: 0 }
    const gone = await sync.sync(root, state)
    await sync.assets.drain()
    return { gone, state }
  }
  const projectionOf = (path: string) => {
    const row = db.videoSettings(path)
    expect(row).not.toBeNull()
    const settings: unknown = JSON.parse(row?.settings ?? '{}')
    return (settings as { projection?: unknown }).projection
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'bp-sync-'))
    await mkdir(join(tmp, 'posters'))
    db = new LibraryDb(':memory:')
    sync = new ServerSync(db, new ScriptScanner(ENGINE), remoteDir(), posterFile, (id) => join(tmp, 'strips', `${id}.jpg`), { progress: () => {}, changed: () => {} })
  })

  afterEach(async () => {
    sync.close()
    vi.restoreAllMocks()
    await Promise.all(servers.splice(0).map((s) => s.close()))
    db.close()
    await rm(tmp, { recursive: true, force: true })
  })

  describe('HereSphere', () => {
    const start = async () => {
      const mock = hereSphereMock()
      const server = await serve((req, res) => mock.handle(req, res))
      mock.base = server.base
      const added = db.addServer({ kind: 'heresphere', url: server.base, name: 'x', username: 'u', secret: 'p' })
      const root = db.server(added.id)
      if (!root) throw new Error('no server root')
      return { mock, server, root }
    }
    const rowFor = (root: ServerRoot, key: string) => {
      const remote = db.remoteRows(root.id).find((r) => r.key === key)
      if (!remote) throw new Error(`no row for ${key}`)
      const row = db.mediaRow(remote.id)
      if (!row) throw new Error(`no media row ${remote.id}`)
      return row
    }

    it('imports every scene with scripts, poster, tags and projection', async () => {
      const { mock, root } = await start()
      const { gone, state } = await run(root)
      expect(gone).toEqual([])
      expect(state).toEqual({ done: 2, total: 2 })
      expect(db.root(root.id)?.error).toBe('')

      const scene = mock.scenes[0]
      if (!scene) throw new Error('no scene')
      const row = rowFor(root, mock.sceneUrl(scene.name))
      expect(row).toMatchObject({
        path: mock.streamUrl(scene),
        folder: 'Acme',
        title: 'Scene one',
        durationMs: 90_000,
        width: 1920,
        height: 1080,
        size: 123,
        rating: 3,
        favourite: true,
        tags: ['anal', 'pov'],
        addedAt: Date.parse('2024-05-06'),
        projection: 'equirect180',
        strip: null,
      })
      expect(row.path).not.toContain('u:p')
      expect(row.thumb).toMatch(/^thumb:\/\/media\//)
      expect(existsSync(posterFile(row.id))).toBe(true)

      const scripts = db.scripts(row.id)
      expect(scripts.map((s) => s.axis).sort()).toEqual(['L0', 'R2'])
      const dir = join(remoteDir(), String(row.id)) + sep
      for (const s of scripts) expect(s.source.startsWith(dir)).toBe(true)
      expect(scripts.find((s) => s.axis === 'L0')?.source).toBe(`${dir}video.funscript`)
      expect(scripts.find((s) => s.axis === 'R2')?.source).toBe(`${dir}video.pitch.funscript`)
      expect(row.axes.sort()).toEqual(['L0', 'R2'])

      expect(projectionOf(row.path)).toMatchObject({ kind: 'equirect180', layout: 'sbs' })
    })

    it('takes the server rating for a v18 folded row unless it changed during the sync', async () => {
      const { mock, root } = await start()
      await run(root)
      const [one, two] = mock.scenes.map((s) => rowFor(root, mock.sceneUrl(s.name)))
      if (!one || !two) throw new Error('no rows')
      for (const row of [one, two]) {
        db.setRating(row.id, 4)
        db.setRemoteStamp(row.id, FOLDED_STAMP)
      }
      db.setTags(one.id, ['local edit'])
      sync = new ServerSync(db, new ScriptScanner(ENGINE), remoteDir(), posterFile, (id) => join(tmp, 'strips', `${id}.jpg`), {
        progress: () => {}, changed: () => {}, editing: () => true,
      })
      mock.onScene = () => db.setRating(two.id, 5)
      await run(root)
      expect(rowFor(root, mock.sceneUrl('one'))).toMatchObject({ rating: 3, favourite: true, tags: ['local edit'] })
      expect(rowFor(root, mock.sceneUrl('two'))).toMatchObject({ rating: 5, favourite: true })
    })

    it('skips unchanged scenes and downloads nothing again', async () => {
      const { mock, server, root } = await start()
      await run(root)
      const scriptHits = server.hits('/script/')
      const thumbHits = server.hits('/thumb/')
      expect(scriptHits).toBe(4)
      expect(thumbHits).toBe(2)

      const { gone, state } = await run(root)
      expect(gone).toEqual([])
      expect(state).toEqual({ done: 2, total: 2 })
      expect(server.hits('/script/')).toBe(scriptHits)
      expect(server.hits('/thumb/')).toBe(thumbHits)

      const scene = mock.scenes[0]
      if (!scene) throw new Error('no scene')
      const before = rowFor(root, mock.sceneUrl(scene.name))
      scene.rating = 5
      await run(root)
      const after = rowFor(root, mock.sceneUrl(scene.name))
      expect(after.id).toBe(before.id)
      expect(after.rating).toBe(5)
      expect(after.thumb).toMatch(/^thumb:\/\/media\//)
      expect(db.scripts(after.id).map((s) => s.axis).sort()).toEqual(['L0', 'R2'])
      expect(server.hits('/script/')).toBe(scriptHits)
      expect(server.hits('/thumb/')).toBe(thumbHits)
    })

    it('keeps the row when the stream URL moves under the same scene', async () => {
      const { mock, server, root } = await start()
      await run(root)
      const scene = mock.scenes[1]
      if (!scene) throw new Error('no scene')
      const before = rowFor(root, mock.sceneUrl(scene.name))
      const scriptHits = server.hits('/script/')
      const oldPath = before.path

      scene.file = 'b'
      await run(root)
      const after = rowFor(root, mock.sceneUrl(scene.name))
      expect(after.id).toBe(before.id)
      expect(after.path).toBe(mock.streamUrl(scene))
      expect(after.path).not.toBe(oldPath)
      expect(after).toMatchObject({ rating: 3, favourite: true })
      expect(db.mediaRowByPath(oldPath)).toBeNull()
      expect(db.videoSettings(oldPath)).toBeNull()
      expect(projectionOf(after.path)).toMatchObject({ kind: 'equirect180', layout: 'sbs' })
      expect(db.scripts(after.id).map((s) => s.axis).sort()).toEqual(['L0', 'R2'])
      expect(server.hits('/script/')).toBe(scriptHits)
    })

    it('removes rows and their cache when the server drops a scene', async () => {
      const { mock, root } = await start()
      await run(root)
      const dropped = rowFor(root, mock.sceneUrl('two'))
      expect(existsSync(join(remoteDir(), String(dropped.id)))).toBe(true)

      mock.listed = ['one']
      const { gone, state } = await run(root)
      expect(gone).toEqual([dropped.id])
      expect(state).toEqual({ done: 1, total: 1 })
      expect(db.mediaRow(dropped.id)).toBeNull()
      expect(existsSync(join(remoteDir(), String(dropped.id)))).toBe(false)
      expect(db.remoteRows(root.id).map((r) => r.key)).toEqual([mock.sceneUrl('one')])
    })

    it('records a sign-in failure on the root and keeps the rows', async () => {
      const { mock, root } = await start()
      await run(root)
      mock.password = 'other'
      await expect(run(root)).rejects.toThrow(/sign in/)
      expect(db.root(root.id)?.error).not.toBe('')
      expect(db.remoteRows(root.id)).toHaveLength(2)
    })

    it('writes the rating and its own tags back, keeping the server tags and cuepoints', async () => {
      const { mock, root } = await start()
      await new HereSphereAdapter(root).writeBack(mock.sceneUrl('one'), { rating: 5, favourite: false, tags: ['pov', 'x'] })
      expect(mock.writes).toHaveLength(1)
      expect(mock.writes[0]?.name).toBe('one')
      expect(mock.writes[0]?.body).toMatchObject({
        rating: 5,
        isFavorite: false,
        tags: [{ name: 'Studio:Acme' }, { name: 'Talent:Jane' }, { name: 'Jane', start: 1000, end: 2000, track: 0 }, { name: 'Category:pov' }, { name: 'Category:x' }],
      })
    })
  })

  describe('Stash', () => {
    const start = async () => {
      const mock = stashMock()
      const server = await serve((req, res) => mock.handle(req, res))
      mock.base = server.base
      const added = db.addServer({ kind: 'stash', url: server.base, name: 's', username: '', secret: 'k' })
      const root = db.server(added.id)
      if (!root) throw new Error('no server root')
      return { mock, server, root }
    }
    const rowFor = (root: ServerRoot) => {
      const remote = db.remoteRows(root.id).find((r) => r.key === '5')
      if (!remote) throw new Error('no row for scene 5')
      const row = db.mediaRow(remote.id)
      if (!row) throw new Error(`no media row ${remote.id}`)
      return row
    }

    it('imports a scene with the key stripped from its URLs', async () => {
      const { mock, server, root } = await start()
      const { gone, state } = await run(root)
      expect(gone).toEqual([])
      expect(state).toEqual({ done: 1, total: 1 })
      expect(db.root(root.id)?.error).toBe('')

      const row = rowFor(root)
      expect(row).toMatchObject({
        path: `${mock.base}/scene/5/stream`,
        folder: 'Acme',
        title: 'Stash Scene',
        durationMs: 61_500,
        width: 3840,
        height: 1920,
        size: 999,
        codec: 'hevc',
        rating: 4,
        favourite: false,
        tags: ['anal'],
        addedAt: Date.parse('2023-01-01T00:00:00Z'),
        projection: 'equirect180',
        strip: null,
      })
      expect(row.path).not.toContain('apikey')
      expect(row.thumb).toMatch(/^thumb:\/\/media\//)
      expect(existsSync(posterFile(row.id))).toBe(true)
      expect(db.scripts(row.id).map((s) => s.axis)).toEqual(['L0'])
      expect(db.scripts(row.id)[0]?.source).toBe(join(remoteDir(), String(row.id), 'video.funscript'))
      expect(projectionOf(row.path)).toMatchObject({ kind: 'equirect180', layout: 'sbs' })
      expect(server.hits('/scene/5/funscript')).toBe(1)
      expect(server.hits('/scene/5/screenshot')).toBe(1)
      expect(mock.counts).toEqual({ list: 1, full: 1 })
      expect(db.metadata(row.id)).toMatchObject({
        description: 'A fictional coast scene.', studio: 'Acme',
        performers: [{ name: 'Mira Vale', aliases: ['MV'] }],
      })
    })

    it('hands imported scenes to the tagger with the stream headers, keeping a tagged row through an update', async () => {
      const { mock, root } = await start()
      const jobs: TagJob[] = []
      sync = new ServerSync(db, new ScriptScanner(ENGINE), remoteDir(), posterFile, (id) => join(tmp, 'strips', `${id}.jpg`), {
        progress: () => {}, changed: () => {}, tagging: () => true, tag: (job) => jobs.push(job),
      })
      await run(root)
      const row = rowFor(root)
      expect(db.stamp(row.path)?.tags).toBe('pending')
      expect(jobs).toEqual([{ id: row.id, path: row.path, durationMs: 61_500, headers: { ApiKey: 'k' } }])

      db.setThumbState(row.id, 'tags', 'ready')
      mock.updatedAt = '2024-02-02T00:00:00Z'
      await run(root)
      expect(db.stamp(row.path)?.tags).toBe('ready')
      expect(jobs).toHaveLength(1)
    })

    it('refreshes older cached metadata even when the remote scene stamp has not changed', async () => {
      const { mock, root } = await start()
      const scene = mock.scene()
      const id = db.upsertMedia({ rootId: root.id, path: `${mock.base}/scene/5/stream`, folder: 'Acme', title: scene.title,
        size: 999, mtime: 0, durationMs: 61_500, width: 3840, height: 1920, codec: 'hevc', projection: 'equirect180', remoteKey: '5' }, 1)
      db.setRemoteStamp(id, mock.updatedAt)
      db.setScriptsStamp(id, 'previous-cache')
      expect(db.metadataImported(id)).toBe(false)
      await run(root)
      expect(db.metadataImported(id)).toBe(true)
      expect(db.metadata(id).performers[0]?.name).toBe('Mira Vale')
      expect(db.mediaRow(id)?.tags).toEqual(['anal'])
      expect(mock.counts.full).toBe(1)
      await run(root)
      expect(mock.counts.full).toBe(1)
    })

    it('fetches no scene doc while updated_at stands, then picks up a change', async () => {
      const { mock, server, root } = await start()
      await run(root)
      const before = rowFor(root)

      const { state } = await run(root)
      expect(state).toEqual({ done: 1, total: 1 })
      expect(mock.counts).toEqual({ list: 2, full: 1 })
      expect(server.hits('/scene/5/funscript')).toBe(1)
      expect(server.hits('/scene/5/screenshot')).toBe(1)

      db.setFavourite([before.id], true)
      mock.updatedAt = '2024-02-02T00:00:00Z'
      mock.rating100 = 100
      await run(root)
      const after = rowFor(root)
      expect(after.id).toBe(before.id)
      expect(after).toMatchObject({ rating: 5, favourite: true })
      expect(mock.counts).toEqual({ list: 3, full: 2 })
      expect(server.hits('/scene/5/funscript')).toBe(2)
      expect(server.hits('/scene/5/screenshot')).toBe(2)
    })

    it.each(['funscript', 'screenshot'])('retries a failed %s without downloading successful assets again', async (asset) => {
      const { mock, server, root } = await start()
      mock.failAsset = asset
      await run(root)
      const row = rowFor(root)
      expect(db.stamp(row.path)?.remoteStamp).toBe(mock.updatedAt)
      expect(db.root(root.id)?.error).toContain('Could not download')
      expect(server.hits('/scene/5/funscript')).toBe(1)
      expect(server.hits('/scene/5/screenshot')).toBe(1)

      mock.failAsset = ''
      sync.close()
      sync = new ServerSync(db, new ScriptScanner(ENGINE), remoteDir(), posterFile, (id) => join(tmp, 'strips', `${id}.jpg`), { progress: () => {}, changed: () => {} })
      await run(root)
      expect(server.hits(`/scene/5/${asset}`)).toBe(1)
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ASSET_RETRY_MS[0]! + 1)
      await run(root)
      expect(db.stamp(row.path)?.remoteStamp).toBe(mock.updatedAt)
      expect(db.root(root.id)?.error).toBe('')
      expect(db.scripts(row.id).map((s) => s.axis)).toEqual(['L0'])
      expect(await readFile(posterFile(row.id))).toEqual(JPEG_BYTES)
      expect(server.hits('/scene/5/funscript')).toBe(asset === 'funscript' ? 2 : 1)
      expect(server.hits('/scene/5/screenshot')).toBe(asset === 'screenshot' ? 2 : 1)
      await run(root)
      expect(mock.counts).toEqual({ list: 4, full: 1 })
    })

    it.each([false, true])('keeps an edit acknowledged during sync, pending at start: %s', async (pendingAtStart) => {
      const { mock, root } = await start()
      await run(root)
      const row = rowFor(root)
      let pending = pendingAtStart
      sync = new ServerSync(db, new ScriptScanner(ENGINE), remoteDir(), posterFile, (id) => join(tmp, 'strips', `${id}.jpg`), {
        progress: () => {}, changed: () => {}, editing: () => pending,
      })
      if (pendingAtStart) {
        db.setRating(row.id, 5)
        db.setTags(row.id, ['local edit'])
      }
      mock.updatedAt = '2024-02-02T00:00:00Z'
      mock.onAsset = () => {
        db.setRating(row.id, 5)
        db.setTags(row.id, ['local edit'])
        pending = false
      }
      await run(root)
      expect(rowFor(root)).toMatchObject({ rating: 5, tags: ['local edit'] })
    })

    it('finishes metadata while a poster is stalled and does not rewrite metadata on daily image checks', async () => {
      const { mock, root } = await start()
      mock.holdAsset = 'screenshot'
      const state = { done: 0, total: 0 }
      await sync.sync(root, state)
      expect(state).toEqual({ done: 1, total: 1 })
      const row = rowFor(root)
      expect(db.stamp(row.path)?.remoteStamp).toBe(mock.updatedAt)
      const assets = sync.assets.drain()
      await vi.waitFor(() => expect(mock.held).not.toBeNull())
      expect(sync.assets.pending()).toBeGreaterThan(0)
      expect(db.mediaRow(row.id)?.title).toBe('Stash Scene')
      mock.holdAsset = ''
      bytes(mock.held!, JPEG_BYTES, 'image/jpeg')
      await assets
      const metadata = vi.spyOn(db, 'setMetadata')
      const tags = vi.spyOn(db, 'setTags')
      const upsert = vi.spyOn(db, 'upsertMedia')
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ASSET_RECHECK_MS + 1)
      await run(root)
      expect(mock.counts.full).toBe(1)
      expect(metadata).not.toHaveBeenCalled()
      expect(tags).not.toHaveBeenCalled()
      expect(upsert).not.toHaveBeenCalled()
    })

    it('keeps an image completion that arrives between metadata preparation and commit', async () => {
      const { mock, root } = await start()
      await run(root)
      const row = rowFor(root)
      db.setThumbState(row.id, 'thumb', 'failed')
      mock.updatedAt = '2024-05-01T00:00:00Z'
      const stamp = db.stamp.bind(db)
      let completed = false
      vi.spyOn(db, 'stamp').mockImplementation((path) => {
        const before = stamp(path)
        if (!completed && path === row.path) {
          completed = true
          db.setThumbState(row.id, 'thumb', 'ready')
        }
        return before
      })
      await sync.sync(root, { done: 0, total: 0 })
      expect(completed).toBe(true)
      expect(db.stamp(row.path)?.thumb).toBe('ready')
      await sync.assets.drain()
    })

    it('repairs downloads an older version incorrectly marked synced', async () => {
      const { mock, root } = await start()
      await run(root)
      const row = rowFor(root)
      db['db'].exec('DELETE FROM remote_asset_jobs')
      db.setScriptsStamp(row.id, '')
      db.setCoverStamp(row.id, `${mock.base}/scene/5/screenshot`)
      db.setThumbState(row.id, 'thumb', 'failed')
      await rm(posterFile(row.id))
      await run(root)
      expect(mock.counts.full).toBe(2)
      expect(db.stamp(row.path)?.scriptsStamp).not.toBe('')
      expect(db.stamp(row.path)?.thumb).toBe('ready')
      expect(await readFile(posterFile(row.id))).toEqual(JPEG_BYTES)
    })

    it('refreshes assets at stable URLs and preserves cached scripts when a refresh fails', async () => {
      const { mock, root } = await start()
      await run(root)
      const row = rowFor(root)
      const scriptFile = join(remoteDir(), String(row.id), 'video.funscript')
      mock.updatedAt = '2024-02-02T00:00:00Z'
      mock.script = '{"actions":[{"at":0,"pos":100},{"at":2000,"pos":0}]}'
      mock.poster = readFileSync(join(__dirname, 'fixtures/replacement.jpg'))
      mock.failAsset = 'funscript'
      await run(root)
      expect(await readFile(scriptFile, 'utf8')).toBe(FUNSCRIPT)
      expect(db.scripts(row.id).map((s) => s.axis)).toEqual(['L0'])
      expect(db.stamp(row.path)?.remoteStamp).toBe(mock.updatedAt)
      expect(await readFile(posterFile(row.id))).toEqual(mock.poster)

      mock.failAsset = ''
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ASSET_RETRY_MS[0]! + 1)
      await run(root)
      expect(await readFile(scriptFile, 'utf8')).toBe(mock.script)
      expect(db.scripts(row.id)[0]?.durationMs).toBe(2000)
      expect(rowFor(root).heat).toHaveLength(60)
      expect(await readFile(posterFile(row.id))).toEqual(mock.poster)
      expect(db.stamp(row.path)?.remoteStamp).toBe(mock.updatedAt)
    })

    it('repairs missing ready cache files without a scene metadata change', async () => {
      const { mock, server, root } = await start()
      mock.preview = readFileSync(join(__dirname, 'fixtures/preview.mp4'))
      await run(root)
      const before = rowFor(root)
      expect(before.strip).not.toBeNull()
      await rm(posterFile(before.id))
      await rm(join(tmp, 'strips', `${before.id}.jpg`))
      await run(root)
      expect(existsSync(posterFile(before.id))).toBe(true)
      expect(existsSync(join(tmp, 'strips', `${before.id}.jpg`))).toBe(true)
      expect(server.hits('/scene/5/funscript')).toBe(1)
      expect(server.hits('/scene/5/preview')).toBe(2)
      expect(db.root(root.id)?.error).toBe('')
    })

    it('rechecks absent assets and refreshes stable URLs independently of metadata', async () => {
      const { mock, server, root } = await start()
      await run(root)
      const before = rowFor(root)
      expect(before.strip).toBeNull()
      expect(db.root(root.id)?.error).toBe('')
      await run(root)
      expect(server.hits('/scene/5/preview')).toBe(1)
      mock.preview = readFileSync(join(__dirname, 'fixtures/preview.mp4'))
      mock.poster = readFileSync(join(__dirname, 'fixtures/replacement.jpg'))
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ASSET_RECHECK_MS + 1)
      await run(root)
      const after = rowFor(root)
      expect(after.strip).not.toBeNull()
      expect(after.thumb).not.toBe(before.thumb)
      expect(await readFile(posterFile(before.id))).toEqual(mock.poster)
      expect(server.hits('/scene/5/funscript')).toBe(1)
      expect(db.root(root.id)?.error).toBe('')
      mock.preview = readFileSync(join(__dirname, 'fixtures/preview-replacement.mp4'))
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ASSET_RECHECK_MS + 1)
      await run(root)
      expect(rowFor(root).strip).not.toBe(after.strip)
      expect(rowFor(root).mtime).toBe(before.mtime)
      expect(server.hits('/scene/5/funscript')).toBe(1)
    })

    it('keeps usable images after corrupt refreshes and retries only the failed asset', async () => {
      const { mock, server, root } = await start()
      mock.preview = readFileSync(join(__dirname, 'fixtures/preview.mp4'))
      await run(root)
      const before = rowFor(root)
      const stripFile = join(tmp, 'strips', `${before.id}.jpg`)
      const oldStrip = await readFile(stripFile)
      mock.updatedAt = '2024-03-01T00:00:00Z'
      mock.preview = Buffer.from('<html>not a preview</html>')
      await run(root)
      expect(await readFile(stripFile)).toEqual(oldStrip)
      expect(rowFor(root).strip).not.toBeNull()
      expect(db.stamp(before.path)?.remoteStamp).toBe(mock.updatedAt)
      const thumbHits = server.hits('/scene/5/screenshot')
      mock.preview = readFileSync(join(__dirname, 'fixtures/preview.mp4'))
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ASSET_RETRY_MS[0]! + 1)
      await run(root)
      expect(server.hits('/scene/5/screenshot')).toBe(thumbHits)
      expect(db.root(root.id)?.error).toBe('')
      mock.updatedAt = '2024-04-01T00:00:00Z'
      mock.poster = Buffer.from('<html>not an image</html>')
      await run(root)
      expect(await readFile(posterFile(before.id))).toEqual(JPEG_BYTES)
      expect(rowFor(root).thumb).not.toBeNull()
      expect(db.root(root.id)?.error).toContain('Could not download')
    })

    it('rejects a wrong key and records it on the root', async () => {
      const { root } = await start()
      await run(root)
      await expect(run({ ...root, secret: 'wrong' })).rejects.toThrow(/sign in/)
      expect(db.root(root.id)?.error).not.toBe('')
      expect(db.remoteRows(root.id)).toHaveLength(1)
    })

    it('writes the rating and tags back, creating a tag Stash lacks', async () => {
      const { mock, root } = await start()
      await new StashAdapter(root).writeBack('5', { rating: 2, favourite: false, tags: ['anal', 'new tag'] })
      expect(mock.created).toEqual(['new tag'])
      expect(mock.updates).toEqual([{ id: '5', rating100: 40, tag_ids: ['1', '9'] }])
    })
  })
})
