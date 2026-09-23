import type { TabHandoff } from '@shared/browser'

export function mediaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) return null
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

export function handoffState(value: unknown): TabHandoff | null {
  if (!value || typeof value !== 'object') return null
  if (!('requestId' in value) || typeof value.requestId !== 'number' || !Number.isSafeInteger(value.requestId)) return null
  if (!('position' in value) || typeof value.position !== 'number' || !Number.isFinite(value.position) || value.position < 0) return null
  if (!('rate' in value) || typeof value.rate !== 'number' || !Number.isFinite(value.rate) || value.rate <= 0) return null
  return { requestId: value.requestId, url: mediaUrl('url' in value ? value.url : null), position: value.position, rate: value.rate }
}

export function handoffHeaders(referer: string, userAgent: string): string {
  const safe = (value: string) => value.length > 0 && !/[\x00-\x1f\x7f,\\]/.test(value)
  const fields: string[] = []
  if (safe(referer)) fields.push(`Referer: ${referer}`)
  if (safe(userAgent)) fields.push(`User-Agent: ${userAgent}`)
  return fields.join(',')
}
