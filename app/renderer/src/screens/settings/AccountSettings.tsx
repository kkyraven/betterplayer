import { Check, Copy, Heart, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { friendLabel, type Friend } from '@shared/account'
import type { IpcChannel, IpcContract } from '@shared/ipc'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { FriendActions } from '@/components/together/FriendActions'
import './FriendsSettings.css'
import { IconButton } from '@/components/ui/IconButton'
import { Switch } from '@/components/ui/Switch'
import { invoke } from '@/ipc'
import { ipcMessage } from '@/lib/errors'
import { useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { SettingsLink } from './SettingsSection'
import { useTogether } from '@/state/together'
import { Avatar } from '@/components/account/Avatar'
import { ProfilePhotoRow } from '@/components/account/ProfilePhotoRow'

export function AccountSettings({ page = 'profile' }: { page?: 'profile' | 'friends' | 'privacy' }) {
  const t = useT()
  const status = useAccount((s) => s.status)
  const sync = useSettings((s) => s.settings?.account.sync ?? true)
  const update = useSettings((s) => s.update)
  const online = useTogether((s) => s.online)
  const connected = useTogether((s) => s.connected)
  const [saveError, setSaveError] = useState<string | null>(null)
  const saveSync = async (sync: boolean) => {
    setSaveError(null)
    try {
      await update((s) => ({ ...s, account: { ...s.account, sync } }))
    } catch (error) {
      setSaveError(ipcMessage(error))
    }
  }
  const [friendError, setFriendError] = useState<string | null>(null)
  const unfriend = async (id: string) => {
    setFriendError(null)
    try {
      await invoke('account:removeFriend', id)
    } catch (error) {
      setFriendError(ipcMessage(error))
    }
  }
  const me = status.me
  return (
    <div className={`set-account${page === 'friends' && me ? ' set-friends' : ''}`}>
      {saveError && <p className="sub error" role="alert">{t('settings.screen.saveFailed', { message: saveError })}</p>}
      {page === 'profile' && (
        <div className="panel" data-setting="account-state" tabIndex={-1}>
          {status.state === 'signingIn' ? (
            <div className="prow">
              <div className="lbl">{t('settings.profile.finishInBrowser')}</div>
              <span className="spacer" />
              <Button onClick={() => call('account:cancelLogin')}>{t('common.cancel')}</Button>
            </div>
          ) : !me ? (
            <div className="prow">
              <div>
                <div className="lbl">{t('settings.profile.notSignedIn')}</div>
                {status.error && <div className="sub error">{status.error}</div>}
              </div>
              <span className="spacer" />
              <Button variant="primary" onClick={() => call('account:login')}>
                {t('settings.profile.signIn')}
              </Button>
            </div>
          ) : (
            <div className="prow">
              <div>
                <div className="lbl">{me.email}</div>
                <div className={status.error ? 'sub error' : 'sub'}>{status.error ?? (me.premium ? t('settings.profile.premium') : t('settings.profile.free'))}</div>
              </div>
              <span className="spacer" />
              <Button onClick={() => call('account:logout')}>{t('settings.profile.signOut')}</Button>
            </div>
          )}
          {me && <ProfilePhotoRow me={me} />}
          {me && <NameRow name={me.name} />}
          {me && <CodeRow code={me.friendCode} />}
        </div>
      )}
      {page === 'friends' && !me && <SettingsLink page="profile" label={t('settings.profile.signIn')} />}
      {page === 'friends' && (friendError || status.error) && (
        <p className="sub error" role="alert">
          {friendError || status.error}
        </p>
      )}
      {page === 'friends' && me && (
        <>
          {(status.friends.incoming.length > 0 || status.friends.outgoing.length > 0) && (
            <>
              <span className="eyebrow">{t('settings.friends.requests')}</span>
              <div className="panel">
                {status.friends.incoming.map((f) => (
                  <FriendRow key={f.id} friend={f}>
                    <Button variant="primary" onClick={() => call('account:acceptFriend', f.id)}>
                      <Check />
                      {t('settings.friends.accept')}
                    </Button>
                    <IconButton label={t('settings.friends.decline')} onClick={() => call('account:removeFriend', f.id)}>
                      <X />
                    </IconButton>
                  </FriendRow>
                ))}
                {status.friends.outgoing.map((f) => (
                  <FriendRow key={f.id} friend={f} sub={t('settings.friends.waiting')}>
                    <IconButton label={t('settings.friends.withdraw')} onClick={() => call('account:removeFriend', f.id)}>
                      <X />
                    </IconButton>
                  </FriendRow>
                ))}
              </div>
            </>
          )}
          <div className="friends-roster">
            {status.friends.friends.length === 0 && (
              <div className="friends-empty"><Heart aria-hidden /><span>{t('settings.friends.none')}</span></div>
            )}
            {status.friends.friends.map((f) => (
              <FriendRow key={f.id} friend={f} online={connected && online.includes(f.id)}>
                <FriendActions friend={f} onUnfriend={() => void unfriend(f.id)} />
              </FriendRow>
            ))}
          </div>
          <AddFriend />
        </>
      )}
      {page === 'privacy' && (
        <>
          {!me && <SettingsLink page="profile" label={t('settings.profile.signIn')} detail={t('settings.privacy.syncVideo')} />}
          {me && (
            <>
              {' '}
              <span className="eyebrow">{t('settings.privacy.sync')}</span>
              <div className="panel">
                <div className="prow">
                  <div>
                    <div className="lbl">{t('settings.privacy.syncVideo')}</div>
                    <div className="sub">{t('settings.privacy.syncVideoSub')}</div>
                  </div>
                  <span className="spacer" />
                  <Switch checked={sync} onCheckedChange={(on) => void saveSync(on)} label={t('settings.privacy.syncVideo')} />
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function FriendRow({ friend, online, sub, children }: { friend: Friend; online?: boolean; sub?: string; children: React.ReactNode }) {
  return (
    <div className="prow friend-row">
      <Avatar name={friendLabel(friend)} url={friend.avatarUrl} />
      <div className="fr-n">
        <div className="lbl">{friendLabel(friend)}{online !== undefined && <span className={`dot ${online ? '' : 'idle'}`} aria-hidden />}</div>
        <div className="sub">{[friend.name && friend.code, sub].filter(Boolean).join(' · ')}</div>
      </div>
      <span className="spacer" />
      {children}
    </div>
  )
}

function NameRow({ name }: { name: string }) {
  const t = useT()
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])
  const commit = (value: string) => {
    if (value.trim() !== name) call('account:setName', value.trim())
  }
  return (
    <div className="prow">
      <Field label={t('settings.profile.displayName')} hint={t('settings.profile.displayNameHint')}>
        <input
          className="input"
          maxLength={40}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value)
          }}
        />
      </Field>
    </div>
  )
}

function CodeRow({ code }: { code: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <div className="prow">
      <span className="lbl">{t('settings.profile.friendCode')}</span>
      <span className="spacer" />
      <span className="val code">{code}</span>
      <IconButton
        label={copied ? t('common.copied') : t('common.copy')}
        onClick={() =>
          void navigator.clipboard.writeText(code).then(
            () => setCopied(true),
            () => undefined,
          )
        }
      >
        {copied ? <Check /> : <Copy />}
      </IconButton>
    </div>
  )
}

function AddFriend() {
  const t = useT()
  const inputId = useId()
  const ownCode = useAccount((s) => s.status.me?.friendCode)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copyCode = async () => {
    if (!ownCode) return
    setCopyError(null)
    try {
      await navigator.clipboard.writeText(ownCode)
      setCopied(true)
    } catch (error) {
      setCopyError(ipcMessage(error))
    }
  }
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!code.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await invoke('account:addFriend', code)
      setCode('')
    } catch (e) {
      setError(ipcMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="friends-add" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="friends-add-heading">
        <label className="field-label" htmlFor={inputId}>{t('settings.friends.addHint')}</label>
        {ownCode && <button type="button" className="friends-own-code" onClick={() => void copyCode()} aria-live="polite">
          {copied ? t('common.copied') : <>{t('settings.friends.yourCode')}: <span className="mono">{ownCode}</span></>}
        </button>}
      </div>
      <input id={inputId} className="input mono" placeholder="ABCD-EFGH" value={code} onChange={(event) => setCode(event.target.value)} spellCheck={false} autoComplete="off" aria-invalid={error ? true : undefined} />
      <Button type="submit" variant="primary" disabled={!code.trim() || busy}>{t('common.add')}</Button>
      {error && <p className="sub error" role="alert">{error}</p>}
      {copyError && <p className="sub error" role="alert">{copyError}</p>}
    </form>
  )
}

function call<C extends IpcChannel>(channel: C, ...args: Parameters<IpcContract[C]>) {
  void invoke(channel, ...args).catch(() => undefined)
}
