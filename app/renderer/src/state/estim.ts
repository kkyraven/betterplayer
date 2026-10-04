import { defaultEstim, type EstimSettings, type Settings } from '@shared/settings'
import { engine } from '@/engine/client'
import { useSettings } from './settings'

let hold: { volume: [number, number] | null; params: boolean } | null = null

export function pushEstim(estim: EstimSettings) {
  const [volumeFloor, volumeMax] = hold?.volume ?? [Math.min(estim.volumeFloor, estim.volumeMax), estim.volumeMax]
  engine.setEstim({ contrast: estim.contrast, volumeFloor, volumeMax, volumeBoost: estim.volumeBoost, params: estim.params || (hold?.params ?? false) })
}

export function holdEstim(next: { volume: [number, number] | null; params: boolean } | null) {
  hold = next
  pushEstim(useSettings.getState().settings?.estim ?? defaultEstim())
}

export function setEstim(patch: Partial<EstimSettings>, immediate = false) {
  const store = useSettings.getState()
  const next = { ...(store.settings?.estim ?? defaultEstim()), ...patch }
  const change = (s: Settings) => ({ ...s, estim: next })
  if (immediate) void store.update(change)
  else store.updateDebounced(change)
  pushEstim(next)
}
