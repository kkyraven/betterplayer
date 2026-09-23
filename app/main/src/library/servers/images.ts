import { t } from '../../i18n'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STRIP_FRAMES } from '../thumbs'
import { runTool } from '../tools'
import type { RemoteScene } from './adapter'
import { HttpError, request } from './http'

export const ASSET_RECHECK_MS = 24 * 60 * 60 * 1000
const IMAGE_LIMIT = 32 * 1024 * 1024
const PREVIEW_LIMIT = 128 * 1024 * 1024
const FFMPEG = ['-y', '-v', 'error', '-xerror', '-threads', '2', '-filter_complex_threads', '1', '-filter_threads', '1', '-protocol_whitelist', 'file,pipe']

export interface SpriteCue {
  start: number
  end: number
  x: number
  y: number
  width: number
  height: number
}

function seconds(value: string): number {
  return value.split(':').reduce((n, part) => n * 60 + Number(part), 0)
}

export function spriteCues(vtt: string): SpriteCue[] {
  const cues: SpriteCue[] = []
  const time = '(\\d{2,}:\\d{2}:\\d{2}\\.\\d{3}|\\d{2}:\\d{2}\\.\\d{3})'
  const pattern = new RegExp(`^${time}\\s+-->\\s+${time}[^\\n]*\\n[^\\n]*#xywh=(\\d+),(\\d+),(\\d+),(\\d+)\\s*$`, 'gm')
  for (const m of vtt.replace(/\r/g, '').matchAll(pattern)) {
    const cue = { start: seconds(m[1]!), end: seconds(m[2]!), x: Number(m[3]), y: Number(m[4]), width: Number(m[5]), height: Number(m[6]) }
    if (cue.end <= cue.start || !Number.isFinite(cue.end) || cue.width < 1 || cue.height < 1 || [cue.x, cue.y, cue.width, cue.height].some((n) => !Number.isSafeInteger(n))) throw new Error(t('library.server.error.invalidSpriteCue'))
    cues.push(cue)
  }
  if (!cues.length) throw new Error(t('library.server.error.noSpriteCues'))
  return cues.sort((a, b) => a.start - b.start)
}

async function download(url: string, headers: Record<string, string>, limit: number): Promise<Buffer> {
  const res = await request(url, { headers })
  if (Number(res.headers.get('content-length')) > limit) {
    await res.body?.cancel()
    throw new Error(t('library.server.error.assetTooLarge'))
  }
  const reader = res.body?.getReader()
  if (!reader) throw new Error(t('library.server.error.emptyAsset'))
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > limit) throw new Error(t('library.server.error.assetTooLarge'))
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel()
  }
  if (!size) throw new Error(t('library.server.error.emptyAsset'))
  return Buffer.concat(chunks)
}

async function probe(path: string) {
  const result: unknown = JSON.parse(await runTool('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', path], 30_000))
  if (!result || typeof result !== 'object' || !('streams' in result) || !Array.isArray(result.streams)) throw new Error(t('library.server.error.noImage'))
  const stream: unknown = result.streams[0]
  if (!stream || typeof stream !== 'object' || !('width' in stream) || !('height' in stream)) throw new Error(t('library.server.error.noImage'))
  const width = Number(stream.width)
  const height = Number(stream.height)
  if (!(width > 0 && height > 0) || width * height > 100_000_000) throw new Error(t('library.server.error.invalidDimensions'))
  const format = 'format' in result ? result.format : null
  const duration = format && typeof format === 'object' && 'duration' in format ? Number(format.duration) : 0
  return { width, height, duration }
}

export async function cacheImage(output: string, source: string | NonNullable<RemoteScene['preview']>, headers: Record<string, string>, durationMs = 0, decodePoster?: (bytes: Buffer) => Buffer): Promise<string | null> {
  await mkdir(dirname(output), { recursive: true })
  const temp = await mkdtemp(join(dirname(output), '.asset-'))
  const input = join(temp, 'input')
  const jpg = join(temp, 'image.jpg')
  try {
    if (typeof source === 'string') {
      const bytes = await download(source, headers, IMAGE_LIMIT)
      if (decodePoster) {
        await writeFile(jpg, decodePoster(bytes))
      } else {
        await writeFile(input, bytes)
        await probe(input)
        await runTool('ffmpeg', [...FFMPEG, '-i', input, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', jpg], 60_000)
      }
      if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) await writeFile(jpg, bytes)
    } else {
      let made = false
      if (source.sprite && source.vtt) {
        try {
          const vtt = await download(source.vtt, headers, 4 * 1024 * 1024)
          const cues = spriteCues(vtt.toString())
          await writeFile(input, await download(source.sprite, headers, IMAGE_LIMIT))
          const dimensions = await probe(input)
          if (cues.some((c) => c.x + c.width > dimensions.width || c.y + c.height > dimensions.height)) throw new Error(t('library.server.error.spriteOutOfBounds'))
          const height = Math.max(2, Math.round(160 * cues[0]!.height / cues[0]!.width / 2) * 2)
          const span = durationMs > 0 ? durationMs / 1000 : cues[cues.length - 1]!.end
          const frames = Array.from({ length: STRIP_FRAMES }, (_, i) => {
            const at = span * (i + 0.5) / STRIP_FRAMES
            return cues.find((c) => at >= c.start && at < c.end) ?? cues.reduce((best, c) => Math.abs(c.start - at) < Math.abs(best.start - at) ? c : best)
          })
          const split = `[0:v]split=${STRIP_FRAMES}${frames.map((_, i) => `[s${i}]`).join('')}`
          const filters = frames.map((c, i) => `[s${i}]crop=${c.width}:${c.height}:${c.x}:${c.y},scale=160:${height}[f${i}]`)
          const stack = `${frames.map((_, i) => `[f${i}]`).join('')}hstack=inputs=${STRIP_FRAMES}`
          await runTool('ffmpeg', [...FFMPEG, '-i', input, '-filter_complex', [split, ...filters, stack].join(';'), '-frames:v', '1', '-q:v', '4', jpg], 60_000)
          made = true
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 404)) throw e
        }
      }
      if (!made) {
        if (!source.video) return null
        await writeFile(input, await download(source.video, headers, PREVIEW_LIMIT))
        const { duration } = await probe(input)
        if (!Number.isFinite(duration) || duration <= 0) throw new Error(t('library.server.error.noPreviewDuration'))
        await runTool('ffmpeg', [...FFMPEG, '-i', input, '-vf', `fps=${STRIP_FRAMES / duration},scale=160:-2,tpad=stop_mode=clone:stop_duration=${duration},tile=${STRIP_FRAMES}x1`, '-frames:v', '1', '-q:v', '4', jpg], 120_000)
      }
    }
    const bytes = await readFile(jpg)
    if (!bytes.length) throw new Error(t('library.server.error.emptyImage'))
    const digest = createHash('sha256').update(bytes).digest('hex')
    await rename(jpg, output)
    return digest
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null
    throw e
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
