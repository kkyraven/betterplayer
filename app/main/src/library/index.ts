import { t } from '../i18n'
import { statSync, watch, type FSWatcher } from 'node:fs'
import { access, copyFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeImage, net } from 'electron'
import type { AxisId } from '@shared/axes'
import { isMediaPath, isVideoPath, type GeneratedResult, type GeneratedScriptRow, type IpcEvent, type IpcEvents } from '@shared/ipc'
import type { DropResult, FolderNode, LibraryChange, LibraryCounts, LibraryRoot, MediaDetail, MediaIndexRow, MediaPage, MediaQuery, Playlist, ScanProgress, Tag } from '@shared/library'
import type { MatcherReport, MatcherResolveResult, OrphanSet } from '@shared/matcher'
import type { ScriptSet } from '@shared/peer'
import { isUrl, type RemoteLoad, type ServerInput } from '@shared/remote'
import { contains } from '../remote/paths'
import type { PerVideoSettings } from '@shared/settings'
import { isEmptyPerVideo, readPerVideo } from '../settings/store'
import { LibraryDb, type TagRow } from './db'
import { EditorStore } from '../editor'
import { buildReport, resolveSet } from './matcher'
import { Scanner, type JobSink } from './scanner'
import { ScriptScanner } from './scripts'
import { detectServer, makeAdapter, type Adapter } from './servers/adapter'
import { baseUrl, headerList } from './servers/http'
import { ServerSync } from './servers/sync'
import { StashAdapter } from './servers/stash'
import { RemoteWrites } from './servers/writes'
import { TagQueue, type TagJob } from './tagger'
import type { SessionRun, SessionSetup } from '@shared/session'
import { ThumbQueue } from './thumbs'

export type Emitter = <E extends IpcEvent>(event: E, payload: IpcEvents[E]) => void

export interface LibraryOptions {
  dataDir: string
  enginePath: string
  modelsDir: string
}

const THUMBS_EVERY_MS = 2500

class IdBatch {
  private ids = new Set<number>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly flush: (ids: number[]) => void,
    private readonly ms: number,
  ) {}

  has(id: number): boolean {
    return this.ids.has(id)
  }

  add(id: number) {
    this.ids.add(id)
    this.timer ??= setTimeout(() => {
      this.timer = null
      const ids = [...this.ids]
      this.ids.clear()
      this.flush(ids)
    }, this.ms)
  }

  close() {
    if (this.timer) clearTimeout(this.timer)
  }
}

function throttle(fn: () => void, ms: number): () => void {
  let last = 0
  let timer: NodeJS.Timeout | null = null
  return () => {
    const wait = last + ms - Date.now()
    if (wait <= 0) {
      last = Date.now()
      fn()
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        fn()
      }, wait)
    }
  }
}

function fileStamp(path: string): string | null {
  try {
    const s = statSync(path)
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch {
    return null
  }
}

export class Library {
  private readonly db: LibraryDb
  readonly editor: EditorStore
  private readonly thumbs: ThumbQueue
  private readonly tagger: TagQueue
  private readonly jobs: JobSink
  private readonly scanner: Scanner
  private emit: Emitter = () => {}
  private watchers = new Map<number, FSWatcher>()
  private rescanTimers = new Map<number, NodeJS.Timeout>()
  private readonly progressChanged = throttle(() => this.emit('library:progress', this.progress()), 250)
  private readonly thumbsDone = new IdBatch((ids) => this.changed({ kind: 'thumbs', ids }), THUMBS_EVERY_MS)
  private readonly tagsDone = new IdBatch((ids) => this.changed({ kind: 'tags', ids }), THUMBS_EVERY_MS)
  private readonly writeBack: RemoteWrites
  private readonly servers: ServerSync
  private readonly adapters = new Map<number, Adapter>()
  private readonly groupImports = new Set<number>()
  private autoTag = false
  private tagServers = false

  constructor(options: LibraryOptions) {
    this.db = new LibraryDb(join(options.dataDir, 'library.db'))
    this.writeBack = new RemoteWrites(this.db, (root) => this.adapter(root), () => this.changed({ kind: 'meta' }))
    this.editor = new EditorStore(this.db)
    this.thumbs = new ThumbQueue(options.dataDir, this.db, { done: (id) => this.thumbsDone.add(id), progress: this.progressChanged })
    const scripts = new ScriptScanner(options.enginePath)
    this.servers = new ServerSync(this.db, scripts, join(options.dataDir, 'remote'), (id) => this.thumbs.file('thumb', id), (id) => this.thumbs.file('strip', id), {
      changed: () => this.changed({ kind: 'scan' }),
      progress: this.progressChanged,
      editing: (id) => this.db.hasRemoteWrite(id),
      tagging: () => this.tagServers,
      tag: (job) => this.tagger.enqueue(job),
      decodePoster: (bytes) => {
        const image = nativeImage.createFromBuffer(bytes)
        if (image.isEmpty()) throw new Error(t('library.error.invalidThumbnail'))
        return image.resize({ width: 480 }).toJPEG(85)
      },
    })
    this.tagger = new TagQueue(options.modelsDir, options.enginePath, this.db, {
      done: (id) => {
        this.tagsDone.add(id)
        if (this.db.remoteKey(id)) this.queueWrites([id])
      },
      progress: this.progressChanged,
    })
    this.jobs = {
      enqueue: (job) => {
        this.thumbs.enqueue(job)
        if (job.tags) this.tagger.enqueue(job)
      },
      remove: async (ids) => {
        this.tagger.remove(ids)
        await this.thumbs.remove(ids)
      },
    }
    this.scanner = new Scanner(
      this.db,
      scripts,
      this.jobs,
      {
        changed: () => this.changed({ kind: 'scan' }),
        progress: this.progressChanged,
      },
      this.servers,
    )
  }

  private changed(change: LibraryChange) {
    this.emit('library:changed', change)
  }

  setAutoTag(on: boolean) {
    if (on === this.autoTag) return
    this.autoTag = on
    this.tagger.setEnabled(on)
  }

  setTagServers(on: boolean) {
    if (on === this.tagServers) return
    this.tagServers = on
    const rows = this.db.setServerTagging(on)
    if (!on) this.tagger.remove(this.db.remoteRowIds())
    for (const job of rows) this.tagger.enqueue(this.tagJob(job))
    this.tagger.wake()
  }

  wakeTagger() {
    this.tagger.wake()
  }

  retagAll(): number {
    const jobs = this.db.resetTags(this.tagServers)
    for (const job of jobs) this.tagger.enqueue(this.tagJob(job))
    this.tagger.wake()
    return jobs.length
  }

  private tagJob(row: TagRow): TagJob {
    const job = { id: row.id, path: row.path, durationMs: row.durationMs }
    if (!isUrl(row.path)) return job
    const server = this.db.server(row.rootId)
    return server ? { ...job, headers: this.adapter(server).headers } : job
  }

  setEmitter(emit: Emitter) {
    this.emit = emit
  }

  start() {
    this.writeBack.start()
    setTimeout(() => this.scanner.scan(), 1500)
    for (const root of this.db.roots()) if (root.kind === 'folder') this.watchRoot(root)
  }

  private watchRoot(root: LibraryRoot) {
    this.unwatchRoot(root.id)
    try {
      const watcher = watch(root.path, { recursive: true, persistent: false }, () => {
        clearTimeout(this.rescanTimers.get(root.id))
        this.rescanTimers.set(root.id, setTimeout(() => this.scanner.scan(root.id), 3000))
      })
      watcher.on('error', (e) => process.stderr.write(`watch ${root.path}: ${String(e)}\n`))
      this.watchers.set(root.id, watcher)
    } catch (e) {
      process.stderr.write(`watch ${root.path}: ${String(e)}\n`)
    }
  }

  private unwatchRoot(id: number) {
    this.watchers.get(id)?.close()
    this.watchers.delete(id)
    clearTimeout(this.rescanTimers.get(id))
    this.rescanTimers.delete(id)
  }

  close() {
    for (const id of [...this.watchers.keys()]) this.unwatchRoot(id)
    this.thumbsDone.close()
    this.tagsDone.close()
    this.writeBack.close()
    this.tagger.close()
    this.db.close()
  }

  setMatchOtherFolders(on: boolean) {
    this.scanner.setMatchOtherFolders(on)
  }

  scriptFolders(path: string): Promise<string[]> {
    return this.scanner.scriptFolders(path)
  }

  roots(): LibraryRoot[] {
    return this.db.roots()
  }

  addRoot(path: string): LibraryRoot {
    const root = this.db.addRoot(path)
    this.watchRoot(root)
    this.changed({ kind: 'meta' })
    this.scanner.scan(root.id)
    return root
  }

  async addPaths(paths: string[]): Promise<DropResult> {
    let play: string | null = null
    let ask: string | null = null
    for (const path of paths) {
      const info = await stat(path).catch(() => null)
      if (!info) continue
      if (info.isDirectory()) {
        const root = this.rootOf(path)
        if (!root) this.addFolder(path)
        else {
          const folder = this.folderIn(root, path)
          if (this.db.excludedFolders(root.id).includes(folder)) this.includeFolder({ rootId: root.id, folder })
          else this.scanner.scan(root.id)
        }
        continue
      }
      if (!isMediaPath(path)) continue
      play ??= path
      if (!isVideoPath(path)) continue
      const root = this.rootOf(path)
      if (!root) ask ??= dirname(path)
      else if (!this.excluded(root, path)) this.scanner.scan(root.id)
    }
    return { play, ask }
  }

  private rootOf(path: string): LibraryRoot | undefined {
    return this.db.roots().find((r) => r.kind === 'folder' && contains(r.path, path))
  }

  private folderIn(root: LibraryRoot, dir: string): string {
    return relative(root.path, dir).split(sep).join('/')
  }

  private addFolder(path: string) {
    const inside = this.db.roots().filter((r) => r.kind === 'folder' && contains(path, r.path))
    if (inside.length === 0) this.addRoot(path)
    else for (const root of inside) this.scanner.scan(root.id)
  }

  private excluded(root: LibraryRoot, path: string): boolean {
    if (this.db.mediaRowByPath(path)?.hidden) return true
    const folder = this.folderIn(root, dirname(path))
    return this.db.excludedFolders(root.id).some((f) => folder === f || folder.startsWith(`${f}/`))
  }

  async addServer(input: ServerInput): Promise<LibraryRoot> {
    const url = baseUrl(input.url)
    if (!isUrl(url)) throw new Error(t('library.error.serverAddress'))
    const credentials = { url, username: input.username.trim(), secret: input.password }
    const { kind, name } = await detectServer(credentials)
    const root = this.db.addServer({ ...credentials, kind, name })
    this.adapters.delete(root.id)
    this.changed({ kind: 'meta' })
    this.scanner.scan(root.id)
    return root
  }

  async removeRoot(id: number) {
    this.unwatchRoot(id)
    this.adapters.delete(id)
    const ids = this.db.mediaIds(id).map((m) => m.id)
    this.db.removeRoot(id)
    this.changed({ kind: 'meta' })
    await this.jobs.remove(ids)
    await this.servers.removeCache(ids)
  }

  remote(path: string): RemoteLoad | null {
    if (!isUrl(path)) return null
    const row = this.db.mediaRowByPath(path)
    if (!row) return null
    const server = this.db.server(row.rootId)
    if (!server) return null
    return { scriptsPath: this.servers.standIn(row.id), headers: headerList(this.adapter(server).headers) }
  }

  private adapter(server: NonNullable<ReturnType<LibraryDb['server']>>): Adapter {
    let adapter = this.adapters.get(server.id)
    if (!adapter) {
      adapter = makeAdapter(server)
      this.adapters.set(server.id, adapter)
    }
    return adapter
  }

  private queueWrites(ids: number[]) {
    this.writeBack.add(ids)
  }

  setRootSessions(id: number, sessions: boolean) {
    this.db.setRootSessions(id, sessions)
    this.changed({ kind: 'meta' })
  }

  scan(rootId?: number) {
    this.scanner.scan(rootId)
  }

  progress(): ScanProgress {
    return { ...this.scanner.state, thumbsPending: this.thumbs.pending(), tagsPending: this.tagger.pending() }
  }

  prepareSearch(q: MediaQuery): Promise<void> {
    return q.search?.trim() ? this.db.prepareSearch() : Promise.resolve()
  }

  query(q: MediaQuery): MediaPage {
    return this.db.query(q)
  }

  queryIds(q: MediaQuery): number[] {
    return this.db.queryIds(q)
  }

  jump(q: MediaQuery, prefix: string): { index: number; id: number } | null {
    return this.db.jump(q, prefix)
  }

  media(id: number): MediaDetail | null {
    const row = this.db.mediaRow(id)
    return row ? { ...row, ...this.db.metadata(id), scripts: this.db.scripts(id) } : null
  }

  byPath(path: string): MediaDetail | null {
    const row = this.db.mediaRowByPath(path)
    return row ? { ...row, ...this.db.metadata(row.id), scripts: this.db.scripts(row.id) } : null
  }

  byTitle(title: string): MediaDetail | null {
    const row = this.db.mediaRowByTitle(title)
    return row ? { ...row, ...this.db.metadata(row.id), scripts: this.db.scripts(row.id) } : null
  }

  folders(): FolderNode[] {
    return this.db.folders()
  }

  counts(): LibraryCounts {
    return this.db.counts()
  }

  setRating(id: number, rating: number) {
    this.db.setRating(id, Math.max(0, Math.min(5, Math.round(rating))))
    this.changed({ kind: 'meta' })
    this.queueWrites([id])
  }

  setTags(id: number, tags: string[]) {
    this.db.setTags(id, tags)
    this.changed({ kind: 'meta' })
    this.queueWrites([id])
  }

  setTitle(id: number, title: string) {
    this.db.setTitle(id, title)
    this.changed({ kind: 'meta' })
  }

  setPinned(ids: number[], pinned: boolean) {
    this.db.setPinned(ids, pinned ? Date.now() : 0)
    this.changed({ kind: 'meta' })
  }

  setHidden(ids: number[], hidden: boolean) {
    this.db.setHidden(ids, hidden)
    this.changed({ kind: 'meta' })
  }

  setFavourite(ids: number[], favourite: boolean) {
    this.db.setFavourite(ids, favourite)
    this.changed({ kind: 'meta' })
    this.queueWrites(ids.filter((id) => {
      const remote = this.db.remoteKey(id)
      return !remote || this.db.server(remote.rootId)?.kind !== 'stash'
    }))
  }

  async moveToFolder(ids: number[], folder: NonNullable<MediaQuery['folder']>) {
    if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id)) || !Number.isInteger(folder?.rootId) || typeof folder.folder !== 'string') return
    const root = this.db.root(folder.rootId)
    if (!root || root.kind !== 'folder') return
    const dir = resolve(root.path, ...folder.folder.split('/').filter(Boolean))
    if (!contains(root.path, dir)) return
    const canonical = relative(root.path, dir).split(sep).join('/')
    let moved = 0
    for (const id of ids) {
      const from = this.db.location(id)
      if (!from || isUrl(from.path) || dirname(from.path) === dir) continue
      const to = join(dir, basename(from.path))
      try {
        await move(from.path, to)
      } catch (e) {
        process.stderr.write(`move ${from.path}: ${e instanceof Error ? e.message : String(e)}\n`)
        continue
      }
      for (const name of await siblingScripts(from.path)) {
        await move(join(dirname(from.path), name), join(dir, name)).catch((e: unknown) => process.stderr.write(`move ${name}: ${e instanceof Error ? e.message : String(e)}\n`))
      }
      this.db.moveMedia(id, { rootId: folder.rootId, path: to, folder: canonical }, from.path)
      moved++
    }
    if (moved > 0) this.changed({ kind: 'scan' })
  }

  async excludeFolder(folder: NonNullable<MediaQuery['folder']>) {
    if (!folder.folder) return
    const ids = this.db.folderMediaIds(folder)
    this.db.transaction(() => {
      this.db.excludeFolder(folder)
      this.db.removeMedia(ids)
    })
    this.changed({ kind: 'meta' })
    this.scanner.scan(folder.rootId)
    await this.jobs.remove(ids)
  }

  includeFolder(folder: NonNullable<MediaQuery['folder']>) {
    this.db.includeFolder(folder)
    this.changed({ kind: 'meta' })
    this.scanner.scan(folder.rootId)
  }

  folderMedia(folder: NonNullable<MediaQuery['folder']>): number[] {
    return this.db.folderMediaIds(folder)
  }

  addTag(mediaIds: number[], tag: string) {
    this.db.addTag(mediaIds, tag)
    this.changed({ kind: 'meta' })
    this.queueWrites(mediaIds)
  }

  tags(): Tag[] {
    return this.db.tags()
  }

  renameTag(from: string, to: string): string {
    const affected = this.db.remoteMediaIdsWithTag(from)
    const name = this.db.renameTag(from, to)
    if (name !== from) {
      this.changed({ kind: 'meta' })
      this.queueWrites(affected)
    }
    return name
  }

  deleteTag(name: string) {
    const affected = this.db.remoteMediaIdsWithTag(name)
    this.db.deleteTag(name)
    this.changed({ kind: 'meta' })
    this.queueWrites(affected)
  }

  played(path: string) {
    const id = this.db.mediaIdByPath(path)
    if (id === null) return
    this.db.played(id, Date.now())
  }

  matcherScan(): Promise<MatcherReport> {
    return buildReport(this.db)
  }

  async matcherResolve(set: Pick<OrphanSet, 'dir' | 'files'>, mediaId: number): Promise<MatcherResolveResult> {
    const video = this.db.location(mediaId)
    if (!video) return { renamed: [], failed: set.files.map((f) => ({ name: f.name, error: t('library.error.videoRemoved') })) }
    const result = await resolveSet(set, video.path)
    if (result.renamed.length > 0) this.scanner.scan(video.rootId)
    return result
  }

  startSession(run: SessionRun, name: string): number {
    return this.db.startSession(run.totalMs, Date.now(), run, name);
  }

  finishSession(id: number, completed: boolean) { this.db.finishSession(id, completed, Date.now()) }
  sessionHistory() { return this.db.sessionHistory() }
  savedSessions() { return this.db.savedSessions() }
  saveSession(name: string, setup: SessionSetup, favourite: boolean) { return this.db.saveSession(name, setup, favourite, Date.now()) }
  favouriteSession(kind: 'saved' | 'history', id: number, favourite: boolean) { this.db.favouriteSession(kind, id, favourite) }
  deleteSavedSession(id: number) { this.db.deleteSavedSession(id) }

  sessionPlayed(sessionId: number, mediaId: number, startMs: number, endMs: number) {
    this.db.sessionPlayed(sessionId, mediaId, startMs, endMs);
  }

  recentSessionMediaIds(sessions: number): number[] {
    return this.db.recentSessionMediaIds(sessions);
  }

  videoSettings(key: string): PerVideoSettings | null {
    const row = this.db.videoSettings(key)
    if (!row) return null
    let raw: unknown = null
    try {
      raw = JSON.parse(row.settings)
    } catch {
      raw = null
    }
    const settings = readPerVideo(raw)
    return row.positionMs === null ? settings : { ...settings, position: row.positionMs }
  }

  setVideoSettings(key: string, settings: PerVideoSettings) {
    const entry = readPerVideo(settings)
    if (isEmptyPerVideo(entry)) {
      this.db.removeVideoSettings(key)
      return
    }
    const { position, ...rest } = entry
    this.db.setVideoSettings(key, { positionMs: position ?? null, settings: JSON.stringify(rest) }, Date.now())
  }

  generated(key: string): GeneratedResult | null {
    const rows = this.db.generated(key)
    if (!rows) return null
    if (rows.stamp !== fileStamp(key)) {
      this.db.removeGenerated(key)
      return null
    }
    return { hash: rows.hash, scripts: rows.scripts }
  }

  setGenerated(key: string, hash: string, scripts: GeneratedScriptRow[]) {
    const stamp = fileStamp(key)
    if (stamp === null) return
    this.db.setGenerated(key, hash, stamp, scripts, Date.now())
  }

  async importStashGroups(rootId: number) {
    const root = this.db.server(rootId)
    if (root?.kind !== 'stash') throw new Error(t('library.error.stashUnavailable'))
    if (this.groupImports.has(rootId)) throw new Error(t('library.error.importInProgress'))
    this.groupImports.add(rootId)
    try {
      const groups = await new StashAdapter(root).groups()
      return this.db.importGroups(rootId, groups)
    } finally {
      this.groupImports.delete(rootId)
      this.changed({ kind: 'meta' })
    }
  }

  playlists(): Playlist[] {
    return this.db.playlists()
  }

  createPlaylist(name: string): Playlist {
    const playlist = this.db.createPlaylist(name)
    this.changed({ kind: 'meta' })
    return playlist
  }

  renamePlaylist(id: number, name: string) {
    this.db.renamePlaylist(id, name)
    this.changed({ kind: 'meta' })
  }

  deletePlaylist(id: number) {
    this.db.deletePlaylist(id)
    this.changed({ kind: 'meta' })
  }

  addToPlaylist(id: number, mediaIds: number[]) {
    this.db.addToPlaylist(id, mediaIds)
    this.changed({ kind: 'meta' })
  }

  removeFromPlaylist(id: number, mediaIds: number[]) {
    this.db.removeFromPlaylist(id, mediaIds)
    this.changed({ kind: 'meta' })
  }

  movePlaylistItems(id: number, move: import('@shared/playlist').PlaylistMove) {
    this.db.movePlaylistItems(id, move)
    this.changed({ kind: 'meta' })
  }

  index(section: 'all' | 'continue'): MediaIndexRow[] {
    return this.db.indexRows(section)
  }

  tagIndex(tag: string): MediaIndexRow[] {
    return this.db.tagIndexRows(tag)
  }

  scriptFile(id: number, axis: AxisId): string | null {
    return this.db.scriptSource(id, axis)
  }

  posterFile(id: number): string {
    return this.thumbs.file('thumb', id)
  }

  stripFile(id: number): string {
    return this.thumbs.file('strip', id)
  }

  async scriptSet(id: number): Promise<{ dir: string; set: ScriptSet } | null> {
    const row = this.db.mediaRow(id)
    if (!row) return null
    const dir = dirname(row.path)
    const names = await siblingScripts(row.path)
    const files = await Promise.all(
      names.map(async (name) => {
        const info = await stat(join(dir, name)).catch(() => null)
        return info ? { name, size: info.size, mtime: Math.round(info.mtimeMs) } : null
      }),
    )
    return { dir, set: { media: basename(row.path), files: files.filter((f) => f !== null) } }
  }

  async servePreview(id: number, range: string | null, signal?: AbortSignal): Promise<Response> {
    const remote = this.db.remoteKey(id)
    const root = remote && this.db.server(remote.rootId)
    if (!remote || root?.kind !== 'stash') return new Response(null, { status: 404 })
    try {
      return await new StashAdapter(root).preview(remote.key, range, signal)
    } catch {
      return new Response(null, { status: 404 })
    }
  }

  async serveThumb(url: string, range: string | null = null, signal?: AbortSignal): Promise<Response> {
    const { hostname, pathname } = new URL(url)
    const id = Number(pathname.slice(1))
    if (hostname === 'preview' && Number.isSafeInteger(id) && id > 0) return this.servePreview(id, range, signal)
    const kind = hostname === 'media' ? 'thumb' : hostname === 'strip' ? 'strip' : null
    if (!kind || !Number.isInteger(id)) return new Response(null, { status: 404 })
    try {
      const file = await net.fetch(pathToFileURL(this.thumbs.file(kind, id)).toString())
      if (!file.ok) return new Response(null, { status: 404 })
      return new Response(file.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } })
    } catch {
      return new Response(null, { status: 404 })
    }
  }
}

async function move(from: string, to: string) {
  if (
    await access(to).then(
      () => true,
      () => false,
    )
  )
    throw new Error(`${to} exists`)
  try {
    await rename(from, to)
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'EXDEV')) throw e
    await copyFile(from, to)
    await unlink(from)
  }
}

async function siblingScripts(file: string): Promise<string[]> {
  const stem = basename(file, extname(file))
  const names = await readdir(dirname(file)).catch(() => [])
  return names.filter((name) => {
    if (!name.startsWith(stem)) return false
    const rest = name.slice(stem.length)
    if (rest === '.zip') return true
    const lower = rest.toLowerCase()
    return lower.endsWith('.funscript') && (rest.length === '.funscript'.length || rest.startsWith('.'))
  })
}
