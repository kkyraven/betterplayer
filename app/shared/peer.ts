import type { IpcChannel } from './ipc'
import { REMOTE_PORT_DEFAULT } from './settings'

export interface PlayingState {
  mediaId: number | null
  playing: boolean
  timeMs: number
  durationMs: number
  rate: number
}

export const IDLE_PLAYING: PlayingState = { mediaId: null, playing: false, timeMs: 0, durationMs: 0, rate: 1 }

export type PlayerCommand = { kind: 'play' } | { kind: 'pause' } | { kind: 'seek'; timeMs: number } | { kind: 'rate'; rate: number } | { kind: 'open'; mediaId: number }

export const SYNC_SEEK_MS = 200
export const SYNC_DEADBAND_MS = 4
const SYNC_GAIN = 0.00025
const SYNC_MAX = 0.05
const SYNC_STEP = 0.005

export function syncRate(rate: number, driftMs: number): number {
  if (Math.abs(driftMs) <= SYNC_DEADBAND_MS) return rate
  const correction = Math.max(-SYNC_MAX, Math.min(SYNC_MAX, driftMs * SYNC_GAIN))
  return Math.round(rate * (1 - correction) * (1 / SYNC_STEP)) / (1 / SYNC_STEP)
}

export interface RemoteSourceStatus {
  source: string
  connected: boolean
  error: string | null
}

export function normaliseSource(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (!url.hostname) return ''
    return `${url.hostname}:${url.port || REMOTE_PORT_DEFAULT}`
  } catch {
    return ''
  }
}

export const sourceBase = (source: string) => `http://${source}`
export const basicAuth = (password: string) => `Basic ${btoa(`bp:${password}`)}`
export const mediaUrl = (base: string, id: number) => `${base}/media/${id}`

const MEDIA_URL = /^https?:\/\/[^/]+\/media\/(\d+)$/

export function mediaIdFromUrl(path: string): number | null {
  const m = MEDIA_URL.exec(path)
  return m ? Number(m[1]) : null
}

export const isRemoteMedia = (path: string) => MEDIA_URL.test(path)

export const FORWARDED_CHANNELS = [
  'video:get',
  'video:set',
  'library:roots',
  'library:setRootSessions',
  'library:scan',
  'library:query',
  'library:queryIds',
  'library:jump',
  'library:media',
  'library:byPath',
  'library:byTitle',
  'library:folders',
  'library:counts',
  'library:setRating',
  'library:setTags',
  'library:setTitle',
  'library:setPinned',
  'library:setHidden',
  'library:setFavourite',
  'library:moveToFolder',
  'library:excludeFolder',
  'library:includeFolder',
  'library:tags',
  'library:folderMedia',
  'library:addTag',
  'library:renameTag',
  'library:deleteTag',
  'library:played',
  'library:playlists',
  'library:importStashGroups',
  'library:createPlaylist',
  'library:renamePlaylist',
  'library:deletePlaylist',
  'library:addToPlaylist',
  'library:removeFromPlaylist',
  'library:progress',
  'session:start',
  'session:played',
  'session:recentMediaIds',
  'session:finish',
  'session:saved',
  'session:history',
  'session:save',
  'session:load',
  'session:replay',
  'session:favourite',
  'session:deleteSaved',
  'subtitles:find',
  'subtitles:read',
  'player:control',
] as const satisfies readonly IpcChannel[]

export type ForwardedChannel = (typeof FORWARDED_CHANNELS)[number]

export const isForwarded = (channel: string): channel is ForwardedChannel => (FORWARDED_CHANNELS as readonly string[]).includes(channel)

export const PATH_CHANNELS: readonly ForwardedChannel[] = ['video:get', 'video:set', 'library:byPath', 'library:played', 'subtitles:find']

export interface ScriptSet {
  media: string
  files: { name: string; size: number; mtime: number }[]
}
