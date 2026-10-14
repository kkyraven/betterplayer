import { isVideoPath } from './ipc'
import { parseScriptName } from './matcher'

export function unavailableHostFile(host: string, heading: string): boolean {
  if (/^(?:www\.)?mega\.(?:nz|co\.nz|io)$/.test(host)) return heading.trim() === 'File cannot be accessed'
  if (/^(?:www\.)?gofile\.io$/.test(host)) return heading.trim() === 'This content does not exist'
  if (/^(?:www\.)?(?:k2s|keep2share)\.cc$/.test(host)) return heading.trim() === 'File unavailable'
  if (host === 'drive.google.com') return heading.trim() === 'Sorry, the file you have requested does not exist.'
  return false
}

export function intermediaryDownloadUrl(original: string, target: string): string | null {
  try {
    const source = new URL(original)
    const destination = new URL(target)
    if (source.origin !== 'https://keep2porn.net' || destination.origin !== 'https://k2s.cc') return null
    if (source.username || source.password || source.search || source.hash) return null
    if (destination.username || destination.password || destination.search || destination.hash) return null
    if (!/^\/\d+-[a-z0-9-]+\.html$/i.test(source.pathname)) return null
    return /^\/file\/[a-z0-9]+$/i.test(destination.pathname) ? destination.href : null
  } catch {
    return null
  }
}

export function matchingVideoFileNames(videoFileNames: readonly string[], scriptFileNames: readonly string[]): string[] {
  const videos = videoFileNames.filter((name) => !/[\\/]/.test(name) && isVideoPath(name))
  const videoStems = new Set(videos.map((name) => name.slice(0, name.lastIndexOf('.')).toLowerCase()))
  const scriptStems = new Set<string>()
  for (const name of scriptFileNames) {
    if (/[\\/]/.test(name)) continue
    const parsed = parseScriptName(name.toLowerCase(), videoStems)
    if (parsed && videoStems.has(parsed.stem)) scriptStems.add(parsed.stem)
  }
  return videos.filter((name) => scriptStems.has(name.slice(0, name.lastIndexOf('.')).toLowerCase()))
}
