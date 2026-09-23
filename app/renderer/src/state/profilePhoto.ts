import { create } from 'zustand'
import { useAccountNavigation } from './accountNavigation'

export const useProfilePhoto = create<{
  userId: string | null
  show: (userId: string) => void
  close: () => void
}>()((set) => ({
  userId: null,
  show: (userId) => {
    useAccountNavigation.getState().close()
    set({ userId })
  },
  close: () => set({ userId: null }),
}))
