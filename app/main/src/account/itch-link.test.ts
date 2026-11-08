import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Me } from '@shared/account'
import type { Library } from '../library'

const opened = vi.hoisted(() => [] as string[])
vi.mock('electron', () => ({ shell: { openExternal: async (url: string) => void opened.push(url) } }))
vi.mock('./store', () => ({ AccountDb: class {
  meta(key: string) { return key === 'token' ? 'session-a' : null }
  setMeta() {}
  clearSync() {}
  close() {}
} }))
import { Account } from './index'

let account: Account
let me: Me
let statuses: string[]
const fetchMock = vi.fn<typeof fetch>()
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.useFakeTimers()
  opened.length = 0
  me = { id: 'alice', name: 'Alice', email: 'alice@example.com', friendCode: 'AAAA-BBBB', premium: false, admin: false, avatarUrl: null }
  statuses = ['pending', 'done']
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path === '/me/itch' && init?.method === 'POST') return response({ id: 'link-1', url: 'https://itch.io/user/oauth?state=link-1' })
    if (path === '/me/itch/link-1') {
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!
      if (status === 'done') me = { ...me, premium: true, itch: true }
      return response({ status })
    }
    if (path === '/me') return response({ ...me, stun: [] })
    if (path === '/friends') return response({ friends: [], incoming: [], outgoing: [] })
    throw new Error('Sync offline')
  })
  account = new Account('https://accounts.example', '/unused', {} as Library, { os: 'darwin', arch: 'arm64', version: 'test' })
})
afterEach(() => { account.stop(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('opens itch.io, waits for the server, and takes the premium it found', async () => {
  const done = account.linkItch()
  await vi.advanceTimersByTimeAsync(0)
  expect(opened).toEqual(['https://itch.io/user/oauth?state=link-1'])
  expect(account.get().linkingItch).toBe(true)
  await vi.advanceTimersByTimeAsync(5000)
  await done
  expect(account.get()).toMatchObject({ linkingItch: false, me: { premium: true, itch: true } })
})

it('says why a link did not unlock', async () => {
  statuses = ['none']
  const none = expect(account.linkItch()).rejects.toThrow('No purchase found')
  await vi.advanceTimersByTimeAsync(3000)
  await none
  statuses = ['taken']
  const taken = expect(account.linkItch()).rejects.toThrow('Linked to another account')
  await vi.advanceTimersByTimeAsync(3000)
  await taken
  expect(account.get().linkingItch).toBe(false)
})

it('stops waiting on a cancel from the app', async () => {
  statuses = ['pending']
  const cancelled = expect(account.linkItch()).rejects.toThrow('Cancelled')
  await vi.advanceTimersByTimeAsync(3000)
  account.cancelItchLink()
  expect(account.get().linkingItch).toBe(false)
  await vi.advanceTimersByTimeAsync(3000)
  await cancelled
})
