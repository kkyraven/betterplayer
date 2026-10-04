// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { BadgeCheck, Clock, Download, Image, Play, Plug, RefreshCw } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { DOM_FREE_SECONDS, type DomProfile } from '@shared/dom'
import { Button } from '@/components/ui/Button'
import { DiscordIcon } from '@/components/ui/DiscordIcon'
import { Segmented } from '@/components/ui/Segmented'
import { cx } from '@/lib/cx'
import { ipcMessage } from '@/lib/errors'
import { isPremium, useAccount } from '@/state/account'
import { domErrorCode, domErrorText, useDom } from '@/state/dom'
import { useT } from '@/state/i18n'
import { OwnAiFields } from './OwnAi'
import { Portrait } from './Portrait'

type Plan = 'free' | 'supporter' | 'own'

export function GetStarted({ dom }: { dom: DomProfile | null }) {
  const t = useT()
  const premium = useAccount(isPremium)
  const running = useDom((s) => s.running)
  const [picked, setPicked] = useState<Plan>(premium ? 'supporter' : 'free')
  const plan = premium && picked === 'free' ? 'supporter' : picked
  const { setAi, start } = useDom.getState()
  const runOwn = async () => {
    await setAi({ provider: 'own' })
    if (dom) await start(dom.id)
  }
  const card = (id: Plan, icon: ReactNode, title: string, sub: string, value: ReactNode, unit: string) => (
    <button type="button" className={cx('dom-plan', plan === id && 'on')} aria-pressed={plan === id} onClick={() => setPicked(id)}>
      <b>{icon}{title}</b>
      <span>{sub}</span>
      <span className="big">{value} <small>{unit}</small></span>
    </button>
  )
  return (
    <div className="dom-start-page">
      {dom && (
        <div className="dom-hd">
          <Portrait dom={dom} className="dom-ava lg" />
          <h1>{dom.name || t('dom.newName')}</h1>
        </div>
      )}
      <div className={cx('dom-plans', premium && 'two')}>
        {!premium && card('free', <Clock />, t('dom.plan.free'), t('dom.plan.free.sub'), DOM_FREE_SECONDS / 60, t('dom.plan.free.unit'))}
        {card('supporter', <BadgeCheck />, t('dom.tier.pro'), t('dom.plan.supporter.sub'), t('dom.plan.supporter.value'), t('dom.plan.supporter.unit'))}
        {card('own', <Plug />, t('dom.plan.own'), t('dom.plan.own.sub'), t('dom.tier.free'), t('dom.plan.own.unit'))}
      </div>
      {plan === 'own' ? (
        <>
          <div className="panel"><OwnAiFields /></div>
          <div>
            <Button variant="primary" className="dom-start" disabled={running} onClick={() => void runOwn()}>
              {dom && <Play />}
              {dom ? t('dom.start') : t('common.continue')}
            </Button>
          </div>
        </>
      ) : (
        <div className="dom-signup">
          <AgenticLoverForm key={String(plan === 'supporter' && premium)} supporter={plan === 'supporter' && premium} />
          <div className="dom-signup-why">
            <span className="eyebrow">{t('dom.signUp.why')}</span>
            <span><Download />{t('dom.import')}</span>
            <span><RefreshCw />{t('dom.memory.synced')}</span>
            <span><Image />{t('dom.signUp.pictures')}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function AgenticLoverForm({ supporter }: { supporter: boolean }) {
  const t = useT()
  const me = useAccount((s) => s.status.me)
  const { login, register, loginWith } = useDom.getState()
  const [mode, setMode] = useState<'create' | 'signIn'>('create')
  const [email, setEmail] = useState(supporter ? (me?.email ?? '') : '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; taken: boolean } | null>(null)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      const code = domErrorCode(err)
      const text = code ? domErrorText(err) : ipcMessage(err)
      if (text !== 'cancelled') setError({ text, taken: code === 'emailTaken' })
    } finally {
      setBusy(false)
    }
  }
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
        <Button disabled={busy} onClick={() => void run(() => loginWith('google'))}><GoogleIcon />Google</Button>
        <Button disabled={busy} onClick={() => void run(() => loginWith('discord'))}><DiscordIcon />Discord</Button>
      </div>
      <div className="dom-or">{t('dom.signUp.or')}</div>
      <Segmented options={[{ value: 'create', label: t('dom.signIn.create') }, { value: 'signIn', label: t('dom.signIn.button') }]} value={mode} onChange={(m) => {
        setMode(m)
        setError(null)
      }} label={t('dom.poweredBy')} />
      <input className={cx('input', error?.taken && 'bad')} type="email" autoComplete="email" placeholder={t('dom.signIn.email')} value={email} onChange={(e) => setEmail(e.target.value)} />
      {mode === 'create' && <input className="input" autoComplete="username" placeholder={t('dom.signUp.username')} value={username} onChange={(e) => setUsername(e.target.value)} />}
      <input className="input" type="password" autoComplete={mode === 'create' ? 'new-password' : 'current-password'} placeholder={t('dom.signIn.password')} value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && (
        <span className="dom-err">
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
      <Button variant="primary" type="submit" className="dom-au-submit" disabled={busy || !ready}>
        {mode === 'create' ? t('dom.signIn.create') : t('dom.signIn.button')}
      </Button>
      {mode === 'create' && !supporter && <span className="dom-au-hint"><BadgeCheck />{t('dom.signUp.hint')}</span>}
    </form>
  )
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} fill="currentColor" aria-hidden="true">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
  )
}
