import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { openLoopback, type Loopback, type Redirect } from './loopback'

let loopback: Loopback | null = null
afterEach(() => loopback?.close())

const get = (query: string, path = '/cb') => fetch(`${loopback!.redirectUri.replace('/cb', path)}?${query}`, { redirect: 'manual' })

it('hands over the first redirect with its state and refuses the rest', async () => {
  const seen: Redirect[] = []
  loopback = await openLoopback(async (redirect) => {
    seen.push(redirect)
    return 'https://account.example/done'
  })
  expect(loopback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/cb$/)
  expect(createHash('sha256').update(loopback.codeVerifier).digest('base64url')).toBe(loopback.codeChallenge)

  expect((await get('code=abc&state=someone-elses')).status).toBe(400)
  expect((await get(`code=abc&state=${loopback.state}`, '/other')).status).toBe(400)
  expect((await get(`state=${loopback.state}`)).status).toBe(400)
  expect(seen).toEqual([])

  const back = await get(`code=abc&state=${loopback.state}`)
  expect(back.status).toBe(302)
  expect(back.headers.get('location')).toBe('https://account.example/done')
  expect(seen).toEqual([{ code: 'abc' }])
  expect((await get(`code=again&state=${loopback.state}`)).status).toBe(400)
})

it('reports a refusal at the portal', async () => {
  const seen: Redirect[] = []
  loopback = await openLoopback(async (redirect) => {
    seen.push(redirect)
    return 'https://account.example/done'
  })
  await get(`error=access_denied&state=${loopback.state}`)
  expect(seen).toEqual([{ error: 'access_denied' }])
})
