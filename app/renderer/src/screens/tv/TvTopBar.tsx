import { Power, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MessageKey } from '@shared/i18n'
import { cx } from '@/lib/cx'
import { fmtDuration } from '@/lib/format'
import { useDevices } from '@/state/devices'
import { useT } from '@/state/i18n'
import * as live from '@/state/live'
import { usePlayer } from '@/state/player'
import { sessionRemainingMs, useSession } from '@/state/session'
import { useUi, type TvTab } from '@/state/ui'

const TABS: ReadonlyArray<{ id: TvTab; label: MessageKey }> = [
  { id: 'nowplaying', label: 'screen.player' },
  { id: 'library', label: 'screen.library' },
  { id: 'continue', label: 'tv.topBar.continue' },
  { id: 'session', label: 'screen.session' },
]

export function TvTopBar() {
  const t = useT()
  const tab = useUi((s) => s.tvTab)
  const views = useUi((s) => s.tvViews)
  const setTvTab = useUi((s) => s.setTvTab)
  const pushTvView = useUi((s) => s.pushTvView)
  const setTvOverlay = useUi((s) => s.setTvOverlay)
  const path = usePlayer((s) => s.path)
  const inSettings = tab !== 'nowplaying' && views.some((v) => v.kind === 'settings')
  return (
    <div className="tv-top">
      <nav className="tv-tabs" aria-label={t('tv.topBar.sections')}>
        {TABS.filter((v) => v.id !== 'nowplaying' || path).map((v) => (
          <button key={v.id} type="button" className={cx(v.id === tab && !inSettings && 'on')} aria-current={v.id === tab ? 'page' : undefined} data-focus-key={`tab:${v.id}`} onClick={() => setTvTab(v.id)}>
            {t(v.label)}
          </button>
        ))}
      </nav>
      <TvStatus />
      <div className="tv-cluster">
        <button type="button" className={cx(inSettings && 'on')} aria-label={t('screen.settings')} data-focus-key="settings" onClick={() => !inSettings && pushTvView({ kind: 'settings' })}>
          <Settings />
        </button>
        <button type="button" aria-label={t('tv.powerMenu.title')} data-focus-key="power" onClick={() => setTvOverlay('power')}>
          <Power />
        </button>
      </div>
    </div>
  )
}

function TvStatus() {
  const t = useT()
  const device = useDevices((s) => {
    const d = Object.values(s.states).find((o) => o.status === 'connected')
    return d ? (d.device ?? d.address).split(' ')[0] : null
  })
  const inSession = useSession((s) => s.stage === 'running')
  return (
    <div className="tv-status">
      <span>
        <span className={cx('dot', !device && 'idle')} /> <b>{device ?? t('tv.topBar.noDevice')}</b>
      </span>
      {inSession && <SessionLeft />}
      <Clock />
    </div>
  )
}

function SessionLeft() {
  const t = useT()
  const plan = useSession((s) => s.plan)
  const index = useSession((s) => s.index)
  const showTimes = useSession((s) => s.setup.showTimes)
  const [left, setLeft] = useState(() => fmtDuration(sessionRemainingMs(plan, index, live.get().timeMs)))
  live.useLive((l) => setLeft(fmtDuration(sessionRemainingMs(plan, index, l.timeMs))), [plan, index])
  if (!showTimes) return <span>{t('screen.session')}</span>
  return (
    <span>
      {t('screen.session')} <b>{left}</b> {t('tv.topBar.left')}
    </span>
  )
}

const clockText = () => new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

function Clock() {
  const [now, setNow] = useState(clockText)
  useEffect(() => {
    const t = window.setInterval(() => setNow(clockText()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return <span className="mono">{now}</span>
}
