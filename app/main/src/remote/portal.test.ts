import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { PortalStill } from '../library/portals'
import { servePortal } from './portal'

const dir = mkdtempSync(join(tmpdir(), 'bp-portal-route-'))
const file = join(dir, 'still.jpg')
writeFileSync(file, 'jpeg bytes')
const answers: Record<number, PortalStill | null> = {
  1: { file, type: 'image/jpeg', info: { kind: 'equirect', halfDeg: [36, 27], arcDeg: 200, ms: 20_000, censor: 'a1b2c3d4e5' } },
  2: { blank: true },
  3: { file, type: 'image/webp', info: { kind: 'poster', halfDeg: [0, 0], arcDeg: 0, ms: 12_000, censor: 'off' } },
}
const asked: unknown[][] = []
const library = { portals: { still: async (id: number, width: 1024 | 2048, ms: number | null) => { asked.push([id, width, ms]); return answers[id] ?? null } } }
let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => void servePortal(library, req, res, new URL(req.url ?? '/', 'http://x').pathname.split('/')[2]))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

it('answers a still with its headers and no caching', async () => {
  const res = await fetch(`${base}/portal/1?w=2048&ms=25000`)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('jpeg bytes')
  expect(Object.fromEntries(res.headers)).toMatchObject({
    'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-portal-kind': 'equirect', 'x-portal-half': '36,27',
    'x-portal-arc': '200', 'x-portal-ms': '20000.000', 'x-portal-censor': 'a1b2c3d4e5',
  })
  expect(asked.at(-1)).toEqual([1, 2048, 25_000])
})

it('answers a poster with its own type, a blank with 204, and 404 for unknown ids or bad widths', async () => {
  const poster = await fetch(`${base}/portal/3`)
  expect([poster.status, poster.headers.get('content-type'), poster.headers.get('x-portal-kind'), poster.headers.get('x-portal-half')]).toEqual([200, 'image/webp', 'poster', '0,0'])
  const blank = await fetch(`${base}/portal/2?w=1024`)
  expect([blank.status, blank.headers.get('x-portal-kind')]).toEqual([204, 'blank'])
  expect((await fetch(`${base}/portal/9?w=1024`)).status).toBe(404)
  expect((await fetch(`${base}/portal/1?w=640`)).status).toBe(404)
  expect((await fetch(`${base}/portal/1?w=1024&ms=soon`)).status).toBe(404)
})
