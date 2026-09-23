import { t } from '../i18n'
import { readdir, readFile, rename, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { isVideoPath } from '@shared/ipc'
import { MIN_CONFIDENCE, nameSimilarity, nameTokens, parseScriptName, renamedScript, scoreMatch, type MatchCandidate, type MatcherReport, type MatcherResolveResult, type OrphanFile, type OrphanSet } from '@shared/matcher'
import type { LibraryDb, MatchMedia } from './db'

const SKIP_DIRS = new Set(['@eaDir', '.AppleDouble', 'System Volume Information', '$RECYCLE.BIN', '$Recycle.Bin', 'Config.Msi', 'Recovery'])
const CANDIDATES_SHOWN = 5
const DURATION_WINDOW = 0.1

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
  const found: Found[] = []
  for (const root of db.roots()) {
    const rootStat = await stat(root.path).catch(() => null)
    if (!rootStat?.isDirectory()) continue
    found.push(...(await findOrphans(root.id, root.path, new Set(db.excludedFolders(root.id)))))
  }
  const media = db.mediaForMatching()
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

async function findOrphans(rootId: number, rootPath: string, excluded: Set<string>): Promise<Found[]> {
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
    const scripts: { name: string; stem: string; suffix: string; axis: OrphanFile['axis'] }[] = []
    for (const entry of entries) {
      const name = entry.name
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
      if (entry.isDirectory()) {
        if (!excluded.has(relative(rootPath, join(dir, name)).split(sep).join('/'))) stack.push(join(dir, name))
        continue
      }
      if (isVideoPath(name)) videoStems.add(basename(name, extname(name)))
      else {
        const parsed = parseScriptName(name)
        if (parsed) scripts.push({ name, ...parsed })
      }
    }
    const byStem = new Map<string, OrphanFile[]>()
    for (const s of scripts) {
      if (videoStems.has(s.stem)) continue
      const files = byStem.get(s.stem) ?? []
      files.push({ name: s.name, suffix: s.suffix, axis: s.axis })
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
        durationMs = Math.max(durationMs, await scriptDuration(full))
      }
      out.push({ rootId, dir, folder, stem, files, durationMs, mtime: Number.isFinite(mtime) ? mtime : 0, birthtime: Number.isFinite(birthtime) ? birthtime : 0 })
    }
  }
  return out
}

async function scriptDuration(file: string): Promise<number> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return 0
    const { actions, metadata } = raw as { actions?: unknown; metadata?: unknown }
    let end = 0
    if (Array.isArray(actions)) {
      for (const a of actions) {
        const at = typeof a === 'object' && a !== null ? (a as { at?: unknown }).at : undefined
        if (typeof at === 'number' && at > end) end = at
      }
    }
    const declared = typeof metadata === 'object' && metadata !== null ? (metadata as { duration?: unknown }).duration : undefined
    if (typeof declared === 'number' && declared * 1000 > end) end = declared * 1000
    return Math.round(end)
  } catch (e) {
    warn(`matcher cannot read ${file}`, e)
    return 0
  }
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
  const axes = new Set(set.files.map((f) => f.axis))
  const pool = new Set<MatchMedia>()
  for (const t of new Set(nameTokens(set.stem))) for (const m of index.get(t) ?? []) pool.add(m)
  if (set.durationMs > 0) {
    for (const m of media) if (m.durationMs > 0 && Math.abs(m.durationMs - set.durationMs) <= DURATION_WINDOW * m.durationMs) pool.add(m)
  }
  const scored: { m: MatchMedia; name: number; confidence: number }[] = []
  for (const m of pool) {
    if (m.axes.some((a) => axes.has(a))) continue
    const name = nameSimilarity(set.stem, m.stem)
    const { confidence } = scoreMatch(baseFeatures(set, m, name, null))
    if (confidence > 0) scored.push({ m, name, confidence })
  }
  scored.sort((a, b) => b.confidence - a.confidence)
  const out: MatchCandidate[] = []
  for (const { m, name } of scored.slice(0, CANDIDATES_SHOWN * 2)) {
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
      if (await stat(to).then(() => true, () => false)) throw new Error(t('matcher.nameTaken'))
      await rename(from, to)
      result.renamed.push(to)
    } catch (e) {
      result.failed.push({ name: file.name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}
