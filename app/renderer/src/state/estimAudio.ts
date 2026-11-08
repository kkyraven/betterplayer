import { create } from 'zustand'
import type { EstimAudioDevice, EstimAudioState } from 'bp-engine'
import { AUDIO_VOLUME_STEP } from '@shared/headsetToys'
import { estimAudioPlan } from '@shared/estimAudio'
import { isUrl } from '@shared/remote'
import type { EstimAudioVideo } from '@shared/settings'
import { engine } from '@/engine/client'
import { invoke } from '@/ipc'
import { audioOutputOf, useDevices } from './devices'

interface EstimAudioStore {
  devices: EstimAudioDevice[] | null
  state: EstimAudioState
  current: { media: string; found: string | null; video: EstimAudioVideo | undefined } | null
  readDevices: () => void
  update: (state: EstimAudioState) => void
}

export const useEstimAudio = create<EstimAudioStore>()((set) => ({
  devices: null,
  state: { status: 'off' },
  current: null,
  readDevices: () => {
    let devices: EstimAudioDevice[] = []
    try {
      devices = engine.estimAudioDevices()
    } catch (error) {
      console.warn('estim audio devices', error)
    }
    set((s) => (s.devices && JSON.stringify(s.devices) === JSON.stringify(devices) ? s : { devices }))
  },
  update: (state) => set((s) => (s.state.status === state.status && s.state.error === state.error ? s : { state })),
}))

let searches = 0

export function stepEstimAudioVolume(sign: 1 | -1) {
  const devices = useDevices.getState()
  const output = audioOutputOf(devices.outputs)
  if (!output) return
  const volume = output.config.volume ?? 1
  const next = Math.round(Math.max(0, Math.min(1, volume + sign * AUDIO_VOLUME_STEP)) * 100) / 100
  if (next !== volume) devices.setVolume(output.id, next)
}

export async function loadEstimAudio(media: string, choices: () => EstimAudioVideo | undefined) {
  if (isUrl(media)) return clearEstimAudio()
  const search = ++searches
  const early = choices()
  if (early?.swap) engine.setEstimAudio(estimAudioPlan(media, null, { ...early, file: null }))
  const found = await invoke('estim:find', media).catch(() => null)
  if (search !== searches) return
  const video = choices()
  useEstimAudio.setState({ current: { media, found, video } })
  engine.setEstimAudio(estimAudioPlan(media, found, video))
}

export function pickEstimAudioFile(media: string): Promise<string | null> {
  return invoke('dialog:openEstimAudio', media)
}

export function applyEstimAudio(media: string, video: EstimAudioVideo | undefined) {
  const current = useEstimAudio.getState().current
  if (current?.media !== media) return
  useEstimAudio.setState({ current: { ...current, video } })
  engine.setEstimAudio(estimAudioPlan(media, current.found, video))
}

export function clearEstimAudio() {
  searches++
  useEstimAudio.setState({ current: null })
  engine.setEstimAudio(null)
}

export function estimAudioOn(): boolean {
  const { current } = useEstimAudio.getState()
  return Boolean(audioOutputOf(useDevices.getState().outputs) && current && estimAudioPlan(current.media, current.found, current.video))
}

export function estimAudioLive(): boolean {
  const { status } = useEstimAudio.getState().state
  return status === 'ready' || status === 'playing'
}
