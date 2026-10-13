import { safeStorage } from 'electron'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

export interface SecretCodec {
  seal: (text: string) => string | null
  unseal: (sealed: string) => string | null
}

export const systemSecretCodec: SecretCodec = {
  seal(text) {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')) return null
    return safeStorage.encryptString(text).toString('base64')
  },
  unseal(sealed) {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')) return null
    try { return safeStorage.decryptString(Buffer.from(sealed, 'base64')) } catch { return null }
  },
}

export class DownloadJournal {
  private tail: Promise<void> = Promise.resolve()
  private readonly path: string
  constructor(private readonly directory: string) { this.path = join(directory, 'queue.json') }
  async load(): Promise<unknown | null> {
    try { return JSON.parse(await readFile(this.path, 'utf8')) as unknown }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw new Error('Download recovery journal could not be read')
    }
  }
  save(value: unknown): Promise<void> {
    const json = JSON.stringify(value)
    const save = this.tail.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.tmp`
      const handle = await open(temporary, 'w', 0o600)
      try { await handle.writeFile(json); await handle.sync() } finally { await handle.close() }
      await rename(temporary, this.path)
      const dir = await open(this.directory, 'r').catch(() => null)
      if (dir) { try { await dir.sync() } catch { } finally { await dir.close() } }
    })
    this.tail = save.catch(() => {})
    return save
  }
  flush(): Promise<void> { return this.tail }
}
