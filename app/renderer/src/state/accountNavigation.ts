import { create } from 'zustand'

export type AccountPage = 'home' | 'profile' | 'friends' | 'privacy'

export function isAccountPage(page: string): page is Exclude<AccountPage, 'home'> {
  return page === 'profile' || page === 'friends' || page === 'privacy'
}

export const useAccountNavigation = create<{
  open: boolean
  page: AccountPage
  target: string | null
  revision: number
  show: (page?: AccountPage, target?: string) => void
  close: () => void
}>()((set) => ({
  open: false,
  page: 'home',
  target: null,
  revision: 0,
  show: (page = 'home', target) => set((s) => ({ open: true, page, target: target ?? null, revision: s.revision + 1 })),
  close: () => set({ open: false, page: 'home', target: null }),
}))
