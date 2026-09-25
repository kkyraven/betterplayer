import { renameSync } from 'node:fs'
import { ToolMissingError, runTool } from '../tools'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LibraryDb, type ServerRoot } from '../db'
import type { RemoteScene } from './adapter'
import { AssetQueue, ASSET_RETRY_MS } from './assets'
import { ASSET_RECHECK_MS } from './images'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, renameSync: vi.fn(fs.renameSync) }
})
vi.mock('../tools', async (original) => {
  const tools = await original<typeof import('../tools')>()
  return { ...tools, runTool: vi.fn(tools.runTool) }
})

let dir: string
let db: LibraryDb
let queue: AssetQueue
let root: ServerRoot
let base: string
let hits: string[]
let handler: (path: string, res: ServerResponse, req: IncomingMessage) => void
const server = createServer((req, res) => { hits.push(req.url!); handler(req.url!, res, req) })
const hooks = { progress: vi.fn(), changed: vi.fn(), image: vi.fn(), decodePoster: (bytes: Buffer) => bytes }
const scripts = { scriptsFor: vi.fn(async () => []) }
const poster = (id: number) => join(dir, 'posters', `${id}.jpg`)
const makeQueue = () => new AssetQueue(db, scripts, join(dir, 'remote'), poster, (id) => join(dir, 'strips', `${id}.jpg`), hooks)

function scene(key = '1'): RemoteScene {
  return { key, stream: `${base}/stream/${key}`, title: 'Fixture', folder: '', addedAt: 1, mtime: 1, size: 1,
    durationMs: 1000, width: 32, height: 18, codec: '', projection: null, rating: 0, tags: [], description: '', performers: [], filename: '', scripts: [], thumb: `${base}/poster/${key}` }
}
function add(doc = scene()) {
  return db.upsertMedia({ rootId: root.id, ...doc, path: doc.stream, projection: 'flat', remoteKey: doc.key }, 1)
}

beforeEach(async () => {
  vi.clearAllMocks()
  hits = []
  handler = (_path, res) => res.end('first image')
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test server')
  base = `http://127.0.0.1:${address.port}`
  dir = await mkdtemp(join(tmpdir(), 'bp-assets-'))
  db = new LibraryDb(join(dir, 'library.db'))
  const added = db.addServer({ kind: 'stash', url: base, name: 'Fixture', username: '', secret: 'first' })
  root = db.server(added.id)!
  queue = makeQueue()
})

afterEach(async () => {
  queue.close()
  await queue.drain()
  db.close()
  vi.restoreAllMocks()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

it('persists each retry delay across database reopen and resets it for a new source version', async () => {
  const doc = scene()
  const id = add(doc)
  handler = (_path, res) => { res.statusCode = 503; res.end() }
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  queue.enqueue(root, id, doc, 'one')
  for (const [index, delay] of ASSET_RETRY_MS.entries()) {
    await queue.drain()
    expect(db.assetJob(id, 'thumb')).toMatchObject({ attempts: index + 1, nextAttempt: now + delay })
    queue.close()
    db.close()
    db = new LibraryDb(join(dir, 'library.db'))
    queue = makeQueue()
    await queue.restore(root)
    await queue.drain()
    expect(hits).toHaveLength(index + 1)
    now += delay!
  }
  queue.enqueue(root, id, doc, 'two')
  expect(db.assetJob(id, 'thumb')).toMatchObject({ attempts: 0, nextAttempt: now })
})

it('refreshes images without metadata writes and preserves the usable file and retry on failure', async () => {
  const doc = scene()
  const id = add(doc)
  queue.enqueue(root, id, doc, 'one')
  await queue.drain()
  const metadata = vi.spyOn(db, 'setMetadata')
  const tags = vi.spyOn(db, 'setTags')
  hooks.changed.mockClear()
  const cached = await readFile(poster(id))
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ASSET_RECHECK_MS + 1)
  handler = (_path, res) => { res.statusCode = 503; res.end() }
  await queue.drain()
  const retry = db.assetJob(id, 'thumb')!
  await queue.restore(root)
  expect(db.assetJob(id, 'thumb')).toEqual(retry)
  expect(await readFile(poster(id))).toEqual(cached)
  expect(metadata).not.toHaveBeenCalled()
  expect(tags).not.toHaveBeenCalled()
  expect(hooks.changed).not.toHaveBeenCalled()
})

it('discards a deleted scene while its download is running', async () => {
  const doc = scene()
  const id = add(doc)
  let release: ServerResponse | undefined
  handler = (_path, res) => { release = res }
  queue.enqueue(root, id, doc, 'one')
  const running = queue.drain()
  await vi.waitFor(() => expect(release).toBeDefined())
  db.removeMedia([id])
  release!.end('obsolete')
  await running
  expect(db.assetJob(id, 'thumb')).toBeNull()
  await expect(readFile(poster(id))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('aborts a superseded download and publishes only its desired replacement', async () => {
  const doc = scene()
  const id = add(doc)
  let release: ServerResponse | undefined
  handler = (path, res) => { if (path === '/new') res.end('new image'); else release = res }
  queue.enqueue(root, id, doc, 'one')
  const running = queue.drain()
  await vi.waitFor(() => expect(release).toBeDefined())
  queue.enqueue(root, id, { ...doc, thumb: `${base}/new` }, 'two')
  release!.end('old image')
  await running
  expect(await readFile(poster(id), 'utf8')).toBe('new image')
  expect(db.remoteAsset(id, 'thumb')?.source).toBe(JSON.stringify(['two', `${base}/new`]))
  expect(hooks.image).toHaveBeenCalledTimes(1)
})

it('aborts on shutdown and resumes pending work with current root credentials', async () => {
  const doc = scene()
  const id = add(doc)
  let release: ServerResponse | undefined
  handler = (_path, res) => { release = res }
  queue.enqueue(root, id, doc, 'one')
  const running = queue.drain()
  await vi.waitFor(() => expect(release).toBeDefined())
  queue.close()
  await running
  expect(db.assetJob(id, 'thumb')?.attempts).toBe(0)
  db.addServer({ ...root, name: 'Fixture', secret: 'replacement' })
  const headers: string[] = []
  const onRequest = (req: IncomingMessage) => { headers.push(String(req.headers.apikey)) }
  server.on('request', onRequest)
  handler = (_path, res) => res.end('replacement')
  queue = makeQueue()
  await queue.drain()
  server.off('request', onRequest)
  expect(headers).toEqual(['replacement'])
  expect(await readFile(poster(id), 'utf8')).toBe('replacement')
  expect(db.assetJob(id, 'thumb')?.source).not.toContain('replacement')
})

it('defers the server after one rejected credential response, including across restart', async () => {
  handler = (_path, res) => { res.statusCode = 401; res.end() }
  for (let i = 1; i <= 5; i++) { const doc = scene(String(i)); queue.enqueue(root, add(doc), doc, 'one') }
  await queue.drain()
  expect(hits).toHaveLength(1)
  queue.close()
  db.close()
  db = new LibraryDb(join(dir, 'library.db'))
  queue = makeQueue()
  await queue.restore(root)
  await queue.drain()
  expect(hits).toHaveLength(1)
})


it('restores successful older assets even when the first hundred scenes have no asset records', async () => {
  for (let i = 1; i <= 100; i++) add(scene(String(i)))
  const doc = scene('101')
  const id = add(doc)
  db.setRemoteAsset(id, 'thumb', JSON.stringify(['one', doc.thumb]), '', Date.now() - ASSET_RECHECK_MS)
  await queue.restore(root)
  expect(db.assetJob(id, 'thumb')).not.toBeNull()
  await queue.drain()
  expect(hits).toEqual(['/poster/101'])
})


it('keeps an optional absence fresh after its former cache file was removed', async () => {
  const doc = scene()
  const id = add(doc)
  queue.enqueue(root, id, doc, 'one')
  await queue.drain()
  await rm(poster(id))
  handler = (_path, res) => { res.statusCode = 404; res.end() }
  await queue.restore(root)
  await queue.drain()
  expect(db.remoteAsset(id, 'thumb')?.digest).toBe('')
  const count = hits.length
  await queue.restore(root)
  await queue.drain()
  expect(hits).toHaveLength(count)
})

it('prioritises missing cached posters over routine refreshes without resetting failed retry delays', async () => {
  const first = scene('1'), second = scene('2')
  const a = add(first), b = add(second)
  queue.enqueue(root, a, first, 'one')
  queue.enqueue(root, b, second, 'one')
  await queue.drain()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ASSET_RECHECK_MS + 1)
  await rm(poster(b))
  await queue.restore(root)
  expect(db.dueAsset(Date.now())).toMatchObject({ mediaId: b, kind: 'thumb', priority: 0 })
  handler = (_path, res) => { res.statusCode = 503; res.end() }
  await queue.drain()
  const failed = db.assetJob(b, 'thumb')!
  await queue.restore(root)
  expect(db.assetJob(b, 'thumb')).toEqual(failed)
})


it('restores usable scripts when installing the staged replacement fails', async () => {
  const doc = { ...scene(), scripts: [{ name: '', url: `${base}/script` }] }
  const id = add(doc)
  handler = (path, res) => res.end(path === '/script' ? '{"actions":[{"at":0,"pos":0}]}' : 'image')
  queue.enqueue(root, id, doc, 'one')
  await queue.drain()
  const cached = join(dir, 'remote', String(id), 'video.funscript')
  const before = await readFile(cached)
  queue.enqueue(root, id, doc, 'two')
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(renameSync).mockImplementationOnce(actual.renameSync).mockImplementationOnce(() => { throw new Error('Replacement failed') })
  await queue.drain()
  expect(await readFile(cached)).toEqual(before)
  expect(db.assetJob(id, 'scripts')?.attempts).toBe(1)
})

it('handles a missing conversion tool once and leaves new scripts and posters eligible', async () => {
  vi.mocked(runTool).mockRejectedValueOnce(new ToolMissingError('ffmpeg'))
  for (let i = 1; i <= 5; i++) {
    const doc = { ...scene(String(i)), preview: { sprite: null, vtt: null, video: `${base}/preview/${i}` } }
    queue.enqueue(root, add(doc), doc, 'one')
  }
  await queue.drain()
  expect(runTool).toHaveBeenCalledTimes(1)
  expect(hits.filter((path) => path.startsWith('/preview/'))).toHaveLength(1)
  const doc = { ...scene('6'), scripts: [{ name: '', url: `${base}/script` }] }
  handler = (path, res) => res.end(path === '/script' ? '{"actions":[]}' : 'image')
  queue.enqueue(root, add(doc), doc, 'one')
  await queue.drain()
  expect(hits).toContain('/script')
  expect(hits).toContain('/poster/6')
  expect(runTool).toHaveBeenCalledTimes(1)
})


it('preserves credential scope delays for missing caches that have not attempted their own retry', async () => {
  const a = add(scene('1')), b = add(scene('2'))
  queue.enqueue(root, a, scene('1'), 'one')
  queue.enqueue(root, b, scene('2'), 'one')
  await queue.drain()
  await Promise.all([rm(poster(a)), rm(poster(b))])
  await queue.restore(root)
  handler = (_path, res) => { res.statusCode = 401; res.end() }
  await queue.drain()
  const deferred = db.assetJob(b, 'thumb')!
  expect(deferred.attempts).toBe(0)
  expect(deferred.nextAttempt).toBeGreaterThan(Date.now())
  const count = hits.length
  queue.close()
  db.close()
  db = new LibraryDb(join(dir, 'library.db'))
  queue = makeQueue()
  await queue.restore(root)
  expect(db.assetJob(b, 'thumb')?.nextAttempt).toBe(deferred.nextAttempt)
  await queue.drain()
  expect(hits).toHaveLength(count)
})

it('asks whether a routine refresh changed and keeps the cached image on Not Modified', async () => {
  const doc = scene()
  const id = add(doc)
  handler = (_path, res) => { res.setHeader('ETag', '"one"'); res.end('first image') }
  queue.enqueue(root, id, doc, 'one')
  await queue.drain()
  const cached = db.remoteAsset(id, 'thumb')!
  expect(cached.validators).toEqual({ [doc.thumb!]: { etag: '"one"' } })
  const later = Date.now() + ASSET_RECHECK_MS + 1
  vi.spyOn(Date, 'now').mockReturnValue(later)
  const conditional: (string | undefined)[] = []
  handler = (_path, res, req) => {
    conditional.push(req.headers['if-none-match'])
    if (req.headers['if-none-match'] === '"one"') { res.statusCode = 304; res.end() } else { res.setHeader('ETag', '"two"'); res.end('second image') }
  }
  await queue.drain()
  expect(conditional).toEqual(['"one"'])
  expect(await readFile(poster(id), 'utf8')).toBe('first image')
  expect(db.remoteAsset(id, 'thumb')).toEqual({ ...cached, checkedAt: later })
  expect(db.assetJob(id, 'thumb')).toMatchObject({ nextAttempt: later + ASSET_RECHECK_MS, attempts: 0 })
  expect(hooks.image).toHaveBeenCalledTimes(1)
  queue.enqueue(root, id, doc, 'two')
  await queue.drain()
  expect(conditional).toEqual(['"one"', undefined])
  expect(await readFile(poster(id), 'utf8')).toBe('second image')
  expect(db.remoteAsset(id, 'thumb')?.validators).toEqual({ [doc.thumb!]: { etag: '"two"' } })
  expect(hooks.image).toHaveBeenCalledTimes(2)
  await rm(poster(id))
  await queue.restore(root)
  await queue.drain()
  expect(conditional).toEqual(['"one"', undefined, undefined])
  expect(await readFile(poster(id), 'utf8')).toBe('second image')
})
