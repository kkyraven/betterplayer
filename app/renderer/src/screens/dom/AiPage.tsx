// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { ExternalLink } from 'lucide-react'
import { AGENTIC_LOVER_URL, DOM_FREE_SECONDS, type AlTier } from '@shared/dom'
import type { MessageKey } from '@shared/i18n'
import { SupporterOffer } from '@/components/account/SupporterOffer'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { cx } from '@/lib/cx'
import { electron } from '@/node'
import { isSubscriber, useAccount } from '@/state/account'
import { useDom } from '@/state/dom'
import { useT } from '@/state/i18n'
import { AgenticLoverForm } from './AgenticLoverForm'
import { OwnAiPanel } from './OwnAi'

export const TIER_LABEL: Record<AlTier, MessageKey> = { free: 'dom.tier.free', pro: 'dom.tier.pro', supporter_plus: 'dom.tier.supporterPlus', supporter_plus_plus: 'dom.tier.supporterPlusPlus' }

export const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

export function AiPage() {
  const t = useT()
  const ai = useDom((s) => s.ai)
  const account = useDom((s) => s.account)
  const subscribed = useAccount(isSubscriber)
  const { setAi } = useDom.getState()
  return (
    <div className="dom-body">
      <div className="page-hd"><h1>{t('dom.ai.title')}</h1></div>
      <div>
        <Segmented options={[{ value: 'agenticlover', label: 'Agentic Lover' }, { value: 'own', label: t('dom.ai.own') }]} value={ai.provider} onChange={(provider) => void setAi({ provider })} label={t('dom.ai.title')} />
      </div>
      {ai.provider === 'own' ? (
        <div className="panel"><OwnAiPanel /></div>
      ) : account.signedIn ? (
        <AgenticLoverAccount />
      ) : (
        <div className="panel dom-au-panel"><AgenticLoverForm supporter={subscribed} /></div>
      )}
      <div className="panel">
        <div className="prow">
          <span className="lbl">{t('dom.ai.tagEditing')}</span>
          <span className="spacer" />
          <Switch checked={ai.tagEditing} onCheckedChange={(tagEditing) => void setAi({ tagEditing })} label={t('dom.ai.tagEditing')} />
        </div>
        <div className="prow">
          <span className="lbl">{t('dom.ai.viewVideo')}</span>
          <span className="spacer" />
          <Switch checked={ai.viewVideo} onCheckedChange={(viewVideo) => void setAi({ viewVideo })} label={t('dom.ai.viewVideo')} />
        </div>
      </div>
      <div>
        <button type="button" className="dom-link" onClick={() => void electron.shell.openExternal(AGENTIC_LOVER_URL)}>agenticlover.ai<ExternalLink /></button>
      </div>
    </div>
  )
}

function AgenticLoverAccount() {
  const t = useT()
  const ai = useDom((s) => s.ai)
  const account = useDom((s) => s.account)
  const subscribed = useAccount(isSubscriber)
  const { setAi, logout } = useDom.getState()
  const free = !subscribed && account.freeSecondsLeft !== null
  const freeLeft = account.freeSecondsLeft ?? 0
  const used = free && freeLeft <= 0
  const share = free ? freeLeft / DOM_FREE_SECONDS : account.tokensLeft
  return (
    <>
      <div className="panel">
        <div className="prow">
          <span>
            <span className="lbl">{t('dom.ai.account')}</span>
            <span className="sub dom-sub">{account.email}</span>
          </span>
          <span className="spacer" />
          <span className={cx('dom-tier', free && 'free')}>{t(free ? 'dom.tier.free' : TIER_LABEL[account.tier])}</span>
          <button type="button" className="dom-link" onClick={() => void logout()}>{t('dom.signOut')}</button>
        </div>
        <div className="prow">
          <span className="lbl">{free ? t('dom.usage.freeMinutes') : t('dom.usage.thisMonth')}</span>
          <span className="spacer" />
          <span className={cx('dom-usage dom-ctl', used && 'warn')}>
            <span className="bar"><i style={{ width: `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%` }} /></span>
            <span className="t">
              {free ? (
                <>
                  <span>{t('dom.usage.minLeft', { minutes: Math.ceil(freeLeft / 60) })}</span>
                  <span>{t('dom.freeOf', { minutes: DOM_FREE_SECONDS / 60 })}</span>
                </>
              ) : (
                <>
                  <span>{t('dom.tokensLeft', { percent: Math.round(account.tokensLeft * 100) })}</span>
                  {account.resetsAt && <span>{t('dom.resets', { date: shortDate(account.resetsAt) })}</span>}
                </>
              )}
            </span>
          </span>
        </div>
        <div className="prow">
          <span className="lbl">{t('dom.ai.model')}</span>
          <span className="spacer" />
          <Select className="dom-ctl" options={[{ value: '', label: t('dom.ai.defaultModel') }, ...account.models.map((m) => ({ value: m.id, label: m.label }))]} value={ai.alModel} onChange={(alModel) => void setAi({ alModel })} label={t('dom.ai.model')} />
        </div>
      </div>
      {free && (used
        ? <SupporterOffer message={t('dom.error.freeTimeUsed')} label={t('dom.buySupporter')} action={{ label: t('dom.plan.own'), onClick: () => void setAi({ provider: 'own' }) }} />
        : <SupporterOffer message={t('dom.offer.full')} label={t('dom.buySupporter')} />)}
    </>
  )
}
