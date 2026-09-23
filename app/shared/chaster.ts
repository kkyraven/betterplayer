export const CHASTER_API = 'https://api.chaster.app'
export const CHASTER_POLL_MS = 60_000

export interface ChasterLock {
  id: string
  title: string
  startedAt: number
  endsAt: number | null
  frozen: boolean
  keyholder: string | null
}

export interface ChasterStatus {
  state: 'off' | 'connecting' | 'ok' | 'error'
  error?: string
  username?: string
  lock: ChasterLock | null
}

export interface ChasterLockJson {
  _id: string
  title: string
  status: 'locked' | 'unlocked' | 'deserted'
  startDate: string
  endDate: string | null
  isAllowedToViewTime: boolean
  isFrozen: boolean
  keyholder: { username: string } | null
}

export function readLock(locks: ChasterLockJson[]): ChasterLock | null {
  const lock = locks.find((l) => l.status === 'locked')
  if (!lock) return null
  const endsAt = lock.isAllowedToViewTime && lock.endDate ? Date.parse(lock.endDate) : NaN
  return {
    id: lock._id,
    title: lock.title,
    startedAt: Date.parse(lock.startDate),
    endsAt: Number.isFinite(endsAt) ? endsAt : null,
    frozen: lock.isFrozen,
    keyholder: lock.keyholder?.username ?? null,
  }
}

export function fmtSpan(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
