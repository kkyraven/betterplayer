import { useEffect, useState } from 'react'
import { fmtSpan } from '@shared/chaster'
import { Field } from '@/components/ui/Field'
import { useChaster, useMinuteClock } from '@/state/chaster'
import { useGooner } from '@/state/gooner'
import { useT } from '@/state/i18n'
import { SettingsLink } from './SettingsSection'
import { useSettings } from '@/state/settings'

export function ChasterSettings() {
  const t = useT()
  const token = useSettings((s) => s.settings?.chaster.token ?? '')
  const update = useSettings((s) => s.update)
  const status = useChaster((s) => s.status)
  const held = useGooner((s) => s.locked && s.gooner.lock?.kind === 'chaster')
  const now = useMinuteClock()
  const [draft, setDraft] = useState(token)

  useEffect(() => setDraft(token), [token])

  const commit = (value: string) => {
    if (held || value.trim() === token) return
    void update((s) => ({ ...s, chaster: { token: value.trim() } }))
  }

  const statusText =
    status.state === 'off'
      ? t('settings.chaster.notConnected')
      : status.state === 'connecting'
        ? t('common.connecting')
        : status.state === 'ok'
          ? t('settings.chaster.connectedAs', { name: status.username ?? '' })
          : (status.error ?? t('common.error'))
  const lock = status.lock
  const lockText = lock
    ? [
        t('settings.chaster.lockedFor', { span: fmtSpan(now - lock.startedAt) }),
        lock.endsAt !== null ? t('settings.chaster.left', { span: fmtSpan(lock.endsAt - now) }) : t('settings.chaster.timeHidden'),
        lock.frozen && t('settings.chaster.frozen'),
        lock.keyholder && t('settings.chaster.keyholder', { name: lock.keyholder }),
      ]
        .filter(Boolean)
        .join(' · ')
    : null

  return (
    <>
      <div className="panel set-chaster" data-setting="chaster-connection" tabIndex={-1}>
        <div className="prow">
          <Field label={t('settings.chaster.developerToken')} hint={t('settings.chaster.tokenHint')}>
            <input
              className="input mono"
              type="password"
              autoComplete="off"
              value={draft}
              disabled={held}
              title={held ? t('settings.chaster.held') : undefined}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={(e) => commit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit(e.currentTarget.value)
              }}
            />
          </Field>
        </div>
        {held && <div className="prow sub">{t('settings.chaster.held')}</div>}
        <div className="prow">
          <span className="lbl">{t('settings.chaster.status')}</span>
          <span className="spacer" />
          <span className={status.state === 'error' ? 'val error' : 'val'}>{statusText}</span>
        </div>
        {lock && lockText && (
          <div className="prow">
            <span>
              <div className="lbl">{lock.title}</div>
              <div className="sub">{lockText}</div>
            </span>
          </div>
        )}
      </div>
      <SettingsLink page="gooner" />
    </>
  )
}
