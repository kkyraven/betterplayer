import { CircleCheck, Download, Info, X } from 'lucide-react'
import { useEffect, useReducer, useState, type ReactNode } from 'react'
import { ITCH_URL } from '@shared/account'
import { Button } from '@/components/ui/Button'
import { invoke, on } from '@/ipc'
import { electron } from '@/node'
import { useT } from '@/state/i18n'
import { useQuestConnect, useQuestHeadsets } from '@/state/questHeadsets'
import { useSettingsNavigation } from '@/state/settingsNavigation'
import { useUi } from '@/state/ui'
import { HeadsetIcon } from './HeadsetIcon'
import './HeadsetToast.css'

const dismissed = new Set<string>()

export function HeadsetToast() {
  const t = useT()
  const headsets = useQuestHeadsets()
  const [asking, setAsking] = useState(false)
  const phase = useQuestConnect((s) => s.phase)
  const busy = phase?.kind === 'connecting'
  const connectTo = useQuestConnect((s) => s.connect)
  const clear = useQuestConnect((s) => s.clear)
  const [allowing, setAllowing] = useState(false)
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    void invoke('quest:prompts').then((list) => setAsking(list.length > 0))
    return on('quest:prompts', (list) => setAsking(list.length > 0))
  }, [])

  useEffect(() => {
    if (phase?.kind === 'failed' && !headsets.some((h) => h.id === phase.id && h.looking)) clear()
  }, [headsets, phase, clear])

  const failed = (h: { id: string }) => phase?.id === h.id && phase.kind === 'failed'
  const headset = headsets.find((h) => h.looking && (failed(h) || (!h.paired && !dismissed.has(h.id))))
  if (!headset || asking) return null
  const { id, name } = headset
  const current = phase?.id === id ? phase : null

  const connect = () => connectTo(id)
  const allow = async () => {
    setAllowing(true)
    const open = await invoke('quest:allowFirewall').finally(() => setAllowing(false))
    if (open) void connect()
  }
  const notNow = () => {
    dismissed.add(id)
    if (phase?.id === id) clear()
    rerender()
  }
  const settings = () => {
    useUi.getState().setScreen('settings')
    useSettingsNavigation.getState().selectPage('headsets')
  }

  const close = (
    <Button variant="ghost" icon className="ht-close" aria-label={t('common.close')} title={t('common.close')} onClick={notNow}>
      <X />
    </Button>
  )
  const bar = (text: string, right: ReactNode) => (
    <div className="ht-bar">
      <HeadsetIcon name={name} />
      <span>{text}</span>
      {right}
    </div>
  )

  if (current?.kind === 'failed') {
    return (
      <div className="headset-toast" role="alert">
        {bar(t('quest.toast.failed', { name }), close)}
        <div className="ht-why">
          {current.firewall ? (
            <Check state="bad" text={t('quest.firewall.blocked')}>
              <Button variant="primary" onClick={() => void allow()} disabled={allowing}>
                {t('quest.firewall.allow')}
              </Button>
            </Check>
          ) : null}
          <Check state="ok" text={t('quest.toast.heard', { name })} />
          {!current.firewall && <Check state="ok" text={t('quest.toast.firewallOpen')} />}
          {!current.firewall && <Check state="bad" text={t('quest.toast.silent', { name })} hint={t('quest.toast.silentHint')} />}
          {current.vpn && <Check state="warn" text={t('quest.toast.vpn', { vpn: current.vpn })} hint={t('quest.toast.vpnHint')} />}
          <div className="ht-foot">
            <Button variant="ghost" onClick={settings}>
              {t('quest.toast.settings')}
            </Button>
            <Button onClick={() => void connect()} disabled={busy}>
              {t('common.tryAgain')}
            </Button>
          </div>
        </div>
      </div>
    )
  }
  if (headset.update && !current) {
    return (
      <div className="headset-toast" role="status">
        {bar(t(headset.update === 'headset' ? 'quest.headsets.updateHeadset' : 'quest.headsets.updateDesktop'), close)}
        <div className="ht-why">
          <div className="ht-foot">
            {headset.update === 'headset' && (
              <button type="button" className="ht-link" onClick={() => void electron.shell.openExternal(ITCH_URL)}>
                <Download />
                {t('quest.toast.download')}
              </button>
            )}
            <Button variant="ghost" onClick={() => void connect()} disabled={busy}>
              {t('quest.toast.tryAnyway')}
            </Button>
          </div>
        </div>
      </div>
    )
  }
  const connecting = current?.kind === 'connecting'
  return (
    <div className="headset-toast" role="status">
      {bar(
        t('quest.toast.detected', { name }),
        <>
          <Button variant="primary" onClick={() => void connect()} disabled={busy}>
            {connecting ? t('common.connecting') : t('devices.wizard.connect')}
          </Button>
          {close}
        </>,
      )}
    </div>
  )
}

function Check({ state, text, hint, children }: { state: 'ok' | 'bad' | 'warn'; text: string; hint?: string; children?: ReactNode }) {
  const Icon = state === 'ok' ? CircleCheck : state === 'bad' ? X : Info
  return (
    <div className="ht-check">
      <Icon className={state} />
      <span>
        {text}
        {hint && <span className="ht-hint">{hint}</span>}
      </span>
      {children}
    </div>
  )
}
