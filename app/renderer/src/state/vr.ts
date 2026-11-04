import { create } from 'zustand'
import type { VrError } from '@shared/vr'

interface VrState {
  supported: boolean
  available: boolean
  active: boolean
  starting: boolean
  error: VrError | null
  hmdName: string
  offer: boolean
  showOffer: () => void
  hideOffer: () => void
  start: () => Promise<void>
  stop: () => void
  clearError: () => void
}

export const useVr = create<VrState>()(() => ({ supported: false, available: false, active: false, starting: false, error: null, hmdName: '', offer: false, showOffer: () => {}, hideOffer: () => {}, start: async () => {}, stop: () => {}, clearError: () => {} }))

export function startVr() {}
