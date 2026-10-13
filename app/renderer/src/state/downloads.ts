import { create } from 'zustand'
import type { DownloadDestination, DownloadEnqueue, DownloadState } from '@shared/downloads'
import { invoke, on } from '@/ipc'

const EMPTY: DownloadState = {
  batches: [], canClear: false, cancellable: 0,
  session: { id: '', completed: 0, total: 0, failed: 0, cancelled: 0, active: 0, attention: 0, receivedBytes: 0, totalBytes: 0, progress: 0 },
}

type DownloadAction = 'pause' | 'resume' | 'retry' | 'cancel' | 'continue'
let returnFocus: HTMLElement | null = null
let defaultRevision = 0

interface DownloadsStore {
  state: DownloadState
  initialized: boolean
  error: string | null
  managerOpen: boolean
  destination: DownloadDestination | null
  defaultDestination: DownloadDestination | null
  init: () => () => void
  setManagerOpen: (open: boolean, trigger?: HTMLElement) => void
  setDestination: (destination: DownloadDestination) => Promise<void>
  setDefault: (destination: DownloadDestination | null) => Promise<void>
  enqueue: (request: DownloadEnqueue) => Promise<string | null>
  command: (action: DownloadAction, id: string) => Promise<void>
  unlock: (id: string, password: string) => Promise<boolean>
  selectArchive: (id: string, entryIds: string[]) => Promise<boolean>
  clear: () => Promise<void>
  cancelAll: () => Promise<void>
  videoOnly: (id: string) => Promise<void>
  dismissError: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function archiveAttentionIds(state: DownloadState): Set<string> {
  return new Set(state.batches.flatMap((batch) => batch.files.flatMap((file) =>
    file.phase === 'waiting' && file.archive && ['password-required', 'wrong-password', 'selection-required'].includes(file.archive.state)
      ? [`${file.id}:${file.archive.state}`] : [])))
}

export const useDownloads = create<DownloadsStore>()((set, get) => ({
  state: EMPTY, initialized: false, error: null, managerOpen: false, destination: null, defaultDestination: null,
  init: () => {
    let disposed = false
    let pushed = false
    const requestedDefaultRevision = defaultRevision
    const receive = (state: DownloadState) => set((previous) => {
      const existing = archiveAttentionIds(previous.state)
      const needsInput = [...archiveAttentionIds(state)].some((id) => !existing.has(id))
      return { state, initialized: true, managerOpen: previous.managerOpen || needsInput }
    })
    const off = on('downloads:state', (state) => {
      pushed = true
      receive(state)
    })
    void invoke('downloads:state').then((state) => {
      if (!disposed && !pushed) receive(state)
    }).catch((error: unknown) => { if (!disposed) set({ error: errorMessage(error) }) })
    void invoke('downloads:default').then((destination) => {
      if (!disposed && requestedDefaultRevision === defaultRevision) set((state) => ({ defaultDestination: destination, destination: state.destination ?? destination }))
    }).catch((error: unknown) => { if (!disposed) set({ error: errorMessage(error) }) })
    return () => { disposed = true; off() }
  },
  setManagerOpen: (managerOpen, trigger) => {
    if (managerOpen && trigger) returnFocus = trigger
    set({ managerOpen })
    if (!managerOpen) {
      const target = returnFocus
      returnFocus = null
      queueMicrotask(() => { if (target?.isConnected) target.focus() })
    }
  },
  setDestination: async (destination) => {
    set({ destination })
    if (get().defaultDestination === null) await get().setDefault(destination)
  },
  setDefault: async (destination) => {
    const revision = ++defaultRevision
    try {
      await invoke('downloads:setDefault', destination)
      if (revision === defaultRevision) set({ defaultDestination: destination, error: null })
    } catch (error) { set({ error: errorMessage(error) }) }
  },
  enqueue: async (request) => {
    try {
      const id = await invoke('downloads:enqueue', request)
      set({ error: null })
      return id
    } catch (error) { set({ error: errorMessage(error) }); return null }
  },
  command: async (action, id) => {
    try {
      await invoke(`downloads:${action}`, id)
      set({ error: null })
    } catch (error) { set({ error: errorMessage(error) }) }
  },
  unlock: async (id, password) => {
    try {
      await invoke('downloads:unlock', id, password)
      set({ error: null })
      return true
    } catch (error) { set({ error: errorMessage(error) }); return false }
  },
  selectArchive: async (id, entryIds) => {
    try {
      await invoke('downloads:selectArchive', id, entryIds.slice())
      set({ error: null })
      return true
    } catch (error) { set({ error: errorMessage(error) }); return false }
  },
  clear: async () => {
    try { await invoke('downloads:clear'); set({ error: null }) }
    catch (error) { set({ error: errorMessage(error) }) }
  },
  cancelAll: async () => {
    try { await invoke('downloads:cancelAll'); set({ error: null }) }
    catch (error) { set({ error: errorMessage(error) }) }
  },
  videoOnly: async (id) => {
    try { await invoke('downloads:videoOnly', id); set({ error: null }) }
    catch (error) { set({ error: errorMessage(error) }) }
  },
  dismissError: () => set({ error: null }),
}))
