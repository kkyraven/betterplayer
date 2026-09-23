import { defaultEstim, type EstimSettings, type Settings } from '@shared/settings'
import { engine } from '@/engine/client'
import { useSettings } from './settings'

export function pushEstim(estim: EstimSettings) {
  engine.setEstim({ contrast: estim.contrast, volumeFloor: estim.volumeFloor, volumeMax: estim.volumeMax, volumeBoost: estim.volumeBoost, params: estim.params })
}

export function setEstim(patch: Partial<EstimSettings>, immediate = false) {
  const store = useSettings.getState()
  const next = { ...(store.settings?.estim ?? defaultEstim()), ...patch }
  const change = (s: Settings) => ({ ...s, estim: next })
  if (immediate) void store.update(change)
  else store.updateDebounced(change)
  pushEstim(next)
}
