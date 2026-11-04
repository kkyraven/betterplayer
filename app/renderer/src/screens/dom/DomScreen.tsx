// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { CircleAlert, Download, Lock, Play, Plus, Search, SlidersHorizontal, Trash2, UserRound } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { DOM_FREE_SECONDS, type AlPersona, type DomProfile } from '@shared/dom'
import type { MessageKey } from '@shared/i18n'
import { SupporterOffer } from '@/components/account/SupporterOffer'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Prompt } from '@/components/ui/Prompt'
import { Segmented } from '@/components/ui/Segmented'
import { invoke } from '@/ipc'
import { cx } from '@/lib/cx'
import { isSubscriber, useAccount } from '@/state/account'
import { domErrorText, useDom } from '@/state/dom'
import { useT } from '@/state/i18n'
import { AdvancedPainEditor } from './AdvancedPain'
import { AiPage, TIER_LABEL, shortDate } from './AiPage'
import { ImagesTab, MemoryTab, PersonalityTab, PleasurePainPage, YouPage } from './DomTabs'
import { FirstRun } from './FirstRun'
import { useDomNav, type SetupPage } from './nav'
import { Trouble, ownTrouble } from './OwnAi'
import { Portrait } from './Portrait'
import { domBlock, serverName, type DomBlock } from './setup'
import './dom.css'

const TABS = ['personality', 'images', 'memory'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, MessageKey> = { personality: 'dom.tab.personality', images: 'dom.tab.images', memory: 'dom.tab.memory' }
const SETUP_PAGES: ReadonlyArray<{ page: SetupPage; label: MessageKey }> = [
  { page: 'ai', label: 'dom.ai.title' },
  { page: 'pleasurePain', label: 'dom.tab.pleasurePain' },
  { page: 'advancedPain', label: 'dom.pain.title' },
]
type View = 'dom' | 'you' | 'flow' | SetupPage
const isSetupPage = (v: View): v is SetupPage => v === 'ai' || v === 'pleasurePain' || v === 'advancedPain'

export function DomScreen() {
  const t = useT()
  const doms = useDom((s) => s.doms)
  const loaded = useDom((s) => s.loaded)
  const selectedId = useDom((s) => s.selectedId)
  const ai = useDom((s) => s.ai)
  const account = useDom((s) => s.account)
  const ownStatus = useDom((s) => s.ownStatus)
  const accountChecked = useDom((s) => s.accountChecked)
  const subscribed = useAccount(isSubscriber)
  const [picked, setPicked] = useState<View | null>(null)
  const [importing, setImporting] = useState(false)
  const { load, select, create, checkOwn } = useDom.getState()
  useEffect(() => {
    void load()
  }, [load, subscribed])
  const ownActive = loaded && ai.provider === 'own'
  useEffect(() => {
    if (!ownActive) return
    const check = () => void checkOwn()
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [ownActive, checkOwn])
  if (!loaded) return null
  const view: View = !ai.setupDone ? (picked === null || isSetupPage(picked) ? 'flow' : picked) : picked === null || picked === 'flow' ? 'dom' : picked
  const block = domBlock(ai, account, subscribed, ownStatus)
  const unknown = ai.setupDone && ai.provider === 'agenticlover' && !accountChecked
  const selected = doms.find((d) => d.id === selectedId) ?? null
  const openSetup = (page: SetupPage) => {
    useDomNav.setState({ lastSetup: page })
    setPicked(page)
  }
  const finish = () => {
    if (doms[0]) select(doms[0].id)
    setPicked('dom')
  }
  if (view === 'flow' && doms.length === 0) return <FirstRun onDone={finish} />
  return (
    <>
      <aside className="side-list dom-list">
        <h1>
          {t('screen.dom')}
          {!unknown && block === 'freeUsed' && <Lock className="dom-lock" aria-label={t('common.supporterOnly')} />}
        </h1>
        <ul className="dom-top">
          <li>
            <button type="button" className="side-row dom-add" onClick={() => {
              setPicked('dom')
              void create()
            }}>
              <Plus />
              {t('dom.new')}
            </button>
          </li>
          {account.signedIn && (
            <li>
              <button type="button" className="side-row dom-add" onClick={() => setImporting(true)}>
                <Download />
                {t('dom.import')}
              </button>
            </li>
          )}
        </ul>
        <ul className="dom-scroll">
          {doms.map((d) => {
            const on = view === 'dom' && d.id === selectedId
            return (
              <li key={d.id}>
                <button type="button" className={cx('side-row dom-row', on && 'on')} aria-current={on || undefined} onClick={() => {
                  setPicked('dom')
                  select(d.id)
                }}>
                  <Portrait dom={d} className="dom-ava" />
                  <span className="n">{d.name || t('dom.newName')}</span>
                  {d.alPersonaId && <span className="src">AL</span>}
                </button>
              </li>
            )
          })}
        </ul>
        <div className="dom-foot">
          <ul>
            <li>
              <button type="button" className={cx('side-row', view === 'you' && 'on')} aria-current={view === 'you' || undefined} onClick={() => setPicked('you')}>
                <UserRound />
                {t('dom.you')}
              </button>
            </li>
            <li>
              <button type="button" className={cx('side-row dom-setup', view === 'flow' && 'on', isSetupPage(view) && 'open')} aria-current={view === 'flow' ? 'page' : undefined} onClick={() => setPicked(ai.setupDone ? useDomNav.getState().lastSetup : 'flow')}>
                <span className="top"><SlidersHorizontal />{t('game.setup')}</span>
                <SetupStatus />
              </button>
            </li>
            {isSetupPage(view) && (
              <li className="dom-subs">
                <ul>
                  {SETUP_PAGES.map(({ page, label }) => (
                    <li key={page}>
                      <button type="button" className={cx('side-row dom-sub-row', view === page && 'on')} aria-current={view === page ? 'page' : undefined} onClick={() => openSetup(page)}>
                        {t(label)}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            )}
          </ul>
        </div>
      </aside>
      {view === 'flow' ? (
        <FirstRun onDone={finish} />
      ) : (
        <div className="page dom-page">
          {view === 'you' ? (
            <>
              <div className="page-hd"><h1>{t('dom.you')}</h1></div>
              <YouPage />
            </>
          ) : view === 'ai' ? (
            <AiPage />
          ) : view === 'pleasurePain' ? (
            <>
              <div className="page-hd"><h1>{t('dom.tab.pleasurePain')}</h1></div>
              <div className="dom-body"><PleasurePainPage /></div>
            </>
          ) : view === 'advancedPain' ? (
            <>
              <div className="page-hd"><h1>{t('dom.pain.title')}</h1></div>
              <div className="dom-body"><AdvancedPainEditor /></div>
            </>
          ) : selected ? (
            <DomPage key={selected.id} dom={selected} block={unknown || block === null ? null : <StartBlock block={block} onFlow={() => setPicked('flow')} onAi={() => openSetup('ai')} />} blocked={unknown || block !== null} />
          ) : (
            <div className="dom-picks dom-empty">
              <EmptyPick icon={<Plus />} title={t('dom.new')} onClick={() => void create()} />
              {account.signedIn && <EmptyPick icon={<Download />} title={t('dom.import')} onClick={() => setImporting(true)} />}
            </div>
          )}
        </div>
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </>
  )
}

function EmptyPick({ icon, title, onClick }: { icon: ReactNode; title: string; onClick: () => void }) {
  return (
    <button type="button" className="dom-pick" onClick={onClick}>
      <span className="ic">{icon}</span>
      <span className="t"><b>{title}</b></span>
    </button>
  )
}

function SetupStatus() {
  const t = useT()
  const ai = useDom((s) => s.ai)
  const account = useDom((s) => s.account)
  const own = useDom((s) => s.ownStatus)
  const accountChecked = useDom((s) => s.accountChecked)
  const subscribed = useAccount(isSubscriber)
  const line = (text: ReactNode, right?: string, warn = false) => (
    <span className={cx('st', warn && 'warn')}>
      <span>{text}</span>
      {right && <span>{right}</span>}
    </span>
  )
  const meter = (share: number) => <span className="meter"><i style={{ width: `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%` }} /></span>
  if (!ai.setupDone) return line(t('dom.setup.notSetUp'), undefined, true)
  if (ai.provider === 'own') {
    if (own?.kind === 'unreachable') return line(`${t('vr.notRunning')} · ${serverName(ai.ownUrl)}`, undefined, true)
    if (own?.kind === 'auth') return line(ownTrouble(t, ai.ownUrl, own).title, undefined, true)
    if (!ai.ownModel.trim()) return line(t('dom.setup.notSetUp'), undefined, true)
    return line(<>{t('dom.ai.own')} · <span className="mono">{ai.ownModel}</span></>)
  }
  if (!accountChecked) return null
  if (!account.signedIn) return line(t('dom.signIn.button'), undefined, true)
  if (!subscribed && account.freeSecondsLeft !== null) {
    const left = account.freeSecondsLeft
    return (
      <>
        {line(t('dom.freeLeft', { minutes: Math.ceil(left / 60) }), t('dom.freeOf', { minutes: DOM_FREE_SECONDS / 60 }), left <= 0)}
        {meter(left / DOM_FREE_SECONDS)}
      </>
    )
  }
  return (
    <>
      {line(`${t(TIER_LABEL[account.tier])} · ${t('dom.tokensLeft', { percent: Math.round(account.tokensLeft * 100) })}`, account.resetsAt ? t('dom.resets', { date: shortDate(account.resetsAt) }) : undefined)}
      {meter(account.tokensLeft)}
    </>
  )
}

function StartBlock({ block, onFlow, onAi }: { block: DomBlock; onFlow: () => void; onAi: () => void }) {
  const t = useT()
  const ai = useDom((s) => s.ai)
  const own = useDom((s) => s.ownStatus)
  const { setAi, checkOwn } = useDom.getState()
  const bar = (icon: ReactNode, title: string, action: ReactNode) => (
    <div className="dom-res warn" role="alert">
      {icon}
      <span className="t"><b>{title}</b></span>
      {action}
    </div>
  )
  switch (block) {
    case 'notSetUp':
      return bar(<SlidersHorizontal />, t('dom.setup.needed'), <Button variant="primary" onClick={onFlow}>{t('library.setup.title')}</Button>)
    case 'signIn':
      return bar(<CircleAlert />, t('dom.error.signedOut'), <Button onClick={onAi}>{t('dom.signIn.button')}</Button>)
    case 'freeUsed':
      return <SupporterOffer message={t('dom.error.freeTimeUsed')} label={t('dom.buySupporter')} action={{ label: t('dom.plan.own'), onClick: () => {
        void setAi({ provider: 'own' })
        onAi()
      } }} />
    case 'ownDown':
      return own && own.kind !== 'ok' ? <Trouble url={ai.ownUrl} result={own} onRetry={() => void checkOwn()} warn /> : null
    case 'ownKey':
      return own?.kind === 'auth' ? bar(<CircleAlert />, ownTrouble(t, ai.ownUrl, own).title, <Button onClick={onAi}>{t('library.setup.title')}</Button>) : null
    case 'ownModel':
      return bar(<CircleAlert />, t('dom.own.pickModel'), <Button onClick={onAi}>{t('library.setup.title')}</Button>)
    default:
      return null
  }
}

function DomPage({ dom, block, blocked }: { dom: DomProfile; block: ReactNode; blocked: boolean }) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('personality')
  const [deleting, setDeleting] = useState(false)
  const running = useDom((s) => s.running)
  const { save, start, remove } = useDom.getState()
  return (
    <>
      <div className="dom-hd">
        <Portrait dom={dom} className="dom-ava lg" />
        <h1>{dom.name || t('dom.newName')}</h1>
        <Button variant="ghost" icon aria-label={t('common.delete')} title={t('common.delete')} onClick={() => setDeleting(true)}>
          <Trash2 />
        </Button>
        <Button variant="primary" className="dom-start" disabled={blocked || running} onClick={() => void start(dom.id)}>
          <Play />
          {t('dom.start')}
        </Button>
      </div>
      {block && <div className="dom-block">{block}</div>}
      <div className="dom-tabs">
        <Segmented options={TABS.map((x) => ({ value: x, label: t(TAB_LABEL[x]) }))} value={tab} onChange={setTab} label={t('screen.dom')} />
      </div>
      <div className="dom-body">
        {tab === 'personality' && <PersonalityTab dom={dom} edit={(d) => void save(d)} />}
        {tab === 'images' && <ImagesTab dom={dom} edit={(d) => void save(d)} />}
        {tab === 'memory' && <MemoryTab key={dom.id} dom={dom} />}
      </div>
      <Prompt open={deleting} onOpenChange={setDeleting} title={t('dom.delete', { name: dom.name || t('dom.newName') })} confirmLabel={t('common.delete')} danger onConfirm={() => void remove(dom.id)} />
    </>
  )
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const doms = useDom((s) => s.doms)
  const [source, setSource] = useState<'mine' | 'directory'>('mine')
  const [settled, setSettled] = useState(false)
  const [query, setQuery] = useState('')
  const [list, setList] = useState<AlPersona[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setList(null)
    const timer = window.setTimeout(() => {
      invoke('dom:personas', source, query).then(
        (l) => {
          if (!live) return
          setSettled(true)
          if (!settled && source === 'mine' && l.length === 0) setSource('directory')
          else setList(l)
        },
        (err: unknown) => live && setError(domErrorText(err)),
      )
    }, source === 'directory' ? 300 : 0)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [source, query])
  const imported = new Set(doms.map((d) => d.alPersonaId))
  const take = async (p: AlPersona) => {
    setBusy(p.id)
    setError(null)
    try {
      const dom = await invoke('dom:import', source, p.id)
      useDom.setState((s) => ({ doms: [...s.doms, dom], selectedId: dom.id }))
      onClose()
    } catch (err) {
      setError(domErrorText(err))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t('dom.import')} width={520}>
      <div className="dom-import">
        <h2>{t('dom.import')}</h2>
        <div className="dom-import-bar">
          <Segmented options={[{ value: 'mine', label: t('dom.import.yours') }, { value: 'directory', label: t('dom.import.directory') }]} value={source} onChange={setSource} label={t('dom.import')} />
          {source === 'directory' && (
            <label className="dom-search">
              <Search />
              <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t('dom.import.directory')} />
            </label>
          )}
        </div>
        {error && <span className="dom-err">{error}</span>}
        {source === 'mine' && list?.length === 0 ? (
          <div className="dom-import-empty">{t('dom.import.none')}</div>
        ) : (
          <ul className="dom-import-list">
            {list?.map((p) => (
              <li key={p.id}>
                {p.avatarUrl ? <img className="dom-ava" src={p.avatarUrl} alt="" /> : <Portrait dom={{ name: p.name, portrait: '' }} className="dom-ava" />}
                <span className="t">
                  <b>{p.name}</b>
                  <span>{p.description}</span>
                </span>
                {source === 'mine' && imported.has(p.id) ? (
                  <span className="dom-status ok">{t('dom.import.imported')}</span>
                ) : (
                  <Button disabled={busy !== null} onClick={() => void take(p)}>{t('common.import')}</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
