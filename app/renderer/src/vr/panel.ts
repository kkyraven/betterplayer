import { useEffect, useState } from 'react'
import type { VrCommand, VrDeckState } from '@shared/vr'
import { invoke, on } from '@/ipc'

export interface Received {
  state: VrDeckState
  at: number
}

export function useDeckState(): Received | null {
  const [received, setReceived] = useState<Received | null>(null)
  useEffect(() => {
    let alive = true
    void invoke('vr:panelState').then((state) => {
      if (alive && state) setReceived((r) => r ?? { state, at: performance.now() })
    })
    const off = on('vr:state', (state) => setReceived({ state, at: performance.now() }))
    return () => {
      alive = false
      off()
    }
  }, [])
  return received
}

export function command(c: VrCommand) {
  void invoke('vr:command', c)
}
