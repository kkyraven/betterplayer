import { ArrowDownToLine, BarChart3, Cable, Gamepad2, Globe, Library, MonitorPlay, Settings, Shuffle, Volume2, Wrench, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { TooltipGroup } from '@/components/ui/TooltipGroup'
import { isAdmin } from '@shared/account'
import { useAccount } from '@/state/account'
import { useT } from '@/state/i18n'
import { cx } from '@/lib/cx'
import { useBrowser } from '@/state/browser'
import { useGame } from '@/state/game'
import { usePlayer } from '@/state/player'
import { SCREEN_LABEL, useUi, type Screen } from '@/state/ui'
import { useUpdate } from '@/state/update'
import { UpdatePanel } from './UpdatePanel'
import { AccountPanel } from '@/components/account/AccountPanel'

const ITEMS: ReadonlyArray<{ id: Screen; icon: LucideIcon }> = [
  { id: 'library', icon: Library },
  { id: 'player', icon: MonitorPlay },
  { id: 'session', icon: Shuffle },
  { id: 'browser', icon: Globe },
  { id: 'game', icon: Gamepad2 },
]

const GAME_SCREENS: ReadonlySet<Screen> = new Set<Screen>(['game', 'settings'])

function RailButton({ id, icon: Icon, badge = false, sound = false }: { id: Screen; icon: LucideIcon; badge?: boolean; sound?: boolean }) {
  const active = useUi((s) => s.screen === id)
  const setScreen = useUi((s) => s.setScreen)
  const disabled = useGame((s) => s.running && !GAME_SCREENS.has(id))
  const label = useT()(SCREEN_LABEL[id])
  return (
    <button type="button" className={cx('rail-btn', active && 'active', badge && 'live')} aria-label={label} aria-current={active ? 'page' : undefined} disabled={disabled} onClick={() => setScreen(id)}>
      <Icon size={18} strokeWidth={2} />
      {badge && <span className="badge" />}
      {sound && !active && <Volume2 className="sound" size={10} strokeWidth={2.5} aria-hidden />}
    </button>
  )
}

function UpdateButton() {
  const t = useT()
  const state = useUpdate((s) => s.state)
  const install = useUpdate((s) => s.install)
  const start = useUpdate((s) => s.start)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const gameRunning = useGame((s) => s.running)
  useEffect(start, [start])
  if (state.status !== 'ready' || gameRunning) return null
  return (
    <>
      <button ref={setAnchor} type="button" className="rail-btn live" onClick={() => void install()}>
        <ArrowDownToLine size={18} strokeWidth={2} />
        <span className="sr-only">{t('update.to', { version: state.version })}</span>
      </button>
      <UpdatePanel version={state.version} notes={state.notes} bytes={state.bytes} anchor={anchor} onInstall={() => void install()} />
    </>
  )
}

export function Rail() {
  const t = useT()
  const hasMedia = usePlayer((s) => s.path !== null)
  const gameRunning = useGame((s) => s.running)
  const browserSound = useBrowser((s) => s.tabs.some((tab) => tab.audible && !tab.muted))
  const admin = useAccount((s) => isAdmin(s.status.me))
  return (
    <TooltipGroup as="nav" side="right" className="rail" aria-label={t('app.rail.screens')}>
      {ITEMS.map((item) => (
        <RailButton key={item.id} {...item} badge={(item.id === 'player' && hasMedia) || (item.id === 'game' && gameRunning)} sound={item.id === 'browser' && browserSound} />
      ))}
      <div className="spacer" />
      <UpdateButton />
      {admin && <RailButton id="admin" icon={BarChart3} />}
      <RailButton id="devices" icon={Cable} />
      <RailButton id="utilities" icon={Wrench} />
      <RailButton id="settings" icon={Settings} />
      <AccountPanel />
    </TooltipGroup>
  )
}
