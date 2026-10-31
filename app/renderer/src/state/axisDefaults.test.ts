import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAxisSettings } from '@shared/settings'

const native = vi.hoisted(() => ({ setAxis: vi.fn(), setGlobalOffsetMs: vi.fn() }))
vi.mock('@/engine/client', () => ({ engine: native }))
vi.mock('./player', async () => ({ usePlayer: (await import('zustand')).create(() => ({ video: { globalOffsetMs: 0, axes: {} } })) }))
vi.mock('./settings', async () => ({ useSettings: (await import('zustand')).create(() => ({ settings: null })) }))

const amplitude = (value: number) => ({ ...defaultAxisSettings('L0'), amplitude: value })

describe('pushAxisToEngine', () => {
  beforeEach(() => vi.clearAllMocks())

  it("keeps a followed video's own axis when a default changes, until the follow ends", async () => {
    const { applyVideoToEngine, pushAxisToEngine } = await import('./axisDefaults')
    applyVideoToEngine({ globalOffsetMs: 0, axes: { L0: amplitude(1.5) } })
    native.setAxis.mockClear()
    pushAxisToEngine('L0', amplitude(0.5))
    pushAxisToEngine('R0', defaultAxisSettings('R0'))
    expect(native.setAxis.mock.calls).toEqual([['R0', defaultAxisSettings('R0')]])

    applyVideoToEngine(null)
    native.setAxis.mockClear()
    pushAxisToEngine('L0', amplitude(0.5))
    expect(native.setAxis).toHaveBeenCalledWith('L0', amplitude(0.5))
  })
})
