import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Controls } from './Controls'
import './FriendActions.css'
import { ChevronDown, ChevronUp, Download, Ellipsis, Hand, Plus, Users } from 'lucide-react'
import { useState } from 'react'
import { friendLabel } from '@shared/account'
import { WATCH_GROUP_LIMIT } from '@shared/together'
import { Avatar } from '@/components/account/Avatar'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { Switch } from '@/components/ui/Switch'
import { isPremium, useAccount } from '@/state/account'
import { useGame } from '@/state/game'
import { useT } from '@/state/i18n'
import { useTogether, type Session } from '@/state/together'

const sizeLabel = (bytes: number) => bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${(bytes / 1_000_000).toFixed(1)} MB`

export function WatchPanel({ session }: { session: Session }) {
  const t = useT()
  const [tab, setTab] = useState<'people' | 'controls'>('people')
  const [collapsed, setCollapsed] = useState(false)
  const together = useTogether()
  const me = useAccount(s => s.status.me)
  const host = session.role === 'host'
  const members = host ? session.members : session.members.filter(member => member.friend.id !== me?.id)
  const count = host ? 1 + members.filter(member => member.status === 'connected').length : Math.max(2, session.members.filter(member => member.status === 'connected').length)
  const transfer = together.transfers.find(item => item.peerId === session.peer.id && item.direction === 'receive')
  const grant = together.handover
  const controlling = grant?.role === 'controller' && grant.status === 'active'
  const ended = session.status === 'ended'
  const transferring = transfer && !['complete', 'failed'].includes(transfer.status)
  return (
    <section className="tg-panel tg-group" aria-label={t('together.friends.watchTogether')}>
      <div className="hd">
        <Users /><b>{t('together.friends.watchTogether')} <span className="tg-count">{count}</span></b>
        <IconButton label={t(collapsed ? 'together.group.expand' : 'together.group.collapse')} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronUp /> : <ChevronDown />}</IconButton>
      </div>
      {ended ? <><div className="note">{session.note}</div><Button onClick={together.end}>{t('common.close')}</Button></> : !collapsed && <>
        {controlling && <div className="tg-tabs" role="group" aria-label={t('together.session.label')}><Button aria-pressed={tab === 'people'} onClick={() => setTab('people')}>{t('together.handover.people')}</Button><Button aria-pressed={tab === 'controls'} onClick={() => setTab('controls')}>{t('together.handover.controls')}</Button></div>}
        {grant && grant.status !== 'offered' && <div className="tg-sharing"><span>{controlling ? t('together.group.you') : friendLabel(grant.peer)}<small>{t(grant.status === 'offering' ? 'together.session.waiting' : 'together.handover.controlling')}</small></span><Button onClick={together.releaseControl}>{t(grant.status === 'offering' ? 'common.cancel' : host ? 'together.handover.takeBack' : 'together.handover.release')}</Button></div>}
        {controlling && tab === 'controls' ? <Controls remote={grant.remote} /> : <>
        <div className="tg-members">
          <div className="tg-member"><Avatar name={me?.name || t('together.group.you')} url={me?.avatarUrl} size={28} /><span>{t('together.group.you')}</span><small>{host ? t('together.group.host') : session.missing ? t('together.group.missing') : t('together.group.inSync')}</small></div>
          {(members.length ? members : [{ friend: session.peer, status: session.status === 'connected' ? 'connected' : 'connecting', missing: false, note: null }]).map(member => {
            const outgoing = together.transfers.find(item => item.peerId === member.friend.id && item.direction === 'send')
            const status = outgoing && !['failed', 'complete'].includes(outgoing.status) ? `${Math.floor(outgoing.bytes / outgoing.video.size * 100)}%` : member.status === 'ended' ? member.note || t('together.note.ended') : member.status === 'inviting' ? t('together.group.invited') : member.status === 'connecting' ? t('together.session.connecting') : !host && member.friend.id === session.peer.id ? t('together.group.host') : member.missing ? t('together.group.missing') : t('together.group.inSync')
            return <div className="tg-member" key={member.friend.id}><Avatar name={friendLabel(member.friend)} url={member.friend.avatarUrl} size={28} /><span>{friendLabel(member.friend)}</span><small title={status} className={member.missing ? 'warn' : ''}>{status}</small>{host && member.status === 'connected' && <DropdownMenu.Root modal={false}><DropdownMenu.Trigger asChild><IconButton label={`${t('common.more')}: ${friendLabel(member.friend)}`}><Ellipsis /></IconButton></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="friend-actions-menu" align="end" sideOffset={4}><DropdownMenu.Item onSelect={() => together.giveControl(member.friend.id)} disabled={grant?.peer.id === member.friend.id}><Hand />{t('together.friends.giveControl')}</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}{outgoing && !['failed', 'complete'].includes(outgoing.status) && <Button variant="ghost" onClick={() => together.cancelTransfer(member.friend.id)}>{t('common.cancel')}</Button>}</div>
          })}
        </div>
        </>}
        {host ? <div className="tg-sharing"><div>{t('together.group.allowDownloads')}</div><Switch label={t('together.group.allowDownloads')} checked={together.downloadsAllowed} onCheckedChange={together.allowDownloads} /></div> : <>
          <div className="tg-sharing"><div>{t('together.group.acceptDownloads')}<small role="status">{t(together.downloadsAllowed ? 'together.group.hostOffering' : 'together.group.sharingOff')}</small></div><Switch label={t('together.group.acceptDownloads')} checked={together.acceptsDownloads} onCheckedChange={together.acceptDownloads} /></div>
          {together.acceptsDownloads && <small className="note">{t('together.group.downloadFolder')}</small>}
          {transfer && <div className="tg-download"><div className="tg-file"><Download /><div>{transfer.video.name}<small>{sizeLabel(transfer.video.size)}</small></div></div><progress aria-label={t('together.transfer.progress')} max={transfer.video.size} value={transfer.bytes} /><div className="tg-download-actions"><span role="status">{t(transfer.status === 'failed' ? 'together.transfer.failed' : transfer.status === 'complete' ? 'together.transfer.saved' : 'together.transfer.progress')}</span>{transferring ? <Button onClick={() => together.cancelTransfer(session.peer.id)}>{t('common.cancel')}</Button> : transfer.status === 'failed' && <Button onClick={together.download}>{t('together.transfer.retry')}</Button>}</div></div>}
        </>}
        {together.transferError && <div className="note" role="status">{together.transferError}{!host && together.acceptsDownloads && together.downloadsAllowed && <Button onClick={together.download}>{t('together.transfer.retry')}</Button>}</div>}
        <div className="tg-group-actions">{host && <Button disabled={session.members.filter(member => member.status !== 'ended').length >= WATCH_GROUP_LIMIT - 1} onClick={() => useTogether.setState({ invitePicker: true })}><Plus />{t('together.group.inviteFriends')}</Button>}<Button variant="ghost" onClick={together.end}>{t(host ? 'together.group.end' : 'together.group.leave')}</Button></div>
      </>}
      {grant?.status === 'offered' && !ended && <Modal open title={t('together.friends.giveControl')} onOpenChange={open => { if (!open) together.answerControl(false) }} width={360}><div className="tg-invite"><h2>{friendLabel(grant.peer)}</h2><p>{t('together.handover.offer')}</p><div className="acts"><Button onClick={() => together.answerControl(false)}>{t('together.invite.decline')}</Button><Button variant="primary" onClick={() => { together.answerControl(true); setTab('controls') }}>{t('together.invite.accept')}</Button></div></div></Modal>}
    </section>
  )
}

export function InviteFriends() {
  const t = useT()
  const open = useTogether(s => s.invitePicker)
  const session = useTogether(s => s.session)
  const online = useTogether(s => s.online)
  const connected = useTogether(s => s.connected)
  const friends = useAccount(s => s.status.friends.friends)
  const premium = useAccount(isPremium)
  const game = useGame(s => s.running)
  const [selected, setSelected] = useState<string[]>([])
  const active = session && session.status !== 'ended'
  const existing = active ? session.members.filter(member => member.status !== 'ended').map(member => member.friend.id) : []
  const room = WATCH_GROUP_LIMIT - 1 - existing.length
  const allowed = connected && premium && !game && (!active || session.kind === 'watch' && session.role === 'host')
  const selection = friends.filter(friend => selected.includes(friend.id) && online.includes(friend.id) && !existing.includes(friend.id)).slice(0, room)
  const close = () => { useTogether.setState({ invitePicker: false }); setSelected([]) }
  return <Modal open={open} onOpenChange={value => { if (!value) close() }} title={t('together.group.inviteFriends')} width={360}>
    <div className="tg-invite"><h2>{t('together.group.inviteFriends')}</h2><div className="tg-invite-list">
      {[...friends].sort((a, b) => Number(online.includes(b.id)) - Number(online.includes(a.id))).map(friend => {
        const invited = existing.includes(friend.id)
        const isOnline = online.includes(friend.id)
        const checked = selection.some(item => item.id === friend.id)
        return <label className="tg-friend-choice" key={friend.id}><input type="checkbox" checked={checked} disabled={!allowed || invited || !isOnline || !checked && selection.length >= room} onChange={event => setSelected(event.target.checked ? [...selected, friend.id] : selected.filter(id => id !== friend.id))} /><Avatar name={friendLabel(friend)} url={friend.avatarUrl} size={28} /><span>{friendLabel(friend)}</span><small>{t(invited ? 'together.group.invited' : isOnline ? 'together.group.online' : 'together.friends.offline')}</small></label>
      })}
    </div><div className="acts"><Button variant="ghost" onClick={close}>{t('common.cancel')}</Button><Button variant="primary" disabled={!allowed || !selection.length} onClick={() => { useTogether.getState().inviteMany(selection); close() }}>{t('together.group.inviteCount', { count: selection.length })}</Button></div></div>
  </Modal>
}
