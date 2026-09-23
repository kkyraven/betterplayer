import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, sep } from 'node:path'
import { parseSubtitles, sidecarTrack, sortTracks, subtitleExtension, type Cue, type SubtitleTrack } from '@shared/subtitles'

export async function findSubtitles(video: string): Promise<SubtitleTrack[]> {
  if (/^https?:\/\//i.test(video)) return []
  const dir = dirname(video)
  const name = basename(video)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const tracks: SubtitleTrack[] = []
  for (const entry of entries) {
    const track = sidecarTrack(name, entry, dir.endsWith(sep) ? dir : dir + sep)
    if (track) tracks.push(track)
  }
  return sortTracks(tracks)
}

export async function readSubtitles(path: string): Promise<Cue[]> {
  const ext = subtitleExtension(path)
  if (!ext) return []
  return parseSubtitles(await readFile(path, 'utf8'), ext)
}
