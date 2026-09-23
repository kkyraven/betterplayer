import { useEffect, useState } from 'react'
import type { RemoteStatus } from '@shared/ipc'
import { REMOTE_PORT_DEFAULT, REMOTE_PORT_MAX, REMOTE_PORT_MIN } from '@shared/settings'
import { Field } from '@/components/ui/Field'
import { Switch } from '@/components/ui/Switch'
import { invoke, on } from '@/ipc'
import { SettingsAdvanced } from './SettingsSection'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'

export function RemoteSettings() {
  const t = useT()
  const remote = useSettings((s) => s.settings?.remote)
  const update = useSettings((s) => s.update)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [portError, setPortError] = useState(false)
  const [port, setPort] = useState(String(remote?.port ?? REMOTE_PORT_DEFAULT))
  const [password, setPassword] = useState(remote?.password ?? '')

  useEffect(() => {
    void invoke('remote:status').then(setStatus)
    return on('remote:status', setStatus)
  }, [])

  const stored = remote?.port
  useEffect(() => {
    if (stored !== undefined) setPort(String(stored))
  }, [stored])
  const storedPassword = remote?.password
  useEffect(() => {
    if (storedPassword !== undefined) setPassword(storedPassword)
  }, [storedPassword])
  const commitPassword = (value: string) => {
    if (value !== storedPassword) void update((s) => ({ ...s, remote: { ...s.remote, password: value } }))
  }

  const commitPort = (value: string) => {
    const next = Number(value)
    if (!Number.isInteger(next) || next < REMOTE_PORT_MIN || next > REMOTE_PORT_MAX) {
      setPortError(true)
      return
    }
    setPortError(false)
    if (next === stored) return
    void update((s) => ({ ...s, remote: { ...s.remote, port: next } }))
  }

  return (
    <div className="set-remote">
      <div className="panel">
        <div className="prow">
          <span className="lbl">{t('settings.sharing.serve')}</span>
          <span className="spacer" />
          <Switch
            checked={remote?.enabled ?? false}
            onCheckedChange={(enabled) => void update((s) => ({ ...s, remote: { ...s.remote, enabled } }))}
            label={t('settings.sharing.serve')}
          />
        </div>
        <div className="prow">
          <Field label={t('settings.sharing.password')}>
            <input
              className="input"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={(e) => commitPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitPassword(e.currentTarget.value)
              }}
            />
          </Field>
        </div>
        {status?.running && status.urls.length > 0 && (
          <div className="prow">
            <span className="urls">
              {status.urls.map((url) => (
                <span key={url} className="val">
                  {remote?.password ? url.replace('http://', 'http://bp:••••@') : url}
                </span>
              ))}
              <span className="sub">{t('settings.sharing.enterAddress')}</span>
            </span>
          </div>
        )}
      </div>
      <SettingsAdvanced page="sharing" error={portError ? t('settings.sharing.invalidPort') : undefined} custom={remote?.port !== undefined && remote.port !== REMOTE_PORT_DEFAULT}>
        <div className="panel">
          <div className="prow">
            {' '}
            <Field label={t('settings.sharing.port')}>
              <input
                className="input mono"
                inputMode="numeric"
                aria-invalid={portError}
                aria-describedby={portError ? 'port-error' : undefined}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                onBlur={(e) => commitPort(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitPort(e.currentTarget.value)
                }}
              />
            </Field>
            {portError && (
              <span id="port-error" className="sub error" role="alert">
                {t('settings.sharing.invalidPortRange', { min: REMOTE_PORT_MIN, max: REMOTE_PORT_MAX })}
              </span>
            )}
          </div>
        </div>
      </SettingsAdvanced>
    </div>
  )
}
