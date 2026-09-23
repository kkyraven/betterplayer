import { t } from '../../i18n'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readPerVideo } from '../../settings/store'
import { FOLDED_STAMP, type LibraryDb, type ScriptRow, type ServerRoot } from '../db'
import { WriteBatch } from '../scanner'
import { summarise, type ScriptScanner } from '../scripts'
import type { TagJob } from '../tagger'
import { makeAdapter, type RemoteScene } from './adapter'
import { mapLanes, request } from './http'
import { scriptFileNames, STAND_IN } from './names'
import { ASSET_RECHECK_MS, cacheImage } from './images'

const DOWNLOAD_LANES = 4

export interface SyncHooks {
  progress: () => void
  changed: () => void
  editing?: (id: number) => boolean
  decodePoster?: (bytes: Buffer) => Buffer
  tagging?: () => boolean
  tag?: (job: TagJob) => void
}

export interface SyncState {
  done: number
  total: number
}

const warn = (what: string, e: unknown) => process.stderr.write(`${what}: ${e instanceof Error ? e.message : String(e)}\n`)

export class ServerSync {
  constructor(
    private readonly db: LibraryDb,
    private readonly scripts: ScriptScanner,
    private readonly remoteDir: string,
    private readonly posterFile: (id: number) => string,
    private readonly stripFile: (id: number) => string,
    private readonly hooks: SyncHooks,
  ) {}

  standIn(id: number): string {
    return join(this.remoteDir, String(id), STAND_IN)
  }

  async removeCache(ids: number[]) {
    await Promise.allSettled(ids.map((id) => rm(join(this.remoteDir, String(id)), { recursive: true, force: true })))
  }

  async sync(root: ServerRoot, state: SyncState): Promise<number[]> {
    const started = Date.now()
    const adapter = makeAdapter(root)
    const rows = this.db.remoteRows(root.id)
    const known = new Map(rows.map((r) => {
      const cached = this.db.stamp(r.path)
      const incomplete = cached && (!cached.scriptsStamp || this.assetDue(r.id, 'thumb', root.kind === 'stash') || (root.kind === 'stash' && this.assetDue(r.id, 'strip', true)))
      return [r.key, incomplete || !this.db.metadataImported(r.id) ? '' : r.stamp]
    }))
    const byKey = new Map(rows.map((r) => [r.key, r]))
    const localEdits = new Map(rows.map((r) => {
      const media = this.db.mediaRow(r.id)
      return [r.id, { pending: this.hooks.editing?.(r.id) ?? false, folded: root.kind === 'heresphere' && r.stamp === FOLDED_STAMP, rating: media?.rating, favourite: media?.favourite, tags: media?.tags }]
    }))
    const preserveEdit = (id: number, field: 'rating' | 'tags') => {
      const before = localEdits.get(id)
      const current = before && this.db.mediaRow(id)
      const ratingChanged = before !== undefined && (before.rating !== current?.rating || before.favourite !== current?.favourite)
      if (field === 'rating' && before?.folded) return ratingChanged
      if (this.hooks.editing?.(id)) return true
      if (!before) return false
      return before.pending || ratingChanged || JSON.stringify(before.tags) !== JSON.stringify(current?.tags)
    }
    const excluded = new Set(this.db.excludedFolders(root.id))
    const seen = new Set<string>()
    const seenPaths = new Set<string>()
    const batch = new WriteBatch(this.db, () => this.hooks.changed())
    let changed = 0
    const failures: string[] = []
    try {
      for await (const entries of adapter.scenes(known, (n) => {
        state.total += n
        this.hooks.progress()
      })) {
        const fresh = entries.filter((e) => e.scene !== null && known.get(e.key) !== e.stamp && !excluded.has(e.scene.folder))
        for (const e of entries) seen.add(e.key)
        state.done += entries.length - fresh.length
        this.hooks.progress()
        await mapLanes(fresh, DOWNLOAD_LANES, async (entry) => {
          const scene = entry.scene
          if (!scene) return
          try {
            const complete = await this.importScene(root, adapter.headers, scene, entry.stamp, byKey.get(entry.key) ?? null, batch, preserveEdit)
            if (!complete) failures.push(t('library.server.error.downloadAssets', { title: scene.title }))
            seenPaths.add(scene.stream)
            changed++
          } catch (e) {
            warn(`import ${scene.title}`, e)
            failures.push(t('library.server.error.importScene', { title: scene.title, error: e instanceof Error ? e.message : String(e) }))
          }
          state.done++
          this.hooks.progress()
        })
        batch.flush()
      }
    } catch (e) {
      batch.flush()
      this.db.setRootError(root.id, e instanceof Error ? e.message : String(e))
      throw e
    }
    batch.flush()
    const gone = rows.filter((r) => !seen.has(r.key) && !seenPaths.has(r.path)).map((r) => r.id)
    if (gone.length > 0) {
      this.db.removeMedia(gone)
      await this.removeCache(gone)
    }
    this.db.setRootError(root.id, [...failures, this.db.remoteWriteError(root.id)].filter(Boolean).join('\n'))
    this.db.setRootScanned(root.id, Date.now())
    process.stderr.write(`sync ${root.url}: ${seen.size} scenes, ${changed} imported, ${gone.length} removed, ${Date.now() - started} ms\n`)
    return gone
  }

  private async importScene(root: ServerRoot, headers: Record<string, string>, scene: RemoteScene, stamp: string, row: { id: number; path: string } | null, batch: WriteBatch, preserveEdit: (id: number, field: 'rating' | 'tags') => boolean) {
    if (row && row.path !== scene.stream) this.db.moveMedia(row.id, { rootId: root.id, path: scene.stream, folder: scene.folder }, row.path)
    const existing = this.db.stamp(scene.stream)
    const now = Date.now()
    const upsert = {
      rootId: root.id,
      path: scene.stream,
      folder: scene.folder,
      title: scene.title,
      size: scene.size,
      mtime: scene.mtime,
      durationMs: scene.durationMs,
      width: scene.width,
      height: scene.height,
      codec: scene.codec,
      projection: scene.projection?.kind ?? 'flat',
      remoteKey: scene.key,
    }
    const id = existing?.id ?? this.db.upsertMedia(upsert, now)
    if (id === 0) throw new Error('row not stored')

    const version = root.kind === 'stash' ? stamp : ''
    const scriptsStamp = JSON.stringify([version, scene.scripts])
    const scriptsNeeded = !existing || existing.scriptsStamp !== scriptsStamp
    const scripts = scriptsNeeded ? await this.fetchScripts(id, scene, headers) : null

    const poster = await this.importImage(id, 'thumb', scene.thumb, version, root.kind === 'stash', headers)
    const strip = scene.preview ? await this.importImage(id, 'strip', scene.preview, version, true, headers, scene.durationMs) : null
    const complete = (!scriptsNeeded || scripts !== null) && poster.complete && (!strip || strip.complete)
    batch.add(() => {
      const tagged = this.db.stamp(scene.stream)?.tags === 'ready'
      if (existing) this.db.upsertMedia(upsert, now)
      this.db.setAddedAt(id, scene.addedAt)
      if (scripts) {
        this.db.setScripts(id, scripts, summarise(scripts))
        this.db.setScriptsStamp(id, scriptsStamp)
      }
      poster.commit()
      strip?.commit()
      this.db.setThumbState(id, 'thumb', existsSync(this.posterFile(id)) ? 'ready' : 'failed')
      this.db.setThumbState(id, 'strip', strip && existsSync(this.stripFile(id)) ? 'ready' : 'failed')
      const tagState = !this.hooks.tagging?.() ? 'failed' : tagged ? 'ready' : 'pending'
      this.db.setThumbState(id, 'tags', tagState)
      if (tagState === 'pending' && scene.durationMs > 0) this.hooks.tag?.({ id, path: scene.stream, durationMs: scene.durationMs, headers })
      const keepRating = preserveEdit(id, 'rating')
      const keepTags = preserveEdit(id, 'tags')
      if (!keepRating) {
        this.db.setRating(id, scene.rating)
        if (scene.favourite !== undefined) this.db.setFavourite([id], scene.favourite)
      }
      if (!keepTags) this.db.setTags(id, scene.tags)
      this.db.setMetadata(id, { description: scene.description, performers: scene.performers, filename: scene.filename, studio: scene.folder })
      this.db.setRemoteStamp(id, complete ? stamp : '')
      if (scene.projection && (scene.projection.kind !== 'flat' || scene.projection.layout !== 'mono')) this.setProjection(scene.stream, scene.projection, now)
    })
    return complete
  }

  private setProjection(key: string, projection: NonNullable<RemoteScene['projection']>, now: number) {
    const row = this.db.videoSettings(key)
    let raw: unknown = null
    if (row) {
      try {
        raw = JSON.parse(row.settings)
      } catch {
        raw = null
      }
    }
    const settings = readPerVideo(raw)
    if (settings.projection) return
    const rest = { ...settings, projection }
    delete rest.position
    this.db.setVideoSettings(key, { positionMs: row?.positionMs ?? null, settings: JSON.stringify(rest) }, now)
  }

  private async fetchScripts(id: number, scene: RemoteScene, headers: Record<string, string>): Promise<ScriptRow[] | null> {
    const names = scriptFileNames(scene.scripts.map((s) => s.name))
    const files = await mapLanes(scene.scripts, 2, async (script, i): Promise<{ name: string; text: string } | null> => {
      const name = names[i]
      if (!name) return null
      try {
        const res = await request(script.url, { headers })
        const text = await res.text()
        JSON.parse(text)
        return { name, text }
      } catch (e) {
        warn(`script ${script.url}`, e)
        return null
      }
    })
    if (files.some((f) => f === null)) return null
    const dir = join(this.remoteDir, String(id))
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    for (const f of files) if (f) await writeFile(join(dir, f.name), f.text)
    if ((await readdir(dir)).length === 0) return []
    return this.scripts.scriptsFor(this.standIn(id))
  }

  private assetDue(id: number, kind: 'thumb' | 'strip', periodic: boolean): boolean {
    const asset = this.db.remoteAsset(id, kind)
    return !asset || (asset.digest !== '' && !existsSync(kind === 'thumb' ? this.posterFile(id) : this.stripFile(id))) || (periodic && Date.now() - asset.checkedAt >= ASSET_RECHECK_MS)
  }

  private async importImage(id: number, kind: 'thumb' | 'strip', source: string | NonNullable<RemoteScene['preview']> | null, version: string, periodic: boolean, headers: Record<string, string>, durationMs = 0) {
    const stamp = JSON.stringify([version, source])
    const asset = this.db.remoteAsset(id, kind)
    if (asset?.source === stamp && !this.assetDue(id, kind, periodic)) return { complete: true, commit: () => {} }
    try {
      const digest = source ? await cacheImage(kind === 'thumb' ? this.posterFile(id) : this.stripFile(id), source, headers, durationMs, this.hooks.decodePoster) : null
      const checkedAt = Date.now()
      return { complete: true, commit: () => this.db.setRemoteAsset(id, kind, stamp, digest ?? asset?.digest ?? '', checkedAt) }
    } catch (e) {
      warn(`${kind} ${id}`, e)
      return { complete: false, commit: () => {} }
    }
  }
}
