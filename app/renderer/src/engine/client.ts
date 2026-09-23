import { invoke } from '@/ipc'
import type { Projection } from '@shared/projection'
import { defaultDlss, type DlssSettings, type FrameGenOverride, type UpscalingSettings } from '@shared/settings'
import { isFree, useAccount } from '@/state/account'
import type { ModelInfo } from '@shared/tracking'

type EngineModule = typeof import('bp-engine')

const ENGINE_ARG = '--bp-engine='
const enginePath = process.argv.find((a) => a.startsWith(ENGINE_ARG))?.slice(ENGINE_ARG.length)
if (!enginePath) throw new Error('Missing --bp-engine argument; main passes it through webPreferences.additionalArguments')

const mod: EngineModule = window.require(enginePath)

export const { axes, listPorts, probeSerial, bleScan, toyScan, toyDevices, version, funscriptJson, funscriptBundle, simplifyIndices, beatAnalyse, beatAnalyseAsync, beatGenerate } = mod

export async function readScripts(path: string) {
  return mod.readScripts(path, await invoke('library:scriptFolders', path))
}

export const models = (): ModelInfo[] => mod.models() as ModelInfo[]

export const MAX_HEIGHT = 1440
export const MAX_OUTPUT_PIXELS = 3840 * 2160
const MAX_OUTPUT_DIMENSION = 8192

export let width = 0
export let height = 0
export let frames: Uint8Array[] = []

let upscalerOn = false

export function outputSize(cssWidth: number, cssHeight: number, projection: Projection, videoWidth: number, videoHeight: number): [number, number] {
  const dpr = window.devicePixelRatio
  let w = Math.round(cssWidth * dpr)
  let h = Math.round(cssHeight * dpr)
  if (projection.kind === 'flat' && videoWidth > 0 && videoHeight > 0) {
    const shownW = projection.layout === 'sbs' ? videoWidth / 2 : videoWidth
    const shownH = projection.layout === 'ou' ? videoHeight / 2 : videoHeight
    const aspect = shownW / shownH
    if (w / h > aspect) w = Math.round(h * aspect)
    else h = Math.round(w / aspect)
    if (projection.layout === 'mono' && !upscalerOn && (w > videoWidth || h > videoHeight)) {
      w = videoWidth
      h = videoHeight
    }
  }
  const scale = Math.min(1, upscalerOn ? 1 : MAX_HEIGHT / h,
    Math.sqrt(MAX_OUTPUT_PIXELS / (w * h)), MAX_OUTPUT_DIMENSION / Math.max(w, h))
  w = Math.floor(w * scale)
  h = Math.floor(h * scale)
  return [Math.max(2, w & ~1), Math.max(2, h & ~1)]
}

export function makeBuffers(w: number, h: number): Uint8Array[] {
  return [0, 1, 2].map(() => new Uint8Array(w * h * 4))
}

const BUFFER_SETS = 4
const BUFFER_CACHE_BYTES = 128 * 1024 * 1024
const bufferSets = new Map<string, Uint8Array[]>()

let slot = { cssWidth: 0, cssHeight: 0 }
let fit: { projection: Projection; videoWidth: number; videoHeight: number } | null = null

function buffersFor(w: number, h: number): Uint8Array[] {
  const key = `${w}x${h}`
  const set = bufferSets.get(key) ?? makeBuffers(w, h)
  bufferSets.delete(key)
  bufferSets.set(key, set)
  const byteSize = (buffers: Uint8Array[]) => buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0)
  let bytes = [...bufferSets.values()].reduce((sum, buffers) => sum + byteSize(buffers), 0)
  for (const [old, buffers] of bufferSets) {
    if (bufferSets.size <= BUFFER_SETS && bytes <= BUFFER_CACHE_BYTES) break
    bufferSets.delete(old)
    bytes -= byteSize(buffers)
  }
  return set
}

;[width, height] = [2, 2]
frames = buffersFor(width, height)

type Engine = InstanceType<EngineModule['Engine']>
type EnhanceCapabilities = ReturnType<Engine['enhanceCapabilities']>

export let engine: Engine
export let enhanceCapabilities: EnhanceCapabilities

const ytdlp = process.argv.find((a) => a.startsWith('--bp-ytdlp='))?.slice('--bp-ytdlp='.length)
export const hasYtdlp = Boolean(ytdlp)

const PICTURE_OPTIONS = { keepaspect: 'no', 'sub-auto': 'no', sid: 'no', 'audio-display': 'no' }

export function createEngine() {
  engine = new mod.Engine(width, height, frames, {
    mpvOptions: {
      ...PICTURE_OPTIONS,
      ...(ytdlp ? { ytdl: 'yes', 'script-opts': `ytdl_hook-ytdl_path=${ytdlp}`, 'ytdl-format': 'bestvideo[vcodec^=avc1][height<=1440]+bestaudio/bestvideo[vcodec^=hev][height<=1440]+bestaudio/bestvideo[height<=1440]+bestaudio/best[height<=1440]/best' } : {}),
    },
  })
  enhanceCapabilities = engine.enhanceCapabilities()
  setInterval(() => {
    for (const line of engine.takeLog()) console.debug(`mpv: ${line}`)
  }, 1000)
  window.addEventListener('beforeunload', () => engine.close())
}

export function createVideoPlayer(w: number, h: number, buffers: Uint8Array[]) {
  return new mod.VideoPlayer(w, h, buffers, { hwdec: engine.hwdec(), mpvOptions: PICTURE_OPTIONS })
}

let displayHz = 60

export function setDisplayHz(hz: number) {
  displayHz = hz > 0 ? hz : 60
}

const effectiveDlss = (dlss: DlssSettings): DlssSettings => (isFree(useAccount.getState()) ? defaultDlss() : dlss)

export function applyEnhance(upscaling: UpscalingSettings, override?: FrameGenOverride) {
  const target = override === 'off' ? 'off' : override === 'on' && upscaling.frameGen === 'off' ? 'display' : upscaling.frameGen
  const targetFps = target === 'off' ? undefined : target === 'display' ? displayHz : Number(target)
  const d = effectiveDlss(upscaling.dlss)
  const dlss = {
    nrPreset: d.nrPreset,
    nrStyle: d.nrStyle,
    intensity: d.intensity,
    localTone: d.localTone,
    localStructure: d.localStructure,
    skinStructure: d.skinStructure,
    autoMask: d.autoMask,
    modelPreset: d.modelPreset,
    factor: d.factor,
    inputHeight: d.inputHeight,
    rate: d.rate,
    guide: d.guide,
    bufferSeconds: d.bufferSeconds,
  }
  engine.setEnhance({ upscaler: upscaling.upscaler, targetFps, dlss })
  const on = upscaling.upscaler !== 'off'
  if (on !== upscalerOn) {
    upscalerOn = on
    if (fit) resize(slot.cssWidth, slot.cssHeight, fit.projection, fit.videoWidth, fit.videoHeight)
  }
}

export function resize(cssWidth: number, cssHeight: number, projection: Projection, videoWidth: number, videoHeight: number) {
  slot = { cssWidth, cssHeight }
  fit = { projection, videoWidth, videoHeight }
  const [w, h] = outputSize(cssWidth, cssHeight, projection, videoWidth, videoHeight)
  if (w === width && h === height) return
  const next = buffersFor(w, h)
  engine.resize(w, h, next)
  width = w
  height = h
  frames = next
}

export function warm(projection: Projection, videoWidth: number, videoHeight: number) {
  if (slot.cssWidth === 0 || videoWidth === 0 || videoHeight === 0) return
  const [w, h] = outputSize(slot.cssWidth, slot.cssHeight, projection, videoWidth, videoHeight)
  buffersFor(w, h)
}

export function acquireFrame(): Uint8Array | null {
  const index = engine.acquire()
  return index >= 0 ? (frames[index] ?? null) : null
}
