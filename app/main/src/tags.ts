import type { MediaTags } from '@shared/ipc'
import { runTool, runToolBytes } from './library/tools'

const MAX_COVER_BYTES = 6 * 1024 * 1024

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function tag(tags: Record<string, unknown>[], ...names: string[]): string | null {
  for (const t of tags) {
    for (const [k, v] of Object.entries(t)) {
      if (names.includes(k.toLowerCase()) && typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return null
}

export interface ParsedTags extends Omit<MediaTags, 'cover'> {
  pictureIndex: number | null
}

export function parseTags(json: unknown): ParsedTags {
  const streams = isObject(json) && Array.isArray(json.streams) ? json.streams.filter(isObject) : []
  const format = isObject(json) && isObject(json.format) ? json.format : {}
  const picture = streams.find((s) => s.codec_type === 'video' && isObject(s.disposition) && s.disposition.attached_pic === 1)
  const video = streams.some((s) => s.codec_type === 'video' && s !== picture)
  const audio = streams.find((s) => s.codec_type === 'audio')
  const tags = [format.tags, audio?.tags].filter(isObject)
  const date = tag(tags, 'date', 'year', 'originaldate')
  const year = date ? Number(/\d{4}/.exec(date)?.[0]) : NaN
  return {
    video,
    title: tag(tags, 'title'),
    artist: tag(tags, 'artist', 'album_artist', 'albumartist'),
    album: tag(tags, 'album'),
    year: Number.isFinite(year) ? year : null,
    pictureIndex: typeof picture?.index === 'number' ? picture.index : null,
  }
}

function mime(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  return 'application/octet-stream'
}

async function readCover(path: string, index: number): Promise<string | null> {
  try {
    const bytes = await runToolBytes('ffmpeg', ['-v', 'error', '-i', path, '-map', `0:${index}`, '-frames:v', '1', '-c', 'copy', '-f', 'image2pipe', '-'], 15_000)
    if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) return null
    return `data:${mime(bytes)};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

export async function readTags(path: string): Promise<MediaTags | null> {
  let parsed: ParsedTags
  try {
    parsed = parseTags(JSON.parse(await runTool('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], 15_000)))
  } catch {
    return null
  }
  const { pictureIndex, ...tags } = parsed
  return { ...tags, cover: pictureIndex === null ? null : await readCover(path, pictureIndex) }
}
