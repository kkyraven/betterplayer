import type { FollowState } from 'bp-engine'
import { describe, expect, it } from 'vitest'
import type { Translate } from '@shared/i18n'
import { followStatus } from './followStatus'

const t = ((key: string) => key) as Translate
const failed = (kind: string, error: string) => ({ kind, status: 'error', error }) as FollowState
const HINT = 'settings.headsets.hereSphereTimestamp'

describe('followStatus', () => {
  it('points a HereSphere that never answered at its timestamp server', () => {
    expect(followStatus(t, failed('heresphere', 'connection timed out'), false, false)).toBe(HINT)
    expect(followStatus(t, failed('heresphere', 'Connection refused (os error 111)'), false, false)).toBe(HINT)
  })

  it('shows the error once HereSphere has answered, as it went away after working', () => {
    expect(followStatus(t, failed('heresphere', 'connection closed'), true, true)).toBe('connection closed')
    expect(followStatus(t, failed('heresphere', 'connection timed out'), false, true)).toBe('connection timed out')
  })

  it('shows an error the timestamp server cannot explain', () => {
    const host = 'No such host is known. (os error 11001)'
    expect(followStatus(t, failed('heresphere', host), false, false)).toBe(host)
  })

  it('never gives another player the hint', () => {
    expect(followStatus(t, failed('deovr', 'connection timed out'), false, false)).toBe('connection timed out')
  })
})
