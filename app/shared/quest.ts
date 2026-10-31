import type { AxisId } from './axes'
import type { Projection, ProjectionSource } from './projection'

export const QUEST_DISCOVERY_PROBE = 'BPQ1?'

export interface QuestBeacon {
  app: 'betterplayer'
  v: 1
  name: string
  port: number
  videos: number
  auth: boolean
}

export const QUEST_FOLLOW_PORT = 23554

export type QuestInfo = QuestBeacon

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
}

export interface QuestPosition {
  ms: number
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

export interface QuestToys {
  outputs: { id: string; name: string; connected: boolean }[]
  video: { mediaId: number; intensity: number; offsetMs: number } | null
}

export type QuestToyCommand =
  | { kind: 'intensity'; mediaId: number; value: number }
  | { kind: 'offset'; mediaId: number; ms: number }
  | { kind: 'reconnect'; id: string }
