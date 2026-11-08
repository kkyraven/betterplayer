import { spawn } from 'node:child_process'
import { Socket } from 'node:net'
import { Readable } from 'node:stream'
import { QUEST_DECODE } from '@shared/quest'
import { runTool, toolFile } from '../library/tools'

export interface StreamFacts {
  codec: string
  width: number
  height: number
  fps: number
  mbps: number
}

export interface StreamPlan {
  width: number
  height: number
  fps: number
  scale: boolean
}

const STREAM_FPS_MAX = 60
export const MAX_ENCODES = 2
const FACT_FILES = 64

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)

export function streamPlan(facts: StreamFacts): StreamPlan | null {
  const { codec, width, height, fps, mbps } = facts
  if (!(width > 0 && height > 0 && fps > 0)) return null
  const limit = QUEST_DECODE[codec]
  if (limit && width <= limit.maxWidth && height <= limit.maxHeight && width * height * fps <= limit.maxPixelRate && mbps <= limit.maxMbps) return null
  const half = fps / 2
  const rate = half >= 48 && half <= STREAM_FPS_MAX ? half : Math.min(fps, STREAM_FPS_MAX)
  const out = QUEST_DECODE.hevc
  if (!out) return null
  const k = Math.min(1, out.maxWidth / width, out.maxHeight / height, Math.sqrt(out.maxPixelRate / (width * height * rate)))
  return k === 1 ? { width, height, fps: rate, scale: false } : { width: even(width * k), height: even(height * k), fps: rate, scale: true }
}

const TRACK_WIDTH = 384
const TRACK_FPS_MAX = 30

export function trackFrames(plan: StreamPlan): { width: number; height: number; bytes: number; step: number; fps: number } {
  const height = Math.max(2, Math.round((TRACK_WIDTH * plan.height) / plan.width / 2) * 2)
  const step = Math.max(1, Math.ceil(plan.fps / TRACK_FPS_MAX - 1e-6))
  return { width: TRACK_WIDTH, height, bytes: TRACK_WIDTH * height * 4, step, fps: plan.fps / step }
}

export function frameSplitter(bytes: number, startMs: number, fps: number, want: () => boolean, emit: (frame: Buffer, timeMs: number) => void): (chunk: Buffer) => void {
  let n = 0
  let filled = 0
  let frame: Buffer | null = null
  return (chunk) => {
    let at = 0
    while (at < chunk.length) {
      if (filled === 0) frame = want() ? Buffer.allocUnsafe(bytes) : null
      const take = Math.min(bytes - filled, chunk.length - at)
      frame?.set(chunk.subarray(at, at + take), filled)
      at += take
      filled += take
      if (filled < bytes) return
      if (frame) emit(frame, startMs + (n * 1000) / fps)
      n++
      filled = 0
    }
  }
}

export const FACT_ARGS = ['-v', 'error', '-select_streams', 'V:0', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,r_frame_rate', '-of', 'json']

const rate = (v: unknown): number => {
  const [num = NaN, den = 1] = typeof v === 'string' ? v.split('/').map(Number) : []
  return den > 0 && num > 0 ? num / den : 0
}

export function readFacts(json: string): Omit<StreamFacts, 'mbps'> | null {
  let first: unknown
  try {
    const parsed: unknown = JSON.parse(json)
    first = parsed && typeof parsed === 'object' && 'streams' in parsed && Array.isArray(parsed.streams) ? (parsed.streams[0] as unknown) : null
  } catch {
    return null
  }
  if (!first || typeof first !== 'object') return null
  const s = first as Record<string, unknown>
  const width = typeof s.width === 'number' ? s.width : 0
  const height = typeof s.height === 'number' ? s.height : 0
  const fps = rate(s.avg_frame_rate) || rate(s.r_frame_rate)
  return typeof s.codec_name === 'string' && width > 0 && height > 0 && fps > 0 ? { codec: s.codec_name, width, height, fps } : null
}

export function streamArgs(path: string, startMs: number, plan: StreamPlan, music?: string | null): string[] {
  const size = plan.scale ? `${plan.width}:${plan.height}:` : ''
  const fps = Number(plan.fps.toFixed(5))
  const track = trackFrames(plan)
  const start = (Math.max(0, startMs) / 1000).toFixed(3)
  const audio = music === null ? [] : music === undefined ? ['-map', '0:a:0?'] : ['-map', '1:a:0?']
  return [
    '-hide_banner', '-v', 'error',
    '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
    '-ss', start, '-i', path,
    ...(music ? ['-ss', start, '-i', music] : []),
    '-filter_complex',
    `[0:V:0]fps=${fps},split[e][t];[e]scale_cuda=${size}format=p010le[v];` +
      `[t]framestep=${track.step},scale_cuda=${TRACK_WIDTH * 4}:-2:format=nv12,hwdownload,format=nv12,scale=${track.width}:${track.height}:flags=bicubic,format=bgra[k]`,
    '-map', '[v]', ...audio,
    '-c:v', 'hevc_nvenc', '-preset', 'p3', '-split_encode_mode', '2', '-tune', 'll',
    '-rc', 'vbr', '-b:v', '80M', '-maxrate', '120M', '-bufsize', '120M',
    '-g', String(Math.round(fps)), '-bf', '0', '-profile:v', 'main10',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    ...(music ? ['-af', 'apad', '-shortest'] : []),
    '-f', 'mpegts', 'pipe:1',
    '-map', '[k]', '-f', 'rawvideo', 'pipe:3',
  ]
}

const ENCODER_ARGS = ['-hide_banner', '-v', 'error', '-init_hw_device', 'cuda=cu', '-filter_hw_device', 'cu', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30:d=0.2', '-vf', 'hwupload,scale_cuda=format=p010le', '-c:v', 'hevc_nvenc', '-profile:v', 'main10', '-f', 'null', '-']

export interface Encode {
  stdout: Readable
  exited: Promise<number | null>
  produced(): boolean
  kill(): void
  stderr(): string
}

export interface StreamDeps {
  probe: (args: string[]) => Promise<string>
  encoder: () => Promise<boolean>
  spawn: (args: string[], frames: (chunk: Buffer) => void) => Promise<Encode>
}

async function spawnFfmpeg(args: string[], frames: (chunk: Buffer) => void): Promise<Encode> {
  const child = spawn(await toolFile('ffmpeg'), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
  const { stdout, stderr } = child
  const pipe3 = child.stdio[3]
  if (!stdout || !stderr || !(pipe3 instanceof Readable)) {
    child.kill()
    throw new Error('ffmpeg started without its pipes')
  }
  pipe3.on('data', frames)
  pipe3.on('error', () => {})
  let tail = ''
  stderr.on('data', (d: Buffer) => (tail = (tail + d.toString()).slice(-2000)))
  const exited = new Promise<number | null>((done) => {
    child.once('error', () => done(null))
    child.once('close', (code) => done(code))
  })
  const produced = () => !(stdout instanceof Socket) || stdout.bytesRead > 0
  return { stdout, exited, produced, kill: () => child.kill(), stderr: () => tail }
}

const DEFAULT_DEPS: StreamDeps = {
  probe: (args) => runTool('ffprobe', args, 20_000),
  encoder: () => runTool('ffmpeg', ENCODER_ARGS, 15_000).then(() => true, () => false),
  spawn: spawnFfmpeg,
}

interface StreamFile {
  path: string
  mtime: number
}

const fileKey = (file: StreamFile) => `${file.mtime}:${file.path}`

export class QuestStreams {
  private readonly deps: StreamDeps
  private readonly facts = new Map<string, Promise<Omit<StreamFacts, 'mbps'> | null>>()
  private readonly failed = new Set<string>()
  private readonly running = new Map<string, Encode>()
  private encoder: Promise<boolean> | null = null

  constructor(deps: Partial<StreamDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps }
  }

  async plan(file: StreamFile & { size: number; durationMs: number }): Promise<StreamPlan | null> {
    if (this.failed.has(fileKey(file))) return null
    const facts = await this.probe(file)
    const plan = facts && streamPlan({ ...facts, mbps: file.durationMs > 0 ? (file.size * 8) / file.durationMs / 1000 : 0 })
    if (!plan) return null
    this.encoder ??= this.deps.encoder().then((ok) => {
      if (!ok) this.encoder = null
      return ok
    })
    return (await this.encoder) ? plan : null
  }

  private probe(file: StreamFile): Promise<Omit<StreamFacts, 'mbps'> | null> {
    const key = fileKey(file)
    const known = this.facts.get(key)
    if (known) return known
    const probed = this.deps.probe([...FACT_ARGS, file.path]).then(readFacts, () => null)
    void probed.then((facts) => facts === null && this.facts.delete(key))
    this.facts.set(key, probed)
    const oldest = this.facts.keys().next().value
    if (this.facts.size > FACT_FILES && oldest !== undefined) this.facts.delete(oldest)
    return probed
  }

  async open(headset: string, file: StreamFile, args: string[], frames: (chunk: Buffer) => void = () => {}): Promise<Encode | null> {
    this.end(headset)
    if (this.running.size >= MAX_ENCODES) return null
    const encode = await this.deps.spawn(args, frames)
    this.end(headset)
    this.running.set(headset, encode)
    void encode.exited.then((code) => {
      if (this.running.get(headset) === encode) this.running.delete(headset)
      if (code !== null && code !== 0 && !encode.produced()) this.failed.add(fileKey(file))
    })
    return encode
  }

  end(headset: string) {
    this.running.get(headset)?.kill()
    this.running.delete(headset)
  }

  endAll() {
    for (const encode of this.running.values()) encode.kill()
    this.running.clear()
  }
}
