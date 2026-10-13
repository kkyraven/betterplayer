export interface WebSourceResolution {
  directUrl: string | null
  host: string
  reason?: string
}

const browserHosts: ReadonlyMap<string, string> = new Map([
  ['mega.nz', 'mega'],
  ['www.mega.nz', 'mega'],
  ['mega.co.nz', 'mega'],
  ['www.mega.co.nz', 'mega'],
  ['mega.io', 'mega'],
  ['www.mega.io', 'mega'],
  ['gofile.io', 'gofile'],
  ['www.gofile.io', 'gofile'],
  ['mediafire.com', 'mediafire'],
  ['www.mediafire.com', 'mediafire'],
  ['bunkr.cr', 'bunkr'],
  ['bunkr.fi', 'bunkr'],
  ['bunkr.si', 'bunkr'],
  ['balbums.st', 'bunkr'],
  ['catbox.moe', 'catbox'],
  ['files.catbox.moe', 'catbox'],
  ['workupload.com', 'workupload'],
  ['www.workupload.com', 'workupload'],
])

const catboxAssetUrl = /^https:\/\/files\.catbox\.moe(?::443)?\/[a-z0-9_-]+\.(?:funscript|mp4|mkv|webm|mov|m4v|avi|wmv|mpeg|mpg|zip|7z|rar)(?:[?#]|$)/i

export function resolveWebSource(url: string): WebSourceResolution | null {
  if (!/^https?:\/\//i.test(url) || /[\s\\\u0000-\u001f\u007f]/.test(url)) return null

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.username || parsed.password || parsed.port) return null

  const host = browserHosts.get(parsed.hostname)
  if (!host) return null

  if (parsed.hostname === 'files.catbox.moe' && catboxAssetUrl.test(url)) {
    return { directUrl: url, host }
  }

  return {
    directUrl: null,
    host,
    reason: host === 'mega' ? 'Browser decryption required' : 'Browser download required',
  }
}
