import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'

const CHUNK = 64 * 1024

export async function contentHash(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return null
  const size = info.size
  const hash = createHash('sha256')
  const sizeBuf = Buffer.alloc(8)
  sizeBuf.writeBigUInt64LE(BigInt(size))
  hash.update(sizeBuf)
  const fh = await open(path, 'r').catch(() => null)
  if (!fh) return null
  try {
    const head = Buffer.alloc(Math.min(CHUNK, size))
    await fh.read(head, 0, head.length, 0)
    hash.update(head)
    if (size > CHUNK) {
      const tail = Buffer.alloc(Math.min(CHUNK, size - CHUNK))
      await fh.read(tail, 0, tail.length, size - tail.length)
      hash.update(tail)
    }
  } finally {
    await fh.close()
  }
  return hash.digest('hex')
}

export async function fileStamp(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null)
  return info?.isFile() ? `${info.size}:${Math.round(info.mtimeMs)}` : null
}
