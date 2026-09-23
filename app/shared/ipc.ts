import type { SharedVideo } from './together'
import type { AccountStatus } from './account'
import type { AdminStats } from './usage'
import type { AxisId } from './axes'
import type { ChasterStatus } from './chaster'
import type { ModelFileInfo, ModelFileStatus, ModelProgress } from './tracking'
import type { BrowserError, BrowserFrame, BrowserHandoff, BrowserRegionEdit, BrowserStartData, BrowserTab, Rect, Region, RegionBox } from './browser'
import type { EditorDocument, EditorFilePage, EditorFileQuery, EditorStored, Pattern } from './editor'
import type { GameSources } from './game'
import type { MatcherReport, MatcherResolveResult, OrphanSet } from './matcher'
import type { DropResult, FolderNode, LibraryChange, LibraryCounts, LibraryRoot, MediaDetail, MediaPage, MediaQuery, Playlist, ScanProgress, Tag } from './library'
import type { PlayerCommand, PlayingState, RemoteSourceStatus } from './peer'
import type { RemoteLoad, ServerInput } from './remote'
import type { PerVideoSettings, Settings } from './settings'
import type { Cue, SubtitleTrack } from './subtitles'
import type { UpdateState } from './update'
import type { SavedSession, SessionHistory, SessionRun, SessionSetup } from './session'

export const VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'mkv', 'mk3d', 'webm', 'mov', 'avi', 'divx', 'wmv', 'asf',
  'ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'm2v', 'vob',
  'flv', 'f4v', '3gp', '3g2', 'ogv', 'ogm', 'mxf', 'dv', 'rm', 'rmvb', 'wtv',
  'ivf', 'h264', '264', 'hevc', 'h265', '265',
] as const
export const AUDIO_EXTENSIONS = [
  'mp3', 'mp2', 'aac', 'ac3', 'dts', 'm4a', 'flac', 'wav', 'w64', 'aiff', 'aif', 'au', 'caf',
  'ogg', 'oga', 'opus', 'mka', 'wma', 'wv', 'tta',
] as const

const extOf = (path: string) => {
  const dot = path.lastIndexOf('.')
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return dot > sep + 1 ? path.slice(dot + 1).toLowerCase() : ''
}

export function isVideoPath(path: string): boolean {
  const ext = extOf(path)
  return VIDEO_EXTENSIONS.some((e) => e === ext)
}

export function isAudioPath(path: string): boolean {
  const ext = extOf(path)
  return AUDIO_EXTENSIONS.some((e) => e === ext)
}

export const isMediaPath = (path: string) => isVideoPath(path) || isAudioPath(path)

export interface MediaTags {
  video: boolean
  title: string | null
  artist: string | null
  album: string | null
  year: number | null
  cover: string | null
}

export interface RemoteStatus {
  running: boolean
  port: number
  urls: string[]
}

export interface ScriptFile {
  suffix: string
  json: string
}

export interface GeneratedScriptRow {
  axis: AxisId
  json: string
}

export interface GeneratedResult {
  hash: string
  scripts: GeneratedScriptRow[]
}

export interface AudioPeaks {
  hz: number
  peaks: Float32Array
}

export interface IpcContract {
  'dialog:openVideo': () => string | null
  'dialog:openStashApp': () => string | null
  'dialog:saveScripts': (media: string, title: string, files: ScriptFile[]) => string[] | null
  'hero:export': (media: string, title: string, json: string) => string | null
  'hero:import': () => string | null
  'hero:sidecar': (media: string) => { text: string; stamp: string } | null
  'window:fullscreen': (on?: boolean) => boolean
  'window:isFullscreen': () => boolean
  'window:playing': (playing: boolean) => void
  'app:quit': () => void
  'app:version': () => string
  'update:state': () => UpdateState
  'update:check': () => void
  'update:install': () => void
  'window:displayHz': () => number
  'app:reportError': (message: string) => void
  'settings:get': () => Settings
  'settings:set': (settings: Settings) => void
  'video:get': (path: string) => PerVideoSettings | null
  'video:set': (path: string, settings: PerVideoSettings) => void
  'generated:get': (key: string) => GeneratedResult | null
  'generated:put': (key: string, hash: string, scripts: GeneratedScriptRow[]) => void
  'library:roots': () => LibraryRoot[]
  'library:addRoot': () => LibraryRoot[]
  'library:addPaths': (paths: string[]) => DropResult
  'library:addServer': (input: ServerInput) => LibraryRoot
  'library:removeRoot': (id: number) => void
  'library:remote': (path: string) => RemoteLoad | null
  'library:setRootSessions': (id: number, sessions: boolean) => void
  'library:scan': (rootId?: number) => void
  'library:retag': () => number
  'library:query': (query: MediaQuery) => MediaPage
  'library:queryIds': (query: MediaQuery) => number[]
  'library:jump': (query: MediaQuery, prefix: string) => { index: number; id: number } | null
  'library:media': (id: number) => MediaDetail | null
  'library:scriptFolders': (path: string) => Promise<string[]>
  'library:byPath': (path: string) => MediaDetail | null
  'library:byTitle': (title: string) => MediaDetail | null
  'library:folders': () => FolderNode[]
  'library:counts': () => LibraryCounts
  'library:setRating': (id: number, rating: number) => void
  'library:setTags': (id: number, tags: string[]) => void
  'library:setTitle': (id: number, title: string) => void
  'library:setPinned': (mediaIds: number[], pinned: boolean) => void
  'library:setHidden': (mediaIds: number[], hidden: boolean) => void
  'library:setFavourite': (mediaIds: number[], favourite: boolean) => void
  'library:moveToFolder': (mediaIds: number[], folder: NonNullable<MediaQuery['folder']>) => void
  'library:excludeFolder': (folder: NonNullable<MediaQuery['folder']>) => void
  'library:includeFolder': (folder: NonNullable<MediaQuery['folder']>) => void
  'library:tags': () => Tag[]
  'library:folderMedia': (folder: NonNullable<MediaQuery['folder']>) => number[]
  'library:addTag': (mediaIds: number[], tag: string) => void
  'library:renameTag': (from: string, to: string) => string
  'library:deleteTag': (name: string) => void
  'library:played': (path: string) => void
  'library:playlists': () => Playlist[]
  'library:importStashGroups': (rootId: number) => { created: number; updated: number; skipped: number }
  'library:createPlaylist': (name: string) => Playlist
  'library:renamePlaylist': (id: number, name: string) => void
  'library:deletePlaylist': (id: number) => void
  'library:addToPlaylist': (id: number, mediaIds: number[]) => void
  'library:removeFromPlaylist': (id: number, mediaIds: number[]) => void
  'library:movePlaylistItems': (id: number, move: import('./playlist').PlaylistMove) => void
  'library:progress': () => ScanProgress
  'matcher:scan': () => MatcherReport
  'matcher:resolve': (set: Pick<OrphanSet, 'dir' | 'files'>, mediaId: number) => MatcherResolveResult
  'session:start': (run: SessionRun, name: string) => number
  'session:played': (sessionId: number, mediaId: number, startMs: number, endMs: number) => void
  'session:recentMediaIds': (sessions: number) => number[]
  'session:finish': (id: number, completed: boolean) => void
  'session:saved': () => SavedSession[]
  'session:history': () => SessionHistory[]
  'session:save': (name: string, setup: SessionSetup, favourite: boolean) => number
  'session:load': (kind: 'saved' | 'history', id: number) => { name: string; setup: SessionSetup }
  'session:replay': (id: number) => SessionRun
  'session:favourite': (kind: 'saved' | 'history', id: number, favourite: boolean) => void
  'session:deleteSaved': (id: number) => void
  'remote:status': () => RemoteStatus
  'remote:publish': (state: PlayingState) => void
  'remote:source': () => RemoteSourceStatus
  'remote:playing': () => PlayingState
  'remote:scripts': (url: string) => string | null
  'player:control': (command: PlayerCommand) => void
  'chaster:status': () => ChasterStatus
  'account:status': () => AccountStatus
  'account:token': () => string | null
  'account:url': () => string
  'account:login': () => void
  'account:cancelLogin': () => void
  'account:logout': () => void
  'account:refresh': () => void
  'account:setName': (name: string) => void
  'account:setAvatar': (userId: string, png: string | null) => void
  'account:friends': () => void
  'account:addFriend': (code: string) => void
  'account:acceptFriend': (id: string) => void
  'account:removeFriend': (id: string) => void
  'account:hash': (path: string) => string | null
  'account:pathForHash': (hash: string) => string | null
  'together:allowQueue': (paths: string[]) => SharedVideo[]
  'together:allow': (path: string | null) => SharedVideo | null
  'together:sendStart': (shareId: string) => string
  'together:read': (id: string) => { data: Uint8Array; digest: string | null }
  'together:receiveStart': (video: SharedVideo) => string | null
  'together:write': (id: string, offset: number, data: Uint8Array) => void
  'together:complete': (id: string, digest: string) => string
  'together:cancel': (id: string) => void
  'together:clear': () => void
  'usage:track': (feature: string) => void
  'admin:stats': (days: number) => AdminStats
  'browser:tabs': () => BrowserTab[]
  'browser:preview': () => string | null
  'browser:startData': () => BrowserStartData
  'browser:reorder': (id: number, toIndex: number) => void
  'browser:toggleBookmark': (url: string, title?: string) => BrowserStartData
  'browser:setAdBlockEnabled': (enabled: boolean) => BrowserStartData
  'browser:open': (url?: string) => BrowserTab
  'browser:close': (id: number) => void
  'browser:activate': (id: number) => void
  'browser:navigate': (id: number, url: string) => void
  'browser:back': (id: number) => void
  'browser:forward': (id: number) => void
  'browser:reload': (id: number) => void
  'browser:stop': (id: number) => void
  'browser:bounds': (rect: Rect | null) => void
  'browser:capture': (id: number, on: boolean) => void
  'browser:setRegion': (id: number, box: RegionBox | null) => void
  'browser:setZone': (id: number, zone: Region | null) => void
  'browser:snapshot': (id: number, width?: number) => BrowserFrame | null
  'browser:handoff': (id: number) => BrowserHandoff | null
  'browser:pause': (id: number) => void
  'browser:play': (id: number) => void
  'browser:setMuted': (id: number, muted: boolean) => void
  'models:dir': () => string
  'models:status': (files: string[]) => Record<string, ModelFileStatus | null>
  'models:download': (id: string, file: ModelFileInfo) => void
  'models:remove': (file: string) => void
  'models:cancel': (id: string) => void
  'audio:decode': (source: string) => string
  'audio:window': (source: string, startMs: number, durationMs: number, requestId: string) => { path: string; startMs: number; endMs: number }
  'audio:cancelWindow': (requestId: string) => void
  'game:sources': () => GameSources
  'game:capture': (id: string | null) => void
  'game:openScreenAccess': () => void
  'audio:peaks': (source: string) => AudioPeaks
  'editor:load': (key: string) => EditorStored
  'editor:files': (query: EditorFileQuery) => EditorFilePage
  'editor:folders': () => FolderNode[]
  'editor:save': (key: string, doc: EditorDocument) => number
  'editor:saveDraft': (key: string, doc: EditorDocument) => void
  'editor:discardDraft': (key: string) => void
  'editor:markExported': (key: string, doc: EditorDocument) => number
  'editor:patterns': () => Pattern[]
  'editor:savePattern': (pattern: Pattern) => Pattern[]
  'editor:deletePattern': (id: string) => Pattern[]
  'editor:export': (media: string, title: string, files: ScriptFile[]) => string[] | null
  'media:tags': (path: string) => MediaTags | null
  'subtitles:find': (video: string) => SubtitleTrack[]
  'subtitles:read': (path: string) => Cue[]
}

export type IpcChannel = keyof IpcContract

export interface IpcEvents {
  'app:openFile': string
  'window:fullscreen': boolean
  'window:shown': boolean
  'library:progress': ScanProgress
  'library:changed': LibraryChange
  'remote:status': RemoteStatus
  'remote:source': RemoteSourceStatus
  'remote:playing': PlayingState
  'player:control': PlayerCommand
  'chaster:status': ChasterStatus
  'account:status': AccountStatus
  'browser:tabs': BrowserTab[]
  'browser:startData': BrowserStartData
  'browser:pointer': { y: number }
  'browser:frame': BrowserFrame
  'browser:region': BrowserRegionEdit
  'browser:zone': BrowserRegionEdit
  'browser:error': BrowserError
  'models:progress': ModelProgress
  'update:state': UpdateState
}

export type IpcEvent = keyof IpcEvents
