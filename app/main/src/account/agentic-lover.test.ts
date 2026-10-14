import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Me } from '@shared/account'
import type { Library } from '../library'

vi.mock('electron', () => ({ shell: {} }))
vi.mock('./store', () => ({ AccountDb: class {
  meta(key: string) { return key === 'token' ? 'session-a' : null }
  setMeta() {}
  clearSync() {}
  close() {}
} }))
import { Account } from './index'

let account: Account
let me: Me
let linked: Partial<Me> | { error: { code: string; message: string } }
const fetchMock = vi.fn<typeof fetch>()
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const linkCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/me/agentic-lover'))
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  me = { id: 'alice', name: 'Alice', email: 'alice@example.com', friendCode: 'AAAA-BBBB', premium: false, admin: false, avatarUrl: null }
  linked = { premium: true, agenticLover: true }
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname
    if (path === '/me') return response({ ...me, stun: [] })
    if (path === '/friends') return response({ friends: [], incoming: [], outgoing: [] })
    if (path === '/me/agentic-lover') return 'error' in linked ? response(linked, 409) : response({ ...me, ...linked, stun: [] })
    throw new Error('Sync offline')
  })
  account = new Account('https://accounts.example', '/unused', {} as Library, { os: 'darwin', arch: 'arm64', version: 'test' })
  account.setAgenticLover(async () => 'al-token')
})
afterEach(() => { account.stop(); vi.unstubAllGlobals() })

it('links Agentic Lover on refresh, once, and takes the premium it grants', async () => {
  await account.refresh()
  await settle()
  expect(linkCalls()).toHaveLength(1)
  expect(linkCalls()[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ token: 'al-token' }) })
  expect(account.get().me).toMatchObject({ name: 'Alice', premium: true, agenticLover: true })
  await account.refresh()
  await settle()
  expect(linkCalls()).toHaveLength(1)
})

it('leaves Agentic Lover alone when the portal already grants premium', async () => {
  me.premium = true
  await account.refresh()
  await settle()
  expect(linkCalls()).toHaveLength(0)
})

it('says so when Agentic Lover has another email, or is signed out', async () => {
  linked = { error: { code: 'agentic_lover_email', message: 'mismatch' } }
  await expect(account.syncAgenticLover()).rejects.toThrow('Agentic Lover uses a different email')
  account.setAgenticLover(async () => null)
  await expect(account.syncAgenticLover()).rejects.toThrow('Signed out of Agentic Lover.')
})
