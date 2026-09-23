import * as Popover from '@radix-ui/react-popover'
import { ArrowLeft, Bell, ChevronRight, CircleUser, ExternalLink, Hand, LogOut, MonitorPlay, RefreshCw, Star, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { DiscordIcon } from '@/components/ui/DiscordIcon'
import { IconButton } from '@/components/ui/IconButton'
import { FriendsList } from '@/components/together/FriendsList'
import { AccountSettings } from '@/screens/settings/AccountSettings'
import { focusSetting, markSettingRows } from '@/screens/settings/search'
import { PAGE_LABELS } from '@/screens/settings/navigation'
import { useAccount } from '@/state/account'
import { useAccountNavigation } from '@/state/accountNavigation'
import { useT } from '@/state/i18n'
import { openSettings } from '@/state/settingsNavigation'
import { invoke } from '@/ipc'
import { ipcMessage } from '@/lib/errors'
import { electron } from '@/node'
import '@/screens/settings/settings.css'
import './AccountPanel.css'
import { Avatar } from './Avatar'

export function AccountPanel({ floating = false }: { floating?: boolean }) {
  const t = useT()
  const status = useAccount((s) => s.status)
  const { open, page, target, revision, show, close } = useAccountNavigation()
  const [controlInvite, setControlInvite] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const headingId = useId()
  const requestsId = useId()
  const body = useRef<HTMLDivElement>(null)
  const me = status.me
  const requests = status.friends.incoming.length
  const title = page === 'home' ? t('settings.category.account') : t(PAGE_LABELS[page])
  const discordLink = (
    <button type="button" onClick={() => void electron.shell.openExternal('https://discord.gg/BXS33KP3FU').catch((error: unknown) => setError(ipcMessage(error)))}>
      <DiscordIcon /><span>{t('account.discordSupport')}</span><ExternalLink />
    </button>
  )
  const togetherActions = (
    <div className="account-features">
      <Button aria-pressed={!controlInvite} onClick={() => { setControlInvite(false); if (!me || !status.friends.friends.length) show('friends') }}><MonitorPlay />{t('together.friends.watchTogether')}</Button>
      <Button aria-pressed={controlInvite} onClick={() => { setControlInvite(true); if (!me || !status.friends.friends.length) show('friends') }}><Hand />{t('together.friends.giveControl')}</Button>
    </div>
  )
  const focusPage = useCallback(() => {
    if (target && target !== 'page' && body.current) {
      markSettingRows(body.current)
      focusSetting(body.current, target)
    } else heading.current?.focus()
  }, [target])
  useEffect(() => {
    if (!open || page !== 'home') setControlInvite(false)
    if (open) focusPage()
    setError(null)
  }, [open, page, focusPage, revision])
  const signOut = async () => {
    try {
      await invoke('account:logout')
    } catch (error) {
      setError(ipcMessage(error))
    }
  }
  return (
    <Popover.Root open={open} onOpenChange={(next) => next ? show() : close()}>
      <Popover.Trigger asChild>
        <button type="button" className={`rail-btn account-trigger${floating ? ' account-trigger-floating' : ''}`} hidden={floating && !open} aria-label={t('settings.category.account')} aria-describedby={requests > 0 ? requestsId : undefined}>
          <Avatar name={me?.name ?? ''} url={me?.avatarUrl} />
          {requests > 0 && <><span className="account-badge" aria-hidden>{requests}</span><span className="sr-only" id={requestsId}>{t('settings.friends.requests')}: {requests}</span></>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="account-panel" data-page={page} side="right" align="end" sideOffset={12} collisionPadding={12} aria-labelledby={headingId} onOpenAutoFocus={(event) => { event.preventDefault(); focusPage() }} onKeyDown={(event) => event.stopPropagation()}>
          <header className="account-heading">
            {page !== 'home' && <IconButton label={t('common.back')} onClick={() => show()}><ArrowLeft /></IconButton>}
            {page === 'home' && <Avatar name={me?.name ?? ''} url={me?.avatarUrl} size={40} />}
            <div className="account-heading-text">
              <h2 id={headingId} ref={heading} tabIndex={-1}>{page === 'home' ? me?.name || me?.friendCode || title : title}</h2>
              {page === 'home' && <span className="sub">{t(me ? me.premium ? 'settings.profile.premium' : 'settings.profile.free' : status.state === 'signingIn' ? 'settings.profile.finishInBrowser' : 'settings.profile.notSignedIn')}</span>}
            </div>
            {page === 'home' && !me && (
              <Button variant={status.state === 'signingIn' ? 'default' : 'primary'} onClick={() => {
                setError(null)
                void invoke(status.state === 'signingIn' ? 'account:cancelLogin' : 'account:login').catch((error: unknown) => setError(ipcMessage(error)))
              }}>
                {t(status.state === 'signingIn' ? 'common.cancel' : 'settings.profile.signIn')}
              </Button>
            )}
            <Popover.Close asChild><IconButton label={t('common.close')}><X /></IconButton></Popover.Close>
          </header>
          {error && <p className="account-error" role="alert">{error}</p>}
          <div className="account-body" ref={body} aria-label={title}>
            {page !== 'home' ? <AccountSettings page={page} /> : !me ? (
              <>
                {status.error && <p className="account-error" role="alert">{status.error}</p>}
                {togetherActions}
                <div className="account-links account-footer">
                  <button type="button" onClick={() => show('privacy')}><RefreshCw /><span>{t('settings.page.privacy')}</span><ChevronRight /></button>
                  {discordLink}
                </div>
              </>
            ) : (
              <>
                {status.error && <p className="account-error" role="alert">{status.error}</p>}
                {togetherActions}
                <FriendsList giveControl={controlInvite} onInvite={close} onAddFriend={() => show('friends')} />
                {(requests > 0 || status.friends.outgoing.length > 0) && <div className="account-links">
                  <button type="button" onClick={() => show('friends')}><Bell /><span>{t('settings.friends.requests')}</span><span className="account-request-count">{requests + status.friends.outgoing.length}</span></button>
                </div>}
                <div className="account-links account-footer">
                  <button type="button" onClick={() => show('profile')}><CircleUser /><span>{t('settings.page.profile')}</span><ChevronRight /></button>
                  <button type="button" onClick={() => show('privacy')}><RefreshCw /><span>{t('settings.page.privacy')}</span><ChevronRight /></button>
                  <button type="button" onClick={() => { close(); openSettings('support') }}><Star /><span>{t('settings.page.support')}</span><ChevronRight /></button>
                  {discordLink}
                  <button type="button" onClick={() => void signOut()}><LogOut /><span>{t('settings.profile.signOut')}</span></button>
                </div>
              </>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
