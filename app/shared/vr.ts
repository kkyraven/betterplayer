import type { AxisId } from './axes'
import type { Projection, ProjectionSource } from './projection'

export interface VrPlayerState {
  title: string
  loaded: boolean
  playing: boolean
  timeMs: number
  durationMs: number
  rate: number
  heat: number[]
  axes: AxisId[]
  devices: { name: string; connected: boolean }[]
  projection: Projection
  projectionSource: ProjectionSource
  volume: number
  muted: boolean
  screenSize: VrScreenSize
  halted: boolean
  inSession: boolean
}

export type VrDeckMode = 'hidden' | 'peek' | 'open'

export interface VrPeek {
  shortcut: VrShortcut
  count: number
}

export interface VrDeckState extends VrPlayerState {
  screen: boolean
  mode: VrDeckMode
  peek: VrPeek | null
}

export type VrCommand =
  | { kind: 'toggle' }
  | { kind: 'seek'; timeMs: number }
  | { kind: 'skip'; seconds: number }
  | { kind: 'step'; direction: -1 | 1 }
  | { kind: 'stop' }
  | { kind: 'recentre'; keepRecline?: boolean }
  | { kind: 'projection'; projection: Projection | null }
  | { kind: 'screenSize'; size: VrScreenSize }
  | { kind: 'screen'; open: boolean }
  | { kind: 'wake' }
  | { kind: 'peek'; shortcut?: VrShortcut }

export type VrPanelId = 'deck'

export interface VrPlacement {
  metres: number
  distance: number
  drop: number
  pitch: number
  curvature: number
}

export interface VrPanelSpec extends VrPlacement {
  width: number
  height: number
}

export const VR_PANELS: Record<VrPanelId, VrPanelSpec> = {
  deck: { width: 1280, height: 440, metres: 0.8, distance: 0.8, drop: 0.38, pitch: 25, curvature: 0 },
}

export const VR_SCREEN: VrPlacement = { metres: 2.4, distance: 2.2, drop: 0.05, pitch: 0, curvature: 0.12 }

export const VR_SCREEN_MAX_WIDTH = 3840

export const VR_DECK_IDLE_MS = 2500

export const VR_DECK_PEEK_MS = 1500

export const VR_SHORTCUTS = ['playPause', 'seekBack', 'seekForward', 'volumeUp', 'volumeDown', 'controls', 'back', 'turnLeft', 'turnRight', 'recentre', 'stop'] as const
export type VrShortcut = (typeof VR_SHORTCUTS)[number]

export const VR_SKIP_SECONDS = 10

export const VR_TURN_DEGREES = 10

export const VR_SCREEN_SIZES = { small: 40, medium: 50, large: 61, huge: 75 } as const
export type VrScreenSize = keyof typeof VR_SCREEN_SIZES
export const VR_SCREEN_SIZE_DEFAULT: VrScreenSize = 'medium'

export const VR_ERRORS = ['not-installed', 'not-running', 'no-headset', 'other-gpu', 'no-interop', 'old-steamvr', 'timeout', 'busy', 'quit', 'compositor', 'failed'] as const
export type VrError = (typeof VR_ERRORS)[number]

export function vrError(message: string): VrError {
  const code = message.split(': ', 1)[0]
  return VR_ERRORS.find((c) => c === code) ?? 'failed'
}
