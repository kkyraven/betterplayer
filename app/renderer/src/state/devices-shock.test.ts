import { beforeEach, expect, it, vi } from 'vitest'
import type { AccountStatus } from '@shared/account'
import { SIGNED_OUT } from '@shared/account'
import { defaultOpenShockTrigger, defaultSettings, type OutputConfig } from '@shared/settings'

const native = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), setPishockEnabled: vi.fn(), testOutput: vi.fn() }))
vi.mock('@/engine/client', () => ({ engine: native }))
vi.mock('./account', async () => {
  const { create } = await import('zustand')
  return {
    useAccount: create<{ status: AccountStatus }>(() => ({ status: SIGNED_OUT })),
    isPremium: (s: { status: AccountStatus }) => s.status.me?.premium === true,
  }
})
vi.mock('./params', () => ({ pushParams: vi.fn() }))
vi.mock('./live', () => ({ subscribe: vi.fn() }))
vi.mock('./usage', () => ({ track: vi.fn() }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./settings', async () => {
  const { create } = await import('zustand')
  return { useSettings: create(() => ({ settings: defaultSettings(), update: vi.fn().mockResolvedValue(undefined), updateDebounced: vi.fn() })) }
})
import { useAccount } from './account'
import { testMove, useDevices } from './devices'

const config: OutputConfig = {
  id: 'saved',
  kind: 'pishock',
  profile: 'stroker',
  username: 'user',
  token: 'key',
  userId: 12,
  clientId: 34,
  shocker: '56',
  trigger: defaultOpenShockTrigger(),
}
const premium: AccountStatus = {
  ...SIGNED_OUT,
  state: 'in',
  me: { id: 'a', name: 'A', email: 'a@example.com', premium: true, admin: false, friendCode: 'AAAA-BBBB', avatarUrl: null },
}
beforeEach(() => {
  useDevices.setState({ outputs: [], states: {}, selectedId: null })
  useAccount.setState({ status: SIGNED_OUT })
  vi.clearAllMocks()
  native.connect.mockReturnValue(1)
})
it('keeps saved PiShock configurations without connecting a free account', async () => {
  useDevices.getState().connectSaved([config])
  expect(native.setPishockEnabled).toHaveBeenCalledWith(false)
  expect(native.connect).not.toHaveBeenCalled()
  expect(useDevices.getState().outputs[0]?.config).toEqual(config)
  await expect(useDevices.getState().add(config)).rejects.toThrow('common.supporterOnly')
  await testMove(useDevices.getState().outputs[0]!)
  expect(native.testOutput).not.toHaveBeenCalled()
  useDevices.getState().reconnect(useDevices.getState().outputs[0]!.id)
  expect(native.connect).not.toHaveBeenCalled()
})
it('connects when entitlement arrives and revokes native access on sign-out', () => {
  useDevices.getState().connectSaved([config])
  useAccount.setState({ status: premium })
  expect(native.setPishockEnabled).toHaveBeenLastCalledWith(true)
  expect(native.connect).toHaveBeenCalledOnce()
  expect(native.connect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pishock', username: 'user', userId: 12, clientId: 34, shocker: '56' }))
  expect(useDevices.getState().selectedId).toBe(1)
  useAccount.setState({ status: SIGNED_OUT })
  expect(native.setPishockEnabled).toHaveBeenLastCalledWith(false)
  expect(useDevices.getState().outputs[0]?.config).toEqual(config)
  expect(useDevices.getState().selectedId).not.toBe(1)
  expect(native.connect).toHaveBeenCalledOnce()
})
