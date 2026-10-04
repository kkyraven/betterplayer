// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import type { AxisId } from '@shared/axes'
import { painOutput, windowAround, type PleasurePain } from '@shared/dom'
import { defaultAxisSettings, type AxisSettings, type ParamAxisId } from '@shared/settings'
import { engine } from '@/engine/client'
import { holdEstim } from '@/state/estim'
import { holdParams, plainParam } from '@/state/params'
import { usePlayer } from '@/state/player'
import { useSettings } from '@/state/settings'

function plainAxis(id: AxisId): AxisSettings {
  return usePlayer.getState().video.axes[id] ?? useSettings.getState().settings?.axesDefault[id] ?? defaultAxisSettings(id)
}

let ranges: Partial<Record<AxisId, [number, number]>> = {}

export function applyLevel(pp: PleasurePain, level: number) {
  const out = painOutput(pp, level)
  const next: Partial<Record<AxisId, [number, number]>> = { ...out.spans }
  const idle: Partial<Record<ParamAxisId, number>> = {}
  for (const id of ['C0', 'P0'] as const) {
    const v = out.points[id]
    if (v === undefined) continue
    next[id] = windowAround(v)
    if (plainParam(id).source === 'restim') idle[id] = 0.5
  }
  holdParams(idle)
  holdEstim({ volume: out.points.volume === undefined ? null : windowAround(out.points.volume), params: next.C0 !== undefined || next.P0 !== undefined })
  for (const id of Object.keys(ranges) as AxisId[]) if (!next[id]) engine.setAxis(id, { ...plainAxis(id), enabled: engine.axisSettings(id).enabled })
  ranges = next
  reapplyRanges()
}

export function reapplyRanges() {
  for (const [id, range] of Object.entries(ranges) as Array<[AxisId, [number, number]]>) {
    engine.setAxis(id, { ...plainAxis(id), enabled: engine.axisSettings(id).enabled, min: range[0], max: range[1] })
  }
}

export function releaseLevel() {
  holdParams({})
  holdEstim(null)
  for (const id of Object.keys(ranges) as AxisId[]) engine.setAxis(id, { ...plainAxis(id), enabled: engine.axisSettings(id).enabled })
  ranges = {}
}
