import type { EroTopic } from '@shared/eroscripts'

export interface DownloadOwner {
  readonly attemptId: string
  readonly fileId: string
  readonly sourceUrl: string
  readonly topic: EroTopic
}

export interface RelatedDownloadContext extends DownloadOwner {
  approvedUrl: string | null
  approvedUntil: number
}

export function relatedNavigation(source: string, target: string): boolean {
  try {
    const original = new URL(source)
    const next = new URL(target)
    if (next.protocol !== 'https:' && next.protocol !== 'http:') return false
    const mega = /^(?:www\.)?mega\.(?:nz|co\.nz|io)$/
    if (mega.test(original.hostname) && mega.test(next.hostname)) {
      const handle = /\/file\/([\w-]+)/.exec(original.pathname)?.[1] ?? /^#!([\w-]+)!/.exec(original.hash)?.[1]
      if (handle) return next.pathname === `/file/${handle}` || next.hash.startsWith(`#!${handle}!`)
      return original.pathname === next.pathname && original.hash === next.hash
    }
    const gofile = /^(?:www\.)?gofile\.io$/
    const pixeldrain = /^(?:www\.)?pixeldrain\.com$/
    if (pixeldrain.test(original.hostname) && pixeldrain.test(next.hostname)) return original.pathname === next.pathname && original.search === next.search
    return next.pathname === original.pathname && (next.origin === original.origin || gofile.test(original.hostname) && gofile.test(next.hostname))
  } catch { return false }
}

export function downloadContextForNavigation(owner: DownloadOwner | null, current: RelatedDownloadContext | null, target: string, now: number): RelatedDownloadContext | null {
  if (current?.approvedUrl === target && current.approvedUntil > now) return current
  if (!owner || !relatedNavigation(owner.sourceUrl, target)) return null
  return current ?? { ...owner, approvedUrl: null, approvedUntil: 0 }
}

export function reusableDownload(owner: DownloadOwner | null, fileId: string, sourceUrl: string, currentUrl: string): boolean {
  return owner !== null && owner.fileId === fileId && owner.sourceUrl === sourceUrl && relatedNavigation(sourceUrl, currentUrl)
}
