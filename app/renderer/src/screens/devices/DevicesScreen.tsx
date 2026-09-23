import { isPremium, useAccount } from '@/state/account'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cx } from '@/lib/cx'
import { outputName, useDevices } from '@/state/devices'
import { FOLLOW_LABELS, useFollow } from '@/state/follow'
import { openSettings, useSettingsNavigation } from '@/state/settingsNavigation'
import { useT } from '@/state/i18n'
import { useIntifaceStatus } from '@/state/intiface'
import { useUi } from '@/state/ui'
import { OutputDetail } from './OutputDetail'
import { statusDot, statusText } from './status'
import './DevicesScreen.css'

export function DevicesScreen() {
  const t = useT()
  const premium = useAccount(isPremium)
  const outputs = useDevices((s) => s.outputs)
  const states = useDevices((s) => s.states)
  const selectedId = useDevices((s) => s.selectedId)
  const select = useDevices((s) => s.select)
  const remove = useDevices((s) => s.remove)
  const openWizard = useUi((s) => s.setDeviceWizard)
  const follow = useFollow((s) => s.state)
  const kind = useFollow((s) => s.kind)
  const intiface = useIntifaceStatus()
  const settingsReturn = useSettingsNavigation((s) => s.returnScreen === 'devices')
  const selected = outputs.find((o) => o.id === selectedId) ?? null

  return (
    <>
      <aside className="dev-list">
        <div className="dev-list-hd">
          <h1>{t('devices.screen.title')}</h1>
          <Button icon aria-label={t('devices.screen.add')} title={t('devices.screen.add')} onClick={() => openWizard(true)}>
            <Plus />
          </Button>
        </div>
        {outputs.length === 0 && <p className="faint dev-empty">{t('devices.screen.empty')}</p>}
        <ul>
          {outputs.map((o) => {
            const state = states[o.id]
            return (
              <li key={o.id}>
                <button type="button" className={cx('drow', o.id === selectedId && 'on')} onClick={() => select(o.id)} aria-current={o.id === selectedId ? 'true' : undefined}>
                  <span className={`dot ${statusDot(state?.status)}`} />
                  <span className="n">{outputName(o.config)}</span>
                  <span className="t mono">{state?.address ?? o.config.kind}</span>
                  <span className={cx('s', state?.status === 'connected' && 'ok', state?.status === 'error' && 'err')}>{o.config.kind === 'pishock' && !premium ? t('common.supporterOnly') : statusText(state)}</span>
                </button>
                <button type="button" className="drow-x" aria-label={t('devices.screen.remove', { name: outputName(o.config) })} title={t('devices.screen.removeDevice')} onClick={() => void remove(o.id)}>
                  <X />
                </button>
              </li>
            )
          })}
        </ul>
        <div className="dev-follow"><Button variant="ghost" onClick={() => openSettings('headsets')}>{t('devices.screen.headsets')}</Button>{follow && <span className="sub">{FOLLOW_LABELS[kind]} · {follow.status}</span>}</div>
        <div className="dev-intiface"><Button variant="ghost" onClick={() => openSettings('intiface')}>Intiface</Button><span className="sub">{intiface.error ?? (intiface.running ? t('devices.status.connected') : t('common.off'))}</span></div>
        {settingsReturn && <Button onClick={() => { useSettingsNavigation.setState({ returnScreen: null }); useUi.getState().setScreen('settings') }}>{t('devices.screen.backToSettings')}</Button>}
      </aside>
      <section className="page dev-detail">
        {selected ? (
          <OutputDetail key={selected.id} output={selected} state={states[selected.id]} />
        ) : (
          <div className="dev-none">
            <p className="faint">{t('devices.screen.emptyDetail')}</p>
            <Button variant="primary" onClick={() => openWizard(true)}>
              <Plus />
              {t('devices.screen.add')}
            </Button>
          </div>
        )}
      </section>
    </>
  )
}
