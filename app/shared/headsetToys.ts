export const TOY_INTENSITY_MAX = 2
export const TOY_OFFSET_MAX_MS = 5000
export const COYOTE_STRENGTH_MAX = 200
export const RESTIM_VOLUME_STEP = 0.01
export const AUDIO_VOLUME_STEP = 0.01
export const COYOTE_STRENGTH_STEP = 1

export interface VideoToys {
  intensity: number
  offsetMs: number
  range: { min: number; max: number } | null
}

export type EstimLevel = { kind: 'restim'; volume: number } | { kind: 'audio'; volume: number } | { kind: 'coyote'; id: string; name: string; a: number; b: number }

export interface HeadsetToys {
  outputs: { id: string; name: string; connected: boolean }[]
  video: VideoToys | null
  estim: EstimLevel[]
}

export type EstimChange = 'up' | number

export type HeadsetToyCommand =
  | { kind: 'intensity'; value: number }
  | { kind: 'offset'; ms: number }
  | { kind: 'range'; min: number; max: number }
  | { kind: 'restimVolume'; change: EstimChange }
  | { kind: 'audioVolume'; change: EstimChange }
  | { kind: 'coyote'; id: string; channel: 'a' | 'b'; change: EstimChange }
  | { kind: 'reconnect'; id: string }

export type VideoToyCommand = Extract<HeadsetToyCommand, { kind: 'intensity' | 'offset' | 'range' }>

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const hundredths = (v: number) => Math.round(v * 100) / 100

export function clampToyCommand<C extends HeadsetToyCommand>(command: C): C {
  switch (command.kind) {
    case 'intensity':
      return { ...command, value: hundredths(clamp(command.value, 0, TOY_INTENSITY_MAX)) }
    case 'offset':
      return { ...command, ms: Math.round(clamp(command.ms, -TOY_OFFSET_MAX_MS, TOY_OFFSET_MAX_MS)) }
    case 'range': {
      const min = hundredths(clamp(command.min, 0, 1))
      return { ...command, min, max: Math.max(min, hundredths(clamp(command.max, 0, 1))) }
    }
    case 'restimVolume':
    case 'audioVolume':
      return command.change === 'up' ? command : { ...command, change: hundredths(clamp(command.change, 0, 1)) }
    case 'coyote':
      return command.change === 'up' ? command : { ...command, change: Math.round(clamp(command.change, 0, COYOTE_STRENGTH_MAX)) }
    case 'reconnect':
      return command
  }
}

export function changedLevel(current: number, change: EstimChange, step: number): number {
  return change === 'up' ? current + step : Math.min(current, change)
}
