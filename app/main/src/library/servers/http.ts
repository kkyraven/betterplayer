import { t } from '../../i18n'

export function headerList(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join(',')
}

export const baseUrl = (url: string) => url.trim().replace(/\/+$/, '')

const FETCH_TIMEOUT_MS = 30_000

export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(status === 401 || status === 403 ? t('library.server.error.signInFailed') : t('library.server.error.http', { status, url }))
  }
}

export async function request(url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  const res = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const conditional = init.headers !== undefined && ('If-None-Match' in init.headers || 'If-Modified-Since' in init.headers)
  if (!res.ok && !(conditional && res.status === 304)) {
    await res.body?.cancel()
    throw new HttpError(res.status, url)
  }
  return res
}

export async function mapLanes<T, R>(items: T[], lanes: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let cursor = 0
  const lane = async () => {
    while (cursor < items.length) {
      const i = cursor++
      const item = items[i]
      if (item === undefined) break
      out[i] = await fn(item, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, lane))
  return out
}
