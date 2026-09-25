import { existsSync, renameSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { t } from '../../i18n'
import type { AssetJob, AssetKind, LibraryDb, ServerRoot } from '../db'
import { summarise, type ScriptScanner } from '../scripts'
import { ToolMissingError } from '../tools'
import { makeAdapter, type RemoteScene } from './adapter'
import { HttpError, request } from './http'
import { ASSET_RECHECK_MS, cacheImage, type PosterDecoder } from './images'
import { recordMetric } from './diagnostics'
import { scriptFileNames, STAND_IN } from './names'

export const ASSET_RETRY_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, ASSET_RECHECK_MS]
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

type ImageSource = string | NonNullable<RemoteScene['preview']> | null
interface AssetHooks {
  progress: () => void
  changed: () => void
  image?: (id: number) => void
  decodePoster?: PosterDecoder
}

export class AssetQueue {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private active: { job: AssetJob; controller: AbortController } | null = null
  private closed = false
  private authBlocks = new Map<number, number>()
  private toolBlock = 0

  constructor(
    private readonly db: LibraryDb,
    private readonly scripts: Pick<ScriptScanner, 'scriptsFor'>,
    private readonly remoteDir: string,
    private readonly posterFile: (id: number) => string,
    private readonly stripFile: (id: number) => string,
    private readonly hooks: AssetHooks,
  ) {}

  pending(): number { return this.closed ? 0 : this.db.pendingAssets() }

  enqueue(root: ServerRoot, id: number, scene: RemoteScene, stamp: string) {
    const version = root.kind === 'stash' ? stamp : ''
    const scripts = JSON.stringify([version, scene.scripts])
    const cached = this.db.stamp(scene.stream)
    this.db.enqueueAsset(id, 'scripts', scripts, cached?.scriptsStamp === scripts ? null : Date.now(), 0)
    this.enqueueImage(root, id, 'thumb', JSON.stringify([version, scene.thumb]))
    if (scene.preview) this.enqueueImage(root, id, 'strip', JSON.stringify([version, scene.preview]))
    if (this.active?.job.mediaId === id && !this.current(this.active.job)) this.active.controller.abort()
    this.deferScopes(root.id)
  }

  private enqueueImage(root: ServerRoot, id: number, kind: 'thumb' | 'strip', source: string, present?: boolean) {
    const cached = this.db.remoteAsset(id, kind)
    const usable = present ?? existsSync(this.file(kind, id))
    const periodic = root.kind === 'stash'
    const due = cached?.source !== source || (!!cached.digest && !usable) ? Date.now() : periodic ? cached.checkedAt + ASSET_RECHECK_MS : null
    this.db.enqueueAsset(id, kind, source, due, usable || cached?.digest === '' ? 2 : kind === 'thumb' ? 0 : 1)
    const job = this.db.assetJob(id, kind)
    if (job && cached?.digest && !usable) this.db.repairAsset(job, kind === 'thumb' ? 0 : 1)
  }

  async restore(root: ServerRoot) {
    const [posters, strips] = await Promise.all([this.posterFile, this.stripFile].map(async (file) => new Set(await readdir(dirname(file(0))).catch(() => []))))
    let after = 0
    while (!this.closed && this.db.server(root.id)) {
      const page = this.db.remoteAssetPage(root.id, after)
      if (!page.length) break
      let index = 0
      while (index < page.length && !this.closed) {
        const started = performance.now()
        this.db.transaction(() => {
          do {
            const asset = page[index++]!
            const files = asset.kind === 'thumb' ? posters : strips
            const file = this.file(asset.kind, asset.id).split(/[\\/]/).pop()!
            this.enqueueImage(root, asset.id, asset.kind, this.db.assetJob(asset.id, asset.kind)?.source ?? asset.source, files!.has(file))
            after = asset.id
          } while (index < page.length && performance.now() - started < 8)
        })
        recordMetric('database', performance.now() - started)
        await yieldTurn()
        if (this.closed || !this.db.server(root.id)) return
      }
      await yieldTurn()
    }
    if (!this.closed) this.deferScopes(root.id)
  }

  private deferScopes(rootId: number) {
    const auth = this.authBlocks.get(rootId) ?? 0
    if (auth > Date.now()) this.db.deferAssetScope(rootId, null, auth)
    if (this.toolBlock > Date.now()) this.deferTools(this.toolBlock)
  }

  private deferTools(until: number) {
    this.db.deferAssetScope(null, 'strip', until)
    if (!this.hooks.decodePoster) this.db.deferAssetScope(null, 'thumb', until)
  }

  wake() {
    if (this.closed || this.running) return
    if (this.timer) clearTimeout(this.timer)
    const due = this.db.nextAssetAttempt()
    if (due === null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain(true)
    }, Math.min(2_147_483_647, Math.max(0, due - Date.now())))
    this.timer.unref()
  }

  async drain(paced = false): Promise<void> {
    if (this.running) {
      await this.running
      if (!paced) return this.drain()
      return
    }
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.running = this.work(paced).finally(() => { this.running = null; if (!this.timer) this.wake() })
    return this.running
  }

  private async work(paced: boolean) {
    while (!this.closed) {
      const job = this.db.dueAsset(Date.now())
      if (!job) break
      const controller = new AbortController()
      this.active = { job, controller }
      try {
        await this.perform(job, controller.signal)
      } catch (error) {
        if (!this.closed && !controller.signal.aborted && this.current(job)) {
          const attempts = job.attempts + 1
          const next = Date.now() + ASSET_RETRY_MS[Math.min(attempts - 1, ASSET_RETRY_MS.length - 1)]!
          if (job.kind !== 'scripts' && !existsSync(this.file(job.kind, job.mediaId))) this.db.setThumbState(job.mediaId, job.kind, 'failed')
          this.db.finishAsset(job, next, attempts, error instanceof HttpError && (error.status === 401 || error.status === 403) ? t('library.server.error.signInFailed') : t('library.server.error.downloadAssets', { title: this.db.mediaRow(job.mediaId)?.title ?? '' }))
          this.hooks.image?.(job.mediaId)
          if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
            this.authBlocks.set(job.rootId, next)
            this.db.deferAssetScope(job.rootId, null, next)
          } else if (error instanceof ToolMissingError) {
            this.toolBlock = next
            this.deferTools(next)
          }
        }
      } finally {
        this.active = null
        if (!this.closed) this.hooks.progress()
      }
      if (paced) {
        this.timer = setTimeout(() => { this.timer = null; this.wake() }, job.priority === 2 ? 250 : 10)
        this.timer.unref()
        return
      }
      await yieldTurn()
    }
  }

  cancel(ids: number[]) {
    if (this.active && ids.includes(this.active.job.mediaId)) this.active.controller.abort()
  }

  close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.active?.controller.abort()
  }

  private current(job: AssetJob): boolean {
    if (this.closed) return false
    const current = this.db.assetJob(job.mediaId, job.kind)
    return current?.generation === job.generation && current.source === job.source
  }

  private file(kind: Exclude<AssetKind, 'scripts'>, id: number) {
    return kind === 'thumb' ? this.posterFile(id) : this.stripFile(id)
  }

  private async perform(job: AssetJob, signal: AbortSignal) {
    const root = this.db.server(job.rootId)
    if (!root) return
    const headers = makeAdapter(root).headers
    const started = performance.now()
    await mkdir(this.remoteDir, { recursive: true })
    const stage = await mkdtemp(join(this.remoteDir, '.asset-'))
    let preserveStage = false
    try {
      if (job.kind === 'scripts') {
        const [, sources] = JSON.parse(job.source) as [string, RemoteScene['scripts']]
        const names = scriptFileNames(sources.map((s) => s.name))
        const scriptDir = join(stage, 'scripts')
        await mkdir(scriptDir)
        for (let i = 0; i < sources.length; i++) {
          const res = await request(sources[i]!.url, { headers, signal })
          const text = await res.text()
          JSON.parse(text)
          await writeFile(join(scriptDir, names[i]!), text, { signal })
        }
        const scripts = sources.length ? await this.scripts.scriptsFor(join(scriptDir, STAND_IN)) : []
        signal.throwIfAborted()
        if (!this.current(job)) return
        const destination = join(this.remoteDir, String(job.mediaId))
        const backup = join(stage, 'previous')
        const hadCache = existsSync(destination)
        if (hadCache) renameSync(destination, backup)
        let installed = false
        try {
          renameSync(scriptDir, destination)
          installed = true
          this.db.transaction(() => {
            const final = scripts.map((s) => ({ ...s, source: s.source.replace(scriptDir, destination), container: s.container?.replace(scriptDir, destination) ?? null }))
            this.db.setScripts(job.mediaId, final, summarise(final))
            this.db.setScriptsStamp(job.mediaId, job.source)
            this.db.finishAsset(job, null)
          })
        } catch (error) {
          try {
            if (installed) renameSync(destination, scriptDir)
          } finally {
            if (hadCache) {
              try { renameSync(backup, destination) } catch (restoreError) { preserveStage = true; throw restoreError }
            }
          }
          throw error
        }
        this.hooks.changed()
      } else {
        const kind = job.kind
        const [, source] = JSON.parse(job.source) as [string, ImageSource]
        const output = join(stage, 'image.jpg')
        const file = this.file(kind, job.mediaId)
        const previous = this.db.remoteAsset(job.mediaId, kind)
        const usable = previous && previous.source === job.source && previous.digest && existsSync(file) ? previous : null
        const result = source ? await cacheImage(output, source, headers, job.durationMs, this.hooks.decodePoster, signal, usable?.validators) : { digest: null, validators: {} }
        signal.throwIfAborted()
        if (!this.current(job)) return
        const recheck = root.kind === 'stash' ? Date.now() + ASSET_RECHECK_MS : null
        if (result === 'unchanged') {
          if (!usable) throw new Error('not modified without a cached image')
          this.db.transaction(() => {
            this.db.setRemoteAsset(job.mediaId, kind, job.source, usable.digest, Date.now(), usable.validators)
            this.db.setThumbState(job.mediaId, kind, 'ready')
            this.db.finishAsset(job, recheck)
          })
          return
        }
        const { digest, validators } = result
        await mkdir(dirname(file), { recursive: true })
        signal.throwIfAborted()
        if (!this.current(job)) return
        const backup = join(stage, 'previous.jpg')
        const replaced = digest !== null && existsSync(file)
        if (replaced) renameSync(file, backup)
        try {
          if (digest !== null) renameSync(output, file)
          this.db.transaction(() => {
            this.db.setRemoteAsset(job.mediaId, kind, job.source, digest ?? (existsSync(file) ? previous?.digest ?? '' : ''), Date.now(), digest !== null ? validators : {})
            this.db.setThumbState(job.mediaId, kind, existsSync(file) ? 'ready' : 'failed')
            this.db.finishAsset(job, recheck)
          })
        } catch (error) {
          if (replaced) {
            try { renameSync(backup, file) } catch (restoreError) { preserveStage = true; throw restoreError }
          }
          throw error
        }
        if (!usable || digest !== usable.digest) this.hooks.image?.(job.mediaId)
      }
    } finally {
      recordMetric('asset', performance.now() - started)
      if (!preserveStage) await rm(stage, { recursive: true, force: true })
    }
  }
}
