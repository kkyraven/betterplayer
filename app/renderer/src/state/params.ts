import { useEffect, useState } from 'react'
import type { ParamHold, ParamSource } from 'bp-engine'
import { DETECT_KINDS, PARAM_AXES, defaultParamSource, type ParamAxisId, type ParamSourceSettings } from '@shared/settings'
import { engine } from '@/engine/client'
import { useDevices } from './devices'
import { usePlayer } from './player'
import { useTracking } from './tracking'

const toEngine = (p: ParamSourceSettings): ParamSource => ({
  source: p.source,
  value: p.value,
  provider: p.provider,
  providerPeriodMs: p.providerPeriodMs,
  providerSpeed: p.providerSpeed,
  kinds: [...p.kinds],
  bias: p.bias,
  holdOnCut: p.holdOnCut,
  holdCoverageOver: p.holdCoverageOver ?? undefined,
  jump: p.jump,
})

export function outputParam(axis: ParamAxisId): ParamSourceSettings {
  const output = useDevices.getState().outputs.find((o) => o.config.profile === 'restim')
  return output?.config.params?.[axis] ?? defaultParamSource()
}

export function effectiveParam(axis: ParamAxisId): ParamSourceSettings {
  if (useTracking.getState().source === 'browser') return outputParam(axis)
  return usePlayer.getState().video.params?.[axis] ?? outputParam(axis)
}

export function pushParams() {
  for (const axis of PARAM_AXES) engine.setParamSource(axis, toEngine(effectiveParam(axis)))
}

export interface HoldInfo {
  held: ParamHold | null
  coverage: number
}

export function useParamHold(axis: ParamAxisId, param: ParamSourceSettings): HoldInfo {
  const [info, setInfo] = useState<HoldInfo>({ held: null, coverage: 0 })
  const active = param.source === 'detection'
  const kinds = param.kinds.join(',')
  useEffect(() => {
    if (!active) {
      setInfo({ held: null, coverage: 0 })
      return
    }
    const read = () => {
      const per = engine.trackState().detector.coverage
      const chosen = new Set(kinds.split(','))
      const coverage = Math.min(1, DETECT_KINDS.reduce((sum, k, i) => sum + (chosen.has(k.id) ? (per[i] ?? 0) : 0), 0))
      setInfo({ held: engine.paramHold(axis), coverage })
    }
    read()
    const timer = window.setInterval(read, 1000)
    return () => window.clearInterval(timer)
  }, [active, axis, kinds])
  return info
}
