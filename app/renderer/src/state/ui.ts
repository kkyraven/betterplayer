import { create } from 'zustand'
import type { MessageKey } from '@shared/i18n'
import type { MediaRow } from '@shared/library'
import { invoke } from '@/ipc'
import { track } from './usage'
import { tvBack, type TvNav, type TvOverlay, type TvTab, type TvView } from './tvNav'

export { TV_TABS, type TvTab } from './tvNav'

export const SCREENS = ['library', 'player', 'session', 'browser', 'game', 'editor', 'devices', 'utilities', 'settings', 'admin'] as const
export type Screen = (typeof SCREENS)[number]

export const SCREEN_LABEL: Record<Screen, MessageKey> = {
  library: 'screen.library',
  player: 'screen.player',
  session: 'screen.session',
  browser: 'screen.browser',
  game: 'screen.game',
  editor: 'screen.editor',
  devices: 'screen.devices',
  utilities: 'screen.utilities',
  settings: 'screen.settings',
  admin: 'screen.admin',
}

interface UiState extends TvNav {
  screen: Screen
  previous: Screen
  fullscreen: boolean
  reduceTransparency: boolean
  mediaCentre: boolean
  tvToast: { text: string; at: number } | null
  tvOptionsRow: MediaRow | null
  deviceWizard: boolean
  setDeviceWizard: (open: boolean) => void
  firstStart: boolean
  setFirstStart: (on: boolean) => void
  setMediaCentre: (on: boolean) => void
  setTvTab: (tab: TvTab) => void
  pushTvView: (view: TvView) => void
  setTvOverlay: (overlay: TvOverlay) => void
  openTvOptions: (row: MediaRow) => void
  tvBack: (playing: boolean) => boolean
  showTvToast: (text: string) => void
  stripHiddenFor: string | null
  hideStrip: (path: string) => void
  setScreen: (screen: Screen) => void
  setFullscreen: (on: boolean) => void
  toggleFullscreen: (on?: boolean) => Promise<void>
  setReduceTransparency: (on: boolean) => void
}

export const useUi = create<UiState>()((set, get) => ({
  screen: 'library',
  previous: 'library',
  fullscreen: false,
  reduceTransparency: false,
  mediaCentre: false,
  tvTab: 'library',
  tvViews: [],
  tvOverlay: 'none',
  tvToast: null,
  tvOptionsRow: null,
  deviceWizard: false,
  stripHiddenFor: null,
  hideStrip: (stripHiddenFor) => set({ stripHiddenFor }),
  setDeviceWizard: (deviceWizard) => set({ deviceWizard }),
  firstStart: process.argv.includes('--bp-first-start'),
  setFirstStart: (firstStart) => set({ firstStart }),
  setMediaCentre: (mediaCentre) => {
    if (mediaCentre) track('mediacentre')
    set({ mediaCentre, tvViews: [], tvOverlay: 'none' })
    void get().toggleFullscreen(mediaCentre)
  },
  setTvTab: (tvTab) => set((s) => ({ tvTab, tvViews: tvTab === 'nowplaying' ? s.tvViews : [], tvOverlay: 'none' })),
  pushTvView: (view) => set((s) => ({ tvViews: [...s.tvViews, view], tvOverlay: 'none', tvTab: s.tvTab === 'nowplaying' ? 'library' : s.tvTab })),
  setTvOverlay: (tvOverlay) => set({ tvOverlay }),
  openTvOptions: (tvOptionsRow) => set({ tvOptionsRow, tvOverlay: 'options' }),
  tvBack: (playing) => {
    const s = get()
    const change = tvBack({ tvTab: s.tvTab, tvViews: s.tvViews, tvOverlay: s.tvOverlay }, playing)
    if (change) set(change)
    return change !== null
  },
  showTvToast: (text) => set({ tvToast: { text, at: performance.now() } }),
  setScreen: (screen) => {
    if (screen !== get().screen) track(`screen.${screen}`)
    set((s) => (screen === s.screen ? {} : { screen, previous: s.screen, stripHiddenFor: screen === 'player' ? null : s.stripHiddenFor }))
  },
  setFullscreen: (fullscreen) => set({ fullscreen }),
  toggleFullscreen: async (on) => set({ fullscreen: await invoke('window:fullscreen', on) }),
  setReduceTransparency: (reduceTransparency) => set({ reduceTransparency }),
}))
