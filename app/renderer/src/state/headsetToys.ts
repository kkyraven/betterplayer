import type { AxisId } from '@shared/axes'
import { AUDIO_VOLUME_STEP, COYOTE_STRENGTH_STEP, RESTIM_VOLUME_STEP, changedLevel, clampToyCommand, type EstimLevel, type HeadsetToyCommand, type HeadsetToys, type VideoToyCommand, type VideoToys } from '@shared/headsetToys'
import { defaultAxisSettings, type PerVideoSettings, type Settings } from '@shared/settings'
import { audioOutputOf, outputName, useDevices, type ConfiguredOutput } from './devices'
import { setEstim, volumeHeld } from './estim'
import { estimAudioLive } from './estimAudio'
import { useSettings } from './settings'

type Defaults = Settings['axesDefault'] | undefined
export type DeviceToyCommand = Exclude<HeadsetToyCommand, VideoToyCommand>

const axisOf = (id: AxisId, video: PerVideoSettings, defaults: Defaults) => video.axes[id] ?? defaults?.[id] ?? defaultAxisSettings(id)
const outputId = (o: ConfiguredOutput) => o.config.id ?? String(o.id)

export function toyOutputs(): HeadsetToys['outputs'] {
  const { outputs, states } = useDevices.getState()
  return outputs.map((o) => ({ id: outputId(o), name: outputName(o.config), connected: states[o.id]?.status === 'connected' }))
}

function live(kind: 'restim' | 'coyote', output?: ConfiguredOutput): boolean {
  const { outputs, states } = useDevices.getState()
  const connected = (o: ConfiguredOutput) => states[o.id]?.status === 'connected'
  if (kind === 'coyote') return output !== undefined && connected(output)
  return !volumeHeld() && outputs.some((o) => o.config.profile === 'restim' && connected(o))
}

export function estimLevels(): EstimLevel[] {
  const estim = useSettings.getState().settings?.estim
  const { outputs } = useDevices.getState()
  const audio = audioOutputOf(outputs)
  const levels: EstimLevel[] = []
  if (estim && live('restim')) levels.push({ kind: 'restim', volume: estim.volumeMax })
  if (audio && estimAudioLive()) levels.push({ kind: 'audio', volume: audio.config.volume ?? 1 })
  for (const o of outputs) {
    if (o.config.kind === 'coyote' && live('coyote', o)) levels.push({ kind: 'coyote', id: outputId(o), name: outputName(o.config), a: o.config.strengthA ?? 0, b: o.config.strengthB ?? 0 })
  }
  return levels
}

export function videoToys(video: PerVideoSettings, shown: AxisId[], defaults: Defaults): VideoToys {
  const first = shown[0]
  const stroke = shown.includes('L0') ? axisOf('L0', video, defaults) : null
  return {
    intensity: first ? axisOf(first, video, defaults).amplitude : 1,
    offsetMs: video.globalOffsetMs,
    range: stroke ? { min: stroke.min, max: stroke.max } : null,
  }
}

export function withToyCommand(video: PerVideoSettings, command: VideoToyCommand, scripted: AxisId[], intensity: number, defaults: Defaults): PerVideoSettings {
  const c = clampToyCommand(command)
  if (c.kind === 'offset') return { ...video, globalOffsetMs: c.ms }
  if (c.kind === 'range') return { ...video, axes: { ...video.axes, L0: { ...axisOf('L0', video, defaults), min: c.min, max: c.max } } }
  const step = c.value - intensity
  const axes = { ...video.axes }
  for (const id of scripted) {
    const current = axisOf(id, video, defaults)
    axes[id] = { ...current, amplitude: Math.max(0, Math.round((current.amplitude + step) * 100) / 100) }
  }
  return { ...video, axes }
}

export function applyDeviceCommand(command: DeviceToyCommand) {
  const c = clampToyCommand(command)
  const devices = useDevices.getState()
  const output = 'id' in c ? devices.outputs.find((o) => outputId(o) === c.id) : undefined
  switch (c.kind) {
    case 'reconnect':
      if (output) devices.reconnect(output.id)
      return
    case 'restimVolume': {
      const estim = useSettings.getState().settings?.estim
      if (!estim || (c.change === 'up' && !live('restim'))) return
      const volumeMax = Math.round(changedLevel(Math.round(estim.volumeMax * 100) / 100, c.change, RESTIM_VOLUME_STEP) * 100) / 100
      if (volumeMax === estim.volumeMax) return
      return setEstim({ volumeMax, volumeFloor: Math.min(estim.volumeFloor, volumeMax) })
    }
    case 'audioVolume': {
      const audio = audioOutputOf(devices.outputs)
      if (!audio || (c.change === 'up' && !estimAudioLive())) return
      const current = audio.config.volume ?? 1
      const volume = Math.round(Math.min(1, changedLevel(Math.round(current * 100) / 100, c.change, AUDIO_VOLUME_STEP)) * 100) / 100
      if (volume !== current) devices.setVolume(audio.id, volume)
      return
    }
    case 'coyote': {
      if (output?.config.kind !== 'coyote' || (c.change === 'up' && !live('coyote', output))) return
      const a = output.config.strengthA ?? 0
      const b = output.config.strengthB ?? 0
      if (c.channel === 'a') return void devices.setStrength(output.id, changedLevel(a, c.change, COYOTE_STRENGTH_STEP), b)
      return void devices.setStrength(output.id, a, changedLevel(b, c.change, COYOTE_STRENGTH_STEP))
    }
  }
}
