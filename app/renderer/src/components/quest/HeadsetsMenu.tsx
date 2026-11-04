import * as Popover from '@radix-ui/react-popover'
import { Download, Settings2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { ITCH_URL } from '@shared/account'
import { Button } from '@/components/ui/Button'
import { SteamIcon } from '@/components/ui/SteamIcon'
import { VrGogglesIcon } from '@/components/ui/VrGogglesIcon'
import { electron } from '@/node'
import { FOLLOW_LABELS, useFollow } from '@/state/follow'
import { useT } from '@/state/i18n'
import { useQuestHeadsets } from '@/state/questHeadsets'
import { useSettingsNavigation } from '@/state/settingsNavigation'
import { useUi } from '@/state/ui'
import { useVr } from '@/state/vr'
import { HeadsetIcon } from './HeadsetIcon'
import { followDot, HeadsetRows, STEAMVR, useSteamvrShown } from './HeadsetRows'

export function HeadsetsMenu() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const headsets = useQuestHeadsets()
  const follow = useFollow((s) => s.state)
  const followKind = useFollow((s) => s.kind)
  const followHost = useFollow((s) => s.host)
  const followName = useFollow((s) => s.quest?.name)
  const matched = useFollow((s) => s.matched !== null)
  const steamvr = useSteamvrShown()
  const vrActive = useVr((s) => s.active)
  const vrStarting = useVr((s) => s.starting)
  const hmdName = useVr((s) => s.hmdName)

  const close = (then: () => void) => () => {
    setOpen(false)
    then()
  }
  const followedQuest = follow && followKind === 'quest' ? (headsets.find((h) => h.host === followHost) ?? null) : null
  const looking = headsets.find((h) => h.looking && h !== followedQuest)

  let chip: { icon: ReactNode; label: string; dot?: string; on?: boolean } | null = null
  if (vrActive || vrStarting) chip = { icon: <SteamIcon />, label: hmdName || STEAMVR, on: true }
  else if (follow) {
    const name = followKind === 'quest' ? (followedQuest?.name ?? followName ?? FOLLOW_LABELS.quest) : FOLLOW_LABELS[followKind]
    chip = { icon: followKind === 'quest' ? <HeadsetIcon name={name} /> : <VrGogglesIcon />, label: name, dot: followDot(follow, matched) }
  } else if (looking) chip = { icon: <HeadsetIcon name={looking.name} />, label: looking.name, dot: 'warn' }
  const label = t('app.titleBar.headsets')

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={`win-status-item${chip ? '' : ' icon'}${chip?.on ? ' on' : ''}`} aria-label={chip ? `${label}: ${chip.label}` : label} title={chip ? undefined : label} aria-busy={vrStarting}>
          {chip?.dot !== undefined && <span className={`dot ${chip.dot}`} />}
          {chip?.icon ?? <VrGogglesIcon />}
          {chip?.label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="win-menu win-devices" align="end" sideOffset={6} collisionPadding={12}>
          {headsets.length === 0 && !follow && !steamvr && <p className="wd-empty faint">{t('quest.headsets.empty')}</p>}
          <ul>
            <HeadsetRows quest={headsets} onAction={() => setOpen(false)} />
          </ul>
          <div className="wd-foot">
            {!headsets.some((h) => h.paired) && (
              <Button onClick={close(() => void electron.shell.openExternal(ITCH_URL))}>
                <Download />
                {t('quest.toast.download')}
              </Button>
            )}
            <Button
              onClick={close(() => {
                useUi.getState().setScreen('settings')
                useSettingsNavigation.getState().selectPage('headsets')
              })}
            >
              <Settings2 />
              {t('quest.toast.settings')}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
