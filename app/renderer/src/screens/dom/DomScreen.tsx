// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import * as Popover from '@radix-ui/react-popover'
import { ChevronsUpDown, Download, ExternalLink, Flame, Lock, Play, Plus, Search, Trash2, UserRound, Waves } from 'lucide-react'
import { useEffect, useState } from 'react'
import { SUBSCRIBE_URL, SUPPORTER_PRICE } from '@shared/account'
import { AGENTIC_LOVER_URL, DOM_FREE_SECONDS, domAccess, type AlPersona, type AlTier, type DomProfile } from '@shared/dom'
import type { MessageKey } from '@shared/i18n'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Prompt } from '@/components/ui/Prompt'
import { Segmented } from '@/components/ui/Segmented'
import { Switch } from '@/components/ui/Switch'
import { Select } from '@/components/ui/Select'
import { invoke } from '@/ipc'
import { cx } from '@/lib/cx'
import { electron } from '@/node'
import { isPremium, useAccount } from '@/state/account'
import { domErrorText, useDom } from '@/state/dom'
import { useT } from '@/state/i18n'
import { GetStarted } from './GetStarted'
import { ImagesTab, MemoryTab, PersonalityTab, PleasurePainPage, YouPage } from './DomTabs'
import { OwnAiFields } from './OwnAi'
import { Portrait } from './Portrait'
import { AdvancedPainEditor } from './AdvancedPain'
import './dom.css'

const TABS = ['personality', 'images', 'memory'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, MessageKey> = { personality: 'dom.tab.personality', images: 'dom.tab.images', memory: 'dom.tab.memory' }
const TIER_LABEL: Record<AlTier, MessageKey> = { free: 'dom.tier.free', pro: 'dom.tier.pro', supporter_plus: 'dom.tier.supporterPlus', supporter_plus_plus: 'dom.tier.supporterPlusPlus' }
const open = (url: string) => void electron.shell.openExternal(url)

export function DomScreen() {
  const t = useT()
  const doms = useDom((s) => s.doms)
  const loaded = useDom((s) => s.loaded)
  const selectedId = useDom((s) => s.selectedId)
  const ai = useDom((s) => s.ai)
  const account = useDom((s) => s.account)
  const premium = useAccount(isPremium)
  const [shared, setShared] = useState<'you' | 'pleasurePain' | 'advancedPain' | null>(null)
  const [importing, setImporting] = useState(false)
  const { load, select, create } = useDom.getState()
  useEffect(() => {
    void load()
  }, [load, premium])
  const access = domAccess({ ai, account }, premium)
  const selected = doms.find((d) => d.id === selectedId) ?? null
  const locked = access === 'freeUsed'
  return (
    <>
      <aside className="side-list dom-list">
        <h1>
          {t('screen.dom')}
          {locked && <Lock className="dom-lock" aria-label={t('common.supporterOnly')} />}
        </h1>
        <ul>
          <li>
            <button type="button" className={cx('side-row', shared === 'you' && 'on')} aria-current={shared === 'you' || undefined} onClick={() => setShared('you')}>
              <UserRound />
              {t('dom.you')}
            </button>
          </li>
          <li>
            <button type="button" className={cx('side-row', shared === 'pleasurePain' && 'on')} aria-current={shared === 'pleasurePain' || undefined} onClick={() => setShared('pleasurePain')}>
              <Flame />
              {t('dom.tab.pleasurePain')}
            </button>
          </li>
          <li>
            <button type="button" className={cx('side-row', shared === 'advancedPain' && 'on')} aria-current={shared === 'advancedPain' || undefined} onClick={() => setShared('advancedPain')}>
              <Waves />
              {t('dom.pain.title')}
            </button>
          </li>
          {doms.map((d) => (
            <li key={d.id}>
              <button type="button" className={cx('side-row dom-row', !shared && d.id === selectedId && 'on')} aria-current={(!shared && d.id === selectedId) || undefined} onClick={() => {
                setShared(null)
                select(d.id)
              }}>
                <Portrait dom={d} className="dom-ava" />
                <span className="n">{d.name || t('dom.newName')}</span>
                {d.alPersonaId && <span className="src">AL</span>}
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="side-row dom-add" onClick={() => {
              setShared(null)
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
        <AccountFoot />
      </aside>
      <div className="page dom-page">
        {shared === 'you' ? (
          <>
            <div className="page-hd"><h1>{t('dom.you')}</h1></div>
            <YouPage />
          </>
        ) : shared === 'pleasurePain' ? (
          <>
            <div className="page-hd"><h1>{t('dom.tab.pleasurePain')}</h1></div>
            <div className="dom-body"><PleasurePainPage /></div>
          </>
        ) : shared === 'advancedPain' ? (
          <>
            <div className="page-hd"><h1>{t('dom.pain.title')}</h1></div>
            <div className="dom-body"><AdvancedPainEditor /></div>
          </>
        ) : access === 'signIn' ? (
          <GetStarted dom={selected} />
        ) : selected ? (
          <DomPage key={selected.id} dom={selected} locked={locked} />
        ) : loaded ? (
          <div className="dom-empty">
            <Button variant="primary" onClick={() => void create()}><Plus />{t('dom.new')}</Button>
            {account.signedIn && <Button onClick={() => setImporting(true)}><Download />{t('dom.import')}</Button>}
          </div>
        ) : null}
      </div>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </>
  )
}

function DomPage({ dom, locked }: { dom: DomProfile; locked: boolean }) {
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
        <Button variant="primary" className="dom-start" disabled={locked || running} onClick={() => void start(dom.id)}>
          <Play />
          {t('dom.start')}
        </Button>
      </div>
      {locked && (
        <div className="game-offer">
          <Lock />
          <span>
            {t('dom.freeUsed')} <span className="game-offer-price">{t('game.priceFrom', { price: SUPPORTER_PRICE })}</span>
          </span>
          <Button variant="primary" onClick={() => open(SUBSCRIBE_URL)}>
            {t('firstStart.supporter.become')}
            <ExternalLink />
          </Button>
        </div>
      )}
      <div className="dom-tabs">
        <Segmented options={TABS.map((x) => ({ value: x, label: t(TAB_LABEL[x]) }))} value={tab} onChange={setTab} label={t('screen.dom')} />
      </div>
      <div className="dom-body">
        {tab === 'personality' && <PersonalityTab dom={dom} edit={(d) => void save(d)} />}
        {tab === 'images' && <ImagesTab dom={dom} edit={(d) => void save(d)} />}
        {tab === 'memory' && <MemoryTab dom={dom} />}
      </div>
      <Prompt open={deleting} onOpenChange={setDeleting} title={t('dom.delete', { name: dom.name || t('dom.newName') })} confirmLabel={t('common.delete')} danger onConfirm={() => void remove(dom.id)} />
    </>
  )
}

function AccountFoot() {
  const t = useT()
  const ai = useDom((s) => s.ai)
  const account = useDom((s) => s.account)
  const premium = useAccount(isPremium)
  const [openPop, setOpenPop] = useState(false)
  const free = !premium && account.freeSecondsLeft !== null
  return (
    <div className="dom-foot">
      <Popover.Root open={openPop} onOpenChange={setOpenPop}>
        <Popover.Trigger asChild>
          <button type="button" className="dom-acct">
            {ai.provider === 'own' ? (
              <>
                <span className="row">
                  <span>{t('dom.ai.own')}</span>
                  <ChevronsUpDown />
                </span>
                <span className="row faint mono">{ai.ownModel || ai.ownUrl}</span>
              </>
            ) : (
              <>
                <span className="row">
                  <span>{t('dom.poweredBy')}</span>
                  <ChevronsUpDown />
                </span>
                {account.signedIn && (
                  <>
                    <span className="meter"><i style={{ width: `${Math.round((free ? (account.freeSecondsLeft ?? 0) / DOM_FREE_SECONDS : account.tokensLeft) * 100)}%` }} /></span>
                    <span className="row faint">
                      {free ? (
                        <>
                          <span>{t('dom.freeLeft', { minutes: Math.ceil((account.freeSecondsLeft ?? 0) / 60) })}</span>
                          <span>{t('dom.freeOf', { minutes: DOM_FREE_SECONDS / 60 })}</span>
                        </>
                      ) : (
                        <>
                          <span>{t(TIER_LABEL[account.tier])} · {t('dom.tokensLeft', { percent: Math.round(account.tokensLeft * 100) })}</span>
                          {account.resetsAt && <span>{t('dom.resets', { date: new Date(account.resetsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) })}</span>}
                        </>
                      )}
                    </span>
                  </>
                )}
              </>
            )}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <AiPopover />
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

function AiPopover() {
  const t = useT()
  const ai = useDom((s) => s.ai)
  const account = useDom((s) => s.account)
  const { setAi, logout } = useDom.getState()
  return (
    <Popover.Content className="dom-pop" side="top" align="start" alignOffset={10} sideOffset={8} collisionPadding={12} aria-label={t('dom.ai.title')}>
      <h2>{t('dom.ai.title')}</h2>
      <Segmented
        options={[
          { value: 'agenticlover', label: 'Agentic Lover' },
          { value: 'own', label: t('dom.ai.own') },
        ]}
        value={ai.provider}
        onChange={(provider) => void setAi({ provider })}
        label={t('dom.ai.title')}
      />
      <div className="panel">
        {ai.provider === 'own' ? (
          <OwnAiFields />
        ) : account.signedIn ? (
          <>
            <div className="prow">
              <span className="lbl">{t('dom.ai.account')}</span>
              <span className="spacer" />
              <span className="val">{account.email}</span>
              <button type="button" className="dom-link" onClick={() => void logout()}>{t('dom.signOut')}</button>
            </div>
            <div className="prow">
              <span className="lbl">{t('dom.ai.model')}</span>
              <span className="spacer" />
              <Select options={[{ value: '', label: t('dom.ai.defaultModel') }, ...account.models.map((m) => ({ value: m.id, label: m.label }))]} value={ai.alModel} onChange={(alModel) => void setAi({ alModel })} label={t('dom.ai.model')} />
            </div>
          </>
        ) : null}
      </div>
      <div className="panel">
        <div className="prow">
          <span className="lbl">{t('dom.ai.tagEditing')}</span>
          <span className="spacer" />
          <Switch checked={ai.tagEditing} onCheckedChange={(tagEditing) => void setAi({ tagEditing })} label={t('dom.ai.tagEditing')} />
        </div>
        <div className="prow">
          <span className="lbl">{t('dom.ai.viewVideo')}</span>
          <span className="spacer" />
          <Switch checked={ai.viewVideo} onCheckedChange={(viewVideo) => void setAi({ viewVideo })} label={t('dom.ai.viewVideo')} />
        </div>
      </div>
      <button type="button" className="dom-link dom-al-link" onClick={() => open(AGENTIC_LOVER_URL)}>
        agenticlover.ai
        <ExternalLink />
      </button>
    </Popover.Content>
  )
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const doms = useDom((s) => s.doms)
  const [source, setSource] = useState<'mine' | 'directory'>('mine')
  const [query, setQuery] = useState('')
  const [list, setList] = useState<AlPersona[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setList(null)
    const timer = window.setTimeout(() => {
      invoke('dom:personas', source, query).then(
        (l) => live && setList(l),
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
      </div>
    </Modal>
  )
}
