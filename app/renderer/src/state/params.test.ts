import { beforeEach, expect, it, vi } from 'vitest'
import { defaultParamSource, PARAM_AXES } from '@shared/settings'

const state = vi.hoisted(() => ({ browser: false, setParamSource: vi.fn() }))
vi.mock('@/engine/client', () => ({ engine: { setParamSource: state.setParamSource } }))
vi.mock('./tracking', () => ({ useTracking: { getState: () => ({ source: state.browser ? 'browser' : 'player' }) } }))
vi.mock('./player', () => ({ usePlayer: { getState: () => ({ video: { params: { C0: { ...defaultParamSource(), source: 'fixed', value: 0.8 } } } }) } }))
vi.mock('./devices', () => ({ useDevices: { getState: () => ({ outputs: [{ config: { profile: 'restim', params: { C0: { ...defaultParamSource(), source: 'fixed', value: 0.2 } } } }] }) } }))

import { effectiveParam, pushParams } from './params'

beforeEach(() => { state.browser = false; vi.clearAllMocks() })

it('uses output parameters in the browser and restores the player override on return', () => {
  expect(effectiveParam('C0').value).toBe(0.8)
  state.browser = true
  pushParams()
  expect(state.setParamSource).toHaveBeenCalledTimes(PARAM_AXES.length)
  expect(state.setParamSource).toHaveBeenCalledWith('C0', expect.objectContaining({ source: 'fixed', value: 0.2 }))
  state.browser = false
  pushParams()
  expect(state.setParamSource).toHaveBeenCalledWith('C0', expect.objectContaining({ source: 'fixed', value: 0.8 }))
})
