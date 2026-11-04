import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AXIS_IDS } from '@shared/axes'
import type { OutputState } from 'bp-engine'
import { defaultAxisSettings, defaultEstim, type PerVideoSettings, type Settings } from '@shared/settings'

const setEstim = vi.hoisted(() => vi.fn())
const held = vi.hoisted(() => ({ volume: false }))
vi.mock('@/engine/client', () => ({ engine: {} }))
vi.mock('./estim', () => ({ setEstim, volumeHeld: () => held.volume }))
vi.mock('./devices', async () => ({
  useDevices: (await import('zustand')).create(() => ({ outputs: [], states: {}, reconnect: vi.fn(), setStrength: vi.fn(async () => undefined) })),
  outputName: (config: { name?: string }) => config.name ?? '',
}))
vi.mock('./settings', async () => ({ useSettings: (await import('zustand')).create(() => ({ settings: null })) }))

const DEFAULTS = { ...Object.fromEntries(AXIS_IDS.map((id) => [id, defaultAxisSettings(id)])), L0: { ...defaultAxisSettings('L0'), amplitude: 0.8 } } as Settings['axesDefault']
const amplitude = (value: number) => ({ ...defaultAxisSettings('L0'), amplitude: value })

describe('videoToys', () => {
  it('shows the first shown axis: its override, else its default, and the stroke range while L0 is shown', async () => {
    const { videoToys } = await import('./headsetToys')
    const video: PerVideoSettings = { globalOffsetMs: -40, axes: { L0: { ...amplitude(1.5), min: 0.1, max: 0.85 } } }
    expect(videoToys(video, ['L0', 'R0'], DEFAULTS)).toEqual({ intensity: 1.5, offsetMs: -40, range: { min: 0.1, max: 0.85 } })
    expect(videoToys({ ...video, axes: {} }, ['L0'], DEFAULTS).intensity).toBe(0.8)
    expect(videoToys(video, ['EV'], DEFAULTS).range).toBeNull()
    expect(videoToys(video, [], DEFAULTS).intensity).toBe(1)
  })
})

describe('withToyCommand', () => {
  it('moves every scripted axis by the same step, floored at 0, and sets the offset and stroke range', async () => {
    const { withToyCommand } = await import('./headsetToys')
    const video: PerVideoSettings = { globalOffsetMs: 0, axes: { R0: amplitude(0.2) }, position: 9_000 }
    const next = withToyCommand(video, { kind: 'intensity', value: 0.5 }, ['L0', 'R0'], 0.8, DEFAULTS)
    expect(next.axes.L0?.amplitude).toBe(0.5)
    expect(next.axes.R0?.amplitude).toBe(0)
    expect(next.position).toBe(9_000)
    expect(withToyCommand(video, { kind: 'offset', ms: 250 }, ['L0'], 1, DEFAULTS)).toEqual({ ...video, globalOffsetMs: 250 })
    expect(withToyCommand(video, { kind: 'range', min: 0.6, max: 0.4 }, ['L0'], 1, DEFAULTS).axes.L0).toEqual({ ...amplitude(0.8), min: 0.6, max: 0.6 })
  })
})

describe('applyDeviceCommand', () => {
  const connected = { status: 'connected' } as OutputState
  beforeEach(() => {
    vi.resetModules()
    setEstim.mockClear()
    held.volume = false
  })

  it('raises an estim level one step for each up and lowers it no further than asked, never up', async () => {
    const { useSettings } = await import('./settings')
    const { useDevices } = await import('./devices')
    useSettings.setState({ settings: { estim: { ...defaultEstim(), volumeFloor: 0.5, volumeMax: 0.62 } } as Settings })
    useDevices.setState({
      outputs: [
        { id: 1, config: { kind: 'websocket', profile: 'restim' } },
        { id: 4, config: { id: 'c1', kind: 'coyote', profile: 'stroker', strengthA: 40, strengthB: 35 } },
      ],
      states: { 1: connected, 4: connected },
    })
    const { applyDeviceCommand } = await import('./headsetToys')

    applyDeviceCommand({ kind: 'restimVolume', change: 'up' })
    expect(setEstim).toHaveBeenLastCalledWith({ volumeMax: 0.63, volumeFloor: 0.5 })
    applyDeviceCommand({ kind: 'restimVolume', change: 0.9 })
    expect(setEstim).toHaveBeenCalledTimes(1)
    applyDeviceCommand({ kind: 'restimVolume', change: 0.3 })
    expect(setEstim).toHaveBeenLastCalledWith({ volumeMax: 0.3, volumeFloor: 0.3 })

    applyDeviceCommand({ kind: 'coyote', id: 'c1', channel: 'a', change: 'up' })
    expect(useDevices.getState().setStrength).toHaveBeenLastCalledWith(4, 41, 35)
    applyDeviceCommand({ kind: 'coyote', id: 'c1', channel: 'b', change: 60 })
    expect(useDevices.getState().setStrength).toHaveBeenLastCalledWith(4, 40, 35)
    applyDeviceCommand({ kind: 'coyote', id: 'c1', channel: 'b', change: 10 })
    expect(useDevices.getState().setStrength).toHaveBeenLastCalledWith(4, 40, 10)
  })

  it('lists and raises only live levels, so nothing waits to arrive at once', async () => {
    const { useSettings } = await import('./settings')
    const { useDevices } = await import('./devices')
    useSettings.setState({ settings: { estim: { ...defaultEstim(), volumeMax: 0.7 } } as Settings })
    useDevices.setState({
      outputs: [
        { id: 1, config: { kind: 'websocket', profile: 'restim', name: 'restim' } },
        { id: 2, config: { id: 'c1', kind: 'coyote', profile: 'stroker', name: 'Coyote', strengthA: 20 } },
        { id: 3, config: { id: 'c2', kind: 'coyote', profile: 'stroker', name: 'Down', strengthA: 20 } },
      ],
      states: { 1: connected, 2: connected },
    })
    const { applyDeviceCommand, estimLevels } = await import('./headsetToys')
    expect(estimLevels()).toEqual([
      { kind: 'restim', volume: 0.7 },
      { kind: 'coyote', id: 'c1', name: 'Coyote', a: 20, b: 0 },
    ])
    vi.mocked(useDevices.getState().setStrength).mockClear()
    applyDeviceCommand({ kind: 'coyote', id: 'c2', channel: 'a', change: 'up' })
    expect(useDevices.getState().setStrength).not.toHaveBeenCalled()
    held.volume = true
    expect(estimLevels().map((l) => l.kind)).toEqual(['coyote'])
    applyDeviceCommand({ kind: 'restimVolume', change: 'up' })
    expect(setEstim).not.toHaveBeenCalled()
  })
})
