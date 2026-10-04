import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgenticLover } from './agentic'
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
