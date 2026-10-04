import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgenticLover, privateAddress } from './agentic'
import type { DomDb } from './store'

vi.mock('electron', () => ({ BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false } }))

function fakeDb(): DomDb {
  const meta = new Map<string, string>()
  return {
    meta: (k: string) => meta.get(k) ?? null,
    setMeta: (k: string, v: string | null) => (v === null ? meta.delete(k) : meta.set(k, v)),
  } as unknown as DomDb
}

const answer = (status: number, body: unknown) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }))

describe('signing up for Agentic Lover', () => {
  afterEach(() => vi.restoreAllMocks())

  it('signs in with the tokens it gets back', async () => {
    answer(201, { token: 'a', refreshToken: 'r', expiresIn: 900 })
    const al = new AgenticLover(fakeDb())
    await al.register('you@example.com', 'you', 'long enough')
    expect(al.signedIn).toBe(true)
  })

  it('tells a taken email from a taken username', async () => {
    answer(409, { message: "If you already have an Ethumia account, it'll work here." })
    await expect(new AgenticLover(fakeDb()).register('you@example.com', 'you', 'long enough')).rejects.toThrow('dom:emailTaken')
    answer(409, { message: 'Username already taken' })
    await expect(new AgenticLover(fakeDb()).register('you@example.com', 'you', 'long enough')).rejects.toThrow('Username already taken')
  })
})

describe('privateAddress', () => {
  it('rejects loopback, private, link-local and unique local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1']) expect(privateAddress(ip), ip).toBe(true)
  })

  it('allows public addresses', () => {
    for (const ip of ['104.18.2.3', '172.32.0.1', '2606:4700::1']) expect(privateAddress(ip), ip).toBe(false)
  })
})
