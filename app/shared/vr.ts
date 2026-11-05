import type { AxisId } from './axes'
import type { HeadsetToyCommand, HeadsetToys } from './headsetToys'
import type { Projection, ProjectionSource } from './projection'
import type { PassthroughSettings, ResolvedPassthrough } from './passthrough'
import type { VrMovablePanel, VrPanelOffset } from './settings'
import { INTRO_BOX, VR_INTRO } from './vrIntro'

export interface VrPlayerState {
  title: string
  loaded: boolean
  playing: boolean
  timeMs: number
  durationMs: number
  rate: number
  heat: number[]
  axes: AxisId[]
  toys: HeadsetToys
  tracking: boolean
  projection: Projection
  projectionSource: ProjectionSource
  volume: number
  muted: boolean
  screenSize: VrScreenSize
  halted: boolean
  inSession: boolean
  turn: number
  passthrough?: ResolvedPassthrough
  passthroughMenus?: boolean
  passthroughKeys?: boolean
}

export const VR_PASSTHROUGH_KEY = 0x00ff00

export type VrDeckMode = 'hidden' | 'peek' | 'open'

export interface VrPeek {
  shortcut: VrShortcut
  count: number
}

export interface VrDeckState extends VrPlayerState {
  screen: boolean
  ring: boolean
  mode: VrDeckMode
  peek: VrPeek | null
}

export type VrHand = 'left' | 'right'

export interface VrRay {
  origin: [number, number, number]
  direction: [number, number, number]
}

export type VrLegendRole = 'trigger' | 'stick' | 'primary' | 'secondary' | 'trackpad' | 'menu'

export interface VrLegendCallout {
  role: VrLegendRole
  at: [number, number] | null
  label: [number, number]
  side: 'left' | 'right' | 'above'
}

export type VrLegendMap = { kind: 'playing' } | { kind: 'panels'; loaded: boolean }

export interface VrLegendOn {
  hand: VrHand
  controller: string
  map: VrLegendMap
  callouts: VrLegendCallout[]
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
  | { kind: 'trigger'; hand: VrHand; down: boolean; ray: VrRay | null; grip?: boolean }
  | { kind: 'ring'; open: boolean }
  | { kind: 'ringBack'; held?: boolean }
  | { kind: 'ringCancel' }
  | { kind: 'ringStick'; at: [number, number] | null }
  | { kind: 'ringConfirm' }
  | { kind: 'turn'; degrees: number }
  | { kind: 'legend'; on: VrLegendOn | null }
  | { kind: 'hands'; models: VrHand[]; rays: VrHand[] }
  | { kind: 'claimPress' }
  | { kind: 'pressTaken' }
  | { kind: 'drag'; on: boolean }
  | { kind: 'toy'; command: HeadsetToyCommand }
  | { kind: 'rangeLive'; value: number | null }
  | { kind: 'buzz'; buzz: VrBuzz; hand?: VrHand }
  | { kind: 'passthrough'; change: Partial<PassthroughSettings> }
  | { kind: 'passthroughMenus'; on: boolean }
  | { kind: 'tracking' }
  | { kind: 'pick'; hand?: VrHand }
  | { kind: 'panelOffset'; panel: VrMovablePanel; offset: VrPanelOffset }
  | { kind: 'intro'; on: boolean }
  | { kind: 'introSkip' }
  | { kind: 'introFrame'; ms: number; at: number; moving: boolean }

export type VrPanelId = 'deck' | 'ring' | 'legend' | 'intro'

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
  ring: { width: 960, height: 960, metres: 0.5, distance: 0.8, drop: 0, pitch: 0, curvature: 0 },
  legend: { width: 1300, height: 800, metres: 0.355, distance: 0, drop: 0, pitch: 0, curvature: 0 },
  intro: { width: INTRO_BOX.width, height: INTRO_BOX.height, metres: INTRO_BOX.metres, distance: VR_INTRO.distance, drop: VR_INTRO.drop, pitch: 0, curvature: 0 },
}

export const VR_WHEEL_STICK = { light: 0.5, release: 0.35 } as const

export const VR_LEGEND = { distance: 0.7, angle: 25, showMs: 250, hideMs: 3000, lift: 0.03, back: 0.05, tilt: 55 } as const

export const VR_BUZZES = ['open', 'hover', 'pick', 'detent', 'notch'] as const
export type VrBuzz = (typeof VR_BUZZES)[number]

export const VR_LENS = {
  fisheye: { presets: [180, 190, 200, 220], min: 150, max: 240 },
  equirect180: { presets: [180, 190, 200, 220], min: 160, max: 260 },
} as const

export const VR_SCREEN: VrPlacement = { metres: 2.08, distance: 1.4, drop: 0.05, pitch: 0, curvature: 2.08 / (2 * Math.PI * 1.4) }

export const VR_PANEL_REACH: Record<VrMovablePanel, readonly [number, number]> = { screen: [0.6, 3.5], deck: [0.5, 1.2] }

export const VR_SCREEN_MAX_WIDTH = 3840

export const VR_POINTING = { angle: 35, leaveAngle: 40, reach: 2, stillMs: 4000, moveM: 0.01, moveDeg: 3, downMs: 600 } as const

export const VR_FADE_MS = 200

export const VR_PANEL_HOLD = { ms: 600, slop: 24 } as const

export const VR_DECK_IDLE_MS = 2500

export const VR_DECK_PEEK_MS = 1500

export const VR_SHORTCUTS = ['playPause', 'seekBack', 'seekForward', 'volumeUp', 'volumeDown', 'controls', 'back', 'stop', 'pointLeft', 'pointRight', 'releaseLeft', 'releaseRight', 'gripLeft', 'gripRight', 'gripReleaseLeft', 'gripReleaseRight'] as const
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
