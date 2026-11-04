import { VR_FREE_MAX_MS, vrUnlimited } from '@shared/account'
import type { MediaRow } from '@shared/library'
import { useAccount } from '@/state/account'
import { useUi } from '@/state/ui'
import { useVr } from '@/state/vr'

export function useHeadsetLimited(): boolean {
  const active = useVr((s) => s.active)
  const unlimited = useAccount((s) => vrUnlimited(s.status.me))
  return active && !unlimited
}

export const overFreeLength = (row: MediaRow): boolean => row.durationMs > VR_FREE_MAX_MS

export const headsetPlay = (limited: boolean, play: (row: MediaRow) => void) => (row: MediaRow) => {
  if (!limited || !overFreeLength(row)) return play(row)
  useUi.getState().setTvOverlay('none')
  useVr.getState().showOffer()
}
