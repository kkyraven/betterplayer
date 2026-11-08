import { create } from 'zustand'
import type { FollowState } from 'bp-engine'
import type { IpcEvents, QuestFrameWant, RemoteStatus } from '@shared/ipc'
import { mediaIdFromUrl } from '@shared/peer'
import type { QuestHello } from '@shared/quest'
import { isUrl } from '@shared/remote'
import { TRACK_AXIS_IDS } from '@shared/tracking'
import { engine } from '@/engine/client'
import { invoke, on } from '@/ipc'
import { fileTitle } from '@/lib/format'
import { applyVideoToEngine } from './axisDefaults'
import { clearEstimAudio, loadEstimAudio } from './estimAudio'
import { usePlayer } from './player'
import { useTracking } from './tracking'
import { useVr } from './vr'

export const FOLLOW_KINDS = ['deovr', 'heresphere', 'whirligig'] as const
export type FollowKind = (typeof FOLLOW_KINDS)[number] | 'quest'
export const FOLLOW_LABELS: Record<FollowKind, string> = { deovr: 'DeoVR', heresphere: 'HereSphere', whirligig: 'Whirligig', quest: 'Better Player Quest' }

const STORAGE_KEY = 'bp.follow'
const DISMISSED_KEY = 'bp.follow.dismissed'
const DISMISSED_MS = 4 * 60 * 60_000
const STREAMING_MS = 2 * 60_000

export interface FollowHalt {
  host: string
  path: string | null
}

interface FollowStore {
  kind: FollowKind
  host: string
  quest: QuestHello | null
  state: FollowState | null
  reached: boolean
  matched: { path: string; title: string } | null
  halted: FollowHalt | null
  setKind: (kind: FollowKind) => void
  setHost: (host: string) => void
  start: () => void
  questHello: (hello: QuestHello & { host: string }) => void
  played: (play: IpcEvents['headset:play']) => void
  stop: () => void
  update: (state: FollowState | null) => void
  feedFailed: (failed: IpcEvents['headset:feedFailed']) => void
}

function loadSetup(): { kind: FollowKind; host: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const saved = raw ? (JSON.parse(raw) as Partial<{ kind: FollowKind; host: string }>) : {}
    const kind = FOLLOW_KINDS.find((k) => k === saved.kind) ?? 'heresphere'
    return { kind, host: saved.host ?? '127.0.0.1' }
  } catch {
    return { kind: 'heresphere', host: '127.0.0.1' }
  }
}

type Dismissed = Record<string, { session: string; at: number }>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function loadDismissed(now: number): Dismissed {
  const out: Dismissed = {}
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '{}')
    if (!isRecord(saved)) return out
    for (const [host, entry] of Object.entries(saved)) {
      if (isRecord(entry) && typeof entry.session === 'string' && typeof entry.at === 'number' && now - entry.at < DISMISSED_MS) out[host] = { session: entry.session, at: entry.at }
    }
  } catch {
  }
  return out
}

let reencoded: QuestFrameWant | null = null
let framesAsked = 'null'

function syncFrames() {
  const key = JSON.stringify(reencoded)
  if (key === framesAsked) return
  framesAsked = key
  void invoke('quest:frames', reencoded)
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/

function onOwnServer(url: string, status: RemoteStatus): boolean {
  try {
    const u = new URL(url)
    if (!status.running || u.protocol !== 'http:' || Number(u.port || 80) !== status.port) return false
    return LOOPBACK.test(u.hostname) || status.urls.some((own) => new URL(own).hostname === u.hostname)
  } catch {
    return false
  }
}

export const useFollow = create<FollowStore>()((set, get) => {
  const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify({ kind: get().kind, host: get().host }))
  let lastPath: string | null | undefined
  let wasPlaying = false
  let followedPlay = false
  const streamed = new Map<string, { session: string; at: number }>()
  let dismissed = loadDismissed(Date.now())
  let lostFeed: QuestFrameWant | null = null
  let followedFile: string | null = null
  const isDismissed = (host: string, session: string) => {
    const d = dismissed[host]
    return d !== undefined && d.session === session && Date.now() - d.at < DISMISSED_MS
  }
  const dismiss = (host: string, session: string) => {
    const now = Date.now()
    dismissed = { ...loadDismissed(now), [host]: { session, at: now } }
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed))
  }
  const servedHere = async (url: string) => {
    const [status, source] = await Promise.all([invoke('remote:status'), invoke('remote:source')])
    return !source.source && (get().kind === 'quest' || onOwnServer(url, status))
  }
  const find = async (path: string) => {
    const id = mediaIdFromUrl(path)
    const served = id !== null && (await servedHere(path)) ? await invoke('library:media', id) : null
    return served ?? (await invoke('library:byPath', path)) ?? (await invoke('library:byTitle', fileTitle(path)))
  }
  const resolve = async (path: string) => {
    const local = await find(path)
    if (get().state?.path !== path) return
    const target = local?.path ?? path
    try {
      const quest = local !== null && get().kind === 'quest'
      const [folders, video, fed] = await Promise.all([
        invoke('library:scriptFolders', target),
        local ? invoke('video:get', local.path) : null,
        quest ? invoke('quest:reencoded', local.id).catch(() => false) : false,
      ])
      if (get().state?.path !== path) return
      applyVideoToEngine(video)
      if (local) void loadEstimAudio(local.path, () => video?.estimAudio)
      const host = get().host
      const feeding = local !== null && fed && !(lostFeed?.host === host && lostFeed.mediaId === local.id)
      reencoded = local && feeding ? { host, mediaId: local.id } : null
      followedFile = quest ? local.path : null
      engine.followFile(followedFile, feeding)
      syncFrames()
      const info = await engine.loadScripts(target, undefined, folders)
      if (get().state?.path !== path) return
      set({ matched: local ? { path: local.path, title: local.title } : null })
      if (local && get().kind === 'quest' && !isUrl(local.path)) {
        const scripted = TRACK_AXIS_IDS.filter((id) => info.scripts.some((s) => s.axis === id && s.selected))
        void useTracking.getState().followHeadset({ media: local, scripted })
      }
    } catch {
      set({ matched: null })
    }
  }
  const begin = (kind: FollowKind, host: string, quest: QuestHello | null, played = false) => {
    if (usePlayer.getState().path) usePlayer.getState().close()
    followedPlay = played
    engine.follow(kind, host.trim() || '127.0.0.1', quest?.port)
    clearEstimAudio()
    lastPath = undefined
    lostFeed = null
    wasPlaying = true
    const { halted } = get()
    const keep = halted !== null && kind === 'quest' && halted.host === host
    set({ kind, host, quest, state: engine.followState(), reached: false, matched: null, halted: keep ? halted : null })
  }
  const automatic = () => get().kind === 'quest' || followedPlay
  const free = (followingIt: boolean) => {
    const { state } = get()
    const player = usePlayer.getState()
    const vr = useVr.getState()
    const taken = state !== null && !(followingIt || (automatic() && state.status !== 'connected'))
    return !taken && !(player.path && !player.snapshot.paused) && !vr.active && !vr.starting
  }
  return {
    ...loadSetup(),
    quest: null,
    state: null,
    reached: false,
    matched: null,
    halted: null,
    setKind: (kind) => {
      set({ kind })
      save()
    },
    setHost: (host) => {
      set({ host })
      save()
    },
    start: () => begin(get().kind, get().host, null),
    questHello: ({ host, ...quest }) => {
      const s = get()
      const sameHost = s.kind === 'quest' && s.host === host
      if (s.state && sameHost && s.quest?.port === quest.port) {
        set({ quest })
        return
      }
      if (isDismissed(host, quest.session)) return
      if (!free(sameHost)) return
      begin('quest', host, quest)
    },
    played: ({ kind, host, mediaId }) => {
      const s = get()
      const key = `${kind}@${host}`
      const session = String(mediaId)
      streamed.set(key, { session, at: Date.now() })
      if (s.state && s.kind === kind && s.host === host) return
      if (isDismissed(key, session) || !free(false)) return
      begin(kind, host, null, true)
    },
    stop: () => {
      const { kind, host, quest } = get()
      const key = `${kind}@${host.trim()}`
      const video = streamed.get(key)
      if (kind === 'quest' && quest) dismiss(host, quest.session)
      else if (video && Date.now() - video.at < STREAMING_MS) dismiss(key, video.session)
      streamed.delete(key)
      const wasAutomatic = automatic()
      followedPlay = false
      reencoded = null
      void useTracking.getState().followHeadset(null)
      syncFrames()
      engine.unfollow()
      engine.unload()
      clearEstimAudio()
      applyVideoToEngine(null)
      set({ state: null, matched: null, halted: null, ...(wasAutomatic ? { ...loadSetup(), quest: null } : {}) })
    },
    update: (state) => {
      const path = state?.path ?? null
      if (path !== lastPath) {
        lastPath = path
        clearEstimAudio()
        reencoded = null
        void useTracking.getState().followHeadset(null)
        syncFrames()
        if (path) void resolve(path)
        else if (state) {
          engine.unload()
          set({ matched: null })
        }
      }
      const playing = state?.playing ?? false
      const { halted, kind, host } = get()
      if (halted && playing && !wasPlaying && kind === 'quest' && host === halted.host) {
        if (path === halted.path) {
          engine.resumeSensation()
          set({ halted: null })
        } else set({ halted: { host, path } })
      }
      wasPlaying = playing
      set(state ? { state, reached: get().reached || state.status === 'connected' } : { state: null, halted: null })
    },
    feedFailed: (failed) => {
      const { state, kind, host } = get()
      if (!state || kind !== 'quest' || host !== failed.host) return
      lostFeed = failed
      if (reencoded?.mediaId !== failed.mediaId) return
      reencoded = null
      engine.followFile(followedFile, false)
      syncFrames()
    },
  }
})

export function startHeadsets() {
  on('headset:hello', (hello) => useFollow.getState().questHello(hello))
  on('headset:frame', (f) => engine.lookaheadFrame(f.run, f.bytes, f.width, f.height, f.timeMs))
  on('headset:feedFailed', (failed) => useFollow.getState().feedFailed(failed))
  void invoke('quest:frames', null)
  on('headset:play', (play) => useFollow.getState().played(play))
  on('headset:bye', ({ host }) => {
    const s = useFollow.getState()
    if (s.state && s.kind === 'quest' && s.host === host) s.stop()
  })
  on('headset:stop', ({ host }) => {
    engine.haltSensation()
    const { state, kind, host: followed } = useFollow.getState()
    const ours = state !== null && kind === 'quest' && followed === host
    useFollow.setState({ halted: ours ? { host, path: state.path ?? null } : null })
  })
}
