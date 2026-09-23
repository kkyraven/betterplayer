import { create } from 'zustand'
import type { Cue, SubtitleTrack } from '@shared/subtitles'
import { invoke } from '@/ipc'

interface SubtitlesState {
  video: string | null
  tracks: SubtitleTrack[]
  track: SubtitleTrack | null
  cues: Cue[]
  load: (video: string) => Promise<void>
  select: (track: SubtitleTrack) => Promise<void>
  clear: () => void
}

export const useSubtitles = create<SubtitlesState>()((set, get) => ({
  video: null,
  tracks: [],
  track: null,
  cues: [],
  load: async (video) => {
    set({ video, tracks: [], track: null, cues: [] })
    const tracks = await invoke('subtitles:find', video)
    if (get().video !== video) return
    set({ tracks })
    const first = tracks[0]
    if (first) await get().select(first)
  },
  select: async (track) => {
    const { video } = get()
    set({ track, cues: [] })
    const cues = await invoke('subtitles:read', track.path).catch((e: unknown) => {
      console.warn(`subtitles: ${track.path}: ${String(e)}`)
      return []
    })
    if (get().video === video && get().track === track) set({ cues })
  },
  clear: () => set({ video: null, tracks: [], track: null, cues: [] }),
}))
