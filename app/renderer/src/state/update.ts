import { create } from 'zustand'
import type { UpdateState } from '@shared/update'
import { invoke, on } from '@/ipc'
import { t } from './i18n'

interface UpdateStore {
  state: UpdateState
  version: string
  start: () => void
  check: () => Promise<void>
  install: () => Promise<void>
}

export function updateText(state: UpdateState): string {
  switch (state.status) {
    case 'off': return t(state.portable ? 'update.status.portable' : 'update.status.off')
    case 'idle': return ''
    case 'checking': return t('update.status.checking')
    case 'upToDate': return t('update.status.upToDate')
    case 'downloading': return t('update.status.downloading', { version: state.version, percent: state.percent })
    case 'ready': return t('update.status.ready', { version: state.version })
    case 'error': return state.message
  }
}

export const useUpdate = create<UpdateStore>()((set, get) => {
  let started = false
  return {
    state: { status: 'idle' },
    version: '',
    start: () => {
      if (started) return
      started = true
      on('update:state', (state) => set({ state }))
      void invoke('update:state').then((state) => set({ state }))
      void invoke('app:version').then((version) => set({ version }))
    },
    check: () => invoke('update:check'),
    install: async () => {
      if (get().state.status === 'ready') await invoke('update:install')
    },
  }
})
