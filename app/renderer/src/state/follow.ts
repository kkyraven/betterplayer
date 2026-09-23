import { create } from 'zustand'
import type { FollowState } from 'bp-engine'
import { engine } from '@/engine/client'
import { invoke } from '@/ipc'
import { fileTitle } from '@/lib/format'
import { usePlayer } from './player'

export const FOLLOW_KINDS = ['deovr', 'heresphere', 'whirligig'] as const
export type FollowKind = (typeof FOLLOW_KINDS)[number]
export const FOLLOW_LABELS: Record<FollowKind, string> = { deovr: 'DeoVR', heresphere: 'HereSphere', whirligig: 'Whirligig' }

const STORAGE_KEY = 'bp.follow'

interface FollowStore {
  kind: FollowKind
  host: string
  state: FollowState | null
  matched: string | null
  setKind: (kind: FollowKind) => void
  setHost: (host: string) => void
  start: () => void
  stop: () => void
  update: (state: FollowState | null) => void
}

function loadSetup(): { kind: FollowKind; host: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const saved = raw ? (JSON.parse(raw) as Partial<{ kind: FollowKind; host: string }>) : {}
    return { kind: FOLLOW_KINDS.includes(saved.kind as FollowKind) ? (saved.kind as FollowKind) : 'heresphere', host: saved.host ?? '127.0.0.1' }
  } catch {
    return { kind: 'heresphere', host: '127.0.0.1' }
  }
}

export const useFollow = create<FollowStore>()((set, get) => {
  const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify({ kind: get().kind, host: get().host }))
  let lastPath: string | null | undefined
  const resolve = async (path: string) => {
    const local = (await invoke('library:byPath', path)) ?? (await invoke('library:byTitle', fileTitle(path)))
    if (get().state?.path !== path) return
    const target = local?.path ?? path
    try {
      const folders = await invoke('library:scriptFolders', target)
      if (get().state?.path !== path) return
      await engine.loadScripts(target, undefined, folders)
      set({ matched: local?.path ?? null })
    } catch {
      set({ matched: null })
    }
  }
  return {
    ...loadSetup(),
    state: null,
    matched: null,
    setKind: (kind) => {
      set({ kind })
      save()
    },
    setHost: (host) => {
      set({ host })
      save()
    },
    start: () => {
      const { kind, host } = get()
      if (usePlayer.getState().path) usePlayer.getState().close()
      engine.follow(kind, host.trim() || '127.0.0.1')
      lastPath = undefined
      set({ state: engine.followState(), matched: null })
    },
    stop: () => {
      engine.unfollow()
      engine.unload()
      set({ state: null, matched: null })
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
      set({ state })
    },
  }
})
