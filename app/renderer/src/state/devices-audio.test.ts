import { beforeEach, expect, it, vi } from 'vitest'
import type { OutputState } from 'bp-engine'
import { defaultSettings, type OutputConfig } from '@shared/settings'

const native = vi.hoisted(() => ({
  connect: vi.fn(() => 1),
  disconnect: vi.fn(),
  setPishockEnabled: vi.fn(),
  setOutputDelay: vi.fn(),
  testOutput: vi.fn(),
  setLive: vi.fn(),
  setEstimAudioOutput: vi.fn(),
  estimAudioDevices: vi.fn(() => [{ name: 'wasapi/{x}', description: 'USB Audio' }]),
  estimAudioState: vi.fn(() => ({ status: 'idle' })),
}))
vi.mock('@/engine/client', () => ({ engine: native }))
vi.mock('./account', () => ({ isPremium: () => false, useAccount: { getState: () => ({}), subscribe: vi.fn() } }))
vi.mock('./params', () => ({ pushParams: vi.fn() }))
vi.mock('./live', () => ({ subscribe: vi.fn() }))
vi.mock('./usage', () => ({ track: vi.fn() }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./settings', async () => {
  const { create } = await import('zustand')
  return { useSettings: create(() => ({ settings: defaultSettings(), update: vi.fn().mockResolvedValue(undefined), updateDebounced: vi.fn() })) }
})
import { useSettings } from './settings'
import { isEngineOutput, outputName, testMove, useDevices } from './devices'

const audio: OutputConfig = { id: 'audio', kind: 'audio', profile: 'stroker', device: 'wasapi/{x}', label: 'USB Audio', delayMs: -40, volume: 0.6 }
const serial: OutputConfig = { id: 'serial', kind: 'serial', profile: 'stroker', path: 'COM3' }
const serialState: OutputState = { id: 1, kind: 'serial', address: 'COM3', profile: 'stroker', status: 'connected', features: [], sentValues: {} }
const audioId = () => useDevices.getState().outputs.find((o) => o.config.kind === 'audio')?.id ?? -1

beforeEach(() => {
  useDevices.setState({ outputs: [], states: {}, selectedId: null })
  vi.clearAllMocks()
})

it('pushes the sound output to the engine instead of connecting it, and shows its state', () => {
  useDevices.getState().connectSaved([serial, audio])
  expect(native.connect).toHaveBeenCalledOnce()
  expect(native.setEstimAudioOutput).toHaveBeenCalledWith({ device: 'wasapi/{x}', delayMs: -40, volume: 0.6 })
  const [toy, sound] = useDevices.getState().outputs
  expect(toy && isEngineOutput(toy)).toBe(true)
  expect(sound && isEngineOutput(sound)).toBe(false)
  expect(useDevices.getState().states[audioId()]).toMatchObject({ kind: 'audio', address: 'USB Audio', status: 'connected' })
  expect(outputName(audio)).toBe('estimAudio.name')
})

it("maps the engine's estim audio status onto the output and keeps it when the engine's outputs change", () => {
  useDevices.getState().connectSaved([serial, audio])
  const id = audioId()
  const { setAudioState, setStates } = useDevices.getState()
  setAudioState({ status: 'missing' })
  expect(useDevices.getState().states[id]?.status).toBe('connecting')
  setAudioState({ status: 'error', error: 'device busy' })
  expect(useDevices.getState().states[id]).toMatchObject({ status: 'error', error: 'device busy' })
  setAudioState({ status: 'playing' })
  expect(useDevices.getState().states[id]).toMatchObject({ status: 'connected', error: undefined })
  const before = useDevices.getState().states
  setAudioState({ status: 'ready' })
  expect(useDevices.getState().states).toBe(before)
  setStates([serialState])
  expect(useDevices.getState().states[1]).toBe(serialState)
  expect(useDevices.getState().states[id]?.status).toBe('connected')
})

it('turns the engine output off when removed and drops its state', async () => {
  useDevices.getState().connectSaved([audio])
  const id = audioId()
  await useDevices.getState().remove(id)
  expect(native.setEstimAudioOutput).toHaveBeenLastCalledWith({ device: undefined, delayMs: 0, volume: 1 })
  expect(native.disconnect).not.toHaveBeenCalled()
  expect(useDevices.getState().outputs).toEqual([])
  expect(useDevices.getState().states[id]).toBeUndefined()
})

it('reconnects by reading the sound outputs again and pushing it, keeping its id', () => {
  useDevices.getState().connectSaved([audio])
  const id = audioId()
  native.setEstimAudioOutput.mockClear()
  useDevices.getState().reconnect(id)
  expect(audioId()).toBe(id)
  expect(native.estimAudioDevices).toHaveBeenCalled()
  expect(native.setEstimAudioOutput).toHaveBeenCalledWith({ device: 'wasapi/{x}', delayMs: -40, volume: 0.6 })
  expect(native.connect).not.toHaveBeenCalled()
  expect(native.disconnect).not.toHaveBeenCalled()
})

it('pushes its volume in hundredths, its delay and a new sound output, and saves them', async () => {
  useDevices.getState().connectSaved([audio])
  const id = audioId()
  useDevices.getState().setVolume(id, 0.333)
  expect(native.setEstimAudioOutput).toHaveBeenLastCalledWith({ device: 'wasapi/{x}', delayMs: -40, volume: 0.33 })
  useDevices.getState().setDelay(id, 25)
  expect(native.setEstimAudioOutput).toHaveBeenLastCalledWith({ device: 'wasapi/{x}', delayMs: 25, volume: 0.33 })
  expect(native.setOutputDelay).not.toHaveBeenCalled()
  expect(useSettings.getState().updateDebounced).toHaveBeenCalledTimes(2)
  await useDevices.getState().setAudioDevice(id, { name: 'wasapi/{y}', label: 'Speakers' })
  expect(native.setEstimAudioOutput).toHaveBeenLastCalledWith({ device: 'wasapi/{y}', delayMs: 25, volume: 0.33 })
  expect(useDevices.getState().states[id]?.address).toBe('Speakers')
  expect(useDevices.getState().outputs[0]?.config).toMatchObject({ device: 'wasapi/{y}', label: 'Speakers', delayMs: 25, volume: 0.33 })
  expect(useSettings.getState().update).toHaveBeenCalled()
})

it('adds one estim audio output only, and never test-moves it', async () => {
  const id = await useDevices.getState().add(audio)
  expect(native.connect).not.toHaveBeenCalled()
  expect(useDevices.getState().selectedId).toBe(id)
  await expect(useDevices.getState().add({ ...audio, id: 'second' })).rejects.toThrow()
  expect(useDevices.getState().outputs).toHaveLength(1)
  const [output] = useDevices.getState().outputs
  if (output) await testMove(output)
  expect(native.testOutput).not.toHaveBeenCalled()
  expect(native.setLive).not.toHaveBeenCalled()
})
