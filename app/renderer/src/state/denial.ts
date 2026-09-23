// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { create } from 'zustand'
import { AXIS_IDS, type AxisId } from '@shared/axes'
import { denialFires, detectKindIds, restrictDenial } from '@shared/gooner'
import { defaultAxisSettings, defaultDenial, type AxisSettings, type DenialAxis, type DenialSettings } from '@shared/settings'
import { engine } from '@/engine/client'
import { isPremium, useAccount } from './account'
import { useGooner } from './gooner'
import { axisValue } from './live'
import { onPlayback, usePlayer } from './player'
import { useSettings } from './settings'

interface DenialStore {
  denial: DenialSettings
  firing: boolean
  set: (patch: Partial<DenialSettings>) => Promise<void>
}

const POLL_MS = 1000 / 30

export const useDenial = create<DenialStore>()((_set, get) => ({
  denial: defaultDenial(),
  firing: false,
  set: async (patch) => {
    const current = get().denial
    const next = restrictDenial(current, { ...current, ...patch }, useGooner.getState().locked)
    await useSettings.getState().update((s) => ({ ...s, denial: next }))
  },
}))

export const denialActive = () => useDenial.getState().denial.enabled && isPremium(useAccount.getState())

function plainAxis(id: AxisId): AxisSettings {
  return usePlayer.getState().video.axes[id] ?? useSettings.getState().settings?.axesDefault[id] ?? defaultAxisSettings(id)
}

const applied = new Map<AxisId, DenialAxis>()

function engage(id: AxisId, rule: DenialAxis) {
  switch (rule.action) {
    case 'hold':
      engine.setLive(id, axisValue(id))
      break
    case 'zero':
      engine.setLive(id, 0)
      break
    case 'slower': {
      const plain = plainAxis(id)
      engine.setAxis(id, { ...plain, enabled: engine.axisSettings(id).enabled, amplitude: plain.amplitude * (1 - rule.by) })
      break
    }
  }
}

function release(id: AxisId, rule: DenialAxis) {
  if (rule.action === 'slower') engine.setAxis(id, { ...plainAxis(id), enabled: engine.axisSettings(id).enabled })
  else engine.setLive(id, null)
}

function apply(rules: DenialSettings['axes']) {
  for (const id of AXIS_IDS) {
    const want = rules[id]
    const had = applied.get(id)
    if (want?.action === had?.action && want?.by === had?.by) continue
    if (had) release(id, had)
    if (want) {
      engage(id, want)
      applied.set(id, want)
    } else applied.delete(id)
  }
}

function reapply() {
  for (const [id, rule] of applied) if (rule.action === 'slower') engage(id, rule)
}

let lastRuns = 0
let lastSeenAt: number | null = null
let ran = false

function tick() {
  const { denial, firing } = useDenial.getState()
  let fire = false
  if (denialActive()) {
    const run = engine.detectBoxes(detectKindIds(denial.kinds, denial.clothing))
    const now = performance.now()
    if (run.runs !== lastRuns) {
      lastRuns = run.runs
      ran = true
      if (run.boxes.length > 0) lastSeenAt = now
    }
    fire = denialFires(denial, now, lastSeenAt, ran)
  } else {
    ran = false
    lastSeenAt = null
  }
  apply(fire ? denial.axes : {})
  if (fire !== firing) useDenial.setState({ firing: fire })
}

let started = false

export function startDenial() {
  if (started) return
  started = true
  const sync = () => {
    const denial = useSettings.getState().settings?.denial ?? defaultDenial()
    if (useDenial.getState().denial !== denial) useDenial.setState({ denial })
  }
  useSettings.subscribe(sync)
  sync()
  usePlayer.subscribe((s, prev) => {
    if (s.video !== prev.video || s.path !== prev.path) reapply()
  })
  onPlayback((command) => {
    if (command.kind === 'play') reapply()
  })
  useSettings.subscribe((s, prev) => {
    if (s.settings?.axesDefault !== prev.settings?.axesDefault) reapply()
  })
  window.setInterval(tick, POLL_MS)
}
