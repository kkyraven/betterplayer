import { create } from 'zustand'
import type { FollowState } from 'bp-engine'
import type { RemoteStatus } from '@shared/ipc'
import { mediaIdFromUrl } from '@shared/peer'
import type { QuestHello } from '@shared/quest'
import { engine } from '@/engine/client'
import { invoke, on } from '@/ipc'
import { fileTitle } from '@/lib/format'
import { applyVideoToEngine } from './axisDefaults'
import { usePlayer } from './player'
import { useVr } from './vr'

export const FOLLOW_KINDS = ['deovr', 'heresphere', 'whirligig'] as const
export type FollowKind = (typeof FOLLOW_KINDS)[number] | 'quest'
export const FOLLOW_LABELS: Record<FollowKind, string> = { deovr: 'DeoVR', heresphere: 'HereSphere', whirligig: 'Whirligig', quest: 'Better Player Quest' }

const STORAGE_KEY = 'bp.follow'
const DISMISSED_KEY = 'bp.follow.dismissed'
const DISMISSED_MS = 4 * 60 * 60_000

export interface FollowHalt {
  host: string
  path: string | null
}

interface FollowStore {
  kind: FollowKind
  host: string
  quest: QuestHello | null
  state: FollowState | null
  matched: { path: string; title: string } | null
  halted: FollowHalt | null
  setKind: (kind: FollowKind) => void
  setHost: (host: string) => void
  start: () => void
  questHello: (hello: QuestHello & { host: string }) => void
  stop: () => void
  update: (state: FollowState | null) => void
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
  let dismissed = loadDismissed(Date.now())
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
      const [folders, video] = await Promise.all([invoke('library:scriptFolders', target), local ? invoke('video:get', local.path) : null])
      if (get().state?.path !== path) return
      applyVideoToEngine(video)
      await engine.loadScripts(target, undefined, folders)
      if (get().state?.path !== path) return
      set({ matched: local ? { path: local.path, title: local.title } : null })
    } catch {
      set({ matched: null })
    }
  }
  const begin = (kind: FollowKind, host: string, quest: QuestHello | null) => {
    if (usePlayer.getState().path) usePlayer.getState().close()
    engine.follow(kind, host.trim() || '127.0.0.1', quest?.port)
    lastPath = undefined
    wasPlaying = true
    const { halted } = get()
    const keep = halted !== null && kind === 'quest' && halted.host === host
    set({ kind, host, quest, state: engine.followState(), matched: null, halted: keep ? halted : null })
  }
  return {
    ...loadSetup(),
    quest: null,
    state: null,
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
      const taken = s.state !== null && !(s.kind === 'quest' && (sameHost || s.state.status !== 'connected'))
      const player = usePlayer.getState()
      const vr = useVr.getState()
      if (taken || (player.path && !player.snapshot.paused) || vr.active || vr.starting) return
      begin('quest', host, quest)
    },
    stop: () => {
      const { kind, host, quest } = get()
      if (kind === 'quest' && quest) dismiss(host, quest.session)
      engine.unfollow()
      engine.unload()
      applyVideoToEngine(null)
      set({ state: null, matched: null, halted: null, ...(kind === 'quest' ? { ...loadSetup(), quest: null } : {}) })
    },
    update: (state) => {
      const path = state?.path ?? null
      if (path !== lastPath) {
        lastPath = path
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
      set(state ? { state } : { state: null, halted: null })
    },
  }
})

export function startHeadsets() {
  on('headset:hello', (hello) => useFollow.getState().questHello(hello))
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
