import type { AxisId } from './axes'
import type { VrDom } from './dom'
import type { HeadsetToyCommand, HeadsetToys, VideoToyCommand, VideoToys } from './headsetToys'
import type { MissingFile } from './library'
import type { Projection, ProjectionSource } from './projection'
import type { ResolvedPassthrough } from './passthrough'
import type { CensorStyle } from './settings'

export const QUEST_PROTOCOL = 2

export const QUEST_DISCOVERY_PROBE = 'BPQ2?'

export interface QuestProbe {
  id: string
  name: string
  v?: number
}

export const QUEST_DISCOVERY_PORT = 23554

export const QUEST_INVITE = 'BPQ2!'

export interface QuestBeacon {
  app: 'betterplayer'
  v: number
  id: string
  name: string
  port: number
  paired: boolean
  proof?: string
  vrFreeMs?: number
}

export interface QuestPairRequest {
  id: string
  name: string
  pin: string
}

export interface QuestPaired {
  token: string
}

export const QUEST_PAIR_TIMEOUT_MS = 120_000

export const QUEST_FOLLOW_PORT = 23554

export type QuestInfo = QuestBeacon

export const QUEST_SCENE_MISSING: Record<MissingFile, string> = { drive: 'drive missing', file: 'file missing' }

export interface QuestScene {
  id: number
  title: string
  url: string
  durationMs: number
  resumeMs: number
  projection: Projection
  projectionSource: ProjectionSource
  width: number
  height: number
  axes: AxisId[]
  heat: number[]
  passthrough?: QuestPassthrough
  stream?: QuestStream
  audio?: QuestSceneAudio
}

export interface QuestSceneAudio {
  url: string | null
}

export interface QuestStream {
  url: string
  width: number
  height: number
  fps: number
}

export interface QuestDecodeLimit {
  maxWidth: number
  maxHeight: number
  maxPixelRate: number
  maxMbps: number
}

const PIXEL_RATE_8K60 = 7680 * 3840 * 60

export const QUEST_DECODE: Record<string, QuestDecodeLimit> = {
  h264: { maxWidth: 8192, maxHeight: 4096, maxPixelRate: PIXEL_RATE_8K60, maxMbps: 220 },
  hevc: { maxWidth: 8192, maxHeight: 4096, maxPixelRate: PIXEL_RATE_8K60, maxMbps: 160 },
  av1: { maxWidth: 8192, maxHeight: 4096, maxPixelRate: PIXEL_RATE_8K60, maxMbps: 100 },
  vp9: { maxWidth: 7680, maxHeight: 4096, maxPixelRate: 6144 * 3072 * 60, maxMbps: 160 },
}

export interface QuestPassthrough extends ResolvedPassthrough {
  maskBase?: string
}

export interface QuestMaskMeta {
  version: 1 | 2
  w: number
  h: number
  fps: number
  layout: 'mono' | 'sbs' | 'ou'
  eye: 0 | 1 | 2
  model: string
  source?: string
}

export interface QuestCensor {
  style: CensorStyle
  strength: number
  track: string | null
}

export interface QuestPosition {
  ms: number
}

export interface QuestSample {
  timeSec: number
  u: number
  v: number
}

export interface QuestSampled {
  colour: number | null
}

export interface QuestHello {
  name: string
  port: number
  session: string
}

export const QUEST_HELLO_REPEAT_MS = 3000

export interface QuestClockFrame {
  path: string
  resource: string
  currentTime: number
  duration: number
  playbackSpeed: number
  playerState: 0 | 1
}

export const QUEST_STALE_MS = 1500

export interface QuestToys extends Omit<HeadsetToys, 'video'> {
  video: (VideoToys & { mediaId: number; tracking?: boolean }) | null
}

export type QuestToyCommand =
  | (VideoToyCommand & { mediaId: number })
  | { kind: 'tracking'; mediaId: number; on: boolean }
  | Exclude<HeadsetToyCommand, VideoToyCommand>

export type QuestDomCommand = { n: number } & ({ kind: 'open'; mediaId: number; startMs: number } | { kind: 'play' } | { kind: 'pause' } | { kind: 'seek'; ms: number })

export interface QuestDom extends VrDom {
  version: number
  commands: QuestDomCommand[]
}

export const QUEST_DOM_WAIT_MS = 25_000

export type QuestDomRequest = { kind: 'start'; domId: string } | { kind: 'send'; text: string }

export interface QuestHeadset {
  id: string
  name: string
  host: string | null
  paired: boolean
  looking: boolean
  update?: 'headset' | 'desktop'
}

export type QuestConnectResult = { answered: true } | { answered: false; firewall: boolean; vpn: string | null }

export const QUEST_ANSWER_MS = 8000

export interface QuestPairPrompt {
  requestId: string
  name: string
  host: string
}

export type QuestPinResult = 'paired' | 'wrong' | 'gone'
