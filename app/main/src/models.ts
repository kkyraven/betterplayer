import { t } from './i18n'
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import type { ModelFileInfo, ModelFileStatus, ModelProgress } from '@shared/tracking'

export class Models {
  readonly dir: string
  private readonly running = new Map<string, AbortController>()

  constructor(
    userData: string,
    private readonly bundled: string,
    private readonly progress: (p: ModelProgress) => void,
  ) {
    this.dir = join(userData, 'models')
    mkdirSync(this.dir, { recursive: true })
  }

  status(files: string[]): Record<string, ModelFileStatus | null> {
    const out: Record<string, ModelFileStatus | null> = {}
    for (const file of files) {
      out[file] = null
      for (const dir of [this.dir, this.bundled]) {
        try {
          const path = join(dir, file)
          out[file] = { path, bytes: statSync(path).size }
          break
        } catch {
        }
      }
    }
    return out
  }

  async download(id: string, file: ModelFileInfo): Promise<void> {
    const target = join(this.dir, file.file)
    const tmp = `${target}.${process.pid}.part`
    const abort = new AbortController()
    this.running.set(id, abort)
    try {
      await this.fetchFile(id, file, tmp, target, abort.signal)
    } catch (e) {
      throw abort.signal.aborted ? new Error('cancelled') : e
    } finally {
      if (this.running.get(id) === abort) this.running.delete(id)
    }
  }

  cancel(id: string) {
    this.running.get(id)?.abort()
  }

  private async fetchFile(id: string, file: ModelFileInfo, tmp: string, target: string, signal: AbortSignal): Promise<void> {
    const res = await fetch(file.url, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'BetterPlayer' }, redirect: 'follow', signal })
    if (!res.ok || !res.body) throw new Error(t('settings.models.httpError', { file: file.file, status: res.status }))
    const total = Number(res.headers.get('content-length') ?? 0)
    const hash = createHash('sha256')
    let done = 0
    let lastReport = 0
    const report = this.progress
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        done += chunk.length
        const now = Date.now()
        if (now - lastReport > 100) {
          lastReport = now
          report({ id, done, total })
        }
        callback(null, chunk)
      },
    })
    try {
      await pipeline(Readable.fromWeb(res.body as ReadableStream), counter, createWriteStream(tmp), { signal })
      const digest = hash.digest('hex')
      if (digest !== file.sha256.toLowerCase()) throw new Error(t('settings.models.checksumMismatch', { file: file.file }))
      renameSync(tmp, target)
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
    report({ id, done: total, total })
  }

  async licence(file: string, url: string): Promise<void> {
    try {
      const licence = await fetch(url)
      if (licence.ok) await writeFile(join(this.dir, `${file}.LICENSE.txt`), await licence.text())
    } catch {
    }
  }

  remove(file: string) {
    rmSync(join(this.dir, file), { force: true })
    rmSync(join(this.dir, `${file}.LICENSE.txt`), { force: true })
  }
}
