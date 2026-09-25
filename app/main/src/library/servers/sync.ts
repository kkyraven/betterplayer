import { t } from '../../i18n'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readPerVideo } from '../../settings/store'
import { FOLDED_STAMP, type LibraryDb, type ServerRoot } from '../db'
import { WriteBatch } from '../scanner'
import type { ScriptScanner } from '../scripts'
import type { TagJob } from '../tagger'
import { makeAdapter, type RemoteScene } from './adapter'
import { STAND_IN } from './names'
import type { PosterDecoder } from './images'
import { recordMetric } from './diagnostics'
import { AssetQueue } from './assets'

const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

export interface SyncHooks {
  progress: () => void
  changed: () => void
  editing?: (id: number) => boolean
  decodePoster?: PosterDecoder
  image?: (id: number) => void
  tagging?: () => boolean
  tag?: (job: TagJob) => void
}

export interface SyncState {
  done: number
  total: number
}

export class ServerSync {
  readonly assets: AssetQueue
  private closed = false
  constructor(
    private readonly db: LibraryDb,
    scripts: ScriptScanner,
    private readonly remoteDir: string,
    posterFile: (id: number) => string,
    stripFile: (id: number) => string,
    private readonly hooks: SyncHooks,
  ) {
    this.assets = new AssetQueue(db, scripts, remoteDir, posterFile, stripFile, hooks)
  }

  close() {
    this.closed = true
    this.assets.close()
  }

  standIn(id: number): string {
    return join(this.remoteDir, String(id), STAND_IN)
  }

  async removeCache(ids: number[]) {
    this.assets.cancel(ids)
    await Promise.allSettled(ids.map((id) => rm(join(this.remoteDir, String(id)), { recursive: true, force: true })))
  }

  async sync(root: ServerRoot, state: SyncState): Promise<number[]> {
    const started = Date.now()
    const adapter = makeAdapter(root)
    const rows: ReturnType<LibraryDb['remoteSyncRows']> = []
    let after = 0
    while (!this.closed && this.db.server(root.id)) {
      const page = this.db.remoteSyncRows(root.id, after)
      if (!page.length) break
      rows.push(...page)
      after = page[page.length - 1]!.id
      await yieldTurn()
    }
    if (this.closed || !this.db.server(root.id)) return []
    const known = new Map(rows.map((r) => [r.key, r.imported && (r.scriptsStamp || r.scriptsQueued) ? r.stamp : '']))
    const byKey = new Map(rows.map((r) => [r.key, r]))
    const localEdits = new Map(rows.map((r) => [r.id, {
      pending: this.hooks.editing?.(r.id) ?? false, folded: root.kind === 'heresphere' && r.stamp === FOLDED_STAMP,
      rating: r.rating, favourite: r.favourite, tags: r.tags,
    }]))
    await this.assets.restore(root)
    if (this.closed || !this.db.server(root.id)) return []
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
    const batch = new WriteBatch(this.db, () => this.hooks.changed(), () => !this.closed)
    let changed = 0
    const failures: string[] = []
    try {
      for await (const entries of adapter.scenes(known, (n) => {
        state.total += n
        this.hooks.progress()
      })) {
        if (this.closed || !this.db.server(root.id)) return []
        const fresh = entries.filter((e) => e.scene !== null && known.get(e.key) !== e.stamp && !excluded.has(e.scene.folder))
        for (const e of entries) seen.add(e.key)
        state.done += entries.length - fresh.length
        this.hooks.progress()
        for (const entry of fresh) {
          const scene = entry.scene
          if (!scene) continue
          if (this.closed || !this.db.server(root.id)) return []
          try {
            await this.importScene(root, adapter.headers, scene, entry.stamp, byKey.get(entry.key) ?? null, batch, preserveEdit)
            seenPaths.add(scene.stream)
            changed++
          } catch (e) {
            process.stderr.write('metadata import failed\n')
            failures.push(t('library.server.error.importScene', { title: scene.title, error: e instanceof Error ? e.message : String(e) }))
          }
          state.done++
          this.hooks.progress()
          await yieldTurn()
        }
        await batch.flush()
      }
    } catch (e) {
      await batch.flush()
      if (this.closed) return []
      this.assets.wake()
      this.db.setRootError(root.id, e instanceof Error ? e.message : String(e))
      throw e
    }
    await batch.flush()
    if (this.closed || !this.db.server(root.id)) return []
    const gone = rows.filter((r) => !seen.has(r.key) && !seenPaths.has(r.path)).map((r) => r.id)
    if (gone.length > 0) {
      this.assets.cancel(gone)
      this.db.removeMedia(gone)
      await this.removeCache(gone)
      if (this.closed || !this.db.server(root.id)) return gone
      this.hooks.changed()
    }
    this.db.setRootError(root.id, [...failures, this.db.remoteWriteError(root.id)].filter(Boolean).join('\n'))
    this.db.setRootScanned(root.id, Date.now())
    this.assets.wake()
    recordMetric('metadata', Date.now() - started)
    process.stderr.write(`metadata sync: ${seen.size} scenes, ${changed} imported, ${gone.length} removed, ${Date.now() - started} ms\n`)
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

    await batch.add(() => {
      if (this.closed || !this.db.server(root.id)) return
      const current = this.db.stamp(scene.stream)
      const tagged = current?.tags === 'ready'
      if (existing) this.db.upsertMedia(upsert, now)
      this.db.setAddedAt(id, scene.addedAt)
      this.assets.enqueue(root, id, scene, stamp)
      if (current) {
        this.db.setThumbState(id, 'thumb', current.thumb)
        this.db.setThumbState(id, 'strip', current.strip)
      }
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
      this.db.setRemoteStamp(id, stamp)
      if (scene.projection && (scene.projection.kind !== 'flat' || scene.projection.layout !== 'mono')) this.setProjection(scene.stream, scene.projection, now)
    })
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

}
