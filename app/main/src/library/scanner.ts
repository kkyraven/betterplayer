import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { isVideoPath } from '@shared/ipc'
import { detectProjection } from '@shared/projection'
import type { LibraryDb, MediaStamp, ScriptKey, ScriptRow } from './db'
import { ScriptFolders } from './script-folders'
import { probe } from './probe'
import { summarise, type ScriptScanner } from './scripts'
import type { ServerSync } from './servers/sync'

const SKIP_DIRS = new Set(['@eaDir', '.AppleDouble', 'System Volume Information', '$RECYCLE.BIN', '$Recycle.Bin', 'Config.Msi', 'Recovery'])
const CHANGED_EVERY_MS = 2000
const PROBE_LANES = 4
const WRITES_PER_TX = 50

export interface ScanHooks {
  progress: () => void
  changed: () => void
}

export interface ScanState {
  scanning: boolean
  done: number
  total: number
}

const yieldTurn = () => new Promise<void>((r) => setImmediate(r))
const warn = (what: string, e: unknown) => process.stderr.write(`${what}: ${e instanceof Error ? e.message : String(e)}\n`)

interface Walk {
  files: string[]
  siblings: Map<string, string[]>
  incomplete: boolean
}

interface ScriptInventory {
  walks: Map<number, Walk>
  siblings: Map<string, string[]>
  folders: ScriptFolders
}

interface Work {
  file: string
  size: number
  mtime: number
  existing: MediaStamp | null
  unchanged: boolean
  stamp: string
  cover: Cover
  folders: string[]
}

interface Cover {
  path: string | null
  stamp: string
}

export interface MediaJob {
  id: number
  path: string
  durationMs: number
  cover: string | null
  thumb: boolean
  strip: boolean
  tags: boolean
}

export interface JobSink {
  enqueue: (job: MediaJob) => void
  remove: (ids: number[]) => Promise<void>
}

export class Scanner {
  readonly state: ScanState = { scanning: false, done: 0, total: 0 }
  private queued: number | 'all' | null = null
  private matchOtherFolders = true
  private inventory: Promise<ScriptInventory> | null = null
  private inventoryKey = ''

  setMatchOtherFolders(on: boolean) {
    if (on === this.matchOtherFolders) return
    this.matchOtherFolders = on
    this.scan()
  }

  async scriptFolders(path: string): Promise<string[]> {
    if (!this.matchOtherFolders || /^[a-z][a-z\d+.-]*:\/\//i.test(path)) return []
    const inventory = await this.getInventory()
    return this.matchOtherFolders ? inventory.folders.forMedia(path) : []
  }

  private getInventory(refresh = false): Promise<ScriptInventory> {
    const roots = this.db.roots().filter((root) => root.kind === 'folder').map((root) => ({ ...root, excluded: this.db.excludedFolders(root.id) }))
    const key = JSON.stringify(roots.map(({ id, path, excluded }) => ({ id, path, excluded })))
    if (refresh || !this.inventory || key !== this.inventoryKey) {
      this.inventoryKey = key
      this.inventory = (async () => {
        const walks = new Map<number, Walk>()
        const siblings = new Map<string, string[]>()
        for (const root of roots) {
          const walk = await this.walk(root.path, new Set(root.excluded))
          walks.set(root.id, walk)
          for (const [dir, names] of walk.siblings) siblings.set(dir, names)
        }
        return { walks, siblings, folders: new ScriptFolders(siblings) }
      })()
    }
    return this.inventory
  }

  constructor(
    private readonly db: LibraryDb,
    private readonly scripts: Pick<ScriptScanner, 'scriptsFor'>,
    private readonly jobs: JobSink,
    private readonly hooks: ScanHooks,
    private readonly servers: Pick<ServerSync, 'sync'>,
  ) {}

  scan(rootId?: number) {
    const want = rootId ?? 'all'
    if (this.state.scanning) {
      this.queued = this.queued === null || this.queued === want ? want : 'all'
      return
    }
    void this.loop(want)
  }

  private async loop(want: number | 'all') {
    this.state.scanning = true
    let next: number | 'all' | null = want
    while (next !== null) {
      const inventory = this.matchOtherFolders ? await this.getInventory(true) : null
      const requested = next === 'all' ? null : this.db.root(next)
      const roots = next === 'all' ? this.db.roots()
        : this.matchOtherFolders && requested?.kind === 'folder' ? this.db.roots().filter((root) => root.kind === 'folder')
        : requested ? [requested] : []
      this.state.done = 0
      this.state.total = 0
      this.hooks.progress()
      for (const root of roots) {
        try {
          if (root.kind === 'folder') await this.scanRoot(root.id, root.path, inventory)
          else await this.syncServer(root.id)
        } catch (e) {
          warn(`scan failed for ${root.path}`, e)
        }
      }
      next = this.queued
      this.queued = null
    }
    this.state.scanning = false
    this.hooks.progress()
    this.hooks.changed()
  }

  private async syncServer(rootId: number) {
    const server = this.db.server(rootId)
    if (!server) return
    const gone = await this.servers.sync(server, this.state)
    if (gone.length > 0) await this.jobs.remove(gone)
  }

  private async scanRoot(rootId: number, rootPath: string, inventory: ScriptInventory | null) {
    const started = Date.now()
    const rootStat = await stat(rootPath).catch(() => null)
    if (!rootStat?.isDirectory()) {
      process.stderr.write(`scan ${rootPath}: not readable, skipped\n`)
      return
    }
    const walk = inventory?.walks.get(rootId) ?? await this.walk(rootPath, new Set(this.db.excludedFolders(rootId)))
    this.state.total += walk.files.length
    this.hooks.progress()

    const counts = { probed: 0, rescanned: 0, changed: 0 }
    let lastChanged = Date.now()
    let dirty = false
    const changedTick = () => {
      if (dirty && Date.now() - lastChanged > CHANGED_EVERY_MS) {
        lastChanged = Date.now()
        dirty = false
        counts.changed++
        this.hooks.changed()
      }
    }
    const jobs: MediaJob[] = []
    const batch = new WriteBatch(this.db, () => {
      dirty = true
      for (const job of jobs.splice(0)) this.jobs.enqueue(job)
    })

    const siblingStats = new Map<string, Promise<string>>()
    const work: Work[] = []
    for (const file of walk.files) {
      try {
        const info = await stat(file)
        const size = info.size
        const mtime = Math.round(info.mtimeMs)
        const existing = this.db.stamp(file)
        const unchanged = existing !== null && existing.size === size && existing.mtime === mtime && existing.durationMs > 0
        const folders = inventory?.folders.forMedia(file) ?? []
        const stamps = [await scriptsStamp(file, walk.siblings, siblingStats)]
        if (inventory) for (const dir of folders) stamps.push(`${dir}:${await scriptsStamp(join(dir, basename(file)), inventory.siblings, siblingStats)}`)
        const stamp = stamps.join('|')
        const cover = await coverFor(file, walk.siblings, siblingStats)
        if (unchanged && stamp === existing.scriptsStamp && cover.stamp === existing.coverStamp) {
          this.jobs.enqueue({
            id: existing.id,
            path: file,
            durationMs: existing.durationMs,
            cover: cover.path,
            thumb: existing.thumb === 'pending',
            strip: existing.durationMs > 0 && existing.strip === 'pending',
            tags: existing.durationMs > 0 && existing.tags === 'pending',
          })
          this.state.done++
        } else work.push({ file, size, mtime, existing, unchanged, stamp, cover, folders })
      } catch (e) {
        warn(`skipped ${file}`, e)
        this.state.done++
      }
      this.hooks.progress()
      await yieldTurn()
    }

    let cursor = 0
    const lane = async () => {
      while (cursor < work.length) {
        const item = work[cursor++]
        if (!item) break
        try {
          await this.scanWork(rootId, rootPath, item, counts, batch, jobs)
        } catch (e) {
          warn(`skipped ${item.file}`, e)
        }
        this.state.done++
        this.hooks.progress()
        changedTick()
        await yieldTurn()
      }
    }
    await Promise.all(Array.from({ length: PROBE_LANES }, lane))
    batch.flush()

    if (walk.incomplete) process.stderr.write(`scan ${rootPath}: a folder could not be read, nothing removed\n`)
    else {
      const seen = new Set(walk.files)
      const gone = this.db.mediaIds(rootId).filter((m) => !seen.has(m.path))
      if (gone.length > 0) {
        this.db.removeMedia(gone.map((m) => m.id))
        dirty = true
        await this.jobs.remove(gone.map((m) => m.id))
      }
    }
    this.db.setRootScanned(rootId, Date.now())
    if (dirty) {
      counts.changed++
      this.hooks.changed()
    }
    process.stderr.write(
      `scan ${rootPath}: ${walk.files.length} files, ${counts.probed} probed, ${counts.rescanned} scripts rescanned, ${counts.changed} changed events, ${Date.now() - started} ms\n`,
    )
  }

  private async scanWork(rootId: number, rootPath: string, item: Work, counts: { probed: number; rescanned: number }, batch: WriteBatch, jobs: MediaJob[]) {
    const { file, existing, unchanged, cover } = item
    let media = { durationMs: existing?.durationMs ?? 0, width: 0, height: 0, codec: '' }
    if (!unchanged) {
      counts.probed++
      media = await probe(file).catch((e) => {
        warn(`ffprobe failed for ${file}`, e)
        return { durationMs: 0, width: 0, height: 0, codec: '' }
      })
    }
    counts.rescanned++
    const scripts = await this.scripts.scriptsFor(file, item.folders)
    const title = basename(file, extname(file))
    batch.add(() => {
      let id: number
      if (unchanged && existing) id = existing.id
      else {
        id = this.db.upsertMedia(
          {
            rootId,
            path: file,
            folder: relative(rootPath, dirname(file)).split(sep).join('/'),
            title,
            size: item.size,
            mtime: item.mtime,
            ...media,
            projection: detectProjection(title).kind,
          },
          Date.now(),
        )
      }
      if (!unchanged || !sameScripts(this.db.scriptKeys(id), scripts)) this.db.setScripts(id, scripts, summarise(scripts))
      this.db.setScriptsStamp(id, item.stamp)
      this.db.setCoverStamp(id, cover.stamp)
      jobs.push({
        id,
        path: file,
        durationMs: media.durationMs,
        cover: cover.path,
        thumb: !unchanged || existing?.thumb === 'pending' || cover.stamp !== existing?.coverStamp,
        strip: media.durationMs > 0 && (!unchanged || existing?.strip === 'pending'),
        tags: media.durationMs > 0 && (!unchanged || existing?.tags === 'pending'),
      })
    })
  }

  private async walk(root: string, excluded: Set<string>): Promise<Walk> {
    const out: Walk = { files: [], siblings: new Map(), incomplete: false }
    const stack = [root]
    for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (e) {
        warn(`cannot read ${dir}`, e)
        out.incomplete = true
        continue
      }
      const siblings: string[] = []
      for (const entry of entries) {
        const name = entry.name
        if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
        const full = join(dir, name)
        if (entry.isDirectory()) {
          if (!excluded.has(relative(root, full).split(sep).join('/'))) stack.push(full)
        }
        else if (isScriptOrZip(name) || isImage(name)) siblings.push(name)
        else if (isVideoPath(name)) {
          const isFile = entry.isFile() || (entry.isSymbolicLink() && (await stat(full).catch(() => null))?.isFile() === true)
          if (!isFile) continue
          if (extname(name).toLowerCase() === '.ts' && (await isSourceText(full))) continue
          out.files.push(full)
        }
      }
      if (siblings.length > 0) out.siblings.set(dir, siblings)
    }
    return out
  }
}

export class WriteBatch {
  private writes: (() => void)[] = []

  constructor(
    private readonly db: LibraryDb,
    private readonly committed: () => void,
  ) {}

  add(write: () => void) {
    this.writes.push(write)
    if (this.writes.length >= WRITES_PER_TX) this.flush()
  }

  flush() {
    if (this.writes.length === 0) return
    const writes = this.writes
    this.writes = []
    this.db.transaction(() => {
      for (const write of writes) {
        try {
          write()
        } catch (e) {
          warn('library write failed', e)
        }
      }
    })
    this.committed()
  }
}

const NO_SCRIPTS = '-'
const SNIFF_BYTES = 8192

async function isSourceText(path: string): Promise<boolean> {
  let fh
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0)
    return looksLikeText(buf.subarray(0, bytesRead))
  } catch {
    return false
  } finally {
    await fh?.close()
  }
}

export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  for (const stride of [188, 192]) {
    for (let i = 0; i + 2 * stride < bytes.length; i++) {
      if (bytes[i] === 0x47 && bytes[i + stride] === 0x47 && bytes[i + 2 * stride] === 0x47) return false
    }
  }
  return true
}

const isScriptOrZip = (name: string) => name.endsWith('.funscript') || name.endsWith('.FUNSCRIPT') || name.endsWith('.zip')

function scriptNameFor(name: string, stem: string): boolean {
  if (!name.startsWith(stem)) return false
  const rest = name.slice(stem.length)
  if (rest === '.zip') return true
  const suffix = rest.endsWith('.funscript') || rest.endsWith('.FUNSCRIPT') ? rest.slice(0, -'.funscript'.length) : null
  return suffix !== null && (suffix === '' || suffix.startsWith('.') || suffix.startsWith('_') || (suffix.startsWith(' (') && suffix.length > 3 && suffix.endsWith(')')))
}

const COVER_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp']
const isImage = (name: string) => COVER_EXTENSIONS.includes(extname(name).slice(1).toLowerCase())

export function coverRank(name: string, stem: string): number | null {
  if (!isImage(name) || !name.startsWith(stem)) return null
  const rest = name.slice(stem.length, name.length - extname(name).length)
  return rest === '.cover' ? 0 : rest === '' ? 1 : null
}

function siblingStamp(dir: string, name: string, stats: Map<string, Promise<string>>): Promise<string> {
  const full = join(dir, name)
  let entry = stats.get(full)
  if (!entry) {
    entry = stat(full).then(
      (s) => (s.isFile() ? `${name}@${Math.round(s.mtimeMs)}:${s.size}` : ''),
      () => '',
    )
    stats.set(full, entry)
  }
  return entry
}

async function scriptsStamp(file: string, siblings: Map<string, string[]>, stats: Map<string, Promise<string>>): Promise<string> {
  const dir = dirname(file)
  const names = siblings.get(dir)
  if (!names) return NO_SCRIPTS
  const stem = basename(file, extname(file))
  const parts: string[] = []
  for (const name of names) {
    if (!scriptNameFor(name, stem)) continue
    const part = await siblingStamp(dir, name, stats)
    if (part) parts.push(part)
  }
  return parts.length > 0 ? parts.sort().join('|') : NO_SCRIPTS
}

async function coverFor(file: string, siblings: Map<string, string[]>, stats: Map<string, Promise<string>>): Promise<Cover> {
  const none: Cover = { path: null, stamp: '' }
  const dir = dirname(file)
  const names = siblings.get(dir)
  if (!names) return none
  const stem = basename(file, extname(file))
  const candidates = names
    .map((name) => ({ name, rank: coverRank(name, stem) }))
    .filter((c): c is { name: string; rank: number } => c.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
  for (const { name } of candidates) {
    const stamp = await siblingStamp(dir, name, stats)
    if (stamp) return { path: join(dir, name), stamp }
  }
  return none
}

function sameScripts(a: ScriptKey[], b: ScriptRow[]): boolean {
  if (a.length !== b.length) return false
  return a.every((s, i) => {
    const t = b[i]
    return t !== undefined && s.axis === t.axis && s.source === t.source && s.actions === t.actions && s.durationMs === t.durationMs
  })
}
