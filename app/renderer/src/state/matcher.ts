import { create } from 'zustand'
import { LIKELY, type MatcherReport, type OrphanSet } from '@shared/matcher'
import { invoke } from '@/ipc'

interface MatcherState {
  report: MatcherReport | null
  scanning: boolean
  busy: Set<string>
  errors: Record<string, string>
  fail: (setId: string, message: string) => void
  scan: () => Promise<void>
  resolve: (setId: string, mediaId: number) => Promise<void>
  resolveLikely: () => Promise<void>
}

export function likelySets(report: MatcherReport | null): { set: OrphanSet; mediaId: number }[] {
  if (!report) return []
  const taken = new Set<number>()
  const out: { set: OrphanSet; mediaId: number }[] = []
  for (const set of report.sets) {
    const best = set.candidates[0]
    if (!best || best.confidence < LIKELY || taken.has(best.mediaId)) continue
    taken.add(best.mediaId)
    out.push({ set, mediaId: best.mediaId })
  }
  return out
}

export const useMatcher = create<MatcherState>()((set, get) => {
  const setBusy = (id: string, on: boolean) =>
    set((s) => {
      const busy = new Set(s.busy)
      if (on) busy.add(id)
      else busy.delete(id)
      return { busy }
    })

  const resolveOne = async (target: OrphanSet, mediaId: number) => {
    setBusy(target.id, true)
    set((s) => {
      const { [target.id]: _dropped, ...errors } = s.errors
      return { errors }
    })
    try {
      const result = await invoke('matcher:resolve', { dir: target.dir, files: target.files }, mediaId)
      set((s) => {
        if (!s.report) return {}
        const failedNames = new Set(result.failed.map((f) => f.name))
        const sets = s.report.sets.flatMap((x) => {
          if (x.id !== target.id) return [x]
          const files = x.files.filter((f) => failedNames.has(f.name))
          return files.length === 0 ? [] : [{ ...x, files }]
        })
        const first = result.failed[0]
        const errors = first ? { ...s.errors, [target.id]: `${first.name}: ${first.error}` } : s.errors
        return { report: { ...s.report, sets }, errors }
      })
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [target.id]: e instanceof Error ? e.message : String(e) } }))
    } finally {
      setBusy(target.id, false)
    }
  }

  return {
    report: null,
    scanning: false,
    busy: new Set(),
    errors: {},
    fail: (setId, message) => set((s) => ({ errors: { ...s.errors, [setId]: message } })),
    scan: async () => {
      set({ scanning: true })
      try {
        set({ report: await invoke('matcher:scan'), errors: {} })
      } finally {
        set({ scanning: false })
      }
    },
    resolve: async (setId, mediaId) => {
      const target = get().report?.sets.find((x) => x.id === setId)
      if (target) await resolveOne(target, mediaId)
    },
    resolveLikely: async () => {
      for (const { set: target, mediaId } of likelySets(get().report)) await resolveOne(target, mediaId)
    },
  }
})
