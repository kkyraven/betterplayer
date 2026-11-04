// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { ArrowLeft, BadgeCheck, Check, ChevronRight, Clock, ExternalLink, Lock, Plug, RefreshCw } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AGENTIC_LOVER_URL, DOM_FREE_SECONDS, OWN_SERVERS, type OwnModels, type OwnServerId } from '@shared/dom'
import { SupporterOffer } from '@/components/account/SupporterOffer'
import { Button } from '@/components/ui/Button'
import { DiscordIcon } from '@/components/ui/DiscordIcon'
import { invoke } from '@/ipc'
import { cx } from '@/lib/cx'
import { ipcMessage } from '@/lib/errors'
import { electron } from '@/node'
import { isSubscriber, useAccount } from '@/state/account'
import { useDom } from '@/state/dom'
import { useT } from '@/state/i18n'
import { AgenticLoverForm, GoogleIcon, type OAuthProvider } from './AgenticLoverForm'
import { ModelPicker } from './ModelPicker'
import { FLOW_START, setFlow, useDomNav, type FlowPlan, type FlowStep } from './nav'
import { ServerMark } from './ServerMark'
import { Trouble, ownTrouble } from './OwnAi'
import { firstChatModel, hostOf, isChatModel, ownServerAt, ownServerId, serverName } from './setup'

const AI_STEPS: ReadonlySet<FlowStep> = new Set(['plan', 'signIn', 'browser', 'server', 'key', 'address', 'model'])
const open = (url: string) => void electron.shell.openExternal(url)
const ask = (url: string) => invoke('dom:ownModels', url).catch((error: unknown): OwnModels => ({ kind: 'unreachable', detail: ipcMessage(error) }))

function useMounted() {
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  return live
}

export function FirstRun({ onDone }: { onDone: () => void }) {
  const t = useT()
  const step = useDomNav((s) => s.flow.step)
  const now = AI_STEPS.has(step) ? 0 : 1
  return (
    <div className="dom-fr">
      <nav className="dom-fr-steps" aria-label={t('firstStart.progress')}>
        {[t('dom.ai.title'), t('dom.you')].map((label, i) => (
          <span key={label} className="dom-fr-step-wrap">
            {i > 0 && <span className="dom-fr-gap" />}
            <span className={cx('dom-fr-step', i < now && 'done')} aria-current={i === now ? 'step' : undefined}>
              <span className="n">{i < now ? <Check /> : i + 1}</span>
              {label}
            </span>
          </span>
        ))}
      </nav>
      {step === 'plan' && <PlanStep />}
      {step === 'signIn' && <SignInStep />}
      {step === 'browser' && <BrowserStep />}
      {step === 'server' && <ServerStep />}
      {step === 'key' && <KeyStep />}
      {step === 'address' && <AddressStep />}
      {step === 'model' && <ModelStep />}
      {step === 'you' && <YouStep onDone={onDone} />}
    </div>
  )
}

function Screen({ eyebrow, title, back, actions, children }: { eyebrow?: string; title: string; back?: () => void; actions?: ReactNode; children: ReactNode }) {
  const t = useT()
  return (
    <div className="dom-fr-page">
      <div className="dom-fr-hd">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
      </div>
      {children}
      {(back || actions) && (
        <div className="dom-fr-actions">
          {back && <Button variant="ghost" onClick={back}><ArrowLeft />{t('common.back')}</Button>}
          <span className="spacer" />
          {actions}
        </div>
      )}
    </div>
  )
}

function Pick({ icon, title, sub, mono, value, unit, right, onClick, disabled = false, on = false }: { icon: ReactNode; title: string; sub?: string; mono?: boolean; value?: ReactNode; unit?: string; right?: ReactNode; onClick: () => void; disabled?: boolean; on?: boolean }) {
  return (
    <button type="button" className={cx('dom-pick', on && 'on')} aria-current={on || undefined} aria-disabled={disabled || undefined} onClick={() => !disabled && onClick()}>
      <span className="ic">{icon}</span>
      <span className="t">
        <b>{title}</b>
        {sub && <span className={cx(mono && 'mono')}>{sub}</span>}
      </span>
      {(value !== undefined || unit) && <span className="v">{value !== undefined && <b>{value}</b>}<small>{unit}</small></span>}
      {right}
      <ChevronRight className="go" />
    </button>
  )
}

function AlLink() {
  return (
    <div className="dom-fr-fine">
      <button type="button" className="dom-link" onClick={() => open(AGENTIC_LOVER_URL)}>agenticlover.ai<ExternalLink /></button>
    </div>
  )
}

async function alDone() {
  await useDom.getState().setAi({ provider: 'agenticlover' })
  setFlow({ step: 'you' })
}

function PlanStep() {
  const t = useT()
  const subscribed = useAccount(isSubscriber)
  const signedIn = useDom((s) => s.account.signedIn)
  const pick = (plan: FlowPlan) => {
    if (plan === 'own') setFlow({ plan, step: 'server' })
    else if (signedIn && (plan === 'free' || subscribed)) {
      setFlow({ plan })
      void alDone()
    } else setFlow({ plan, step: 'signIn' })
  }
  return (
    <Screen title={t('dom.flow.chooseAi')}>
      <div className="dom-picks">
        {!subscribed && <Pick icon={<Clock />} title={t('dom.plan.free')} sub={t('dom.plan.free.sub')} value={DOM_FREE_SECONDS / 60} unit={t('dom.plan.free.unit')} onClick={() => pick('free')} />}
        <Pick icon={<BadgeCheck />} title={t('dom.tier.pro')} sub={t('dom.plan.supporter.sub')} value={t('dom.plan.supporter.value')} unit={t('dom.plan.supporter.unit')} onClick={() => pick('supporter')} />
        <Pick icon={<Plug />} title={t('dom.plan.own')} sub={t('dom.plan.own.sub')} onClick={() => pick('own')} />
      </div>
      <AlLink />
    </Screen>
  )
}

function useSubscriptionOnFocus(on: boolean) {
  useEffect(() => {
    if (!on) return
    const check = () => {
      if (useAccount.getState().status.me) void invoke('account:refresh').catch(() => {})
    }
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [on])
}

function SignInStep() {
  const t = useT()
  const plan = useDomNav((s) => s.flow.plan)
  const subscribed = useAccount(isSubscriber)
  const signedIn = useDom((s) => s.account.signedIn)
  const offer = plan === 'supporter' && !subscribed
  useSubscriptionOnFocus(offer)
  const oauth = (provider: OAuthProvider) => {
    setFlow({ step: 'browser' })
    signInWith(provider)
  }
  return (
    <Screen eyebrow={plan === 'supporter' ? t('dom.tier.pro') : t('dom.plan.free')} title="Agentic Lover" back={() => setFlow({ step: 'plan' })} actions={signedIn && <Button variant={offer ? 'default' : 'primary'} onClick={() => void alDone()}>{t('common.continue')}</Button>}>
      {offer && <SupporterOffer message={t('dom.offer.full')} label={t('dom.buySupporter')} />}
      {!signedIn && <AgenticLoverForm key={String(subscribed)} supporter={plan === 'supporter' && subscribed} waiting={offer} onOAuth={oauth} onSignedIn={() => void alDone()} />}
      <AlLink />
    </Screen>
  )
}

function signInWith(provider: OAuthProvider) {
  useDomNav.setState({ oauth: { provider, pending: true, error: null } })
  useDom.getState().loginWith(provider).then(
    () => {
      useDomNav.setState((s) => ({ oauth: { ...s.oauth, pending: false } }))
      void alDone()
    },
    (err: unknown) => {
      const text = ipcMessage(err)
      useDomNav.setState((s) => ({ oauth: { ...s.oauth, pending: false, error: text === 'cancelled' ? null : text } }))
    },
  )
}

function BrowserStep() {
  const t = useT()
  const { provider, pending, error } = useDomNav((s) => s.oauth)
  return (
    <Screen title={t('firstStart.account.inBrowser')} back={pending ? undefined : () => setFlow({ step: 'signIn' })}>
      <div className="dom-fr-browser">
        <span className="tile">{provider === 'google' ? <GoogleIcon /> : <DiscordIcon />}</span>
        {!pending && <Button onClick={() => signInWith(provider)}><ExternalLink />{t('firstStart.account.openAgain')}</Button>}
        {error && <span className="dom-err" role="alert">{error}</span>}
      </div>
    </Screen>
  )
}

function Connected({ url, models }: { url: string; models: readonly string[] }) {
  const t = useT()
  return (
    <div className="dom-stat">
      <span className="s ok"><span className="dot" />{t('dom.images.connected')}</span>
      <span className="meta">{serverName(url)} · {t('dom.own.models', { count: models.filter(isChatModel).length })}</span>
    </div>
  )
}

const LOCAL = OWN_SERVERS.filter((s) => 'local' in s)
const HOSTED = OWN_SERVERS.filter((s) => 'key' in s)

function ServerStep() {
  const t = useT()
  const ai = useDom((s) => s.ai)
  const flow = useDomNav((s) => s.flow)
  const mounted = useMounted()
  const [probed, setProbed] = useState<Partial<Record<OwnServerId, OwnModels['kind']>>>({})
  const [keyed, setKeyed] = useState<Partial<Record<OwnServerId, boolean>>>({})
  const [failed, setFailed] = useState<{ id: OwnServerId; result: Exclude<OwnModels, { kind: 'ok' }> } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    for (const s of LOCAL) void ask(s.url).then((r) => mounted.current && setProbed((p) => ({ ...p, [s.id]: r.kind })))
    for (const s of HOSTED) void invoke('dom:hasKey', s.url).then((has) => mounted.current && setKeyed((k) => ({ ...k, [s.id]: has })), () => {})
  }, [mounted])
  const tryLocal = async (id: OwnServerId, url: string) => {
    setBusy(true)
    const r = await ask(url)
    if (!mounted.current) return
    setBusy(false)
    setProbed((p) => ({ ...p, [id]: r.kind }))
    if (r.kind === 'auth') return setFlow({ server: 'custom', url, model: '', step: 'address' })
    if (r.kind !== 'ok') return setFailed({ id, result: r })
    setFailed(null)
    setFlow({ server: id, url, models: r.models, model: firstChatModel(r.models), step: 'model' })
  }
  useEffect(() => {
    if (!failed) return
    const url = OWN_SERVERS.find((s) => s.id === failed.id)?.url ?? ''
    const retry = () => void tryLocal(failed.id, url)
    window.addEventListener('focus', retry)
    return () => window.removeEventListener('focus', retry)
  })
  const pick = (id: OwnServerId) => {
    setFailed(null)
    const s = OWN_SERVERS.find((x) => x.id === id)
    if (!s) {
      const url = ownServerId(flow.url) === 'custom' ? flow.url : ownServerId(ai.ownUrl) === 'custom' ? ai.ownUrl : ''
      setFlow({ server: 'custom', url, model: '', step: 'address' })
    } else if ('key' in s) setFlow({ server: id, url: s.url, model: '', step: 'key' })
    else void tryLocal(id, s.url)
  }
  const state = (s: (typeof OWN_SERVERS)[number]) => {
    if ('key' in s) return keyed[s.id] === false ? <span className="dom-pk-s">{t('dom.own.needsKey')}</span> : null
    const kind = probed[s.id]
    if (kind === undefined) return null
    if (kind === 'auth') return <span className="dom-pk-s">{t('dom.own.needsKey')}</span>
    const up = kind !== 'unreachable'
    return <span className={cx('dom-pk-s', up && 'ok')}>{up && <span className="dot" />}{up ? t('game.running') : t('vr.notRunning')}</span>
  }
  return (
    <Screen eyebrow={t('dom.plan.own')} title={t('dom.own.pickServer')} back={() => setFlow({ step: 'plan', server: null })}>
      <div className="dom-picks">
        {[...OWN_SERVERS, null].map((s) => {
          const id: OwnServerId = s?.id ?? 'custom'
          const row = <Pick key={id} icon={<ServerMark id={id} />} title={s?.name ?? t('settings.section.custom')} sub={s ? hostOf(s.url) : undefined} mono={!!s} right={s && state(s)} on={flow.server === id} disabled={busy} onClick={() => pick(id)} />
          if (failed?.id !== id || !s) return row
          const trouble = ownTrouble(t, s.url, failed.result)
          return (
            <div key={id} className="dom-pick-box">
              {row}
              <div className="dom-pk-err" role="alert">
                <span className="t">
                  <b>{trouble.title}</b>
                  {trouble.detail && <span className={cx(trouble.mono && 'mono')}>{trouble.detail}</span>}
                </span>
                <Button disabled={busy} onClick={() => void tryLocal(id, s.url)}><RefreshCw />{t('common.retry')}</Button>
              </div>
            </div>
          )
        })}
      </div>
    </Screen>
  )
}

function KeyStep() {
  const t = useT()
  const flow = useDomNav((s) => s.flow)
  const preset = ownServerAt(flow.url)
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Exclude<OwnModels, { kind: 'ok' }> | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const mounted = useMounted()
  useEffect(() => {
    void invoke('dom:hasKey', flow.url).then(setSaved, () => {})
  }, [flow.url])
  const check = async () => {
    setBusy(true)
    setKeyError(null)
    try {
      if (key.trim()) await invoke('dom:setKey', flow.url, key.trim())
      const r = await ask(flow.url)
      if (!mounted.current) return
      if (r.kind !== 'ok') return setResult(r)
      setFlow({ models: r.models, step: 'model' })
    } catch (err) {
      if (mounted.current) setKeyError(ipcMessage(err))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const name = preset?.name ?? hostOf(flow.url)
  return (
    <Screen eyebrow={t('dom.plan.own')} title={t('dom.own.keyTitle', { server: name })} back={() => setFlow({ step: 'server' })} actions={<Button variant="primary" disabled={busy || (!key.trim() && !saved)} onClick={() => void check()}>{t('common.continue')}</Button>}>
      <div className="dom-fr-key">
        <input className={cx('input mono', result?.kind === 'auth' && 'bad')} type="password" autoFocus spellCheck={false} aria-label={t('dom.ai.key')} placeholder={saved ? '••••••••' : t('dom.own.pasteKey')} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (key.trim() || saved) && !busy && void check()} />
        {preset && 'key' in preset && <button type="button" className="dom-link get" onClick={() => open(preset.key)}>{t('dom.own.getKey')}<ExternalLink /></button>}
      </div>
      {keyError && <span className="dom-err" role="alert">{keyError}</span>}
      {result && <Trouble url={flow.url} result={result} onRetry={() => void check()} />}
      <div className="dom-fr-fine"><Lock />{t('dom.own.keySaved', { server: name })}</div>
    </Screen>
  )
}

function AddressStep() {
  const t = useT()
  const flow = useDomNav((s) => s.flow)
  const formId = useId()
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [result, setResult] = useState<OwnModels | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const url = flow.url.trim()
  useEffect(() => {
    setResult(null)
    setKeyError(null)
    if (!url) return
    let live = true
    const timer = window.setTimeout(() => {
      void (async () => {
        let r = await ask(url)
        if (live && r.kind === 'auth' && key.trim()) {
          try {
            await invoke('dom:setKey', url, key.trim())
            r = await ask(url)
          } catch (err) {
            if (live) setKeyError(ipcMessage(err))
          }
        }
        const has = await invoke('dom:hasKey', url).catch(() => false)
        if (!live) return
        setResult(r)
        setSaved(has)
      })()
    }, 400)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [url, key, attempt])
  const ok = result?.kind === 'ok'
  const next = (e: FormEvent) => {
    e.preventDefault()
    if (ok) setFlow({ url, models: result.models, step: 'model' })
  }
  return (
    <Screen eyebrow={t('dom.plan.own')} title={t('dom.own.addressTitle')} back={() => setFlow({ step: 'server' })} actions={<Button variant="primary" type="submit" form={formId} disabled={!ok}>{t('common.continue')}</Button>}>
      <form id={formId} className="dom-fr-form" onSubmit={next}>
        <label className="dom-field">
          <span className="eyebrow">{t('dom.ai.address')}</span>
          <input className="input mono" autoFocus spellCheck={false} placeholder="http://…/v1" value={flow.url} onChange={(e) => setFlow({ url: e.target.value })} />
        </label>
        <label className="dom-field">
          <span className="eyebrow">{t('dom.ai.key')}</span>
          <input className={cx('input mono', result?.kind === 'auth' && 'bad')} type="password" spellCheck={false} placeholder={saved ? '••••••••' : t('dom.ai.keyOptional')} value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
      </form>
      {keyError && <span className="dom-err" role="alert">{keyError}</span>}
      {result && (result.kind === 'ok' ? <Connected url={url} models={result.models} /> : <Trouble url={url} result={result} onRetry={() => setAttempt((a) => a + 1)} />)}
    </Screen>
  )
}

function ModelStep() {
  const t = useT()
  const flow = useDomNav((s) => s.flow)
  const [busy, setBusy] = useState(false)
  const mounted = useMounted()
  const preset = ownServerAt(flow.url)
  const back = () => setFlow({ step: flow.server === 'custom' ? 'address' : preset && 'key' in preset ? 'key' : 'server' })
  const next = async () => {
    if (!flow.model || busy) return
    setBusy(true)
    const { setAi, checkOwn } = useDom.getState()
    try {
      await setAi({ provider: 'own', ownUrl: flow.url, ownModel: flow.model })
      void checkOwn()
      if (mounted.current) setFlow({ step: 'you' })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Screen eyebrow={t('dom.plan.own')} title={t('dom.own.pickModel')} back={back} actions={<Button variant="primary" disabled={!flow.model || busy} onClick={() => void next()}>{t('common.continue')}</Button>}>
      <Connected url={flow.url} models={flow.models} />
      <ModelPicker inline models={flow.models} value={flow.model} onPick={(model) => setFlow({ model })} onSubmit={() => void next()} />
    </Screen>
  )
}

function YouStep({ onDone }: { onDone: () => void }) {
  const t = useT()
  const plan = useDomNav((s) => s.flow.plan)
  const [name, setName] = useState('')
  const [safeword, setSafeword] = useState('')
  const [busy, setBusy] = useState(false)
  const formId = useId()
  const done = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    const { you, setYou, setAi } = useDom.getState()
    try {
      if (name.trim() || safeword.trim()) await setYou({ ...you, name: name.trim() || you.name, safeword: safeword.trim() || you.safeword })
      await setAi({ setupDone: true })
    } finally {
      setBusy(false)
    }
    useDomNav.setState({ flow: FLOW_START })
    onDone()
  }
  return (
    <Screen title={t('dom.you')} back={() => setFlow({ step: plan === 'own' ? 'model' : 'plan' })} actions={<Button variant="primary" type="submit" form={formId} disabled={busy}>{t('common.done')}</Button>}>
      <form id={formId} className="dom-fr-form" onSubmit={(e) => void done(e)}>
        <label className="dom-field">
          <span className="eyebrow">{t('common.name')}</span>
          <input className="input" autoFocus maxLength={100} placeholder={t('common.optional')} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="dom-field">
          <span className="eyebrow">{t('dom.you.safeword')}</span>
          <input className="input" maxLength={100} placeholder={t('common.optional')} value={safeword} onChange={(e) => setSafeword(e.target.value)} />
          <span className="dom-hint">{t('dom.you.safewordHint')}</span>
        </label>
      </form>
    </Screen>
  )
}
