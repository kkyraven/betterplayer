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
const me: Me = { id: 'alice', name: 'Alice', email: 'alice@example.com', friendCode: 'AAAA-BBBB', premium: false, admin: false, avatarUrl: null }
const fetchMock = vi.fn<typeof fetch>()
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url) => String(url).endsWith('/me') ? response({ ...me, stun: [] }) : String(url).endsWith('/friends') ? response({ friends: [], incoming: [], outgoing: [] }) : Promise.reject(new Error('Sync offline')))
  account = new Account('https://accounts.example', '/unused', {} as Library, { os: 'darwin', arch: 'arm64', version: 'test' })
  await account.refresh()
  fetchMock.mockReset()
})
afterEach(() => { account.stop(); vi.unstubAllGlobals() })

it('sends only the chosen crop as PNG and keeps current profile fields', async () => {
  fetchMock.mockResolvedValue(response({ ...me, name: 'Old name', avatarUrl: 'https://accounts.example/avatars/new.webp', stun: [] }))
  await account.setAvatar('alice', Buffer.from('crop').toString('base64'))
  expect(fetchMock).toHaveBeenCalledWith('https://accounts.example/me/avatar', expect.objectContaining({ method: 'PUT', body: Buffer.from('crop'), headers: expect.objectContaining({ Authorization: 'Bearer session-a', 'Content-Type': 'image/png' }) }))
  expect(account.get().me).toMatchObject({ name: 'Alice', avatarUrl: 'https://accounts.example/avatars/new.webp' })
})

it('rejects uploads selected for another account or oversized IPC payloads before networking', async () => {
  await expect(account.setAvatar('bob', 'YQ==')).rejects.toThrow('Account changed')
  await expect(account.setAvatar('alice', 'a'.repeat(2_666_669))).rejects.toThrow('Invalid photo')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('does not restore a signed-out account when an upload finishes', async () => {
  let finish!: (response: Response) => void
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
  const upload = account.setAvatar('alice', 'YQ==')
  fetchMock.mockResolvedValue(response({ ok: true }))
  await account.logout()
  finish(response({ ...me, avatarUrl: 'https://accounts.example/avatars/new.webp', stun: [] }))
  await upload
  expect(account.get().me).toBeNull()
})

it('removes the photo with an authenticated DELETE', async () => {
  fetchMock.mockResolvedValue(response({ ...me, avatarUrl: null, stun: [] }))
  await account.setAvatar('alice', null)
  expect(fetchMock).toHaveBeenCalledWith('https://accounts.example/me/avatar', expect.objectContaining({ method: 'DELETE', body: undefined }))
  expect(account.get().me?.avatarUrl).toBeNull()
})
