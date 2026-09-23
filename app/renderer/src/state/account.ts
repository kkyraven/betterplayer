import { create } from 'zustand'
import { SIGNED_OUT, type AccountStatus } from '@shared/account'
import { invoke, on } from '@/ipc'
import { ipcMessage } from '@/lib/errors'
import { t } from './i18n'

interface AccountStore {
  status: AccountStatus
  token: string | null
}

export const useAccount = create<AccountStore>()(() => ({ status: SIGNED_OUT, token: null }))

export function startAccount(): () => void {
  let revision = 0
  let disposed = false
  const take = async (status: AccountStatus) => {
    if (disposed) return
    const current = ++revision
    const needsToken = status.state === 'in' || status.state === 'error'
    const previous = useAccount.getState()
    const keptToken = needsToken && previous.status.me?.id === status.me?.id ? previous.token : null
    useAccount.setState({ status, token: keptToken })
    if (!needsToken) return
    let token: string | null = null
    try { token = await invoke('account:token') } catch { }
    if (!disposed && current === revision) useAccount.setState({ token })
  }
  const stop = on('account:status', (status) => void take(status))
  const initialRevision = revision
  void invoke('account:status').then((status) => {
    if (revision === initialRevision) void take(status)
  }).catch(() => {})
  return () => { disposed = true; revision++; stop() }
}

export const isPremium = (s: AccountStore) => s.status.me?.premium === true
export const isFree = (s: AccountStore) => s.status.state === 'out' || (s.status.me !== null && !s.status.me.premium)

export async function checkSupporter(): Promise<string | null> {
  try {
    await invoke(useAccount.getState().status.me ? 'account:refresh' : 'account:login')
    const account = useAccount.getState().status
    return account.error ?? (account.me?.premium ? null : t('account.notSubscribed'))
  } catch (error) {
    return ipcMessage(error)
  }
}
