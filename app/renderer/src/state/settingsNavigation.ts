import { create } from 'zustand'
import { isAccountPage, useAccountNavigation } from './accountNavigation'
import { categoryFor, SETTINGS_CATEGORIES, type SettingsCategoryId, type SettingsPageId, type SettingDescriptor } from '@/screens/settings/navigation'
import { useUi, type Screen } from './ui'

interface Location {
  page: SettingsPageId
  target?: string
}
interface SettingsNavigation {
  page: SettingsPageId
  showPage: boolean
  revision: number
  lastPages: Partial<Record<SettingsCategoryId, SettingsPageId>>
  disclosures: Record<string, boolean>
  scroll: Partial<Record<SettingsPageId, number>>
  query: string
  results: boolean
  target: string | null
  history: Location[]
  returnScreen: Screen | null
  selectPage: (page: SettingsPageId, target?: string, advanced?: boolean, remember?: boolean) => void
  selectCategory: (category: SettingsCategoryId) => void
  reveal: (setting: SettingDescriptor) => void
  back: () => void
  setQuery: (query: string) => void
  toggleAdvanced: (key: string, open: boolean) => void
  setScroll: (page: SettingsPageId, top: number) => void
}

export const useSettingsNavigation = create<SettingsNavigation>()((set, get) => ({
  page: 'appearance',
  showPage: false,
  revision: 0,
  lastPages: {},
  disclosures: {},
  scroll: {},
  query: '',
  results: false,
  target: null,
  history: [],
  returnScreen: null,
  selectPage: (page, target, advanced, remember = false) => {
    if (isAccountPage(page) && !useUi.getState().mediaCentre) {
      useAccountNavigation.getState().show(page, target)
      return
    }
    set((s) => ({
      page,
      target: target ?? null,
      results: false,
      showPage: true,
      revision: s.revision + 1,
      lastPages: { ...s.lastPages, [categoryFor(page).id]: page },
      disclosures: advanced ? {
        ...Object.fromEntries(Object.entries(s.disclosures).map(([key, open]) => [key, key.startsWith(`${page}:`) ? true : open])),
        [page]: true,
      } : s.disclosures,
      history: remember ? [...s.history, { page: s.page, target: `link-${page}` }] : [],
    }))
  },
  selectCategory: (id) => {
    const category = SETTINGS_CATEGORIES.find((c) => c.id === id)!
    get().selectPage(get().lastPages[id] ?? category.pages[0], 'page')
  },
  reveal: (setting) => get().selectPage(setting.page, setting.id, setting.advanced),
  back: () => {
    const s = get()
    const previous = s.history.at(-1)
    if (previous) {
      set({
        revision: s.revision + 1,
        page: previous.page,
        target: previous.target ?? null,
        history: s.history.slice(0, -1),
        lastPages: { ...s.lastPages, [categoryFor(previous.page).id]: previous.page },
      })
    } else if (s.query) set({ results: true, target: null })
  },
  setQuery: (query) => set({ query, results: !!query.trim(), target: null }),
  toggleAdvanced: (key, open) => set((s) => ({ disclosures: { ...s.disclosures, [key]: open } })),
  setScroll: (page, top) => set((s) => ({ scroll: { ...s.scroll, [page]: top } })),
}))

export function openSettings(page: SettingsPageId, target?: string, advanced = false) {
  useSettingsNavigation.getState().selectPage(page, target, advanced)
  if (!isAccountPage(page) || useUi.getState().mediaCentre) useUi.getState().setScreen('settings')
}
