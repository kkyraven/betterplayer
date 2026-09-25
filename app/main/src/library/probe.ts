import { runTool } from './tools'

export interface ProbeResult {
  durationMs: number
  width: number
  height: number
  codec: string
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const seconds = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n > 0 ? n : 0
}

export async function probe(path: string, signal?: AbortSignal): Promise<ProbeResult> {
  const out = await runTool('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], 20_000, signal)
  const json: unknown = JSON.parse(out)
  const streams = isObject(json) && Array.isArray(json.streams) ? json.streams : []
  const format = isObject(json) && isObject(json.format) ? json.format : {}
  const video = streams.find((s): s is Record<string, unknown> => isObject(s) && s.codec_type === 'video')
  const duration = seconds(format.duration) || seconds(video?.duration)
  return {
    durationMs: Math.round(duration * 1000),
    width: typeof video?.width === 'number' ? video.width : 0,
    height: typeof video?.height === 'number' ? video.height : 0,
    codec: typeof video?.codec_name === 'string' ? video.codec_name : '',
  }
}
