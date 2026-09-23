// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  display: vi.fn(), microphone: vi.fn(), enumerate: vi.fn(),
  play: vi.fn(async () => {}),
  trackStart: vi.fn(), audioClose: vi.fn(async () => {}),
  engine: { trackPlayback: vi.fn(), trackFrame: vi.fn(), beatLiveStart: vi.fn(), beatLivePush: vi.fn(), beatClear: vi.fn() },
}))
vi.mock('@/engine/client', () => ({ engine: mocks.engine }))
vi.mock('@/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/node', () => ({ platform: 'darwin', osRelease: '25.0.0' }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./account', async () => {
  const { create } = await import('zustand')
  return { isPremium: (s: { premium: boolean }) => s.premium, useAccount: create(() => ({ premium: true })) }
})
vi.mock('./tracking', async () => {
  const { create } = await import('zustand')
  const useTracking = create<{ source: string | null; start: () => Promise<void>; stop: () => void }>((set) => ({
    source: null,
    start: async () => { mocks.trackStart(); set({ source: 'game' }) },
    stop: () => set({ source: null }),
  }))
  return { useTracking }
})
vi.mock('./settings', async () => {
  const { defaultTrackingDefaults } = await import('@shared/tracking')
  return { useSettings: { getState: () => ({ settings: { game: { kind: 'rhythm', ai: true }, tracking: defaultTrackingDefaults() } }) } }
})
vi.mock('./player', () => ({ usePlayer: { getState: () => ({ pause: vi.fn() }) } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ setScreen: vi.fn() }) } }))
vi.mock('./usage', () => ({ track: vi.fn() }))

import { useGame } from './game'
import { useTracking } from './tracking'

function mediaStream(video = false) {
  const track = { stop: vi.fn(), readyState: 'live', addEventListener: vi.fn<(event: string, callback: () => void) => void>(), removeEventListener: vi.fn() }
  return { track, getTracks: () => [track], getVideoTracks: () => video ? [track] : [], getAudioTracks: () => video ? [] : [track] }
}
const capture = mediaStream(true)
const microphone = mediaStream()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.invoke.mockResolvedValue(undefined)
  mocks.display.mockResolvedValue(capture)
  mocks.microphone.mockResolvedValue(microphone)
  mocks.enumerate.mockResolvedValue([])
  mocks.play.mockResolvedValue(undefined)
  mocks.trackStart.mockImplementation(() => {})
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: mocks.display, getUserMedia: mocks.microphone, enumerateDevices: mocks.enumerate } })
  vi.stubGlobal('AudioContext', class {
    destination = {}
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() } }
    createScriptProcessor() { return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null } }
    createGain() { return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } } }
    close() { return mocks.audioClose() }
  })
  vi.stubGlobal('document', { createElement: (tag: string) => tag === 'video' ? {
    play: mocks.play, requestVideoFrameCallback: vi.fn(() => 1), cancelVideoFrameCallback: vi.fn(),
  } : { getContext: () => null } })
  useGame.setState({ pickedId: 'window:1', audioId: 'mic', error: null })
})
afterEach(() => {
  useGame.getState().stop()
  vi.unstubAllGlobals()
})

it('allows only one capture request while startup is pending and cancels before tracking', async () => {
  let resolveCapture!: (value: typeof capture) => void
  mocks.display.mockReturnValue(new Promise((resolve) => { resolveCapture = resolve }))
  const pending = useGame.getState().start()
  await Promise.resolve()
  await useGame.getState().start()
  expect(mocks.display).toHaveBeenCalledOnce()
  useGame.getState().stop()
  resolveCapture(capture)
  await pending
  expect(capture.track.stop).toHaveBeenCalledOnce()
  expect(mocks.trackStart).not.toHaveBeenCalled()
  expect(useGame.getState()).toMatchObject({ running: false, starting: false, stream: null })
})

it('releases the microphone when tracking fails to start', async () => {
  mocks.trackStart.mockImplementation(() => { throw new Error('Tracker failed') })
  await useGame.getState().start()
  expect(capture.track.stop).toHaveBeenCalledOnce()
  expect(microphone.track.stop).toHaveBeenCalledOnce()
  expect(useGame.getState()).toMatchObject({ error: 'Tracker failed', starting: false, running: false })
})

it('reports playback failure and stops the tracker and both streams', async () => {
  mocks.play.mockRejectedValue(new Error('Playback failed'))
  await useGame.getState().start()
  expect(capture.track.stop).toHaveBeenCalledOnce()
  expect(microphone.track.stop).toHaveBeenCalledOnce()
  expect(useTracking.getState().source).toBeNull()
  expect(useGame.getState().error).toBe('Playback failed')
})

it('handles unavailable audio enumeration without an unhandled rejection', async () => {
  mocks.enumerate.mockRejectedValue(new Error('No audio permission'))
  await useGame.getState().refreshAudio()
  expect(useGame.getState()).toMatchObject({ error: 'No audio permission', audioDevices: [], audioId: 'system' })
})

it('starts capture and audio, then releases both when tracking stops elsewhere', async () => {
  await useGame.getState().start()
  expect(useGame.getState()).toMatchObject({ running: true, starting: false, stream: capture })
  expect(mocks.engine.beatLiveStart).toHaveBeenCalledOnce()
  useTracking.getState().stop()
  expect(useGame.getState()).toMatchObject({ running: false, stream: null })
  expect(capture.track.stop).toHaveBeenCalledOnce()
  expect(microphone.track.stop).toHaveBeenCalledOnce()
  expect(mocks.engine.beatClear).toHaveBeenCalledOnce()
})

it('releases a microphone granted after cancellation', async () => {
  let resolveMicrophone!: (value: typeof microphone) => void
  mocks.microphone.mockReturnValue(new Promise((resolve) => { resolveMicrophone = resolve }))
  const pending = useGame.getState().start()
  await vi.waitFor(() => expect(mocks.microphone).toHaveBeenCalledOnce())
  useGame.getState().stop()
  resolveMicrophone(microphone)
  await pending
  expect(microphone.track.stop).toHaveBeenCalledOnce()
  expect(mocks.trackStart).not.toHaveBeenCalled()
  expect(useGame.getState().running).toBe(false)
})

it('closes the audio graph if beat startup fails', async () => {
  mocks.engine.beatLiveStart.mockImplementationOnce(() => { throw new Error('Beat failed') })
  await useGame.getState().start()
  expect(mocks.audioClose).toHaveBeenCalledOnce()
  expect(capture.track.stop).toHaveBeenCalledOnce()
  expect(microphone.track.stop).toHaveBeenCalledOnce()
  expect(useGame.getState()).toMatchObject({ error: 'Beat failed', running: false, starting: false })
})

it('stops the game if the selected audio input disconnects', async () => {
  await useGame.getState().start()
  const onEnded = microphone.track.addEventListener.mock.calls.find(([event]) => event === 'ended')?.[1]
  expect(onEnded).toBeDefined()
  onEnded?.()
  expect(useGame.getState()).toMatchObject({ running: false, stream: null })
  expect(useTracking.getState().source).toBeNull()
  expect(capture.track.stop).toHaveBeenCalledOnce()
  expect(microphone.track.stop).toHaveBeenCalledOnce()
})


it('defaults to system audio on macOS even when only microphones are enumerated', async () => {
  useGame.setState({ audioId: '' })
  mocks.enumerate.mockResolvedValue([{ kind: 'audioinput', deviceId: 'mic', label: 'MacBook microphone' }])
  await useGame.getState().refreshAudio()
  expect(useGame.getState().audioId).toBe('system')
})

it('captures system audio on macOS without opening the microphone', async () => {
  const output = mediaStream()
  mocks.display.mockResolvedValue({ ...capture, getAudioTracks: () => output.getAudioTracks(), getTracks: () => [...capture.getTracks(), ...output.getTracks()] })
  vi.stubGlobal('MediaStream', class {
    constructor(private tracks: ReturnType<typeof output.getTracks>) {}
    getTracks() { return this.tracks }
    getAudioTracks() { return this.tracks }
  })
  useGame.setState({ audioId: 'system' })
  await useGame.getState().start()
  expect(mocks.display).toHaveBeenCalledWith(expect.objectContaining({ audio: true }))
  expect(mocks.microphone).not.toHaveBeenCalled()
  expect(mocks.engine.beatLiveStart).toHaveBeenCalledOnce()
  expect(useGame.getState().running).toBe(true)
})

it('does not request system audio when a microphone is selected', async () => {
  await useGame.getState().start()
  expect(mocks.display).toHaveBeenCalledWith(expect.objectContaining({ audio: false }))
  expect(mocks.microphone).toHaveBeenCalledOnce()
})

it('reports missing system audio without silently switching to the microphone', async () => {
  useGame.setState({ audioId: 'system' })
  await useGame.getState().start()
  expect(useGame.getState()).toMatchObject({ running: false, error: 'game.noSystemAudio' })
  expect(mocks.microphone).not.toHaveBeenCalled()
  expect(capture.track.stop).toHaveBeenCalled()
})
