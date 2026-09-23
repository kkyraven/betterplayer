import { WATCH_GROUP_LIMIT } from '@shared/together'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Ellipsis, MonitorPlay, UserMinus } from 'lucide-react'
import { friendLabel, type Friend, type PeerKind } from '@shared/account'
import { IconButton } from '@/components/ui/IconButton'
import { isPremium, useAccount } from '@/state/account'
import { useAccountNavigation } from '@/state/accountNavigation'
import { useGame } from '@/state/game'
import { useT } from '@/state/i18n'
import { useTogether } from '@/state/together'
import './FriendActions.css'

export function FriendActions({ friend, onUnfriend }: { friend: Friend; onUnfriend: () => void }) {
  const t = useT()
  const premium = useAccount(isPremium)
  const online = useTogether((s) => s.connected && s.online.includes(friend.id))
  const session = useTogether(s => s.session)
  const busy = session !== null && session.status !== 'ended'
  const hosting = busy && session.kind === 'watch' && session.role === 'host'
  const full = hosting && session.members.filter(member => member.status !== 'ended').length >= WATCH_GROUP_LIMIT - 1
  const alreadyInvited = busy && session.members.some(member => member.friend.id === friend.id && member.status !== 'ended')
  const gameRunning = useGame((s) => s.running)
  const invite = useTogether((s) => s.invite)
  const close = useAccountNavigation((s) => s.close)
  const reason = !premium ? t('together.friends.premium') : !online ? t('together.friends.offline') : gameRunning ? t('screen.game') : full ? t('together.group.full') : busy && !hosting || alreadyInvited ? t('together.friends.inSession') : null
  const start = (kind: PeerKind) => {
    invite(friend, kind)
    close()
  }
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <IconButton label={`${t('common.more')}: ${friendLabel(friend)}`}><Ellipsis /></IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="friend-actions-menu" align="end" sideOffset={4} collisionPadding={12} onKeyDown={(event) => event.stopPropagation()}>
          {reason && <DropdownMenu.Label>{reason}</DropdownMenu.Label>}
          <DropdownMenu.Item disabled={reason !== null} onSelect={() => start('watch')}><MonitorPlay />{t(hosting ? 'together.group.invite' : 'together.friends.watchTogether')}</DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item className="danger" onSelect={onUnfriend}><UserMinus />{t('settings.friends.unfriend')}</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
