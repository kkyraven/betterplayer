import { isAudioPath } from './ipc'
import type { EstimAudioVideo } from './settings'

export interface EstimAudioPlan {
  media: string
  estim: string
  music?: string
  swapChannels: boolean
}

export function estimAudioPlan(media: string, found: string | null, video: EstimAudioVideo | undefined): EstimAudioPlan | null {
  const file = video?.file === null ? undefined : (video?.file ?? found ?? undefined)
  const swapChannels = video?.swapChannels === true
  if (video?.swap) return { media, estim: media, ...(file ? { music: file } : {}), swapChannels }
  return file ? { media, estim: file, swapChannels } : null
}

const key = (path: string) => path.replace(/\\/g, '/').toLowerCase()

const parts = (path: string) => {
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = path.slice(sep + 1)
  const dot = name.lastIndexOf('.')
  return { dir: key(path.slice(0, Math.max(sep, 0))), stem: dot > 0 ? name.slice(0, dot) : name }
}

const words = (stem: string) => stem.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()

const STIM = /(^| )e? ?stim( |$)/

function runsOn(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 4 && long.startsWith(`${short} `)
}

export function pickEstimAudio(video: string, audio: readonly string[], videos: readonly string[]): string | null {
  const own = parts(video)
  const name = words(own.stem)
  if (!name) return null
  const others = videos.map((v) => words(parts(v).stem)).filter((w) => w !== name)
  const claimed = (stem: string) => others.some((o) => o === stem || (runsOn(o, stem) && (stem.length < name.length || o.length > name.length)))
  let best = Number.POSITIVE_INFINITY
  let tied: string[] = []
  for (const path of [...audio].filter((p) => isAudioPath(p) && key(p) !== key(video)).sort()) {
    const file = parts(path)
    const stem = words(file.stem)
    if (!stem || (stem !== name && claimed(stem))) continue
    const beside = file.dir === own.dir
    const rank = stem === name ? (beside ? 0 : 1) : runsOn(name, stem) ? (beside ? 2 : 3) : null
    if (rank === null || rank > best) continue
    if (rank < best) tied = []
    best = rank
    tied.push(path)
  }
  if (tied.length <= 1 || best <= 1) return tied[0] ?? null
  const stim = tied.filter((p) => STIM.test(words(parts(p).stem)))
  return stim.length === 1 ? (stim[0] ?? null) : null
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function readEstimAudioVideo(raw: unknown): EstimAudioVideo | undefined {
  if (!isRecord(raw)) return undefined
  const v: EstimAudioVideo = {
    ...(typeof raw.file === 'string' && raw.file ? { file: raw.file } : raw.file === null ? { file: null } : {}),
    ...(raw.swap === true ? { swap: true } : {}),
    ...(raw.swapChannels === true ? { swapChannels: true } : {}),
  }
  return Object.keys(v).length > 0 ? v : undefined
}
