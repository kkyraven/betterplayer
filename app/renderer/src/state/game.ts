// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { create } from 'zustand'
import { CAPTURE_WIDTH } from '@shared/browser'
import { SYSTEM_AUDIO, gameAxes, gameSource, supportsGameSystemAudio, type GameKind, type GameSource } from '@shared/game'
import { engine } from '@/engine/client'
import { invoke } from '@/ipc'
import { osRelease, platform } from '@/node'
import { isPremium, useAccount } from './account'
import { t } from './i18n'
import { usePlayer } from './player'
import { useSettings } from './settings'
import { useTracking } from './tracking'
import { useUi } from './ui'
import { track } from './usage'

const BEAT_RATE = 22050
const AUDIO_CHUNK = 1024

export interface AudioDevice {
  id: string
  label: string
}

interface GameStore {
  sources: GameSource[]
  screenAccess: boolean
  pickedId: string | null
  audioDevices: AudioDevice[]
  audioId: string
  starting: boolean
  running: boolean
  stream: MediaStream | null
  error: string | null
  refreshSources: () => Promise<void>
  refreshAudio: () => Promise<void>
  pick: (id: string | null) => void
  setAudio: (id: string) => void
  setKind: (kind: GameKind) => void
  setAi: (ai: boolean) => void
  start: () => Promise<void>
  stop: () => void
}

export const hasSystemAudio = supportsGameSystemAudio(platform, osRelease)

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const useGame = create<GameStore>()((set, get) => {
  let stopCapture: (() => void) | null = null
  let cancelled = false

  const feedFrames = async (stream: MediaStream, clock: { startedAt: number | null }): Promise<() => void> => {
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    let handle = 0
    let stopped = false
    const onFrame = () => {
      if (stopped) return
      if (ctx && video.videoWidth > 0 && clock.startedAt !== null) {
        const w = CAPTURE_WIDTH
        const h = Math.max(2, Math.round((CAPTURE_WIDTH * video.videoHeight) / video.videoWidth / 2) * 2)
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w
          canvas.height = h
        }
        ctx.drawImage(video, 0, 0, w, h)
        const rgba = ctx.getImageData(0, 0, w, h).data
        const gray = new Uint8Array(w * h)
        for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (rgba[j]! * 77 + rgba[j + 1]! * 150 + rgba[j + 2]! * 29) >> 8
        engine.trackFrame(gray, w, h, performance.now() - clock.startedAt, 1)
      }
      handle = video.requestVideoFrameCallback(onFrame)
    }
    try {
      await video.play()
      handle = video.requestVideoFrameCallback(onFrame)
    } catch (error) {
      video.srcObject = null
      throw error
    }
    return () => {
      stopped = true
      video.cancelVideoFrameCallback(handle)
      video.srcObject = null
    }
  }

  const feedAudio = async (stream: MediaStream): Promise<() => void> => {
    const audio = new AudioContext({ sampleRate: BEAT_RATE })
    let source: MediaStreamAudioSourceNode | null = null
    let processor: ScriptProcessorNode | null = null
    let silence: GainNode | null = null
    let beatStarted = false
    const cleanup = () => {
      if (processor) processor.onaudioprocess = null
      source?.disconnect()
      processor?.disconnect()
      silence?.disconnect()
      void audio.close().catch(() => {})
      if (beatStarted) engine.beatClear()
    }
    try {
      source = audio.createMediaStreamSource(stream)
      processor = audio.createScriptProcessor(AUDIO_CHUNK, 1, 1)
      silence = audio.createGain()
      silence.gain.value = 0
      processor.onaudioprocess = (e) => engine.beatLivePush(e.inputBuffer.getChannelData(0))
      source.connect(processor)
      processor.connect(silence)
      silence.connect(audio.destination)
      if (audio.state === 'suspended') await audio.resume()
      beatStarted = true
      engine.beatLiveStart()
      return cleanup
    } catch (error) {
      cleanup()
      throw error
    }
  }

  const audioStream = async (capture: MediaStream): Promise<MediaStream> => {
    const { audioId } = get()
    if (audioId === SYSTEM_AUDIO) {
      if (capture.getAudioTracks().length === 0) throw new Error(t('game.noSystemAudio'))
      return new MediaStream(capture.getAudioTracks())
    }
    return navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: audioId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
  }

  return {
    sources: [],
    screenAccess: true,
    pickedId: null,
    audioDevices: [],
    audioId: hasSystemAudio ? SYSTEM_AUDIO : '',
    starting: false,
    running: false,
    stream: null,
    error: null,
    refreshSources: async () => {
      try {
        const { sources, screenAccess } = await invoke('game:sources')
        const { pickedId } = get()
        set({ sources, screenAccess, pickedId: pickedId && sources.some((s) => s.id === pickedId) ? pickedId : (sources[0]?.id ?? null) })
      } catch (e) {
        set({ sources: [], pickedId: null, error: errorText(e) })
      }
    },
    refreshAudio: async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const audioDevices = devices.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || t('game.audioDevice', { n: i + 1 }) }))
        const { audioId } = get()
        const known = (hasSystemAudio && audioId === SYSTEM_AUDIO) || audioDevices.some((d) => d.id === audioId)
        set({ audioDevices, audioId: known ? audioId : (hasSystemAudio ? SYSTEM_AUDIO : (audioDevices[0]?.id ?? '')) })
      } catch (error) {
        set({ audioDevices: [], audioId: hasSystemAudio ? SYSTEM_AUDIO : '', error: errorText(error) })
      }
    },
    pick: (pickedId) => set({ pickedId }),
    setAudio: (audioId) => set({ audioId }),
    setKind: (kind) => void useSettings.getState().update((s) => ({ ...s, game: { ...s.game, kind } })),
    setAi: (ai) => void useSettings.getState().update((s) => ({ ...s, game: { ...s.game, ai } })),
    start: async () => {
      const { pickedId, running, starting, audioId } = get()
      if (running || starting || !pickedId) return
      if (!isPremium(useAccount.getState())) return
      const settings = useSettings.getState().settings
      if (!settings) return
      const { kind, ai } = settings.game
      const source = gameSource(kind, ai)
      cancelled = false
      set({ error: null, starting: true })
      usePlayer.getState().pause()
      let capture: MediaStream | null = null
      let audio: MediaStream | null = null
      let startedTracking = false
      let completed = false
      let stopFrames: (() => void) | null = null
      let stopAudio: (() => void) | null = null
      try {
        await invoke('game:capture', pickedId)
        if (cancelled) return
        capture = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: kind === 'rhythm' && hasSystemAudio && audioId === SYSTEM_AUDIO })
        if (cancelled) return
        audio = kind === 'rhythm' ? await audioStream(capture) : null
        if (cancelled || !isPremium(useAccount.getState())) return
        startedTracking = true
        await useTracking.getState().start('game', { axes: gameAxes(settings.tracking.axes, source) })
        if (cancelled || useTracking.getState().source !== 'game') return
        const clock = { startedAt: null as number | null }
        stopFrames = await feedFrames(capture, clock)
        if (cancelled || useTracking.getState().source !== 'game') return
        if (audio) stopAudio = await feedAudio(audio)
        if (cancelled || useTracking.getState().source !== 'game') return
        clock.startedAt = performance.now()
        engine.trackPlayback(0, true, 1)
        const ended = () => get().stop()
        const videoTrack = capture.getVideoTracks()[0]
        if (!videoTrack || videoTrack.readyState === 'ended') throw new Error(t('game.captureEnded'))
        const inputTracks = [...new Set([videoTrack, ...(audio?.getAudioTracks() ?? [])])]
        if (inputTracks.some((track) => track.readyState === 'ended')) throw new Error(t('game.captureEnded'))
        for (const track of inputTracks) track.addEventListener('ended', ended)
        stopCapture = () => {
          for (const track of inputTracks) track.removeEventListener('ended', ended)
          stopFrames?.()
          stopAudio?.()
          for (const track of capture?.getTracks() ?? []) track.stop()
          for (const track of audio?.getTracks() ?? []) track.stop()
        }
        completed = true
        set({ running: true, stream: capture })
        track('action.game.start')
        useUi.getState().setScreen('game')
      } catch (e) {
        if (!cancelled) set({ error: errorText(e) })
      } finally {
        if (!completed) {
          stopFrames?.()
          stopAudio?.()
          for (const track of capture?.getTracks() ?? []) track.stop()
          for (const track of audio?.getTracks() ?? []) track.stop()
          void invoke('game:capture', null).catch(() => {})
          if (startedTracking && useTracking.getState().source === 'game') useTracking.getState().stop()
          set({ running: false, stream: null })
        }
        set({ starting: false })
      }
    },
    stop: () => {
      cancelled = true
      if (!get().running && !get().starting) return
      set({ running: false, stream: null })
      stopCapture?.()
      stopCapture = null
      void invoke('game:capture', null).catch(() => {})
      if (useTracking.getState().source === 'game') useTracking.getState().stop()
    },
  }
})

useTracking.subscribe((s, prev) => {
  if (prev.source === 'game' && s.source !== 'game') useGame.getState().stop()
})

useAccount.subscribe((s) => {
  if (!isPremium(s)) useGame.getState().stop()
})
