import { timingSafeEqual } from 'node:crypto'

export function authorised(header: string | undefined, password: string): boolean {
  if (!password) return true
  const m = /^Basic\s+(\S+)$/i.exec(header ?? '')
  if (!m) return false
  const sent = Buffer.from(Buffer.from(m[1] ?? '', 'base64').toString('utf8').replace(/^[^:]*:/, ''))
  const wanted = Buffer.from(password)
  return sent.length === wanted.length && timingSafeEqual(sent, wanted)
}
