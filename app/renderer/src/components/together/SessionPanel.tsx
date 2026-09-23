import { Controls } from './Controls'
import { InviteFriends, WatchPanel } from './WatchPanel'
import { friendLabel } from '@shared/account'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useT } from '@/state/i18n'
import { useTogether, type Session } from '@/state/together'
import './together.css'

export function SessionPanel() {
  const session = useTogether((s) => s.session)
  if (!session) return <InviteFriends />
  if (session.status === 'incoming') return <InvitePrompt session={session} />
  if (session.kind === 'watch') return <><WatchPanel key={session.id} session={session} /><InviteFriends /></>
  return <LegacySession session={session} />
}

function LegacySession({ session }: { session: Session }) {
  const t = useT()
  const end = useTogether(s => s.end)
  return <section className="tg-panel" aria-label={t('together.session.label')}><div className="hd"><b>{friendLabel(session.peer)}</b><Button onClick={end}>{t('together.session.end')}</Button></div>{session.note && <div className="note">{session.note}</div>}{session.status === 'connected' && session.role === 'guest' && <Controls remote={session.remote} />}</section>
}

function InvitePrompt({ session }: { session: Session }) {
  const t = useT()
  const accept = useTogether((s) => s.accept)
  const decline = useTogether((s) => s.decline)
  const name = friendLabel(session.peer)
  const heading = t(session.kind === 'control' ? 'together.invite.controlTitle' : 'together.invite.watchTitle', { name })
  const body = t(session.kind === 'control' ? 'together.invite.controlBody' : 'together.invite.watchBody')
  return (
    <Modal open onOpenChange={() => undefined} title={heading} width={360}>
      <div className="tg-invite">
        <h2>{heading}</h2>
        <p>{body}</p>
        <div className="acts">
          <Button variant="ghost" onClick={decline}>
            {t('together.invite.decline')}
          </Button>
          <Button variant="primary" autoFocus onClick={accept}>
            {t('together.invite.accept')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
