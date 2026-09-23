export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

import { t } from '@/state/i18n'

export function fmtSpeed(unitsPerSecond: number): string {
  return t('format.speed', { value: Math.round(unitsPerSecond) })
}

export function fileTitle(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export function fmtWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date(now).toDateString()
  return sameDay ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function fmtTimecode(ms: number): string {
  const total = Math.max(0, ms)
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const frac = String(Math.floor(total % 1000)).padStart(3, '0')
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${frac}`
  return h > 0 ? `${h}:${mmss}` : mmss
}
