import { Download, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { ITCH_URL } from '@shared/account'
import type { QuestHeadset } from '@shared/quest'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { SteamIcon } from '@/components/ui/SteamIcon'
import { VrGogglesIcon } from '@/components/ui/VrGogglesIcon'
import { invoke } from '@/ipc'
import { fileTitle } from '@/lib/format'
import { electron, platform } from '@/node'
import { FOLLOW_LABELS, useFollow } from '@/state/follow'
import { useT } from '@/state/i18n'
import { usePlayer } from '@/state/player'
import { useQuestConnect } from '@/state/questHeadsets'
import { useVr } from '@/state/vr'
import { followDot, followStatus } from './followStatus'
import { HeadsetIcon } from './HeadsetIcon'

export const STEAMVR = 'SteamVR'

export const useSteamvrShown = () => useVr((s) => (s.supported && platform === 'win32') || s.available || s.active || s.starting)

export function HeadsetRows({ quest, manage = false, onAction }: { quest: QuestHeadset[]; manage?: boolean; onAction?: () => void }) {
  const t = useT()
  const connecting = useQuestConnect((s) => (s.phase?.kind === 'connecting' ? s.phase.id : null))
  const connect = useQuestConnect((s) => s.connect)
  const follow = useFollow((s) => s.state)
  const followKind = useFollow((s) => s.kind)
  const followHost = useFollow((s) => s.host)
  const followName = useFollow((s) => s.quest?.name)
  const matched = useFollow((s) => s.matched)
  const reached = useFollow((s) => s.reached)
  const stopFollowing = useFollow((s) => s.stop)
  const steamvr = useSteamvrShown()
  const vrAvailable = useVr((s) => s.available)
  const vrActive = useVr((s) => s.active)
  const vrStarting = useVr((s) => s.starting)
  const startVr = useVr((s) => s.start)
  const stopVr = useVr((s) => s.stop)
  const hasVideo = usePlayer((s) => s.path !== null)
  const after = (action: () => void) => () => {
    action()
    onAction?.()
  }

  const followedQuest = follow && followKind === 'quest' ? (quest.find((h) => h.host === followHost) ?? null) : null
  const followRow = follow && (
    <Row
      key="follow"
      icon={followKind === 'quest' ? <HeadsetIcon name={followedQuest?.name ?? followName ?? FOLLOW_LABELS.quest} /> : <VrGogglesIcon />}
      dot={followDot(follow, matched !== null)}
      name={followKind === 'quest' ? (followedQuest?.name ?? followName ?? FOLLOW_LABELS.quest) : FOLLOW_LABELS[followKind]}
      status={[followStatus(t, follow, matched !== null, reached), follow.path && (matched?.title ?? fileTitle(follow.path))].filter(Boolean).join(' · ')}
    >
      {manage ? (
        <Button onClick={stopFollowing}>{t('settings.headsets.stopFollowing')}</Button>
      ) : (
        <IconButton size="sm" label={t('settings.headsets.stopFollowing')} onClick={stopFollowing}>
          <X />
        </IconButton>
      )}
    </Row>
  )
  const questRow = (h: QuestHeadset) => {
    if (h === followedQuest) return followRow
    const status = h.update
      ? t(h.update === 'headset' ? 'quest.headsets.updateHeadset' : 'quest.headsets.updateDesktop')
      : connecting === h.id
        ? t('common.connecting')
        : h.looking || !h.paired
          ? t('quest.headsets.onNetwork')
          : h.host
            ? manage
              ? `${t('quest.headsets.paired')} · ${h.host}`
              : t('quest.headsets.paired')
            : `${t('quest.headsets.paired')} · ${t('together.friends.offline')}`
    const dot = h.update || h.looking ? 'warn' : h.host ? '' : 'idle'
    return (
      <Row key={h.id} icon={<HeadsetIcon name={h.name} />} dot={dot} name={h.name} status={status}>
        {h.update === 'headset' && (
          <IconButton size="sm" label={t('quest.toast.download')} onClick={after(() => void electron.shell.openExternal(ITCH_URL))}>
            <Download />
          </IconButton>
        )}
        {h.looking && !h.update && (
          <Button variant="primary" disabled={connecting !== null} aria-label={`${t('devices.wizard.connect')}: ${h.name}`} onClick={() => void connect(h.id)}>
            {t('devices.wizard.connect')}
          </Button>
        )}
        {manage && h.paired && (
          <Button variant="ghost" onClick={() => void invoke('quest:forget', h.id)}>
            {t('common.remove')}
          </Button>
        )}
      </Row>
    )
  }
  const vrStatus = vrStarting ? t('common.connecting') : vrActive ? t('vr.inHeadset') : vrAvailable ? t('vr.ready') : t('vr.notRunning')
  const vrAction = vrActive ? t('vr.backToDesktop') : hasVideo ? t('vr.playInHeadset') : t('vr.openInHeadset')

  return (
    <>
      {follow && !followedQuest && followRow}
      {quest.map(questRow)}
      {steamvr && (
        <Row icon={<SteamIcon />} dot={vrStarting ? 'warn' : vrActive || vrAvailable ? '' : 'idle'} name={STEAMVR} status={vrStatus}>
          <Button variant={vrActive ? 'default' : 'primary'} disabled={vrStarting} onClick={after(() => (vrActive ? stopVr() : void startVr()))}>
            {vrAction}
          </Button>
        </Row>
      )}
    </>
  )
}

function Row({ icon, dot, name, status, children }: { icon: ReactNode; dot: string; name: string; status: string; children?: ReactNode }) {
  return (
    <li className="wd-row">
      <span className={`dot ${dot}`} />
      <span className="wd-icon">{icon}</span>
      <span className="wd-t">
        <span className="wd-n">{name}</span>
        <span className="wd-s" title={status}>
          {status}
        </span>
      </span>
      {children}
    </li>
  )
}
