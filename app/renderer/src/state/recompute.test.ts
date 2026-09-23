import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutputState } from 'bp-engine'
import { defaultTrackAxes, defaultTrackingDefaults } from '@shared/tracking'

const ipc = vi.hoisted(() => ({ invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>() }))
const eng = vi.hoisted(() => ({
  generate: vi.fn<() => Promise<{ axis: string; suffix: string; actions: number; durationMs: number; json: string }[]>>(),
  generateState: vi.fn(() => ({ status: 'idle', timeMs: 0, durationMs: 0 })),
  generateCancel: vi.fn(),
  setGenerated: vi.fn(),
  beatState: vi.fn(() => ({ status: 'ready', fullStatus: 'ready', bpm: 120 })),
  play: vi.fn(),
  pause: vi.fn(),
}))
vi.mock('@/ipc', () => ({ invoke: ipc.invoke, on: () => () => {} }))
vi.mock('@/engine/client', () => ({ engine: eng, version: () => '0.0.1', applyEnhance: vi.fn(), warm: vi.fn(), models: () => [], axes: () => ['L0', 'L1', 'L2', 'R0', 'R1', 'R2'].map((id) => ({ id })) }))
vi.mock('./audio', () => ({ releaseAudio: vi.fn(), ensureFullAudio: vi.fn(() => Promise.resolve()), ensureAudio: vi.fn(() => Promise.resolve()), forgetAudio: vi.fn() }))

import { settingsHash, waitForAudio } from './generated'
import { useDevices } from './devices'
import { usePlayer } from './player'
import { useRecompute } from './recompute'
import { useTracking } from './tracking'

let PATH = ''
let n = 0
const present = { detector: false, motion: false, music: false }
const output = (id: number, kind: 'howl' | 'serial', status = 'connected') => ({
  output: { id, config: { kind, profile: 'stroker' as const } },
  state: { id, kind, address: '', profile: 'stroker', status, error: null, device: null, tcode: null, ramp: null, howl: null, features: [], battery: null } as unknown as OutputState,
})
const scripts = [{ axis: 'L0', suffix: '', actions: 2, durationMs: 1000, json: '{"actions":[{"at":0,"pos":0},{"at":1000,"pos":100}]}' }]

function connect(kind: 'howl' | 'serial' = 'howl') {
  const o = output(1, kind)
  useDevices.setState({ outputs: [o.output], states: { 1: o.state } })
}

beforeEach(() => {
  eng.beatState.mockReturnValue({ status: 'ready', fullStatus: 'ready', bpm: 120 })
  ipc.invoke.mockReset().mockResolvedValue(null)
  eng.generate.mockReset().mockResolvedValue(scripts)
  eng.setGenerated.mockReset()
  eng.generateCancel.mockReset()
  eng.generateState.mockReturnValue({ status: 'idle', timeMs: 0, durationMs: 0 })
  PATH = `/videos/clip-${++n}.mp4`
  usePlayer.setState({ path: PATH, snapshot: { ...usePlayer.getState().snapshot, loaded: true, paused: false } })
  useTracking.setState({ source: 'player', key: PATH, axes: defaultTrackAxes(), sensitivity: 1, present })
  useDevices.setState({ outputs: [], states: {} })
})

describe('whole-file audio readiness', () => {
  it('waits for the complete analysis even when a playback window is ready', async () => {
    vi.useFakeTimers()
    try {
      eng.beatState.mockReturnValue({ status: 'ready', fullStatus: 'analysing', bpm: 120 })
      let finished = false
      const result = waitForAudio(PATH).then((value) => { finished = true; return value })
      await vi.advanceTimersByTimeAsync(500)
      expect(finished).toBe(false)
      eng.beatState.mockReturnValue({ status: 'ready', fullStatus: 'ready', bpm: 120 })
      await vi.advanceTimersByTimeAsync(250)
      expect(await result).toBe('120 BPM')
    } finally { vi.useRealTimers() }
  })
})

describe('settingsHash', () => {
  it('moves with the tracking setup and the defaults that shape a run', () => {
    const tracking = { axes: defaultTrackAxes(), sensitivity: 1, region: null }
    const defaults = defaultTrackingDefaults()
    const base = settingsHash(tracking, defaults, present, '0.0.1')
    expect(settingsHash({ ...tracking, sensitivity: 1.2 }, defaults, present, '0.0.1')).not.toBe(base)
    expect(settingsHash(tracking, { ...defaults, beatVolumeDepth: true }, present, '0.0.1')).not.toBe(base)
    expect(settingsHash(tracking, { ...defaults, beatBounce: false }, present, '0.0.1')).not.toBe(base)
    expect(settingsHash(tracking, { ...defaults, beatBounceDepth: 0.4 }, present, '0.0.1')).not.toBe(base)
    expect(settingsHash(tracking, { ...defaults, beatBounceSpeed: 5 }, present, '0.0.1')).not.toBe(base)
    expect(settingsHash(tracking, defaults, { ...present, motion: true }, '0.0.1')).not.toBe(base)
    expect(settingsHash(tracking, defaults, present, '0.0.2')).not.toBe(base)
    expect(settingsHash(tracking, { ...defaults, showBox: false, motionDefault: false }, present, '0.0.1')).toBe(base)
    expect(settingsHash({ ...tracking, regionTarget: undefined }, defaults, present, '0.0.1')).toBe(base)
  })
})

describe('recompute', () => {
  it('does nothing without a hosted output', async () => {
    connect('serial')
    await useRecompute.getState().check()
    expect(eng.generate).not.toHaveBeenCalled()
    expect(ipc.invoke).not.toHaveBeenCalledWith('generated:get', expect.anything())
  })

  it('runs once for a setup and again only when the setup changes', async () => {
    connect()
    await useRecompute.getState().check()
    expect(eng.generate).toHaveBeenCalledTimes(1)
    expect(eng.setGenerated).toHaveBeenLastCalledWith([{ axis: 'L0', json: scripts[0]?.json }])
    expect(ipc.invoke).toHaveBeenCalledWith('generated:put', PATH, expect.any(String), [{ axis: 'L0', json: scripts[0]?.json }])
    expect(eng.pause).toHaveBeenCalled()
    expect(eng.play).toHaveBeenCalled()
    usePlayer.setState({ video: { globalOffsetMs: 40, axes: {} } })
    await useRecompute.getState().check()
    expect(eng.generate).toHaveBeenCalledTimes(1)
    useTracking.setState({ sensitivity: 1.4 })
    await useRecompute.getState().check()
    expect(eng.generate).toHaveBeenCalledTimes(2)
  })

  it('installs a saved result with a matching hash without a run', async () => {
    connect()
    const rows = [{ axis: 'L0', json: '{"actions":[]}' }]
    ipc.invoke.mockImplementation((channel, _key) => {
      if (channel !== 'generated:get') return Promise.resolve(null)
      return Promise.resolve({ hash: hashNow(), scripts: rows })
    })
    await useRecompute.getState().check()
    expect(eng.generate).not.toHaveBeenCalled()
    expect(eng.setGenerated).toHaveBeenCalledWith(rows)
    expect(useRecompute.getState().busy).toBe(false)
  })

  it('leaves a cancelled run alone until the setup changes', async () => {
    connect()
    eng.generate.mockRejectedValueOnce(new Error('cancelled'))
    eng.generateState.mockReturnValue({ status: 'cancelled', timeMs: 0, durationMs: 0 })
    await useRecompute.getState().check()
    expect(eng.generate).toHaveBeenCalledTimes(1)
    expect(eng.setGenerated.mock.calls.every((c) => Array.isArray(c[0]) && c[0].length === 0)).toBe(true)
    await useRecompute.getState().check()
    expect(eng.generate).toHaveBeenCalledTimes(1)
    useTracking.setState({ axes: { ...defaultTrackAxes(), R0: { ...defaultTrackAxes().R0, source: 'video' } } })
    await useRecompute.getState().check()
    expect(eng.generate).toHaveBeenCalledTimes(2)
  })
})

function hashNow(): string {
  const t = useTracking.getState()
  const { axes, sensitivity, region, regionSource, regionTarget, beatTempoFactor, pace, heroZone, heroDirection, heroColours, heroAxisColours } = t
  return settingsHash({ axes, sensitivity, region, regionSource, ...(regionTarget ? { regionTarget } : {}), beatTempoFactor, pace, heroZone, heroDirection, heroColours, heroAxisColours }, defaultTrackingDefaults(), present, '0.0.1')
}
