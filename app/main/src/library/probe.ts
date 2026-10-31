import type { ContainerFacts, Layout } from '@shared/projection'
import { runTool } from './tools'

export interface ProbeResult {
  durationMs: number
  width: number
  height: number
  codec: string
  vr: ContainerFacts
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
  const video = streams.find((s): s is Record<string, unknown> => isObject(s) && s.codec_type === 'video' && !(isObject(s.disposition) && s.disposition.attached_pic === 1))
  const duration = seconds(format.duration) || seconds(video?.duration)
  return {
    durationMs: Math.round(duration * 1000),
    width: typeof video?.width === 'number' ? video.width : 0,
    height: typeof video?.height === 'number' ? video.height : 0,
    codec: typeof video?.codec_name === 'string' ? video.codec_name : '',
    vr: video ? containerFacts(video) : {},
  }
}

type Sphere = NonNullable<ContainerFacts['sphere']>
type Stereo = NonNullable<ContainerFacts['stereo']>
const SPHERE_TYPES = new Map<string, Sphere>([['equirectangular', 'equirect'], ['tiled equirectangular', 'equirect'], ['half equirectangular', 'half'], ['fisheye', 'fisheye'], ['rectilinear', 'flat']])
const STEREO_TYPES = new Map<string, Stereo>([['side by side', 'sbs'], ['top and bottom', 'ou'], ['2D', 'mono'], ['unspecified', 'views']])
const STEREO_MODES = new Map<string, [Layout, boolean]>([['mono', ['mono', false]], ['left_right', ['sbs', false]], ['right_left', ['sbs', true]], ['top_bottom', ['ou', false]], ['bottom_top', ['ou', true]]])

export function containerFacts(stream: Record<string, unknown>): ContainerFacts {
  const out: ContainerFacts = {}
  const width = typeof stream.width === 'number' ? stream.width : 0
  const list = Array.isArray(stream.side_data_list) ? stream.side_data_list : []
  for (const sd of list) {
    if (!isObject(sd)) continue
    if (sd.side_data_type === 'Spherical Mapping') {
      const projection = String(sd.projection ?? '')
      out.sphere = SPHERE_TYPES.get(projection) ?? 'other'
      const left = Number(sd.bound_left) || 0
      const right = Number(sd.bound_right) || 0
      if (projection === 'tiled equirectangular' && width > 0) out.cover = Math.round((width / (width + left + right)) * 100) / 100
    } else if (sd.side_data_type === 'Stereo 3D') {
      const type = String(sd.type ?? '')
      const stereo = STEREO_TYPES.get(type)
      if (stereo) out.stereo = stereo
      if (sd.inverted === 1) out.swap = true
    }
  }
  const mode = isObject(stream.tags) && typeof stream.tags.stereo_mode === 'string' ? STEREO_MODES.get(stream.tags.stereo_mode) : undefined
  if (!out.stereo && mode) {
    out.stereo = mode[0]
    if (mode[1]) out.swap = true
  }
  return out
}
