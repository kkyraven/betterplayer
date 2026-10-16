import { create } from 'zustand'
import type { Tag, TagUndo } from '@shared/library'
import { invoke } from '@/ipc'
import { t } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { useSettings } from '@/state/settings'

export interface TagResult {
  label: string
  ok: boolean
}

interface TagManagerState {
  tags: Tag[]
  blocked: string[]
  history: { label: string; undo: TagUndo }[]
  busy: boolean
  load: () => Promise<void>
  remove: (names: string[], block: boolean) => Promise<TagResult | null>
  merge: (names: string[], into: string) => Promise<TagResult | null>
  allow: (name: string) => Promise<TagResult | null>
  undo: () => Promise<boolean>
}

const tagName = (name: string) => name.trim().toLowerCase()

function retarget(names: string[], into: string | undefined) {
  const { filters, setFilters } = useLibrary.getState()
  if (filters.tag && names.includes(filters.tag)) setFilters({ ...filters, tag: into })
}

function pinInto(names: string[], into: string) {
  const pinned = useSettings.getState().settings?.library.pinnedTags ?? []
  if (pinned.includes(into) || !pinned.some((p) => names.includes(p))) return
  void useSettings.getState().update((s) => {
    const pins = s.library.pinnedTags
    const at = pins.findIndex((p) => names.includes(p))
    return at < 0 || pins.includes(into) ? s : { ...s, library: { ...s.library, pinnedTags: [...pins.slice(0, at + 1), into, ...pins.slice(at + 1)] } }
  })
}

export const useTagManager = create<TagManagerState>()((set, get) => {
  const run = async (label: string, change: () => Promise<TagUndo>, after?: () => void): Promise<TagResult | null> => {
    if (get().busy) return null
    set({ busy: true })
    try {
      const undo = await change()
      set((s) => ({ history: [...s.history, { label, undo }] }))
      after?.()
      return { label, ok: true }
    } catch {
      return { label: t('library.tag.saveFailed'), ok: false }
    } finally {
      set({ busy: false })
      await get().load()
    }
  }

  return {
    tags: [],
    blocked: [],
    history: [],
    busy: false,

    load: async () => {
      const [tags, blocked] = await Promise.all([invoke('library:tags'), invoke('library:blockedTags')])
      set({ tags, blocked })
    },

    remove: (names, block) => {
      const [first] = names
      if (first === undefined) return Promise.resolve(null)
      const label = names.length === 1 ? t('utilities.tags.deleted', { name: first }) : t('utilities.tags.deletedMany', { count: names.length })
      return run(label, () => invoke('library:deleteTags', names, block), () => retarget(names, undefined))
    },

    merge: (names, into) => {
      const name = tagName(into)
      const from = names.filter((n) => n !== name)
      const [first] = from
      if (!name || first === undefined) return Promise.resolve(null)
      const exists = get().tags.some((tag) => tag.name === name)
      const label = from.length > 1 ? t('utilities.tags.merged', { count: from.length, name })
        : exists ? t('utilities.tags.mergedOne', { from: first, to: name })
        : t('utilities.tags.renamed', { from: first, to: name })
      return run(label, () => invoke('library:mergeTags', from, name), () => {
        retarget(from, name)
        pinInto(from, name)
      })
    },

    allow: (name) => run(t('utilities.tags.allowed', { name }), () => invoke('library:unblockTags', [name])),

    undo: async () => {
      const last = get().history.at(-1)
      if (!last || get().busy) return false
      set({ busy: true })
      try {
        await invoke('library:undoTags', last.undo)
        set((s) => ({ history: s.history.slice(0, -1) }))
        return true
      } catch {
        return false
      } finally {
        set({ busy: false })
        await get().load()
      }
    },
  }
})
