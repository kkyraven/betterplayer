import * as Popover from '@radix-ui/react-popover'
import { Lock, Plus, RefreshCw, Settings2, Snowflake, Tv } from 'lucide-react'
import { useState } from 'react'
import type { OutputState } from 'bp-engine'
import { fmtSpan, type ChasterLock } from '@shared/chaster'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Logo } from '@/components/ui/Logo'
import { useChaster, useMinuteClock } from '@/state/chaster'
import { outputName, useDevices } from '@/state/devices'
import { useT } from '@/state/i18n'
import { FOLLOW_LABELS, useFollow } from '@/state/follow'
import { useRemote } from '@/state/remote'
import { useUi } from '@/state/ui'
import { statusDot, statusText } from '@/screens/devices/status'

export function TitleBar() {
  const t = useT()
  const follow = useFollow((s) => s.state)
  const followKind = useFollow((s) => s.kind)
  const source = useRemote((s) => s.status)
  const chasterLock = useChaster((s) => s.status.lock)
  const setMediaCentre = useUi((s) => s.setMediaCentre)
  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <Logo className="logo" variant="lockup" alt="Beta Player" />
        <span className="titlebar-beta" aria-hidden="true">{t('app.titleBar.beta')}</span>
      </div>
      <div className="spacer" />
      <div className="win-status">
        {chasterLock && <ChastityTime lock={chasterLock} />}
        {source.source && (
          <span className="win-status-item" title={source.error ?? undefined}>
            <span className={`dot ${source.connected ? '' : 'warn'}`} />
            {source.source}
          </span>
        )}
        {follow && (
          <span className="win-status-item">
            <span className={`dot ${follow.status === 'connected' ? '' : follow.status === 'error' ? 'danger' : 'warn'}`} />
            {FOLLOW_LABELS[followKind]}
          </span>
        )}
        <DevicesMenu />
        <button type="button" className="win-status-item icon" aria-label={t('app.titleBar.mediaCentre')} title={t('app.titleBar.mediaCentre')} onClick={() => setMediaCentre(true)}>
          <Tv />
        </button>
      </div>
    </header>
  )
}

function ChastityTime({ lock }: { lock: ChasterLock }) {
  const t = useT()
  const now = useMinuteClock()
  const detail = [lock.title, t('app.titleBar.chaster.locked', { span: fmtSpan(now - lock.startedAt) }), lock.endsAt !== null && t('app.titleBar.chaster.left', { span: fmtSpan(lock.endsAt - now) }), lock.frozen && t('app.titleBar.chaster.frozen')].filter(Boolean).join(' · ')
  return (
    <span className="win-status-item win-chastity" title={detail} aria-label={t('app.titleBar.chaster.label', { detail })}>
      {lock.frozen ? <Snowflake /> : <Lock />}
      {fmtSpan(now - lock.startedAt)}
    </span>
  )
}

function summaryDot(states: Array<OutputState | undefined>): string {
  if (states.length === 0) return 'idle'
  if (states.some((s) => s?.status === 'error')) return 'danger'
  if (states.some((s) => s?.status !== 'connected')) return 'warn'
  return ''
}

function DevicesMenu() {
  const t = useT()
  const outputs = useDevices((s) => s.outputs)
  const states = useDevices((s) => s.states)
  const reconnect = useDevices((s) => s.reconnect)
  const select = useDevices((s) => s.select)
  const setScreen = useUi((s) => s.setScreen)
  const openWizard = useUi((s) => s.setDeviceWizard)
  const [open, setOpen] = useState(false)
  const label = outputs.length === 0 ? t('app.titleBar.devices') : outputs.length <= 2 ? outputs.map((o) => outputName(o.config)).join(' · ') : t('app.titleBar.deviceCount', { count: outputs.length })
  const dot = summaryDot(outputs.map((o) => states[o.id]))
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="win-status-item" aria-label={t('app.titleBar.devicesLabel', { label })}>
          <span className={`dot ${dot}`} />
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="win-menu win-devices" align="end" sideOffset={6} collisionPadding={12}>
          {outputs.length === 0 && <p className="wd-empty faint">{t('app.titleBar.noDevices')}</p>}
          <ul>
            {outputs.map((o) => {
              const state = states[o.id]
              const status = [statusText(state), state?.battery !== undefined && `${state.battery}%`].filter(Boolean).join(' · ')
              return (
                <li key={o.id} className="wd-row">
                  <span className={`dot ${statusDot(state?.status)}`} />
                  <span className="wd-t">
                    <span className="wd-n">{outputName(o.config)}</span>
                    <span className="wd-s" title={status}>
                      {status}
                    </span>
                  </span>
                  <IconButton size="sm" label={t('app.titleBar.reconnect')} onClick={() => reconnect(o.id)}>
                    <RefreshCw />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={t('app.titleBar.deviceSettings')}
                    onClick={() => {
                      select(o.id)
                      setScreen('devices')
                      setOpen(false)
                    }}
                  >
                    <Settings2 />
                  </IconButton>
                </li>
              )
            })}
          </ul>
          <div className="wd-foot">
            <Button
              onClick={() => {
                setOpen(false)
                openWizard(true)
              }}
            >
              <Plus />
              {t('app.titleBar.addDevice')}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
