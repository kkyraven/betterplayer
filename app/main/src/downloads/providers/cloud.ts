export interface CloudSource {
  directUrl: string | null
  host: string
  reason?: string
}

export function resolveCloudSource(url: string): CloudSource | null {
  if (/[\s\\\u0000-\u001f\u007f]/.test(url)) return null

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) return null

  const host = parsed.hostname
  const pixeldrain = host === 'pixeldrain.com' || host === 'www.pixeldrain.com'
  const dropbox = host === 'dropbox.com' || host === 'www.dropbox.com'
  if (!pixeldrain && !dropbox && host !== 'drive.google.com') return null

  const browser = (reason: string): CloudSource => ({ directUrl: null, host, reason })
  const parts = /^(https?:\/\/[^/?#]+)([^?#]*)(?:\?([^#]*))?(#.*)?$/i.exec(url)
  if (!parts || parts[2] !== parsed.pathname) return browser('Unknown link layout')
  const path = parsed.pathname

  if (pixeldrain) {
    const file = /^\/(?:u|api\/file)\/([A-Za-z0-9_-]+)$/.exec(path)
    if (file) {
      const query = parts[3] ?? ''
      const suffix = new URLSearchParams(query).has('download') ? '' : `${query ? '&' : ''}download`
      return { directUrl: `${parts[1]}/api/file/${file[1]}?${query}${suffix}${parts[4] ?? ''}`, host }
    }
    if (/^\/(?:l|d|api\/(?:list|filesystem))(?:\/|$)/.test(path)) return browser('File selection required')
    return browser('Unknown link layout')
  }

  if (dropbox) {
    if (/^\/(?:sh|scl\/fo)(?:\/|$)/.test(path)) return browser('File selection required')
    if (/^\/(?:s|scl\/fi)\/[A-Za-z0-9_.-]+\/[^/]+$/.test(path) && !/^\/s\/(?:dl|raw)\//.test(path)) {
      return { directUrl: dropboxDownloadUrl(url), host }
    }
    return browser('Unknown link layout')
  }

  if (/^\/drive\/(?:u\/\d+\/)?folders(?:\/|$)/.test(path)) return browser('File selection required')
  const filePath = /^\/file\/d\/[A-Za-z0-9_-]+(?:\/(?:view|edit|preview))?\/?$/.test(path)
  const ids = parsed.searchParams.getAll('id')
  const fileQuery = ['/open', '/uc'].includes(path) && ids.length === 1 && /^[A-Za-z0-9_-]+$/.test(ids[0] ?? '')
  if (filePath || fileQuery) return browser('Browser download required')
  return browser('Unknown link layout')
}

function dropboxDownloadUrl(url: string): string {
  const fragmentIndex = url.indexOf('#')
  const base = fragmentIndex < 0 ? url : url.slice(0, fragmentIndex)
  const fragment = fragmentIndex < 0 ? '' : url.slice(fragmentIndex)
  const queryIndex = base.indexOf('?')
  if (queryIndex < 0) return `${base}?dl=1${fragment}`

  let found = false
  const query = base.slice(queryIndex + 1)
  const parameters = query.split('&').map(parameter => {
    if (!new URLSearchParams(`&${parameter}`).has('dl')) return parameter
    found = true
    const equalsIndex = parameter.indexOf('=')
    const key = equalsIndex < 0 ? parameter : parameter.slice(0, equalsIndex)
    return `${key}=1`
  }).join('&')
  return `${base.slice(0, queryIndex + 1)}${parameters}${found ? '' : `${query ? '&' : ''}dl=1`}${fragment}`
}
