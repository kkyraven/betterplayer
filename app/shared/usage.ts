export interface UsagePing {
  install: string
  os: 'darwin' | 'win32' | 'linux'
  arch: string
  version: string
  features: Record<string, number>
}

export const isFeatureName = (s: string): boolean => s.length <= 64 && /^(play|session\.start|browser\.track|mediacentre|screen\.[a-z]+|action\.[a-z0-9]+(\.[a-z0-9]+){1,2}|device\.[a-z]+)$/.test(s)

export interface DayPoint {
  day: string
  active: number
  installs: number
}

export interface Share {
  key: string
  count: number
}

export interface FeatureStat {
  feature: string
  installs: number
  uses: number
}

export interface AdminStats {
  window: number
  totals: {
    installs: number
    signedIn: number
    dau: number
    wau: number
    mau: number
    users: number
    premium: number
  }
  days: DayPoint[]
  os: Share[]
  versions: Share[]
  features: FeatureStat[]
}

export const OS_LABELS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
