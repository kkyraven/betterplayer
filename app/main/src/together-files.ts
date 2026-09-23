import { t } from './i18n'
import { createHash, randomUUID, type Hash } from 'node:crypto'
import { open, stat, unlink, link, copyFile, constants, type FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { FILE_CHUNK_BYTES, parseSharedVideo, type SharedVideo } from '@shared/together'
import { VIDEO_EXTENSIONS } from '@shared/ipc'
import { contentHash } from './account/hash'

interface Sending { file: FileHandle; offset: number; size: number; stamp: number; digest: Hash; shareId: string }
interface Receiving { file: FileHandle; offset: number; video: SharedVideo; digest: Hash; temporary: string; destination: string }

export class TogetherFiles {
  private shares = new Map<string, { video: SharedVideo; path: string; stamp: number }>()
  private revision = 0
  private sends = new Map<string, Sending>()
  private receives = new Map<string, Receiving>()
  constructor(private readonly chooseDestination: (name: string) => Promise<string | null>) {}

  async allow(path: string | null): Promise<SharedVideo | null> {
    return (await this.allowQueue(path ? [path] : []))[0] ?? null
  }

  async allowQueue(paths: string[]): Promise<SharedVideo[]> {
    if (!Array.isArray(paths) || paths.length > 32 || paths.some(path => typeof path !== 'string')) throw new Error(t('together.transfer.invalidQueue'))
    const revision = ++this.revision
    const wanted = new Set(paths)
    for (const [id, share] of this.shares) if (!wanted.has(share.path)) this.shares.delete(id)
    await Promise.all([...this.sends].filter(([, send]) => !this.shares.has(send.shareId)).map(([id]) => this.cancel(id)))
    const videos: SharedVideo[] = []
    for (const path of wanted) {
      if (!path || /^\w+:\/\//.test(path) || !VIDEO_EXTENSIONS.some(ext => extname(path).toLowerCase() === `.${ext}`)) continue
      try {
        const info = await stat(path)
        if (revision !== this.revision) return []
        const existing = [...this.shares.values()].find(share => share.path === path && share.stamp === info.mtimeMs && share.video.size === info.size)
        if (existing) { videos.push(existing.video); continue }
        for (const [id, share] of this.shares) if (share.path === path) this.shares.delete(id)
        const hash = await contentHash(path)
        if (revision !== this.revision) return []
        if (!info.isFile() || !hash || info.size <= 0) continue
        const video = parseSharedVideo({ id: randomUUID(), hash, name: basename(path), size: info.size })
        if (!video) continue
        this.shares.set(video.id, { video, path, stamp: info.mtimeMs })
        videos.push(video)
      } catch { }
    }
    return videos
  }

  async sendStart(shareId: string): Promise<string> {
    const share = this.shares.get(shareId)
    if (!share || share.video.id !== shareId || this.sends.size >= 15) throw new Error(t('together.transfer.unavailable'))
    const file = await open(share.path, 'r')
    try {
      const info = await file.stat()
      if (this.shares.get(shareId) !== share || info.size !== share.video.size || info.mtimeMs !== share.stamp) throw new Error(t('together.transfer.videoChanged'))
      const id = randomUUID()
      this.sends.set(id, { file, size: info.size, stamp: info.mtimeMs, offset: 0, digest: createHash('sha256'), shareId })
      return id
    } catch (error) { await file.close(); throw error }
  }

  async read(id: string): Promise<{ data: Uint8Array; digest: string | null }> {
    const send = this.sends.get(id)
    if (!send || !this.shares.has(send.shareId)) throw new Error(t('together.transfer.unavailable'))
    if (send.offset === send.size) {
      const info = await send.file.stat()
      if (info.size !== send.size || info.mtimeMs !== send.stamp) throw new Error(t('together.transfer.videoChanged'))
      const digest = send.digest.digest('hex')
      await this.cancel(id)
      return { data: new Uint8Array(), digest }
    }
    const data = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, send.size - send.offset))
    const { bytesRead } = await send.file.read(data, 0, data.length, send.offset)
    if (bytesRead !== data.length || !this.shares.has(send.shareId)) throw new Error(t('together.transfer.videoChanged'))
    send.offset += bytesRead
    send.digest.update(data)
    return { data, digest: null }
  }

  async receiveStart(raw: SharedVideo): Promise<string | null> {
    const video = parseSharedVideo(raw)
    if (!video || !VIDEO_EXTENSIONS.some(ext => extname(video.name).toLowerCase() === `.${ext}`) || this.receives.size) throw new Error(t('together.transfer.invalid'))
    const revision = this.revision
    const destination = await this.chooseDestination(video.name)
    if (!destination || revision !== this.revision) return null
    if (await stat(destination).then(() => true, () => false)) throw new Error(t('together.transfer.newFileName'))
    const id = randomUUID()
    const temporary = join(dirname(destination), `.bp-${id}.part`)
    const file = await open(temporary, 'wx', 0o600)
    if (revision !== this.revision) { await file.close(); await unlink(temporary); return null }
    this.receives.set(id, { file, offset: 0, video, digest: createHash('sha256'), temporary, destination })
    return id
  }

  async write(id: string, offset: number, raw: Uint8Array): Promise<void> {
    const receive = this.receives.get(id)
    if (!receive || offset !== receive.offset || !(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > FILE_CHUNK_BYTES || offset + raw.byteLength > receive.video.size) throw new Error(t('together.transfer.invalidChunk'))
    const data = Buffer.from(raw)
    let written = 0
    while (written < data.length) {
      const result = await receive.file.write(data, written, data.length - written, offset + written)
      if (!result.bytesWritten) throw new Error(t('together.transfer.writeFailed'))
      written += result.bytesWritten
    }
    receive.digest.update(data)
    receive.offset += data.length
  }

  async complete(id: string, digest: string): Promise<string> {
    const receive = this.receives.get(id)
    if (!receive || receive.offset !== receive.video.size || !/^[a-f0-9]{64}$/.test(digest) || receive.digest.digest('hex') !== digest) throw new Error(t('together.transfer.verificationFailed'))
    await receive.file.sync()
    if (await contentHash(receive.temporary) !== receive.video.hash || this.receives.get(id) !== receive) throw new Error(t('together.transfer.videoVerificationFailed'))
    try {
      await link(receive.temporary, receive.destination)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || !['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(String(error.code))) throw error
      await copyFile(receive.temporary, receive.destination, constants.COPYFILE_EXCL)
    }
    if (this.receives.get(id) !== receive) { await unlink(receive.destination); throw new Error(t('together.transfer.cancelled')) }
    const path = receive.destination
    await this.cancel(id)
    return path
  }

  async cancel(id: string): Promise<void> {
    const send = this.sends.get(id)
    this.sends.delete(id)
    await send?.file.close().catch(() => undefined)
    const receive = this.receives.get(id)
    this.receives.delete(id)
    if (receive) { await receive.file.close().catch(() => undefined); await unlink(receive.temporary).catch(() => undefined) }
  }

  async clear(): Promise<void> {
    ++this.revision
    this.shares.clear()
    await Promise.all([...this.sends.keys(), ...this.receives.keys()].map(id => this.cancel(id)))
  }
}
