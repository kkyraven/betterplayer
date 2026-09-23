import { create } from 'zustand'
import type { ModelInfo } from '@shared/tracking'
import { invoke, on } from '@/ipc'
import { ipcMessage } from '@/lib/errors'

export type Download = { status: 'running'; done: number; total: number } | { status: 'error'; error: string } | { status: 'done' }

interface ModelsState {
  downloads: Record<string, Download>
  download: (model: ModelInfo) => Promise<void>
  cancel: (id: string) => Promise<void>
  clear: (id: string) => void
}

export const percent = (d: Download | undefined): number => (d?.status === 'running' ? Math.round((d.done / Math.max(1, d.total)) * 100) : 0)

export const useModels = create<ModelsState>()((set, get) => {
  let listening = false
  const listen = () => {
    if (listening) return
    listening = true
    on('models:progress', (p) =>
      set((s) => {
        const current = s.downloads[p.id]
        if (current?.status !== 'running') return {}
        return { downloads: { ...s.downloads, [p.id]: { status: 'running', done: p.done, total: p.total || current.total } } }
      }),
    )
  }
  const put = (id: string, download: Download | null) =>
    set((s) => {
      const { [id]: _old, ...rest } = s.downloads
      return { downloads: download ? { ...rest, [id]: download } : rest }
    })
  return {
    downloads: {},
    download: async (model) => {
      listen()
      if (get().downloads[model.id]?.status === 'running') return
      put(model.id, { status: 'running', done: 0, total: model.sizeMb * 1024 * 1024 })
      try {
        for (const file of model.files) await invoke('models:download', model.id, file)
        put(model.id, { status: 'done' })
      } catch (e) {
        const error = ipcMessage(e)
        put(model.id, error === 'cancelled' ? null : { status: 'error', error })
      }
    },
    cancel: (id) => invoke('models:cancel', id),
    clear: (id) => put(id, null),
  }
})
