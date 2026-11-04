import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { QuestHeadset } from '@shared/quest'
import { invoke, on } from '@/ipc'

export function useQuestHeadsets(): QuestHeadset[] {
  const [headsets, setHeadsets] = useState<QuestHeadset[]>([])
  useEffect(() => {
    void invoke('quest:headsets').then(setHeadsets)
    return on('quest:headsets', setHeadsets)
  }, [])
  return headsets
}

export type QuestConnectPhase = { id: string; kind: 'connecting' } | { id: string; kind: 'failed'; firewall: boolean; vpn: string | null }

const ANSWERED_HOLD_MS = 3000

interface QuestConnectStore {
  phase: QuestConnectPhase | null
  connect: (id: string) => Promise<void>
  clear: () => void
}

export const useQuestConnect = create<QuestConnectStore>()((set, get) => ({
  phase: null,
  connect: async (id) => {
    set({ phase: { id, kind: 'connecting' } })
    const result = await invoke('quest:connect', id)
    if (!result.answered) return set({ phase: { id, kind: 'failed', firewall: result.firewall, vpn: result.vpn } })
    window.setTimeout(() => {
      const p = get().phase
      if (p?.id === id && p.kind === 'connecting') set({ phase: null })
    }, ANSWERED_HOLD_MS)
  },
  clear: () => set({ phase: null }),
}))
