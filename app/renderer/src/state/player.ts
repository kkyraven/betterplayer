import { useMemo } from 'react'
import { create } from 'zustand'
import { track } from '@/state/usage'
import type { TrackingSettings } from '@shared/tracking'
import type { ScriptInfo } from 'bp-engine'
import type { MediaDetail } from '@shared/library'
import type { BrowserHandoff } from '@shared/browser'
import { movePlaylistItems, shufflePlaylist, type PlaylistMove } from '@shared/playlist'
import { isAudioPath, type MediaTags } from '@shared/ipc'
import { basicAuth, isRemoteMedia, mediaIdFromUrl, type PlayerCommand } from '@shared/peer'
import { AXIS_IDS, type AxisId } from '@shared/axes'
import { effectiveParam, pushParams } from './params'
import { detectProjection, type Projection } from '@shared/projection'
import { isUrl } from '@shared/remote'
import { defaultAxisSettings, type AxisSettings, type DlssSettings, type FrameGenOverride, type PerVideoSettings, type UpscalingSettings, type ParamAxisId, type ParamSourceSettings } from '@shared/settings'
import { applyEnhance, engine, warm } from '@/engine/client'
import * as live from './live'
import { invoke } from '@/ipc'
import { nextBookmarkTime } from '@/lib/bookmarks'
import { fileTitle } from '@/lib/format'
import { isFree, useAccount } from './account'
import { t } from './i18n'
import { useLibrary } from './library'
import { useSettings } from './settings'
import { useSubtitles } from './subtitles'
import { useTracking } from './tracking'
import { useUi } from './ui'

export interface PlayerSnapshot {
  durationMs: number
  paused: boolean
  loaded: boolean
  rate: number
  flagsVersion: number
  videoWidth: number
  videoHeight: number
  error: string | null
}

export type SheetTab = 'video' | 'device' | 'range' | 'projection' | 'queue'

export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

export const AUTOPLAY_ORDER = ['off', 'next', 'random'] as const
export type AutoplayMode = (typeof AUTOPLAY_ORDER)[number]
export const REPEAT_ORDER = ['off', 'once', 'all'] as const
export type RepeatMode = (typeof REPEAT_ORDER)[number]

const PLAYBACK_KEY = 'bp.playback'

export const END_WINDOW_MS = 500

function adjacent(ids: number[], current: number | undefined, dir: 1 | -1): number | undefined {
  const i = current === undefined ? -1 : ids.indexOf(current)
  return i >= 0 ? ids[i + dir] : ids[0]
}

type Playback = { autoplay: AutoplayMode; repeat: RepeatMode; volume: number; muted: boolean }

function loadPlayback(): Playback {
  const fallback: Playback = { autoplay: 'off', repeat: 'off', volume: 1, muted: false }
  try {
    const p = JSON.parse(localStorage.getItem(PLAYBACK_KEY) ?? '{}') as Partial<Record<keyof Playback, unknown>>
    return {
      autoplay: AUTOPLAY_ORDER.find((m) => m === p.autoplay) ?? fallback.autoplay,
      repeat: REPEAT_ORDER.find((m) => m === p.repeat) ?? fallback.repeat,
      volume: typeof p.volume === 'number' && Number.isFinite(p.volume) ? Math.max(0, Math.min(1, p.volume)) : fallback.volume,
      muted: typeof p.muted === 'boolean' ? p.muted : fallback.muted,
    }
  } catch {
    return fallback
  }
}

function cycle<T>(order: readonly [T, ...T[]], value: T): T {
  return order[(order.indexOf(value) + 1) % order.length] ?? order[0]
}

interface PlayerState {
  path: string | null
  title: string
  scripts: ScriptInfo[]
  media: MediaDetail | null
  audio: MediaTags | null
  video: PerVideoSettings
  projection: Projection
  volume: number
  muted: boolean
  autoplay: AutoplayMode
  repeat: RepeatMode
  replayed: boolean
  playlist: PlaylistPlayback | null
  openPlaylist: (id: number, shuffled?: boolean, startId?: number) => Promise<void>
  openLibraryMedia: (media: Pick<MediaDetail, 'id' | 'path'>) => Promise<void>
  jumpQueue: (id: number) => Promise<void>
  moveQueue: (move: PlaylistMove) => void
  cycleAutoplay: () => void
  cycleRepeat: () => void
  onEnded: () => Promise<void>
  step: (dir: 1 | -1) => Promise<void>
  takePauseRequest: () => boolean
  markEnded: () => void
  sheet: SheetTab | null
  snapshot: PlayerSnapshot
  mark: number | null
  open: (path: string, startSeconds?: number, playlist?: PlaylistPlayback, showPlayer?: boolean, signal?: AbortSignal, handoff?: BrowserHandoff) => Promise<void>
  prepare: (path: string, size?: { width: number; height: number }) => Promise<void>
  setTracking: (tracking: TrackingSettings) => void
  close: () => void
  play: () => void
  pause: () => void
  togglePlay: () => void
  seek: (seconds: number) => void
  seekBy: (seconds: number) => void
  setMark: () => void
  goToMark: () => void
  stepBookmark: (direction: -1 | 1) => void
  adjustAmplitude: (delta: number) => void
  resetAmplitude: () => void
  setRate: (rate: number) => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  setSheet: (sheet: SheetTab | null) => void
  setProjection: (projection: Projection | null) => void
  setFrameGen: (override: FrameGenOverride | null) => void
  setUpscaling: (patch: Partial<UpscalingSettings>) => void
  setDlss: (patch: Partial<DlssSettings>) => void
  setGlobalOffset: (ms: number) => void
  setAxis: (id: AxisId, patch: Partial<AxisSettings>) => void
  resetAxis: (id?: AxisId) => void
  setParam: (id: ParamAxisId, patch: Partial<ParamSourceSettings>) => void
  resetParam: (id: ParamAxisId) => void
  selectVariant: (id: AxisId, variant: string | null) => void
  savePosition: () => void
  setSnapshot: (snapshot: PlayerSnapshot) => void
}

const EMPTY_VIDEO: PerVideoSettings = { globalOffsetMs: 0, axes: {} }

export interface PlaylistPlayback {
  id: number
  orderedIds: number[]
  ids: number[]
  index: number
}

const playbackListeners = new Set<(command: PlayerCommand) => void>()
const told = (command: PlayerCommand) => {
  for (const l of playbackListeners) l(command)
}

export function onPlayback(listener: (command: PlayerCommand) => void): () => void {
  playbackListeners.add(listener)
  return () => {
    playbackListeners.delete(listener)
  }
}

export { isUrl }

function urlTitle(url: string): string {
  try {
    const u = new URL(url)
    const tail = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '')
    return tail ? `${u.hostname} · ${tail}` : u.hostname
  } catch {
    return url
  }
}

export const usePlayer = create<PlayerState>()((set, get) => {
  const axisDefaults = () => useSettings.getState().settings?.axesDefault
  const effectiveAxis = (id: AxisId, video: PerVideoSettings): AxisSettings => video.axes[id] ?? axisDefaults()?.[id] ?? defaultAxisSettings()
  const playback = loadPlayback()
  const savePlayback = () => {
    const { autoplay, repeat, volume, muted } = get()
    localStorage.setItem(PLAYBACK_KEY, JSON.stringify({ autoplay, repeat, volume, muted }))
  }

  let persistTimer = 0
  let pendingVideoSave: (() => void) | null = null
  const flushVideoSave = () => {
    window.clearTimeout(persistTimer)
    pendingVideoSave?.()
    pendingVideoSave = null
  }
  let prepared: { path: string; video: PerVideoSettings } | null = null
  let pauseRequested = false
  let ended = false
  let openToken = 0
  let retryBrowserPage: (() => void) | null = null
  let browserLoad: AbortController | null = null
  let advanceToken = 0
  const persist = (video: PerVideoSettings) => {
    set({ video })
    const { path } = get()
    if (!path) return
    window.clearTimeout(persistTimer)
    pendingVideoSave = () => { void invoke('video:set', path, video) }
    persistTimer = window.setTimeout(flushVideoSave, 300)
  }

  const savePositionAt = (timeMs: number) => {
    const { path, video, snapshot } = get()
    if (!path || !snapshot.loaded) return
    const nearEnd = snapshot.durationMs > 0 && timeMs > snapshot.durationMs - 5000
    const position = nearEnd || timeMs < 5000 ? undefined : Math.round(timeMs)
    if (position === video.position) return
    const { position: _old, ...rest } = video
    const next = position === undefined ? rest : { ...rest, position }
    set({ video: next })
    window.clearTimeout(persistTimer)
    pendingVideoSave = null
    void invoke('video:set', path, next)
  }

  return {
    path: null,
    title: '',
    scripts: [],
    media: null,
    audio: null,
    video: EMPTY_VIDEO,
    projection: detectProjection(''),
    volume: playback.volume,
    muted: playback.muted,
    autoplay: playback.autoplay,
    repeat: playback.repeat,
    replayed: false,
    playlist: null,
    sheet: null,
    mark: null,
    snapshot: { durationMs: 0, paused: true, loaded: false, rate: 1, flagsVersion: -1, videoWidth: 0, videoHeight: 0, error: null },

    open: async (path, startSeconds, playlist, showPlayer = true, signal, handoff) => {
      if (signal?.aborted) return
      browserLoad?.abort()
      browserLoad = handoff ? new AbortController() : null
      if (browserLoad) signal = signal ? AbortSignal.any([signal, browserLoad.signal]) : browserLoad.signal
      const token = ++openToken
      retryBrowserPage = null
      advanceToken++
      set({ playlist: playlist ?? null, ...(!playlist && get().sheet === 'queue' ? { sheet: null } : {}) })
      if (path !== get().path) track('play')
      const settingsStore = useSettings.getState()
      const settings = settingsStore.settings ?? (await settingsStore.load())
      if (signal?.aborted || token !== openToken) return
      const { snapshot } = get()
      const same = !handoff && path === get().path && snapshot.loaded && !snapshot.error
      const video = same ? get().video : prepared?.path === path ? prepared.video : ((await invoke('video:get', path)) ?? EMPTY_VIDEO)
      if (signal?.aborted || token !== openToken) return
      prepared = null
      const remote = !same && isUrl(path) && !isRemoteMedia(path) ? await invoke('library:remote', path) : null
      const scriptFolders = !same && !isUrl(path) ? await invoke('library:scriptFolders', path) : undefined
      if (signal?.aborted || token !== openToken) return
      if (!same) {
        if (get().path) get().savePosition()
        flushVideoSave()
        useTracking.getState().stop()
      }
      for (const id of AXIS_IDS) engine.setAxis(id, { ...settings.axesDefault[id], ...video.axes[id] })
      engine.setGlobalOffsetMs(video.globalOffsetMs)
      engine.setVolume(get().volume)
      engine.setMuted(get().muted)
      if (same) {
        if (startSeconds !== undefined) get().seek(startSeconds)
        get().play()
      } else {
        set({
          path,
          title: isUrl(path) ? urlTitle(path) : fileTitle(path),
          scripts: [],
          media: null,
          audio: isAudioPath(path) ? { video: false, title: null, artist: null, album: null, year: null, cover: null } : null,
          video,
          projection: video.projection ?? detectProjection(fileTitle(path)),
          mark: null,
          replayed: false,
        })
        ended = false
        const mediaId = mediaIdFromUrl(path)
        if (mediaId !== null) told({ kind: 'open', mediaId })
        void useSubtitles.getState().load(path)
        if (!isUrl(path)) {
          void invoke('media:tags', path).then((tags) => {
            if (get().path !== path || !tags) return
            const media = get().media
            if (tags.video) set({ audio: null })
            else set({ audio: tags, title: media?.titleSet ? media.title : tags.title ?? get().title })
          })
        }
      }
      if (showPlayer) {
        useUi.getState().setScreen('player')
        if (useUi.getState().mediaCentre) useUi.getState().setTvTab('nowplaying')
      }
      if (!same) {
        void invoke('library:byPath', path).then((media) => {
          if (get().path !== path) return
          if (media && isUrl(path)) set({ media, title: media.title, projection: video.projection ?? { ...detectProjection(media.title), kind: media.projection } })
          else set({ media, ...(media ? { title: media.titleSet ? media.title : get().audio?.title ?? media.title } : {}) })
        })
        const password = isRemoteMedia(path) ? settings.remote.sourcePassword : ''
        const start = startSeconds ?? (video.position !== undefined ? video.position / 1000 : undefined)
        const current = () => !signal?.aborted && token === openToken && get().path === path
        const loadPage = (position = start) => engine.load(path, position, video.variants, remote?.scriptsPath, remote?.headers ?? (password ? `Authorization: ${basicAuth(password)}` : undefined), signal, scriptFolders)
        const loadMedia = async () => {
          if (!handoff?.url) return loadPage()
          try {
            const info = await engine.load(handoff.url, start, video.variants, undefined, handoff.headers, signal)
            if (current()) {
              retryBrowserPage = () => {
                if (!current()) return
                set((state) => ({ snapshot: { ...state.snapshot, error: null } }))
                const position = live.get().timeMs / 1000
                void loadPage(position > 0 ? position : start).then((loaded) => {
                  if (!current()) return
                  set({ scripts: loaded.scripts })
                  engine.play()
                }).catch((error: unknown) => {
                  if (current()) set((state) => ({ snapshot: { ...state.snapshot, error: String(error) } }))
                })
              }
            }
            return info
          } catch (error) {
            if (!current()) throw error
            return loadPage()
          }
        }
        const [standIn, loaded] = await Promise.all([
          isRemoteMedia(path) ? invoke('remote:scripts', path) : null,
          loadMedia(),
        ])
        if (signal?.aborted || token !== openToken || get().path !== path) return
        const info = standIn ? await engine.loadScripts(standIn, video.variants).catch(() => loaded) : loaded
        if (signal?.aborted || token !== openToken || get().path !== path) return
        applyEnhance(settings.upscaling, video.frameGen)
        engine.play()
        set({ scripts: info.scripts })
        await useTracking.getState().autoStart()
        if (handoff && current()) get().setRate(handoff.rate)
      }
      if (signal?.aborted || token !== openToken) return
      void invoke('library:played', path)
      pushParams()
      await settingsStore.addRecent(path)
    },
    openLibraryMedia: async (media) => {
      const { playlistId } = useLibrary.getState()
      if (playlistId == null) return get().open(media.path)
      try {
        await get().openPlaylist(playlistId, false, media.id)
      } catch {
        if (useLibrary.getState().playlistId === playlistId) useLibrary.setState({ playlistError: t('player.queue.playlistError') })
      }
    },
    openPlaylist: async (id, shuffled = false, startId) => {
      browserLoad?.abort()
      browserLoad = null
      retryBrowserPage = null
      const token = ++openToken
      advanceToken++
      if (get().path) get().pause()
      const orderedIds = await invoke('library:queryIds', { playlistId: id, section: 'all', filters: {}, sort: 'name', desc: false, offset: 0, limit: 0 })
      if (token !== openToken) return
      const ids = shuffled ? shufflePlaylist(orderedIds) : orderedIds
      const index = startId === undefined ? 0 : ids.indexOf(startId)
      const first = ids[index]
      if (startId !== undefined && index < 0) throw new Error(t('player.queue.videoUnavailable'))
      if (first === undefined) throw new Error(t('player.queue.empty'))
      const detail = await invoke('library:media', first)
      if (token !== openToken) return
      if (!detail) throw new Error(t('player.queue.videoUnavailable'))
      const { useSession } = await import('./session')
      if (token !== openToken) return
      if (useSession.getState().stage === 'running') useSession.getState().end()
      set({ autoplay: shuffled ? 'random' : 'next', repeat: 'off', replayed: false })
      await get().open(detail.path, 0, { id, orderedIds, ids, index })
    },
    jumpQueue: async (id) => {
      const { playlist, path } = get()
      if (!playlist) return
      const index = playlist.ids.indexOf(id)
      if (index < 0 || index === playlist.index) return
      const token = ++advanceToken
      const detail = await invoke('library:media', id)
      if (token !== advanceToken || get().playlist !== playlist || get().path !== path) return
      if (!detail) throw new Error(t('player.queue.videoUnavailable'))
      await get().open(detail.path, 0, { ...playlist, index })
    },
    moveQueue: (move) => {
      const playlist = get().playlist
      if (!playlist) return
      const ids = movePlaylistItems(playlist.ids, move, t)
      if (ids.every((id, index) => id === playlist.ids[index])) return
      advanceToken++
      set({ playlist: { ...playlist, ids, orderedIds: ids, index: ids.indexOf(playlist.ids[playlist.index]!) } })
    },
    prepare: async (path, size) => {
      const [stored, remote, scriptFolders] = await Promise.all([invoke('video:get', path), isUrl(path) && !isRemoteMedia(path) ? invoke('library:remote', path) : null, !isUrl(path) ? invoke('library:scriptFolders', path) : undefined])
      const video = stored ?? EMPTY_VIDEO
      prepared = { path, video }
      engine.prepare(path, remote?.scriptsPath, scriptFolders).catch((e: unknown) => console.debug(`prepare: ${String(e)}`))
      if (size) warm(video.projection ?? detectProjection(fileTitle(path)), size.width, size.height)
    },
    close: () => {
      browserLoad?.abort()
      browserLoad = null
      openToken++
      retryBrowserPage = null
      advanceToken++
      get().savePosition()
      flushVideoSave()
      useTracking.getState().stop()
      engine.unload()
      prepared = null
      ended = false
      useSubtitles.getState().clear()
      set({ path: null, title: '', scripts: [], media: null, audio: null, video: EMPTY_VIDEO, sheet: null, mark: null, replayed: false, playlist: null })
      pushParams()
      useUi.getState().setScreen('library')
    },
    play: () => {
      if (ended) get().seek(0)
      engine.play()
      told({ kind: 'play' })
    },
    pause: () => {
      if (!get().snapshot.paused) pauseRequested = true
      savePositionAt(live.get().timeMs)
      engine.pause()
      told({ kind: 'pause' })
    },
    togglePlay: () => (get().snapshot.paused ? get().play() : get().pause()),
    seek: (seconds) => {
      if (!get().snapshot.loaded) return
      const target = Math.max(0, seconds)
      try {
        engine.seek(target)
      } catch (e) {
        console.debug(`seek: ${String(e)}`)
        return
      }
      ended = false
      savePositionAt(target * 1000)
      told({ kind: 'seek', timeMs: target * 1000 })
    },
    seekBy: (seconds) => get().seek(live.get().timeMs / 1000 + seconds),
    stepBookmark: (direction) => {
      const { scripts, snapshot } = get()
      if (!snapshot.loaded) return
      const bookmarks = scripts.filter((script) => script.selected).flatMap((script) => script.bookmarks)
      const target = nextBookmarkTime(bookmarks, live.get().timeMs, direction, snapshot.durationMs)
      if (target !== undefined) get().seek(target / 1000)
    },
    setMark: () => {
      if (get().snapshot.loaded) set({ mark: live.get().timeMs / 1000 })
    },
    goToMark: () => {
      const { mark } = get()
      if (mark !== null) get().seek(mark)
    },
    adjustAmplitude: (delta) => {
      const { video } = get()
      const axes = { ...video.axes }
      for (const id of live.axisIdsWith(live.FLAG_SCRIPT) as AxisId[]) {
        const current = effectiveAxis(id, video)
        const next = { ...current, amplitude: Math.max(0, Math.round((current.amplitude + delta) * 100) / 100) }
        engine.setAxis(id, next)
        axes[id] = next
      }
      persist({ ...video, axes })
    },
    resetAmplitude: () => {
      const { video } = get()
      const axes = { ...video.axes }
      for (const id of live.axisIdsWith(live.FLAG_SCRIPT) as AxisId[]) {
        const next = { ...effectiveAxis(id, video), amplitude: (axisDefaults()?.[id] ?? defaultAxisSettings()).amplitude }
        engine.setAxis(id, next)
        axes[id] = next
      }
      persist({ ...video, axes })
    },
    setRate: (rate) => {
      useTracking.getState().setBasePlaybackRate(rate)
      told({ kind: 'rate', rate })
    },
    setVolume: (volume) => {
      const v = Math.max(0, Math.min(1, volume))
      engine.setVolume(v)
      if (get().muted && v > 0) engine.setMuted(false)
      set({ volume: v, muted: get().muted && v === 0 })
      savePlayback()
    },
    toggleMute: () => {
      const muted = !get().muted
      engine.setMuted(muted)
      set({ muted })
      savePlayback()
    },
    cycleAutoplay: () => {
      const autoplay = cycle(AUTOPLAY_ORDER, get().autoplay)
      const playlist = get().playlist
      if (playlist && autoplay !== 'off') {
        const current = playlist.ids[playlist.index]!
        const ids = autoplay === 'random' ? [current, ...shufflePlaylist(playlist.orderedIds.filter(id => id !== current))] : playlist.orderedIds
        set({ autoplay, playlist: { ...playlist, ids, index: ids.indexOf(current) } })
      } else set({ autoplay })
      savePlayback()
    },
    cycleRepeat: () => {
      const repeat = cycle(REPEAT_ORDER, get().repeat)
      set((s) => ({ repeat, replayed: repeat === 'once' ? false : s.replayed }))
      savePlayback()
    },
    onEnded: async () => {
      const { path, repeat, replayed, autoplay, media, playlist } = get()
      const token = ++advanceToken
      if (!path) return
      if (repeat === 'all' || (repeat === 'once' && !replayed)) {
        set({ replayed: true })
        get().seek(0)
        engine.play()
        return
      }
      if (autoplay === 'off') return
      const stillAtEnd = () => {
        const s = get()
        return token === advanceToken && s.path === path && s.playlist === playlist && s.autoplay === autoplay && s.snapshot.paused && live.get().timeMs >= s.snapshot.durationMs - END_WINDOW_MS
      }
      const ids = playlist?.ids ?? await useLibrary.getState().allIds()
      if (ids.length === 0 || !stillAtEnd()) return
      let id: number | undefined
      if (playlist) {
        id = ids[playlist.index + 1]
      } else if (autoplay === 'random') {
        const pool = ids.filter((x) => x !== media?.id)
        const pick = pool.length > 0 ? pool : media ? [media.id] : []
        id = pick[Math.floor(Math.random() * pick.length)]
      } else {
        id = adjacent(ids, media?.id, 1)
      }
      if (id === undefined) return
      const detail = await invoke('library:media', id)
      if (!detail || !stillAtEnd()) return
      await get().open(detail.path, playlist ? 0 : undefined, playlist ? { ...playlist, index: playlist.index + 1 } : undefined, false)
    },
    step: async (dir) => {
      const { media, playlist, path } = get()
      const token = ++advanceToken
      const ids = playlist?.ids ?? await useLibrary.getState().allIds()
      const id = playlist ? ids[playlist.index + dir] : adjacent(ids, media?.id, dir)
      if (id === undefined) return
      const detail = await invoke('library:media', id)
      if (detail && token === advanceToken && get().path === path && get().playlist === playlist) await get().open(detail.path, playlist ? 0 : undefined, playlist ? { ...playlist, index: playlist.index + dir } : undefined)
    },
    takePauseRequest: () => {
      const requested = pauseRequested
      pauseRequested = false
      return requested
    },
    markEnded: () => {
      ended = true
    },
    setSheet: (sheet) => set({ sheet }),
    setProjection: (projection) => {
      const { video, title } = get()
      const { projection: _dropped, ...rest } = video
      persist(projection ? { ...rest, projection } : rest)
      set({ projection: projection ?? detectProjection(title) })
    },
    setFrameGen: (override) => {
      const { frameGen: _dropped, ...rest } = get().video
      persist(override ? { ...rest, frameGen: override } : rest)
      const settings = useSettings.getState().settings
      if (settings) applyEnhance(settings.upscaling, override ?? undefined)
    },
    setUpscaling: (patch) => {
      const store = useSettings.getState()
      const current = store.settings?.upscaling
      if (!current) return
      const upscaling = { ...current, ...patch }
      applyEnhance(upscaling, get().video.frameGen)
      void store.update((s) => ({ ...s, upscaling }))
    },
    setDlss: (patch) => {
      const store = useSettings.getState()
      const current = store.settings?.upscaling
      if (!current) return
      const upscaling = { ...current, dlss: { ...current.dlss, ...patch } }
      applyEnhance(upscaling, get().video.frameGen)
      store.updateDebounced((s) => ({ ...s, upscaling }))
    },
    setGlobalOffset: (ms) => {
      engine.setGlobalOffsetMs(ms)
      persist({ ...get().video, globalOffsetMs: ms })
    },
    setAxis: (id, patch) => {
      const { video } = get()
      const next = { ...effectiveAxis(id, video), ...patch }
      engine.setAxis(id, next)
      persist({ ...video, axes: { ...video.axes, [id]: next } })
    },
    resetAxis: (id) => {
      const { video } = get()
      const axes = { ...video.axes }
      for (const a of id ? [id] : AXIS_IDS) {
        delete axes[a]
        engine.setAxis(a, axisDefaults()?.[a] ?? defaultAxisSettings())
      }
      persist({ ...video, axes })
    },
    setParam: (id, patch) => {
      const { video } = get()
      persist({ ...video, params: { ...video.params, [id]: { ...effectiveParam(id), ...patch } } })
      pushParams()
    },
    resetParam: (id) => {
      const { video } = get()
      const { [id]: _dropped, ...params } = video.params ?? {}
      persist({ ...video, params: Object.keys(params).length > 0 ? params : undefined })
      pushParams()
    },
    selectVariant: (id, variant) => {
      const scripts = engine.selectVariant(id, variant)
      const { video } = get()
      const { [id]: _old, ...rest } = video.variants ?? {}
      const variants = variant ? { ...rest, [id]: variant } : rest
      set({ scripts })
      persist({ ...video, variants: Object.keys(variants).length > 0 ? variants : undefined })
    },
    setTracking: (tracking) => {
      const before = get().video.tracking
      const heroChanged = before?.heroMusic !== tracking.heroMusic || before?.zones !== tracking.zones
      persist({ ...get().video, tracking })
      if (heroChanged) flushVideoSave()
    },
    savePosition: () => savePositionAt(live.get().timeMs),
    setSnapshot: (snapshot) => {
      set({ snapshot })
      if (snapshot.error && retryBrowserPage) {
        const retry = retryBrowserPage
        retryBrowserPage = null
        retry()
      }
    },
  }
})

useAccount.subscribe((s, prev) => {
  const settings = useSettings.getState().settings
  if (settings && isFree(s) !== isFree(prev)) applyEnhance(settings.upscaling, usePlayer.getState().video.frameGen)
})

export function useActiveAxes(): string[] {
  const version = usePlayer((s) => s.snapshot.flagsVersion)
  return useMemo(() => live.axisIdsWith(live.FLAG_SCRIPT | live.FLAG_LIVE | live.FLAG_TRACKED), [version])
}

export function useScriptedAxes(): string[] {
  const version = usePlayer((s) => s.snapshot.flagsVersion)
  return useMemo(() => live.axisIdsWith(live.FLAG_SCRIPT | live.FLAG_DERIVED), [version])
}
