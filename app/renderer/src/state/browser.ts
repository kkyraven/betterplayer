import { create } from 'zustand'
import { track } from '@/state/usage'
import type { BrowserFrame, BrowserStartData, BrowserTab, Rect, Region, RegionBox } from '@shared/browser'
import { engine } from '@/engine/client'
import { invoke, on } from '@/ipc'
import { useUi } from '@/state/ui'

type FrameListener = (frame: BrowserFrame) => void

const frameListeners = new Set<FrameListener>()

export function subscribeFrames(listener: FrameListener): () => void {
  frameListeners.add(listener)
  return () => {
    frameListeners.delete(listener)
  }
}

const COLOUR_IDLE_MS = 250

export function feedColour(everyMs: () => number | null, width?: number): () => void {
  let timer = 0
  let stopped = false
  const tick = async () => {
    const interval = everyMs()
    if (interval === null) {
      timer = window.setTimeout(tick, COLOUR_IDLE_MS)
      return
    }
    const started = performance.now()
    const frame = await useBrowser.getState().snapshot(width)
    if (stopped) return
    if (frame) engine.trackFrame(frame.bytes, frame.width, frame.height, frame.mediaTime * 1000, frame.channels)
    timer = window.setTimeout(tick, Math.max(0, interval - (performance.now() - started)))
  }
  void tick()
  return () => {
    stopped = true
    window.clearTimeout(timer)
  }
}

interface BrowserState {
  tabs: BrowserTab[]
  initialized: boolean
  startData: BrowserStartData | null
  activeId: number | null
  region: Region | null
  zone: Region | null
  error: string | null
  capturing: boolean
  init: () => () => void
  open: (url?: string) => Promise<void>
  close: (id: number) => Promise<void>
  activate: (id: number) => Promise<void>
  reorder: (id: number, toIndex: number) => Promise<void>
  toggleBookmark: (url: string, title?: string) => Promise<void>
  bookmarksBar: boolean
  setBookmarksBar: (on: boolean) => void
  setAdBlockEnabled: (enabled: boolean) => Promise<void>
  navigate: (url: string) => Promise<void>
  back: () => Promise<void>
  forward: () => Promise<void>
  reload: () => Promise<void>
  stop: () => Promise<void>
  setBounds: (rect: Rect | null) => Promise<void>
  capture: (on: boolean) => Promise<void>
  snapshot: (width?: number) => Promise<BrowserFrame | null>
  pause: () => Promise<void>
  play: () => Promise<void>
  setMuted: (id: number, muted: boolean) => Promise<void>
  setRegion: (box: RegionBox | null) => Promise<void>
  setZone: (zone: Region | null) => Promise<void>
}

function fromTabs(tabs: BrowserTab[]) {
  const active = tabs.find((tab) => tab.active)
  return { tabs, activeId: active?.id ?? null, capturing: active?.capturing ?? false }
}

const BOOKMARKS_BAR_KEY = 'browser.bookmarksBar'

export const useBrowser = create<BrowserState>()((set, get) => ({
  tabs: [],
  initialized: false,
  bookmarksBar: typeof localStorage === 'undefined' || localStorage.getItem(BOOKMARKS_BAR_KEY) !== 'off',
  setBookmarksBar: (on) => {
    localStorage.setItem(BOOKMARKS_BAR_KEY, on ? 'on' : 'off')
    set({ bookmarksBar: on })
  },
  startData: null,
  activeId: null,
  region: null,
  zone: null,
  error: null,
  capturing: false,

  init: () => {
    let disposed = false
    let receivedTabs = false
    let receivedStartData = false
    const updateTabs = (tabs: BrowserTab[]) => {
      const next = fromTabs(tabs)
      set({
        ...next,
        initialized: true,
        ...(next.activeId !== get().activeId ? { region: null, zone: null, error: null } : {}),
      })
    }
    const offTabs = on('browser:tabs', (tabs) => {
      receivedTabs = true
      updateTabs(tabs)
    })
    const offStartData = on('browser:startData', (startData) => {
      receivedStartData = true
      set({ startData })
    })
    void invoke('browser:tabs').then((tabs) => {
      if (!disposed && !receivedTabs) updateTabs(tabs)
    })
    void invoke('browser:startData').then((startData) => {
      if (!disposed && !receivedStartData) set({ startData })
    })
    const offScreen = useUi.subscribe((state, previous) => {
      if ((state.screen !== previous.screen || state.mediaCentre !== previous.mediaCentre) &&
          (state.screen !== 'browser' || state.mediaCentre)) void get().setBounds(null)
    })
    const offFrame = on('browser:frame', (frame) => {
      for (const listener of frameListeners) listener(frame)
    })
    const offRegion = on('browser:region', ({ id, region }) => {
      if (id === get().activeId) set({ region })
    })
    const offZone = on('browser:zone', ({ id, region }) => {
      if (id === get().activeId) set({ zone: region })
    })
    const offError = on('browser:error', ({ id, error }) => {
      if (id === get().activeId) set({ error, capturing: false })
    })
    return () => {
      disposed = true
      offTabs()
      offStartData()
      offScreen()
      offFrame()
      offRegion()
      offZone()
      offError()
    }
  },

  open: async (url) => {
    await invoke('browser:open', url)
  },
  close: (id) => invoke('browser:close', id),
  activate: (id) => invoke('browser:activate', id),
  reorder: async (id, toIndex) => {
    const tabs = [...get().tabs]
    const from = tabs.findIndex((tab) => tab.id === id)
    const [tab] = tabs.splice(from, 1)
    if (from < 0 || !tab) return
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab)
    set({ tabs })
    await invoke('browser:reorder', id, toIndex)
  },
  toggleBookmark: async (url, title) => { await invoke('browser:toggleBookmark', url, title) },
  setAdBlockEnabled: async (enabled) => { await invoke('browser:setAdBlockEnabled', enabled) },
  navigate: async (url) => {
    const { activeId } = get()
    if (activeId === null) await get().open(url)
    else await invoke('browser:navigate', activeId, url)
  },
  back: async () => {
    const { activeId } = get()
    if (activeId !== null) await invoke('browser:back', activeId)
  },
  forward: async () => {
    const { activeId } = get()
    if (activeId !== null) await invoke('browser:forward', activeId)
  },
  reload: async () => {
    const { activeId } = get()
    if (activeId !== null) await invoke('browser:reload', activeId)
  },
  stop: async () => {
    const { activeId } = get()
    if (activeId !== null) await invoke('browser:stop', activeId)
  },
  setBounds: (rect) => {
    const { screen, mediaCentre } = useUi.getState()
    return invoke('browser:bounds', screen === 'browser' && !mediaCentre ? rect : null)
  },
  capture: async (on) => {
    const { activeId } = get()
    if (activeId === null) return
    if (on) track('browser.track')
    set({ capturing: on, error: on ? null : get().error })
    await invoke('browser:capture', activeId, on)
  },
  snapshot: (width) => {
    const { activeId } = get()
    return activeId === null ? Promise.resolve(null) : invoke('browser:snapshot', activeId, width)
  },
  pause: async () => {
    const { activeId } = get()
    if (activeId !== null) await invoke('browser:pause', activeId)
  },
  play: async () => {
    const { activeId } = get()
    if (activeId !== null) await invoke('browser:play', activeId)
  },
  setMuted: (id, muted) => invoke('browser:setMuted', id, muted),
  setRegion: async (box) => {
    const { activeId } = get()
    if (activeId === null) return
    if (!box?.auto) set({ region: box?.region ?? null })
    await invoke('browser:setRegion', activeId, box)
  },
  setZone: async (zone) => {
    const { activeId } = get()
    if (activeId === null) return
    set({ zone })
    await invoke('browser:setZone', activeId, zone)
  },
}))
