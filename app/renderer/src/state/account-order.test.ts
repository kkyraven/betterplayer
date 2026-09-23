import { beforeEach, expect, it, vi } from 'vitest'
import { SIGNED_OUT, type AccountStatus } from '@shared/account'
const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), stop: vi.fn() }))
vi.mock('@/ipc', () => ({ invoke: ipc.invoke, on: ipc.on }))
vi.mock('@/lib/errors', () => ({ ipcMessage: String }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
import { startAccount, useAccount } from './account'
const premium: AccountStatus = {
  ...SIGNED_OUT,
  state: 'in',
  me: { id: 'a', name: 'A', email: 'a@example.com', premium: true, admin: false, friendCode: 'AAAA-BBBB' },
}
let publish: (status: AccountStatus) => void
beforeEach(() => {
  vi.resetAllMocks()
  useAccount.setState({ status: SIGNED_OUT, token: null })
  ipc.on.mockImplementation((_channel, handler) => {
    publish = handler
    return ipc.stop
  })
})
it('applies entitlement immediately and ignores token completion after sign-out', async () => {
  let finish!: (token: string) => void
  ipc.invoke.mockImplementation((channel) =>
    channel === 'account:status'
      ? Promise.resolve(SIGNED_OUT)
      : new Promise<string>((resolve) => {
          finish = resolve
        }),
  )
  const stop = startAccount()
  await Promise.resolve()
  publish(premium)
  expect(useAccount.getState().status).toBe(premium)
  publish(SIGNED_OUT)
  finish('old-session-token')
  await Promise.resolve()
  expect(useAccount.getState()).toMatchObject({ status: SIGNED_OUT, token: null })
  stop()
})
it('does not replace a newer account event with the startup snapshot', async () => {
  let initial!: (status: AccountStatus) => void
  ipc.invoke.mockImplementation((channel) =>
    channel === 'account:status'
      ? new Promise<AccountStatus>((resolve) => {
          initial = resolve
        })
      : Promise.resolve('old-token'),
  )
  const stop = startAccount()
  publish(SIGNED_OUT)
  initial(premium)
  await Promise.resolve()
  expect(useAccount.getState().status).toBe(SIGNED_OUT)
  expect(ipc.invoke).not.toHaveBeenCalledWith('account:token')
  stop()
})
it('does not apply asynchronous results after cleanup', async () => {
  let initial!: (status: AccountStatus) => void
  ipc.invoke.mockReturnValue(
    new Promise<AccountStatus>((resolve) => {
      initial = resolve
    }),
  )
  const stop = startAccount()
  stop()
  initial(premium)
  await Promise.resolve()
  expect(useAccount.getState().status).toBe(SIGNED_OUT)
})
