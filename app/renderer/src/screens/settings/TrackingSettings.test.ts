import { expect, it, vi } from 'vitest'
import { TRACK_AXIS_IDS, defaultTrackingDefaults } from '@shared/tracking'

vi.mock('@/ipc', () => ({ invoke: vi.fn(), on: vi.fn() }))
vi.mock('@/engine/client', () => ({ models: () => [] }))
vi.mock('@/state/tracking', () => ({ useTracking: vi.fn() }))
import { advancedCustom } from './TrackingSettings'

it('Custom: a legacy Beat table is not custom, an axis switched off is', () => {
  const legacy = defaultTrackingDefaults()
  for (const id of TRACK_AXIS_IDS) if (legacy.axes[id].source !== 'off') legacy.axes[id].source = 'beat'
  legacy.fill = 'beat'
  expect(advancedCustom(defaultTrackingDefaults())).toBe(false)
  expect(advancedCustom(legacy)).toBe(false)
  legacy.axes.L2.source = 'off'
  expect(advancedCustom(legacy)).toBe(true)
})
