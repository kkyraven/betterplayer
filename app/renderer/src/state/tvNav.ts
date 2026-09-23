import type { MediaQuery } from '@shared/library'

export const TV_SHELL_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Backspace', ' ', 'o', 'O', 'ContextMenu', '[', ']', 'MediaPlayPause', 'MediaStop', 'MediaTrackNext', 'MediaTrackPrevious'])

export const TV_TABS = ['nowplaying', 'library', 'continue', 'session'] as const
export type TvTab = (typeof TV_TABS)[number]

export type TvBrowseKind = 'folders' | 'tags' | 'playlists'

export interface TvGridSource {
  title: string
  folder?: NonNullable<MediaQuery['folder']>
  playlistId?: number
  tag?: string
}

export type TvView = { kind: 'browse'; what: TvBrowseKind } | { kind: 'grid'; source: TvGridSource } | { kind: 'settings' }

export type TvOverlay = 'none' | 'power' | 'quick' | 'options'

export interface TvNav {
  tvTab: TvTab
  tvViews: TvView[]
  tvOverlay: TvOverlay
}

export function tvBack(nav: TvNav, playing: boolean): Partial<TvNav> | null {
  if (nav.tvOverlay !== 'none') return { tvOverlay: 'none' }
  if (nav.tvTab === 'nowplaying') return { tvTab: 'library' }
  if (nav.tvViews.length > 0) return { tvViews: nav.tvViews.slice(0, -1) }
  if (playing) return { tvTab: 'nowplaying' }
  if (nav.tvTab !== 'library') return { tvTab: 'library' }
  return null
}

export function tvTabStep(tab: TvTab, step: 1 | -1, playing: boolean): TvTab {
  const tabs = TV_TABS.filter((t) => t !== 'nowplaying' || playing)
  const i = tabs.indexOf(tab)
  return tabs[(i + step + tabs.length) % tabs.length] ?? tab
}
