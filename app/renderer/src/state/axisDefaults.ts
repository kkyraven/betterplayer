import { AXIS_IDS, type AxisId } from '@shared/axes'
import { defaultAxisSettings, type AxisSettings, type PerVideoSettings, type Settings } from '@shared/settings'
import { engine } from '@/engine/client'
import { usePlayer } from './player'
import { useSettings } from './settings'

let followed: PerVideoSettings | null = null

export function pushAxisToEngine(id: AxisId, settings: AxisSettings) {
  if (!usePlayer.getState().video.axes[id] && !followed?.axes[id]) engine.setAxis(id, settings)
}

export function setAxisDefault(id: AxisId, patch: Partial<AxisSettings>, immediate = false) {
  const store = useSettings.getState()
  const next = { ...(store.settings?.axesDefault[id] ?? defaultAxisSettings(id)), ...patch }
  const change = (s: Settings) => ({ ...s, axesDefault: { ...s.axesDefault, [id]: next } })
  if (immediate) void store.update(change)
  else store.updateDebounced(change)
  pushAxisToEngine(id, next)
}

export function applyVideoToEngine(video: PerVideoSettings | null) {
  followed = video
  const defaults = useSettings.getState().settings?.axesDefault
  for (const id of AXIS_IDS) engine.setAxis(id, { ...(defaults?.[id] ?? defaultAxisSettings(id)), ...video?.axes[id] })
  engine.setGlobalOffsetMs(video?.globalOffsetMs ?? 0)
}
