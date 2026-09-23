import { WATCH_GROUP_LIMIT } from '@shared/together'
import { Hand, MonitorPlay, Plus } from 'lucide-react'
import { friendLabel, type Friend } from '@shared/account'
import { Button } from '@/components/ui/Button'
import { isPremium, useAccount } from '@/state/account'
import { useGame } from '@/state/game'
import { useT } from '@/state/i18n'
import { useTogether } from '@/state/together'
import { Avatar } from '@/components/account/Avatar'

export function FriendsList({ onInvite, onAddFriend, giveControl = false }: { onInvite: () => void; onAddFriend: () => void; giveControl?: boolean }) {
  const t = useT()
  const friends = useAccount((s) => s.status.friends.friends)
  const premium = useAccount(isPremium)
  const online = useTogether((s) => s.online)
  const connected = useTogether((s) => s.connected)
  const session = useTogether(s => s.session)
  const busy = session !== null && session.status !== 'ended'
  const hosting = busy && session.kind === 'watch' && session.role === 'host'
  const full = hosting && session.members.filter(member => member.status !== 'ended').length >= WATCH_GROUP_LIMIT - 1
  const gameRunning = useGame((s) => s.running)
  const invite = useTogether((s) => s.invite)
  const start = (friend: Friend) => {
    if (giveControl) useTogether.getState().inviteWithControl(friend)
    else invite(friend, 'watch')
    onInvite()
  }
  return (
    <section aria-label={t('together.friends.title')}>
      <div className="account-section-heading">
        <span>{t(giveControl ? 'together.friends.giveControl' : 'together.friends.title')}</span>
        <button type="button" onClick={onAddFriend}><Plus aria-hidden />{t('together.friends.add')}</button>
      </div>
      {!giveControl && <Button disabled={!premium || !connected || gameRunning || busy && !hosting} onClick={() => { useTogether.setState({ invitePicker: true }); onInvite() }}><MonitorPlay />{t('together.group.inviteFriends')}</Button>}
      {friends.length === 0 && <p className="account-empty">{t('settings.friends.none')}</p>}
      <ul className="account-friends">
        {[...friends].sort((a, b) => Number(online.includes(b.id)) - Number(online.includes(a.id))).map((friend) => {
          const on = connected && online.includes(friend.id)
          const member = busy ? session.members.find(member => member.friend.id === friend.id && member.status !== 'ended') : undefined
          const canHandOver = giveControl && member?.status === 'connected'
          const can = on && premium && (!busy || hosting) && !gameRunning && (canHandOver || !full && !member)
          const reason = !premium ? t('together.friends.premium') : !on ? t('together.friends.offline') : gameRunning ? t('screen.game') : full && !canHandOver ? t('together.group.full') : busy && !hosting ? t('together.friends.inSession') : null
          return (
            <li key={friend.id} className="account-friend" aria-label={[friendLabel(friend), friend.name && friend.code].filter(Boolean).join(' · ')}>
              <span className="account-friend-avatar"><Avatar name={friendLabel(friend)} url={friend.avatarUrl} /><span className={`dot ${on ? '' : 'idle'}`} aria-hidden /></span>
              <span className="account-friend-name">{friendLabel(friend)}{friend.name && <span className="account-friend-code">{friend.code}</span>}</span>
              {reason && <span className="account-friend-reason">{reason}</span>}
              <div className="account-friend-actions">
                <Button disabled={!can} onClick={() => start(friend)}>{giveControl ? <Hand /> : <MonitorPlay />}{t(giveControl ? 'together.friends.giveControl' : hosting ? 'together.group.invite' : 'together.friends.watchTogether')}</Button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
