import { create } from 'zustand'
import type { MediaQuery } from '@shared/library'

export type DropTarget =
  | { kind: 'favourites' }
  | { kind: 'playlist'; id: number }
  | { kind: 'newPlaylist' }
  | { kind: 'tag'; name: string }
  | { kind: 'folder'; folder: NonNullable<MediaQuery['folder']> }

export const dropKey = (target: DropTarget): string => JSON.stringify(target)
export const parseDrop = (key: string): DropTarget => JSON.parse(key) as DropTarget

export interface Drag {
  ids: number[]
  thumbs: (string | null)[]
  x: number
  y: number
}

interface SelectState {
  on: boolean
  ids: ReadonlySet<number>
  before: ReadonlySet<number> | null
  drag: Drag | null
  dropTarget: string | null
  pendingPlaylist: number[] | null
  start: (id: number) => void
  toggle: (id: number) => void
  setAll: (ids: number[]) => void
  undoAll: () => void
  clear: () => void
  setDrag: (drag: Drag | null) => void
  moveDrag: (x: number, y: number) => void
  setDropTarget: (key: string | null) => void
  setPendingPlaylist: (ids: number[] | null) => void
}

export const useSelect = create<SelectState>()((set, get) => ({
  on: false,
  ids: new Set(),
  before: null,
  drag: null,
  dropTarget: null,
  pendingPlaylist: null,
  start: (id) => set({ on: true, ids: new Set([id]), before: null }),
  toggle: (id) => {
    const ids = new Set(get().ids)
    if (!ids.delete(id)) ids.add(id)
    set({ ids, before: null })
  },
  setAll: (ids) => set({ on: true, ids: new Set(ids), before: get().ids }),
  undoAll: () => {
    const { before } = get()
    if (before) set({ ids: before, before: null })
  },
  clear: () => set({ on: false, ids: new Set(), before: null, drag: null, dropTarget: null }),
  setDrag: (drag) => set(drag ? { drag } : { drag: null, dropTarget: null }),
  moveDrag: (x, y) => set((s) => (s.drag ? { drag: { ...s.drag, x, y } } : s)),
  setDropTarget: (dropTarget) => {
    if (get().dropTarget !== dropTarget) set({ dropTarget })
  },
  setPendingPlaylist: (pendingPlaylist) => set({ pendingPlaylist }),
}))
