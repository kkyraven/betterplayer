import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowState, OutputState } from 'bp-engine'
import { AXIS_IDS } from '@shared/axes'
import type { IpcEvents } from '@shared/ipc'
import type { QuestToys } from '@shared/quest'
import { defaultAxisSettings, type PerVideoSettings, type Settings } from '@shared/settings'

const native = vi.hoisted(() => ({ setAxis: vi.fn(), setGlobalOffsetMs: vi.fn() }))
const listeners = vi.hoisted(() => new Map<string, (payload: unknown) => void>())
const invoke = vi.hoisted(() => vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>())
const flags = vi.hoisted(() => ({ script: [] as string[], derived: [] as string[] }))
vi.mock('@/engine/client', () => ({ engine: native }))
vi.mock('@/ipc', () => ({
  invoke,
  on: (event: string, listener: (payload: unknown) => void) => {
    listeners.set(event, listener)
    return () => listeners.delete(event)
  },
}))
vi.mock('./live', () => ({ FLAG_SCRIPT: 1, FLAG_DERIVED: 2, axisIdsWith: (mask: number) => [...(mask & 1 ? flags.script : []), ...(mask & 2 ? flags.derived : [])] }))
vi.mock('./follow', async () => ({ useFollow: (await import('zustand')).create(() => ({ kind: 'heresphere', host: '', state: null, matched: null })) }))
vi.mock('./devices', async () => ({
  useDevices: (await import('zustand')).create(() => ({ outputs: [], states: {}, reconnect: vi.fn() })),
  outputName: (config: { name?: string }) => config.name ?? '',
}))
vi.mock('./player', async () => ({ usePlayer: (await import('zustand')).create(() => ({ snapshot: { flagsVersion: 0 } })) }))
vi.mock('./settings', async () => ({ useSettings: (await import('zustand')).create(() => ({ settings: null })) }))

const DEFAULTS = { ...Object.fromEntries(AXIS_IDS.map((id) => [id, defaultAxisSettings(id)])), L0: { ...defaultAxisSettings('L0'), amplitude: 0.8 } } as Settings['axesDefault']
const amplitude = (value: number) => ({ ...defaultAxisSettings('L0'), amplitude: value })

describe('videoToys', () => {
  it('shows the first shown axis: its override, else its default', async () => {
    const { videoToys } = await import('./questToys')
    const video: PerVideoSettings = { globalOffsetMs: -40, axes: { L0: amplitude(1.5) } }
    expect(videoToys(12, video, ['L0', 'R0'], DEFAULTS)).toEqual({ mediaId: 12, intensity: 1.5, offsetMs: -40 })
    expect(videoToys(12, { ...video, axes: {} }, ['L0'], DEFAULTS).intensity).toBe(0.8)
    expect(videoToys(12, video, [], DEFAULTS).intensity).toBe(1)
  })
})

describe('withToyCommand', () => {
  it('moves every scripted axis by the same step, floored at 0, and sets the offset', async () => {
    const { withToyCommand } = await import('./questToys')
    const video: PerVideoSettings = { globalOffsetMs: 0, axes: { R0: amplitude(0.2) }, position: 9_000 }
    const next = withToyCommand(video, { kind: 'intensity', mediaId: 12, value: 0.5 }, ['L0', 'R0'], 0.8, DEFAULTS)
    expect(next.axes.L0?.amplitude).toBe(0.5)
    expect(next.axes.R0?.amplitude).toBe(0)
    expect(next.position).toBe(9_000)
    expect(withToyCommand(video, { kind: 'offset', mediaId: 12, ms: 250 }, ['L0'], 1, DEFAULTS)).toEqual({ ...video, globalOffsetMs: 250 })
  })
})

describe('startQuestToys', () => {
  const QUEST = '192.168.1.40'
  const TWELVE = 'D:/v/Twelve.mp4'
  const PLAYING: FollowState = { kind: 'quest', address: `${QUEST}:23554`, status: 'connected', path: 'http://192.168.1.10:8420/media/12', playing: true, timeMs: 0, durationMs: 0, rate: 1 }
  let saved: Record<string, PerVideoSettings>
  const settle = () => new Promise((done) => setImmediate(done))
  const lastToys = () => invoke.mock.calls.filter(([channel]) => channel === 'remote:toys').at(-1)
  const published = () => lastToys()?.[1] as QuestToys | undefined
  const send = (command: IpcEvents['headset:toys']) => listeners.get('headset:toys')?.(command)

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    listeners.clear()
    Object.assign(flags, { script: ['L0', 'R0'], derived: [] })
    saved = { [TWELVE]: { globalOffsetMs: 40, axes: { L0: amplitude(1.5) }, position: 9_000 } }
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'video:get') return saved[String(args[0])] ?? null
      if (channel === 'video:set') saved[String(args[0])] = args[1] as PerVideoSettings
      return null
    })
  })

  it("publishes the toys and applies only the followed Quest's changes to its video", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { useFollow } = await import('./follow')
    const { useDevices } = await import('./devices')
    const { useSettings } = await import('./settings')
    useSettings.setState({ settings: { axesDefault: DEFAULTS } as Settings })
    useDevices.setState({ outputs: [{ id: 3, config: { id: 'h1', kind: 'handy', profile: 'stroker', name: 'Handy' } }], states: { 3: { status: 'connected' } as OutputState } })
    const { startQuestToys } = await import('./questToys')
    startQuestToys()
    expect(published()).toEqual({ outputs: [{ id: 'h1', name: 'Handy', connected: true }], video: null })
    expect(lastToys()?.[2]).toBeNull()

    useFollow.setState({ kind: 'quest', host: QUEST, state: PLAYING })
    useFollow.setState({ matched: { path: TWELVE, title: 'Twelve' } })
    await settle()
    expect(published()?.video).toEqual({ mediaId: 12, intensity: 1.5, offsetMs: 40 })
    expect(lastToys()?.[2]).toBe(QUEST)

    send({ kind: 'intensity', mediaId: 12, value: 1, host: '192.168.1.41' })
    send({ kind: 'offset', mediaId: 13, ms: 0, host: QUEST })
    expect(native.setAxis).not.toHaveBeenCalled()
    expect(native.setGlobalOffsetMs).not.toHaveBeenCalled()

    send({ kind: 'intensity', mediaId: 12, value: 1.2, host: QUEST })
    send({ kind: 'offset', mediaId: 12, ms: -100, host: QUEST })
    expect(native.setAxis).toHaveBeenCalledWith('L0', amplitude(1.2))
    expect(native.setAxis).toHaveBeenCalledWith('R0', { ...defaultAxisSettings('R0'), amplitude: 0.7 })
    expect(native.setGlobalOffsetMs).toHaveBeenCalledWith(-100)
    expect(published()?.video).toEqual({ mediaId: 12, intensity: 1.2, offsetMs: -100 })

    saved[TWELVE] = { ...saved[TWELVE]!, position: 20_000 }
    expect(invoke).not.toHaveBeenCalledWith('video:set', TWELVE, expect.anything())
    vi.advanceTimersByTime(300)
    await settle()
    expect(saved[TWELVE]).toEqual({ globalOffsetMs: -100, axes: { L0: amplitude(1.2), R0: { ...defaultAxisSettings('R0'), amplitude: 0.7 } }, position: 20_000 })

    send({ kind: 'reconnect', id: 'h1', host: '192.168.1.41' })
    expect(useDevices.getState().reconnect).toHaveBeenCalledWith(3)

    useFollow.setState({ state: null, matched: null })
    await settle()
    expect(published()?.video).toBeNull()
    vi.useRealTimers()
  })
})
