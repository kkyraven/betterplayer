import { FOLDED_STAMP, type LibraryDb, type ServerRoot } from '../db'
import type { Adapter } from './adapter'

export class RemoteWrites {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private closed = false
  private editedDuringFlush = false

  constructor(
    private readonly db: LibraryDb,
    private readonly adapter: (root: ServerRoot) => Adapter,
    private readonly changed: () => void,
  ) {}

  add(ids: number[]) {
    this.db.transaction(() => {
      for (const id of ids) this.db.queueRemoteWrite(id)
    })
    if (this.running) this.editedDuringFlush = true
    this.schedule(600)
  }

  start() {
    this.schedule(0)
  }

  private schedule(delay: number) {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delay)
  }

  async flush() {
    if (this.closed || this.running) return
    this.running = true
    this.editedDuringFlush = false
    try {
      for (const { id, revision } of this.db.remoteWrites()) {
        if (this.closed) break
        const remote = this.db.remoteKey(id)
        const row = remote && this.db.mediaRow(id)
        const root = remote && this.db.server(remote.rootId)
        if (!remote || !row || !root) continue
        if (root.kind === 'heresphere' && this.db.stamp(row.path)?.remoteStamp === FOLDED_STAMP) continue
        const previousError = this.db.remoteWriteError(root.id)
        try {
          await this.adapter(root).writeBack(remote.key, { rating: row.rating, favourite: row.favourite, tags: row.tags })
          if (this.closed) break
          this.db.finishRemoteWrite(id, revision)
          const rootError = this.db.root(root.id)?.error ?? ''
          if (previousError && rootError.includes(previousError)) {
            const remaining = rootError.split('\n').filter((line) => line !== previousError)
            const nextError = this.db.remoteWriteError(root.id)
            if (nextError && !remaining.includes(nextError)) remaining.push(nextError)
            this.db.setRootError(root.id, remaining.join('\n'))
          }
        } catch (e) {
          if (this.closed) break
          const error = e instanceof Error ? e.message : String(e)
          this.db.failRemoteWrite(id, revision, error)
          this.db.setRootError(root.id, error)
        }
        this.changed()
      }
    } finally {
      this.running = false
      if (!this.closed && this.db.remoteWrites().length > 0) this.schedule(this.editedDuringFlush ? 600 : 30_000)
    }
  }

  close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
