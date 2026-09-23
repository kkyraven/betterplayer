export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Region {
  x: number
  y: number
  w: number
  h: number
}

export interface RegionBox {
  region: Region
  auto: boolean
  label: string | null
}

export interface BrowserVideo {
  present: boolean
  playing: boolean
  mediaTime: number
  rate: number
}

export interface BrowserHandoff {
  pageUrl: string
  url: string | null
  headers: string
  position: number
  rate: number
}

export interface TabHandoff {
  requestId: number
  url: string | null
  position: number
  rate: number
}

export interface BrowserTab {
  id: number
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  blocked: number
  video: BrowserVideo | null
  capturing: boolean
  audible: boolean
  muted: boolean
  favicon: string | null
  active: boolean
}

export interface BrowserFrame {
  id: number
  bytes: Uint8Array
  channels: 1 | 3
  width: number
  height: number
  mediaTime: number
  capturedAt: number
}

export interface BrowserError {
  id: number
  error: string
}

export interface BrowserRegionEdit {
  id: number
  region: Region
}

export const CAPTURE_WIDTH = 384
export const SNAPSHOT_WIDTH = 640
export const REVEAL_ZONE_PX = 24

export const TAB_CHANNELS = {
  capture: 'bp:capture',
  snapshot: 'bp:snapshot',
  pause: 'bp:pause',
  handoff: 'bp:handoff',
  play: 'bp:play',
  region: 'bp:region',
  zone: 'bp:zone',
  zoneEdit: 'bp:zone-edit',
  video: 'bp:video',
  frame: 'bp:frame',
  regionEdit: 'bp:region-edit',
  error: 'bp:error',
} as const

export type TabFrame = Omit<BrowserFrame, 'id'>

export interface BrowserBookmark {
  url: string
  title: string
}

export interface BrowserVisitedSite extends BrowserBookmark {
  visits: number
  lastVisited: number
}

export interface BrowserStartData {
  bookmarks: BrowserBookmark[]
  mostVisited: BrowserVisitedSite[]
  icons: Record<string, string>
  adBlockEnabled: boolean
}
