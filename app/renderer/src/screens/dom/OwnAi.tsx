// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { CircleAlert, KeyRound, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { OWN_SERVERS, type OwnModels, type OwnServerId } from '@shared/dom'
import type { Translate } from '@shared/i18n'
import { Button } from '@/components/ui/Button'
import { radioGroupKeyDown } from '@/components/ui/radioKeys'
import { cx } from '@/lib/cx'
import { ipcMessage } from '@/lib/errors'
import { useDom } from '@/state/dom'
import { useT } from '@/state/i18n'
import { ModelCombobox } from './ModelPicker'
import { ServerMark } from './ServerMark'
import { firstChatModel, hostOf, isChatModel, ownServerAt, serverName } from './setup'

const SERVER_IDS: OwnServerId[] = [...OWN_SERVERS.map((s) => s.id), 'custom']

export function ownTrouble(t: Translate, url: string, r: Exclude<OwnModels, { kind: 'ok' }>): { title: string; detail: string; mono: boolean } {
  if (r.kind === 'unreachable') {
    const preset = ownServerAt(url)
    return { title: t('dom.own.unreachable', { host: hostOf(url) }), detail: preset && 'local' in preset ? t('dom.own.startServer', { server: preset.name }) : t('dom.own.checkAddress'), mono: false }
  }
  if (r.kind === 'auth') return { title: r.hasKey ? t('dom.own.keyRejected') : t('dom.own.needsKey'), detail: r.detail, mono: true }
  return { title: t('dom.error.server'), detail: r.detail || String(r.status), mono: true }
}

export function Trouble({ url, result, onRetry, warn }: { url: string; result: Exclude<OwnModels, { kind: 'ok' }>; onRetry?: () => void; warn?: boolean }) {
  const t = useT()
  const trouble = ownTrouble(t, url, result)
  return (
    <div className={cx('dom-res', warn && 'warn')} role="alert">
      {result.kind === 'auth' ? <KeyRound /> : <CircleAlert />}
      <span className="t">
        <b>{trouble.title}</b>
        {trouble.detail && <span className={cx(trouble.mono && 'why')}>{trouble.detail}</span>}
      </span>
      {onRetry && result.kind !== 'auth' && <Button onClick={onRetry}><RefreshCw />{t('common.retry')}</Button>}
    </div>
  )
}

export function ServerSegments({ value, onChange }: { value: OwnServerId; onChange: (id: OwnServerId) => void }) {
  const t = useT()
  return (
    <div className="seg dom-servers" role="radiogroup" aria-label={t('dom.ai.server')} onKeyDown={radioGroupKeyDown}>
      {SERVER_IDS.map((id) => (
        <button key={id} type="button" role="radio" aria-checked={id === value} tabIndex={id === value ? 0 : -1} className={cx(id === value && 'on')} onClick={() => onChange(id)}>
          <ServerMark id={id} />
          {id === 'custom' ? t('settings.section.custom') : OWN_SERVERS.find((s) => s.id === id)?.name}
        </button>
      ))}
    </div>
  )
}

export function OwnAiPanel() {
  const t = useT()
  const ai = useDom((s) => s.ai)
  const hasKey = useDom((s) => s.hasKey)
  const status = useDom((s) => s.ownStatus)
  const { setAi, setKey, checkOwn } = useDom.getState()
  const [custom, setCustom] = useState(false)
  const [key, setKeyDraft] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const address = useRef<HTMLInputElement>(null)
  const first = useRef(true)
  const preset = ownServerAt(ai.ownUrl)
  const local = preset !== undefined && 'local' in preset
  const models = status?.kind === 'ok' ? status.models : []
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const timer = window.setTimeout(() => void commitKey(key), 400)
    return () => window.clearTimeout(timer)
  }, [ai.ownUrl, key])
  useEffect(() => {
    if (local && !ai.ownModel && status?.kind === 'ok') {
      const model = firstChatModel(status.models)
      if (model) void setAi({ ownModel: model })
    }
  }, [local, ai.ownModel, status, setAi])
  const pickServer = (id: OwnServerId) => {
    const next = OWN_SERVERS.find((s) => s.id === id)
    setCustom(!next)
    if (!next) address.current?.focus()
    else if (next.url !== preset?.url) void setAi({ ownUrl: next.url, ownModel: '' })
  }
  const commitKey = async (draft: string) => {
    await checkOwn()
    if (!draft || useDom.getState().ownStatus?.kind === 'unreachable') return
    try {
      await setKey(draft)
      setKeyError(null)
    } catch (err) {
      setKeyError(ipcMessage(err))
      return
    }
    await checkOwn()
    if (useDom.getState().ownStatus?.kind === 'ok') setKeyDraft((k) => (k === draft ? '' : k))
  }
  const trouble = status && status.kind !== 'ok' ? ownTrouble(t, ai.ownUrl, status) : null
  return (
    <>
      <div className="prow">
        <ServerSegments value={custom || !preset ? 'custom' : preset.id} onChange={pickServer} />
      </div>
      <div className="prow">
        <span className="lbl">{t('dom.ai.address')}</span>
        <span className="spacer" />
        <input ref={address} className="input mono dom-ctl" value={ai.ownUrl} spellCheck={false} aria-label={t('dom.ai.address')} onChange={(e) => void setAi({ ownUrl: e.target.value })} />
      </div>
      <div className="prow">
        <span className="lbl">{t('dom.ai.key')}</span>
        <span className="spacer" />
        <input className={cx('input mono dom-ctl', status?.kind === 'auth' && 'bad')} type="password" value={key} spellCheck={false} aria-label={t('dom.ai.key')} placeholder={hasKey ? '••••••••' : preset && 'key' in preset ? t('dom.own.needsKey') : t('dom.ai.keyOptional')} onChange={(e) => setKeyDraft(e.target.value)} onBlur={() => void commitKey(key)} />
      </div>
      {keyError && (
        <div className="prow">
          <span className="dom-err" role="alert">{keyError}</span>
        </div>
      )}
      <div className="prow">
        <span className="lbl">{t('dom.ai.model')}</span>
        <span className="spacer" />
        <ModelCombobox models={models} value={ai.ownModel} onPick={(ownModel) => void setAi({ ownModel })} />
      </div>
      {status && (
        <div className="prow dom-stat">
          {trouble ? (
            <>
              <span className="s bad"><span className="dot danger" />{trouble.title}</span>
              {trouble.detail && <span className={cx('meta', trouble.mono && 'mono')}>{trouble.detail}</span>}
              <span className="spacer" />
              <Button onClick={() => void checkOwn()}><RefreshCw />{t('common.retry')}</Button>
            </>
          ) : (
            <>
              <span className="s ok"><span className="dot" />{t('dom.images.connected')}</span>
              <span className="meta">{serverName(ai.ownUrl)} · {t('dom.own.models', { count: models.filter(isChatModel).length })}</span>
              <span className="spacer" />
              <Button variant="ghost" onClick={() => void checkOwn()}><RefreshCw />{t('common.refresh')}</Button>
            </>
          )}
        </div>
      )}
    </>
  )
}
