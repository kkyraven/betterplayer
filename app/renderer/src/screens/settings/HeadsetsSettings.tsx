import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight, Download, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ITCH_URL } from '@shared/account'
import type { QuestHeadset } from '@shared/quest'
import { HeadsetIcon } from '@/components/quest/HeadsetIcon'
import { HeadsetRows, useSteamvrShown } from '@/components/quest/HeadsetRows'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Segmented } from '@/components/ui/Segmented'
import { VrGogglesIcon } from '@/components/ui/VrGogglesIcon'
import { invoke } from '@/ipc'
import { cx } from '@/lib/cx'
import { electron } from '@/node'
import { FOLLOW_KINDS, FOLLOW_LABELS, useFollow } from '@/state/follow'
import { useT } from '@/state/i18n'
import { useQuestConnect, useQuestHeadsets } from '@/state/questHeadsets'

type PlayerKind = (typeof FOLLOW_KINDS)[number]

const unpairedHeard = (h: QuestHeadset) => !h.paired && h.host !== null
const PLAYER_OPTIONS = FOLLOW_KINDS.map((k) => ({ value: k, label: FOLLOW_LABELS[k] }))

export function HeadsetsSettings() {
  const headsets = useQuestHeadsets()
  const following = useFollow((s) => s.state !== null)
  const steamvr = useSteamvrShown()
  const [adding, setAdding] = useState<'quest' | PlayerKind | null>(null)
  const guided = !headsets.some((h) => h.paired)
  const heard = guided ? headsets.find(unpairedHeard) : undefined
  const listed = guided ? headsets.filter((h) => h !== heard && unpairedHeard(h)) : headsets
  const close = useCallback(() => setAdding(null), [])
  useEffect(() => {
    if (following) setAdding((a) => (a === 'quest' ? a : null))
  }, [following])

  return (
    <div className="hs-page">
      <FirewallAlert />
      {guided && <QuestSetup heard={heard} />}
      {(listed.length > 0 || following || steamvr) && (
        <ul className="panel hs-list" data-setting="headset-list" tabIndex={-1}>
          <HeadsetRows quest={listed} manage />
        </ul>
      )}
      {guided && !following && <OtherPlayers />}
      {!guided && adding === null && <AddHeadset following={following} onPick={setAdding} />}
      {!guided && adding === 'quest' && <QuestSetup heard={headsets.find(unpairedHeard)} headsets={headsets} onClose={close} />}
      {!guided && adding !== null && adding !== 'quest' && <FollowForm kind={adding} onClose={close} />}
    </div>
  )
}

function FirewallAlert() {
  const t = useT()
  const [blocked, setBlocked] = useState(false)
  const [allowing, setAllowing] = useState(false)
  useEffect(() => {
    const check = () => void invoke('quest:firewall').then(setBlocked)
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])
  if (!blocked) return null
  const allow = () => {
    setAllowing(true)
    void invoke('quest:allowFirewall')
      .then((open) => setBlocked(!open))
      .finally(() => setAllowing(false))
  }
  return (
    <div className="hs-alert" role="alert">
      <span className="dot warn" />
      <span>{t('quest.firewall.blocked')}</span>
      <Button variant="primary" onClick={allow} disabled={allowing}>
        {t('quest.firewall.allow')}
      </Button>
    </div>
  )
}

function QuestSetup({ heard, headsets, onClose }: { heard: QuestHeadset | undefined; headsets?: QuestHeadset[]; onClose?: () => void }) {
  const t = useT()
  const connecting = useQuestConnect((s) => (s.phase?.kind === 'connecting' ? s.phase.id : null))
  const connect = useQuestConnect((s) => s.connect)
  const [found, setFound] = useState<string | null>(null)
  useEffect(() => {
    if (heard) setFound(heard.id)
  }, [heard])
  useEffect(() => {
    if (found !== null && headsets?.some((h) => h.id === found && h.paired)) onClose?.()
  }, [found, headsets, onClose])
  const [byAddress, setByAddress] = useState(false)
  const [address, setAddress] = useState('')
  const [badAddress, setBadAddress] = useState(false)
  const connectAddress = () => void invoke('quest:invite', { address }).then((sent) => setBadAddress(!sent))
  const done = heard !== undefined

  return (
    <section className="panel hs-card">
      <div className="hs-head">
        <span className="eyebrow">
          <HeadsetIcon name="Quest" />
          {t('quest.setup.title')}
        </span>
        {onClose && (
          <IconButton size="sm" label={t('common.close')} onClick={onClose}>
            <X />
          </IconButton>
        )}
      </div>
      <ol className="hs-steps">
        <Step n={1} done={done} text={t('quest.setup.install')}>
          {!done && (
            <Button variant="primary" onClick={() => void electron.shell.openExternal(ITCH_URL)}>
              <Download />
              {t('quest.toast.download')}
            </Button>
          )}
        </Step>
        <Step n={2} done={done} text={t('quest.setup.network')} />
        {heard?.update ? (
          <Step n={3} done={false} text={t(heard.update === 'headset' ? 'quest.headsets.updateHeadset' : 'quest.headsets.updateDesktop')} warn />
        ) : (
          <Step n={3} done={false} text={heard ? t('quest.setup.found', { name: heard.name }) : t('quest.setup.pin')}>
            {heard && (
              <Button variant="primary" disabled={connecting !== null} aria-label={`${connecting === heard.id ? t('common.connecting') : t('devices.wizard.connect')}: ${heard.name}`} onClick={() => void connect(heard.id)}>
                {connecting === heard.id ? t('common.connecting') : t('devices.wizard.connect')}
              </Button>
            )}
          </Step>
        )}
      </ol>
      {byAddress ? (
        <div className="hs-row">
          <input
            className="input mono"
            value={address}
            autoFocus
            aria-label={t('settings.headsets.address')}
            aria-invalid={badAddress}
            placeholder={t('settings.headsets.addressPlaceholder')}
            onChange={(e) => {
              setAddress(e.target.value)
              setBadAddress(false)
            }}
            onKeyDown={(e) => e.key === 'Enter' && address.trim() && connectAddress()}
          />
          <Button onClick={connectAddress} disabled={!address.trim()}>
            {t('devices.wizard.connect')}
          </Button>
        </div>
      ) : (
        <button type="button" className="hs-link" onClick={() => setByAddress(true)}>
          {t('quest.setup.byAddress')}
        </button>
      )}
    </section>
  )
}

function Step({ n, done, text, warn = false, children }: { n: number; done: boolean; text: string; warn?: boolean; children?: ReactNode }) {
  const t = useT()
  return (
    <li className={cx('hs-step', done && 'done')}>
      <span className="hs-num">
        {done ? (
          <>
            <Check />
            <span className="sr-only">{t('common.done')}</span>
          </>
        ) : (
          n
        )}
      </span>
      <span className={cx('hs-step-t', warn && 'warn')}>{text}</span>
      {children}
    </li>
  )
}

function OtherPlayers() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const kind = useFollow((s) => s.kind)
  return (
    <div className="hs-more">
      <button type="button" className={cx('hs-disclosure', open && 'open')} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight />
        {t('settings.headsets.otherPlayers')}
      </button>
      {open && <FollowForm kind={kind === 'quest' ? 'heresphere' : kind} />}
    </div>
  )
}

function AddHeadset({ following, onPick }: { following: boolean; onPick: (kind: 'quest' | PlayerKind) => void }) {
  const t = useT()
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button className="hs-add">
          <Plus />
          {t('settings.headsets.add')}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="win-menu hs-add-menu" align="start" sideOffset={6} collisionPadding={12}>
          <DropdownMenu.Item className="item" onSelect={() => onPick('quest')}>
            <HeadsetIcon name="Quest" />
            {FOLLOW_LABELS.quest}
          </DropdownMenu.Item>
          {!following &&
            FOLLOW_KINDS.map((k) => (
            <DropdownMenu.Item key={k} className="item" onSelect={() => onPick(k)}>
              <VrGogglesIcon />
              {FOLLOW_LABELS[k]}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function FollowForm({ kind: initial, onClose }: { kind: PlayerKind; onClose?: () => void }) {
  const t = useT()
  const host = useFollow((s) => s.host)
  const setKind = useFollow((s) => s.setKind)
  const setHost = useFollow((s) => s.setHost)
  const start = useFollow((s) => s.start)
  const [kind, setLocalKind] = useState(initial)
  const pick = (next: PlayerKind) => {
    setLocalKind(next)
    setKind(next)
  }
  const follow = () => {
    setKind(kind)
    start()
    onClose?.()
  }
  return (
    <section className="panel hs-card">
      {onClose && (
        <div className="hs-head">
          <span className="eyebrow">{t('settings.headsets.otherPlayers')}</span>
          <IconButton size="sm" label={t('common.close')} onClick={onClose}>
            <X />
          </IconButton>
        </div>
      )}
      <Segmented options={PLAYER_OPTIONS} value={kind} onChange={pick} label={t('settings.headsets.player')} />
      <div className="hs-row">
        <input className="input mono" value={host} aria-label={t('settings.headsets.address')} placeholder={t('settings.headsets.addressPlaceholder')} onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && follow()} />
        <Button onClick={follow}>{t('settings.headsets.follow')}</Button>
      </div>
    </section>
  )
}
