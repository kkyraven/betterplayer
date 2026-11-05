import { scryptSync, timingSafeEqual } from 'node:crypto'

const same = (sent: string, wanted: string) => {
  const a = Buffer.from(sent)
  const b = Buffer.from(wanted)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const passwordMatches = (sent: string, password: string) => password !== '' && same(sent, password)

export function authorised(header: string | undefined, password: string): boolean {
  const m = /^Basic\s+(\S+)$/i.exec(header ?? '')
  if (!m) return false
  return passwordMatches(Buffer.from(m[1] ?? '', 'base64').toString('utf8').replace(/^[^:]*:/, ''), password)
}

export function postedPassword(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const { password } = body as Record<string, unknown>
  return typeof password === 'string' && password !== '' ? password : null
}

export const urlKey = (password: string, salt: string) => scryptSync(password, salt, 24).toString('base64url')

export const keyMatches = (sent: string, key: string) => key !== '' && same(sent, key)

export function splitKey(path: string): { key: string | null; path: string } {
  const m = /^\/k\/([^/]+)(\/.*)?$/.exec(path)
  return m ? { key: m[1] ?? null, path: m[2] ?? '/' } : { key: null, path }
}
