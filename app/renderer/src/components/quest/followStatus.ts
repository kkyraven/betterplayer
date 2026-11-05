import type { FollowState } from 'bp-engine'
import type { Translate } from '@shared/i18n'

const timestampOff = (state: FollowState, reached: boolean) => state.kind === 'heresphere' && !reached && /timed out|refused/i.test(state.error ?? '')

export function followStatus(t: Translate, state: FollowState, matched: boolean, reached: boolean): string {
  if (state.status === 'error') return timestampOff(state, reached) ? t('settings.headsets.hereSphereTimestamp') : (state.error ?? t('common.error'))
  if (state.status !== 'connected') return t('common.connecting')
  if (!state.path) return t('settings.headsets.nothingOpen')
  if (!matched) return t('settings.headsets.noScript')
  return state.playing ? t('settings.headsets.playing') : t('settings.headsets.paused')
}

export const followDot = (state: FollowState, matched: boolean) => (state.status === 'error' ? 'danger' : state.status !== 'connected' || (state.path && !matched) ? 'warn' : '')
