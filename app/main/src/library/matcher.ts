import { t } from '../i18n'
import { constants } from 'node:fs'
import { copyFile, link, open, readdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { isVideoPath } from '@shared/ipc'
import { MIN_CONFIDENCE, nameSimilarity, nameTokens, parseScriptName, renamedScript, scoreMatch, type MatchCandidate, type MatcherReport, type MatcherResolveResult, type OrphanFile, type OrphanSet } from '@shared/matcher'
import type { LibraryDb, MatchMedia } from './db'
import { verifiedScriptEntries } from '../downloads/verify'

const SKIP_DIRS = new Set(['@eaDir', '.AppleDouble', 'System Volume Information', '$RECYCLE.BIN', '$Recycle.Bin', 'Config.Msi', 'Recovery'])
const CANDIDATES_SHOWN = 5
const DURATION_WINDOW = 0.1
const MAX_SCRIPT_BYTES = 32 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_ACTIONS = 1_000_000

const warn = (what: string, e: unknown) => process.stderr.write(`${what}: ${e instanceof Error ? e.message : String(e)}\n`)

interface Found {
  rootId: number
  dir: string
  folder: string
  stem: string
  files: OrphanFile[]
  durationMs: number
  mtime: number
  birthtime: number
}

export async function buildReport(db: LibraryDb): Promise<MatcherReport> {
  const media = db.mediaForMatching()
  const knownStems = new Set(media.map((m) => m.stem))
  const found: Found[] = []
  for (const root of db.roots()) {
    const rootStat = await stat(root.path).catch(() => null)
    if (!rootStat?.isDirectory()) continue
    found.push(...(await findOrphans(root.id, root.path, new Set(db.excludedFolders(root.id)), knownStems)))
  }
  const index = tokenIndex(media)
  const sets: OrphanSet[] = []
  for (const set of found) {
    const candidates = await score(set, media, index)
    sets.push({
      id: `${set.dir}${sep}${set.stem}`,
      rootId: set.rootId,
      dir: set.dir,
      folder: set.folder,
      stem: set.stem,
      files: set.files,
      durationMs: set.durationMs,
      candidates,
    })
  }
  sets.sort((a, b) => (b.candidates[0]?.confidence ?? 0) - (a.candidates[0]?.confidence ?? 0) || a.stem.localeCompare(b.stem))
  return { sets, at: Date.now() }
}

async function findOrphans(rootId: number, rootPath: string, excluded: Set<string>, libraryStems: ReadonlySet<string>): Promise<Found[]> {
  const out: Found[] = []
  const stack = [rootPath]
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (e) {
      warn(`matcher cannot read ${dir}`, e)
      continue
    }
    const videoStems = new Set<string>()
    const scriptNames: string[] = []
    const archiveDurations = new Map<string, number>()
    for (const entry of entries) {
      const name = entry.name
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
      if (entry.isDirectory()) {
        if (!excluded.has(relative(rootPath, join(dir, name)).split(sep).join('/'))) stack.push(join(dir, name))
        continue
      }
      if (isVideoPath(name)) videoStems.add(basename(name, extname(name)))
      else {
        if (/\.funscript$/i.test(name)) scriptNames.push(name)
        else if (/\.zip$/i.test(name)) {
          try {
            const bytes = await readBoundedFile(join(dir, name), MAX_ARCHIVE_BYTES)
            if (!bytes) continue
            const packed = verifiedScriptEntries(bytes)
            archiveDurations.set(name, Math.max(...packed.map((entry) => scriptBytesDuration(entry.bytes))))
            scriptNames.push(name)
          } catch { }
        }
      }
    }
    const knownStems = new Set([...libraryStems, ...videoStems])
    for (const name of archiveDurations.keys()) knownStems.add(basename(name, extname(name)))
    scriptNames.sort((a, b) => a.length - b.length || a.localeCompare(b))
    for (const name of scriptNames) {
      const parsed = parseScriptName(name, knownStems)
      if (parsed?.suffix === '') knownStems.add(parsed.stem)
    }
    const byStem = new Map<string, OrphanFile[]>()
    for (const name of scriptNames) {
      const s = archiveDurations.has(name) ? { stem: basename(name, extname(name)), suffix: '', axis: 'L0' as const } : parseScriptName(name, knownStems)
      if (!s) continue
      if (videoStems.has(s.stem)) continue
      const files = byStem.get(s.stem) ?? []
      files.push({ name, suffix: s.suffix, axis: s.axis })
      byStem.set(s.stem, files)
    }
    const folder = relative(rootPath, dir).split(sep).join('/')
    for (const [stem, files] of byStem) {
      files.sort((a, b) => (a.suffix === '' ? -1 : b.suffix === '' ? 1 : a.suffix.localeCompare(b.suffix)))
      let durationMs = 0
      let mtime = Infinity
      let birthtime = Infinity
      for (const file of files) {
        const full = join(dir, file.name)
        const info = await stat(full).catch(() => null)
        if (info) {
          mtime = Math.min(mtime, info.mtimeMs)
          birthtime = Math.min(birthtime, info.birthtimeMs || info.mtimeMs)
        }
        durationMs = Math.max(durationMs, archiveDurations.get(file.name) ?? await scriptDuration(full))
      }
      out.push({ rootId, dir, folder, stem, files, durationMs, mtime: Number.isFinite(mtime) ? mtime : 0, birthtime: Number.isFinite(birthtime) ? birthtime : 0 })
    }
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function scriptDuration(file: string): Promise<number> {
  try {
    const bytes = await readBoundedFile(file, MAX_SCRIPT_BYTES)
    return bytes ? scriptBytesDuration(bytes) : 0
  } catch (e) {
    warn(`matcher cannot read ${file}`, e)
    return 0
  }
}

async function readBoundedFile(file: string, limit: number): Promise<Buffer | null> {
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) return null
    const bytes = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    return length === info.size ? bytes.subarray(0, length) : null
  } finally { await handle.close() }
}

function scriptBytesDuration(bytes: Buffer): number {
  try {
    const raw: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
    if (!isRecord(raw)) return 0
    let end = 0
    let actionCount = 0
    const actions = [raw.actions]
    if (Array.isArray(raw.axes)) for (const axis of raw.axes) if (isRecord(axis)) actions.push(axis.actions)
    if (isRecord(raw.channels)) for (const channel of Object.values(raw.channels)) if (isRecord(channel)) actions.push(channel.actions)
    for (const list of actions) {
      if (!Array.isArray(list)) continue
      actionCount += list.length
      if (actionCount > MAX_ACTIONS) return 0
      for (const action of list) {
        const at = isRecord(action) ? action.at : undefined
        if (typeof at === 'number' && Number.isFinite(at) && at > end) end = at
      }
    }
    const declared = isRecord(raw.metadata) ? raw.metadata.duration : undefined
    if (typeof declared === 'number' && Number.isFinite(declared * 1000) && declared * 1000 > end) end = declared * 1000
    return Math.round(end)
  } catch { return 0 }
}

function tokenIndex(media: MatchMedia[]): Map<string, MatchMedia[]> {
  const index = new Map<string, MatchMedia[]>()
  for (const m of media) {
    for (const t of new Set(nameTokens(m.stem))) {
      if (t.length < 3) continue
      const list = index.get(t) ?? []
      list.push(m)
      index.set(t, list)
    }
  }
  return index
}

async function score(set: Found, media: MatchMedia[], index: Map<string, MatchMedia[]>): Promise<MatchCandidate[]> {
  const pool = new Set<MatchMedia>()
  for (const t of new Set(nameTokens(set.stem))) for (const m of index.get(t) ?? []) pool.add(m)
  if (set.durationMs > 0) {
    for (const m of media) if (m.durationMs > 0 && Math.abs(m.durationMs - set.durationMs) <= DURATION_WINDOW * m.durationMs) pool.add(m)
  }
  const scored: { m: MatchMedia; name: number; confidence: number }[] = []
  for (const m of pool) {
    const name = nameSimilarity(set.stem, m.stem)
    const { confidence } = scoreMatch(baseFeatures(set, m, name, null))
    if (confidence > 0) scored.push({ m, name, confidence })
  }
  scored.sort((a, b) => b.confidence - a.confidence)
  const out: MatchCandidate[] = []
  for (const { m, name } of scored.slice(0, CANDIDATES_SHOWN * 2)) {
    const existing = await readdir(dirname(m.path)).catch(() => null)
    if (!existing) continue
    const taken = new Set(existing.map((file) => file.toLowerCase()))
    if (set.files.some((file) => taken.has(renamedScript(m.stem, file).toLowerCase()))) continue
    const info = await stat(m.path).catch(() => null)
    const videoTimes = [m.mtime, info?.mtimeMs ?? m.mtime, info?.birthtimeMs || m.mtime]
    const scriptTimes = [set.mtime, set.birthtime].filter((t) => t > 0)
    let timeDiff: number | null = null
    for (const s of scriptTimes) for (const v of videoTimes) timeDiff = timeDiff === null ? Math.abs(s - v) : Math.min(timeDiff, Math.abs(s - v))
    const { confidence, reasons } = scoreMatch(baseFeatures(set, m, name, timeDiff))
    if (confidence >= MIN_CONFIDENCE) out.push({ mediaId: m.id, title: m.title, stem: m.stem, rootId: m.rootId, folder: m.folder, durationMs: m.durationMs, confidence, reasons })
  }
  out.sort((a, b) => b.confidence - a.confidence)
  return out.slice(0, CANDIDATES_SHOWN)
}

function baseFeatures(set: Found, m: MatchMedia, name: number, timeDiffMs: number | null) {
  return {
    durationDiffMs: set.durationMs > 0 && m.durationMs > 0 ? Math.abs(set.durationMs - m.durationMs) : null,
    videoDurationMs: m.durationMs,
    name,
    timeDiffMs,
    sameFolder: dirname(m.path) === set.dir,
  }
}

export async function resolveSet(set: Pick<OrphanSet, 'dir' | 'files'>, videoPath: string): Promise<MatcherResolveResult> {
  const videoDir = dirname(videoPath)
  const videoStem = basename(videoPath, extname(videoPath))
  const result: MatcherResolveResult = { renamed: [], failed: [] }
  for (const file of set.files) {
    const from = join(set.dir, file.name)
    const to = join(videoDir, renamedScript(videoStem, file))
    try {
      const occupied = (await readdir(videoDir)).some((name) => name.toLowerCase() === basename(to).toLowerCase())
      if (occupied) throw new Error(t('matcher.nameTaken'))
      try { await link(from, to) }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EXDEV') throw error
        await copyFile(from, to, constants.COPYFILE_EXCL)
      }
      await unlink(from)
      result.renamed.push(to)
    } catch (e) {
      result.failed.push({ name: file.name, error: e instanceof Error && 'code' in e && e.code === 'EEXIST' ? t('matcher.nameTaken') : e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}
