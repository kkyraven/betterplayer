import type { OutputState, ToyFeature } from 'bp-engine'
import type { MessageKey } from '@shared/i18n'
import { t } from '@/state/i18n'

export const FEATURE_LABEL: Record<string, MessageKey> = {
  vibrate: 'devices.feature.vibrate',
  rotate: 'devices.feature.rotate',
  oscillate: 'devices.feature.oscillate',
  constrict: 'devices.feature.constrict',
  position: 'devices.feature.position',
  spray: 'devices.feature.spray',
  temperature: 'devices.feature.temperature',
  led: 'devices.feature.led',
}

export function featureName(kind: string): string {
  const key = FEATURE_LABEL[kind]
  return key ? t(key) : kind
}

export function featureSummary(features: ReadonlyArray<Pick<ToyFeature, 'kind'>>): string {
  const counts = new Map<string, number>()
  for (const f of features) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1)
  return [...counts].map(([kind, n]) => `${featureName(kind)}${n > 1 ? ` ×${n}` : ''}`).join(' · ')
}

export function statusDot(status: string | undefined): string {
  switch (status) {
    case 'connected':
      return ''
    case 'connecting':
      return 'warn'
    case 'error':
      return 'danger'
    default:
      return 'idle'
  }
}

export function ossmText(state: OutputState | undefined): string {
  const o = state?.ossm
  if (!o) return statusText(state)
  if (o.state === 'streaming.idle') return o.speed === 0 ? t('devices.status.ossm.knobUp') : t('devices.status.ossm.streamingAt', { speed: o.speed })
  if (o.state === 'streaming.preflight') return t('devices.status.ossm.preflight')
  if (o.state.startsWith('homing')) return t('devices.status.ossm.homing')
  if (o.state.startsWith('menu')) return t('devices.status.ossm.menu')
  if (o.state.startsWith('error')) return t('devices.status.ossm.error')
  return o.state
}

export function statusText(state: OutputState | undefined): string {
  if (!state) return t('devices.status.notConnected')
  switch (state.status) {
    case 'connected':
      return t('devices.status.connected')
    case 'connecting':
      return t('devices.status.connecting')
    case 'error':
      return state.error ?? t('devices.status.error')
    default:
      return state.status
  }
}
