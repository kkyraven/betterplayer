export interface EroSource {
  id: string
  url: string
  label: string
  host: string
  kind: 'video' | 'script' | 'archive' | 'unknown'
  fileName: string | null
  postNumber: number
  controlId: string | null
  mirrorKey: string | null
  archivePasswords?: string[]
}

export interface EroTopic {
  tabId: number
  generation: number
  url: string
  title: string
  sources: EroSource[]
  scope: 'loaded-posts'
  categories?: Array<{ slug: string; name: string }>
}

export type EroTopicReport = Omit<EroTopic, 'tabId'>

export const EROSCRIPTS_HOME = 'https://discuss.eroscripts.com/'
export const ERO_CHANNELS = {
  observe: 'bp:eroscripts-observe',
  topic: 'bp:eroscripts-topic',
  activate: 'bp:eroscripts-activate',
  activated: 'bp:eroscripts-activated',
  prepare: 'bp:eroscripts-prepare',
  prepared: 'bp:eroscripts-prepared',
  hostPrepare: 'bp:download-host-prepare',
  hostPrepared: 'bp:download-host-prepared',
  hostActivate: 'bp:download-host-activate',
  hostDownload: 'bp:download-host-download',
  hostRelease: 'bp:download-host-release',
  hostCancel: 'bp:download-host-cancel',
  hostWaiting: 'bp:download-host-waiting',
} as const

export const MAX_TOPIC_SOURCES = 200
export const MAX_SOURCE_URL_LENGTH = 8192

export function isEroScriptsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
      && (url.hostname === 'discuss.eroscripts.com' || url.hostname === 'eroscripts.com' || url.hostname === 'www.eroscripts.com')
  } catch { return false }
}

export function isEroTopicUrl(value: string): boolean {
  if (!isEroScriptsUrl(value)) return false
  const url = new URL(value)
  return url.hostname === 'discuss.eroscripts.com' && /^\/t\/(?:[^/]+\/)?\d+(?:\/\d+)?\/?$/.test(url.pathname)
}

export function sourceUrl(value: string, base?: string): string | null {
  if (value.length > MAX_SOURCE_URL_LENGTH) return null
  try {
    const url = new URL(value, base)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null
    return url.href
  } catch { return null }
}

export function sourceKind(fileName: string): EroSource['kind'] {
  const name = fileName.toLowerCase().split(/[?#]/, 1)[0] ?? ''
  if (/\.funscript$/.test(name)) return 'script'
  if (/\.(?:mp4|mkv|webm|mov|m4v|avi|wmv|mpeg|mpg)$/.test(name)) return 'video'
  if (/\.(?:zip|7z|rar)$/.test(name)) return 'archive'
  return 'unknown'
}

export function sourceId(postNumber: number, url: string, controlId: string | null = null): string {
  let hash = 2166136261
  for (const char of `${postNumber}\n${url}\n${controlId ?? ''}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return `post-${postNumber}-${(hash >>> 0).toString(16)}`
}

export function explicitMirrorKind(heading: string, sources: ReadonlyArray<Pick<EroSource, 'url' | 'label' | 'kind' | 'fileName' | 'controlId'>>): EroSource['kind'] | null {
  const match = /^(video|script|funscript|archive)\s+mirrors?\s*:?\s*$/i.exec(heading.trim())
  if (!match || sources.length < 2 || sources.length > 8 || sources.some((source) => source.controlId !== null)) return null
  const kind = match[1]?.toLowerCase() === 'video' ? 'video' : match[1]?.toLowerCase() === 'archive' ? 'archive' : 'script'
  const names = sources.map((source) => source.fileName).filter((name): name is string => name !== null)
  if (new Set(names).size > 1) return null
  for (const source of sources) {
    if (source.kind !== 'unknown' && source.kind !== kind) return null
    if (/\b(?:\d{3,4}p|\d+k|part\s*\d|version\s*\d|v\d+|edit|cut|axis|stroke|pitch|roll|twist)\b/i.test(source.label)) return null
    try {
      const url = new URL(source.url)
      if (/\/(?:folder|folders|l|s|d)\//i.test(url.pathname) && url.hostname !== 'www.dropbox.com' && url.hostname !== 'dropbox.com') return null
      if (url.hostname === 'gofile.io') return null
    } catch { return null }
  }
  return kind
}
