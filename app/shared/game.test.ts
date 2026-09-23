// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { expect, it } from 'vitest'
import { gameAxes, gameSource, supportsGameSystemAudio } from './game'
import { defaultTrackAxes, TRACK_AXIS_IDS } from './tracking'

it('picks Beat for a rhythm game and lets AI decide a motion game', () => {
  expect(gameSource('rhythm', true)).toBe('beat')
  expect(gameSource('rhythm', false)).toBe('beat')
  expect(gameSource('motion', true)).toBe('ai-motion')
  expect(gameSource('motion', false)).toBe('video')
})

it('puts every tracked axis on the source and leaves off axes off', () => {
  const axes = gameAxes(defaultTrackAxes(), 'beat')
  expect(axes.L0.source).toBe('beat')
  expect(axes.L1.source).toBe('beat')
  expect(axes.R0.source).toBe('off')
  expect(axes.L1.intensity).toBe(defaultTrackAxes().L1.intensity)
})

it('keeps custom limits and motion settings without changing the saved defaults', () => {
  const defaults = defaultTrackAxes()
  defaults.L0 = { source: 'hero', intensity: 0.7, min: 0.2, max: 0.6, smoothingMs: 180, invert: true }
  defaults.L2.source = 'off'
  const saved = structuredClone(defaults)
  const axes = gameAxes(defaults, 'ai-motion')

  for (const id of TRACK_AXIS_IDS) {
    expect(axes[id]).toEqual({ ...saved[id], source: saved[id].source === 'off' ? 'off' : 'ai-motion' })
    expect(axes[id]).not.toBe(defaults[id])
  }
  axes.L0.min = 0.4
  expect(defaults).toEqual(saved)
})


it.each([
  ['win32', '10.0.0', true],
  ['darwin', '23.2.0', true],
  ['darwin', '25.0.0', true],
  ['darwin', '23.1.0', false],
  ['darwin', '22.6.0', false],
  ['linux', '6.12.0', false],
] as const)('checks system audio support on %s %s', (platform, release, supported) => {
  expect(supportsGameSystemAudio(platform, release)).toBe(supported)
})
