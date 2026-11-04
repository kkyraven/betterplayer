// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { BadgeCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { DiscordIcon } from '@/components/ui/DiscordIcon'
import { Segmented } from '@/components/ui/Segmented'
import { cx } from '@/lib/cx'
import { ipcMessage } from '@/lib/errors'
import { useAccount } from '@/state/account'
import { domErrorCode, domErrorText, useDom } from '@/state/dom'
import { useT } from '@/state/i18n'

export type OAuthProvider = 'google' | 'discord'

export function AgenticLoverForm({ supporter, waiting = false, onOAuth, onSignedIn }: { supporter: boolean; waiting?: boolean; onOAuth?: (provider: OAuthProvider) => void; onSignedIn?: () => void }) {
  const t = useT()
  const me = useAccount((s) => s.status.me)
  const { login, register, loginWith } = useDom.getState()
  const [mode, setMode] = useState<'create' | 'signIn'>('create')
  const [email, setEmail] = useState(supporter ? (me?.email ?? '') : '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; taken: boolean; wrong: boolean } | null>(null)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onSignedIn?.()
    } catch (err) {
      const code = domErrorCode(err)
      const text = code ? domErrorText(err) : ipcMessage(err)
      if (text !== 'cancelled') setError({ text, taken: code === 'emailTaken', wrong: code === 'wrongLogin' })
    } finally {
      setBusy(false)
    }
  }
  const oauth = (provider: OAuthProvider) => (onOAuth ? onOAuth(provider) : void run(() => loginWith(provider)))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(() => (mode === 'create' ? register(email.trim(), username.trim(), password) : login(email.trim(), password)))
  }
  const ready = email.trim() && password && (mode === 'signIn' || username.trim())
  return (
    <form className="dom-au" onSubmit={submit} aria-busy={busy}>
      {supporter && mode === 'create' && me?.email && (
        <div className="dom-callout">
          <BadgeCheck />
          <span>{t('dom.signUp.supporter', { email: me.email })}</span>
        </div>
      )}
      <div className="dom-oauth">
        <Button disabled={busy} onClick={() => oauth('google')}><GoogleIcon />Google</Button>
        <Button disabled={busy} onClick={() => oauth('discord')}><DiscordIcon />Discord</Button>
      </div>
      <div className="dom-or">{t('dom.signUp.or')}</div>
      <Segmented options={[{ value: 'create', label: t('dom.signIn.create') }, { value: 'signIn', label: t('dom.signIn.button') }]} value={mode} onChange={(m) => {
        setMode(m)
        setError(null)
      }} label={t('dom.poweredBy')} />
      <input className={cx('input', (error?.taken || error?.wrong) && 'bad')} type="email" autoComplete="email" placeholder={t('dom.signIn.email')} value={email} onChange={(e) => setEmail(e.target.value)} />
      {mode === 'create' && <input className="input" autoComplete="username" placeholder={t('dom.signUp.username')} value={username} onChange={(e) => setUsername(e.target.value)} />}
      <input className={cx('input', error?.wrong && 'bad')} type="password" autoComplete={mode === 'create' ? 'new-password' : 'current-password'} placeholder={t('dom.signIn.password')} value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && (
        <span className="dom-err" role="alert">
          {error.text}
          {error.taken && (
            <>
              {' '}
              <button type="button" className="dom-err-link" onClick={() => {
                setMode('signIn')
                setError(null)
              }}>{t('dom.signIn.button')}</button>
            </>
          )}
        </span>
      )}
      <Button variant={waiting ? 'default' : 'primary'} type="submit" className="dom-au-submit" disabled={busy || !ready}>
        {mode === 'create' ? t('dom.signIn.create') : t('dom.signIn.button')}
      </Button>
      {mode === 'create' && !supporter && <span className="dom-au-hint"><BadgeCheck />{t('dom.signUp.hint')}</span>}
    </form>
  )
}

export function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} fill="currentColor" aria-hidden="true">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
  )
}
