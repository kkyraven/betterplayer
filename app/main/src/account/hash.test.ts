import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentHash } from './hash'

const dir = mkdtempSync(join(tmpdir(), 'bp-hash-'))
const file = (name: string, bytes: Buffer) => {
  const p = join(dir, name)
  writeFileSync(p, bytes)
  return p
}

describe('content hash', () => {
  it('is the same for the same bytes under any name, and hex sha256 sized', async () => {
    const bytes = Buffer.alloc(300_000, 7)
    const a = await contentHash(file('one.mp4', bytes))
    const b = await contentHash(file('Some Title (2024).mp4', bytes))
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes with the head, the tail and the size', async () => {
    const base = Buffer.alloc(300_000, 7)
    const head = Buffer.from(base)
    head[10] = 1
    const tail = Buffer.from(base)
    tail[299_990] = 1
    const longer = Buffer.concat([base, Buffer.alloc(1, 7)])
    const hashes = await Promise.all([base, head, tail, longer].map((b, i) => contentHash(file(`v${i}.mp4`, b))))
    expect(new Set(hashes).size).toBe(4)
  })

  it('handles small files and answers null for a missing one', async () => {
    expect(await contentHash(file('tiny.mp4', Buffer.from('hi')))).toMatch(/^[0-9a-f]{64}$/)
    expect(await contentHash(join(dir, 'nope.mp4'))).toBeNull()
  })
})
