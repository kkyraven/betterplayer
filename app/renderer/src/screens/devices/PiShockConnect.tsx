// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { useEffect, useRef, useState } from 'react'
import { SUBSCRIBE_URL } from '@shared/account'
import { readPiShockDevices, readPiShockUser, type PiShockShocker } from '@shared/pishock'
import { defaultOpenShockTrigger, type OutputConfig } from '@shared/settings'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { electron } from '@/node'
import { checkSupporter, isPremium, useAccount } from '@/state/account'
import { useDevices } from '@/state/devices'
import { useT } from '@/state/i18n'

export function PiShockConnect({ onConnect }: { onConnect: (config: OutputConfig) => Promise<void> }) {
  const t = useT()
  const premium = useAccount(isPremium)
  const outputs = useDevices((s) => s.outputs)
  const [username, setUsername] = useState('')
  const [key, setKey] = useState('')
  const [found, setFound] = useState<{ userId: number; shockers: PiShockShocker[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (!premium) {
      request.current?.abort()
      setFound(null)
      setBusy(false)
    }
  }, [premium])
  const change = () => {
    request.current?.abort()
    request.current = null
    setFound(null)
    setError(null)
    setBusy(false)
  }
  const lookup = async () => {
    if (!isPremium(useAccount.getState())) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setFound(null)
    setError(null)
    const timer = window.setTimeout(() => controller.abort(), 10_000)
    try {
      const auth = new URL('https://auth.pishock.com/Auth/GetUserIfAPIKeyValid')
      auth.search = new URLSearchParams({ apikey: key.trim(), username: username.trim() }).toString()
      const response = await fetch(auth, { signal: controller.signal })
      if (!response.ok) throw new Error()
      const userId = readPiShockUser(await response.json(), t)
      const devices = new URL('https://ps.pishock.com/PiShock/GetUserDevices')
      devices.search = new URLSearchParams({ UserId: String(userId), Token: key.trim(), api: 'true' }).toString()
      const listed = await fetch(devices, { signal: controller.signal })
      if (!listed.ok) throw new Error()
      const shockers = readPiShockDevices(await listed.json(), t)
      if (request.current === controller && !controller.signal.aborted && isPremium(useAccount.getState())) setFound({ userId, shockers })
    } catch {
      if (request.current === controller) setError(t('devices.pishock.lookupError'))
    } finally {
      window.clearTimeout(timer)
      if (request.current === controller) setBusy(false)
    }
  }
  if (!premium)
    return (
      <div className="panel shock-setup">
        <div className="prow">
          <span>{t('common.supporterOnly')}</span>
          <Button variant="primary" onClick={() => void electron.shell.openExternal(SUBSCRIBE_URL)}>
            {t('firstStart.supporter.become')}
          </Button>
          <Button onClick={() => void checkSupporter().then(setError)}>{t('firstStart.supporter.refresh')}</Button>
        </div>
        {error && <p className="prow" role="alert">{error}</p>}
      </div>
    )
  const rows = found?.shockers.filter((s) => !outputs.some((o) => o.config.kind === 'pishock' && o.config.shocker === s.id && o.config.clientId === s.clientId))
  return (
    <div className="panel shock-setup">
      <div className="prow">
        <Field label={t('devices.pishock.username')}>
          <input
            className="input"
            autoComplete="off"
            value={username}
            onChange={(e) => {
              change()
              setUsername(e.target.value)
            }}
          />
        </Field>
      </div>
      <div className="prow">
        <Field label={t('devices.pishock.apiKey')} hint={t('devices.shock.scriptHint')}>
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => {
              change()
              setKey(e.target.value)
            }}
          />
        </Field>
      </div>
      <div className="prow">
        <Button disabled={busy || !username.trim() || !key.trim()} onClick={() => void lookup()}>
          {t(busy ? 'devices.wizard.checking' : 'devices.pishock.lookup')}
        </Button>
      </div>
      {error && <p className="prow" role="alert">{error}</p>}
      {rows?.map((s) => (
        <div className="prow" key={`${s.clientId}:${s.id}`}>
          <span className="lbl">{s.name}</span>
          <span className="sub">{s.hub}</span>
          <span className="spacer" />
          {s.paused ? (
            <span>{t('devices.wizard.paused')}</span>
          ) : (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                if (!found || !isPremium(useAccount.getState())) return
                setBusy(true)
                void onConnect({
                  kind: 'pishock',
                  profile: 'stroker',
                  username: username.trim(),
                  token: key.trim(),
                  userId: found.userId,
                  clientId: s.clientId,
                  shocker: s.id,
                  name: s.name,
                  trigger: defaultOpenShockTrigger(),
                }).catch(() => {
                  setBusy(false)
                  setError(t('devices.pishock.lookupError'))
                })
              }}
            >
              {t('devices.wizard.connect')}
            </Button>
          )}
        </div>
      ))}
      {rows?.length === 0 && <p className="prow">{t('devices.wizard.noShockers')}</p>}
    </div>
  )
}
