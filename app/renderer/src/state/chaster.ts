import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { ChasterStatus } from '@shared/chaster'
import type { ChasterState } from '@shared/gooner'
import { invoke, on } from '@/ipc'

interface ChasterStore {
  status: ChasterStatus
}

export const useChaster = create<ChasterStore>()(() => ({ status: { state: 'off', lock: null } }))

export function startChaster(): () => void {
  void invoke('chaster:status').then((status) => useChaster.setState({ status }))
  return on('chaster:status', (status) => useChaster.setState({ status }))
}

export function chasterState(status: ChasterStatus): ChasterState {
  if (status.lock) return 'locked'
  return status.state === 'ok' ? 'unlocked' : 'unknown'
}

const CLOCK_MS = 30_000

export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => window.clearInterval(t)
  }, [])
  return now
}
