// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { ArrowUp, Brain, CirclePause, CirclePlay, FastForward, Flame, ListOrdered, Square, X, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { DOM_LEVEL_MAX } from '@shared/dom'
import { isPremium, useAccount } from '@/state/account'
import { useDom, type DomActIcon } from '@/state/dom'
import { useT } from '@/state/i18n'
import { Portrait } from './Portrait'
import './dom.css'

const ACT_ICON: Record<DomActIcon, LucideIcon> = { top: ListOrdered, played: CirclePlay, paused: CirclePause, seek: FastForward, level: Flame, remembered: Brain, forgot: X }

function Level() {
  const level = useDom((s) => s.level)
  const held = useDom((s) => s.held)
  const shown = held?.level ?? level
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!held) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [held])
  const left = held ? Math.max(0, Math.ceil((held.until - now) / 1000)) : 0
  return (
    <span className="dom-lvl">
      <span className="n">{shown}</span>
      <span className="dom-lvl-bar"><i style={{ width: `${(shown / DOM_LEVEL_MAX) * 100}%` }} /></span>
      {held && <span className="left">0:{String(left).padStart(2, '0')}</span>}
    </span>
  )
}

export function DomColumn() {
  const t = useT()
  const dom = useDom((s) => s.doms.find((d) => d.id === s.domId) ?? null)
  const ppOn = useDom((s) => s.pleasurePain.enabled)
  const lines = useDom((s) => s.lines)
  const image = useDom((s) => s.image)
  const thinking = useDom((s) => s.thinking)
  const freeSeconds = useDom((s) => s.account.freeSecondsLeft)
  const provider = useDom((s) => s.ai.provider)
  const premium = useAccount(isPremium)
  const { stop, send } = useDom.getState()
  const [draft, setDraft] = useState('')
  const log = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [lines.length, thinking])
  if (!dom) return null
  const submit = (e: FormEvent) => {
    e.preventDefault()
    send(draft)
    setDraft('')
  }
  const showFree = !premium && provider === 'agenticlover' && freeSeconds !== null
  return (
    <aside className="dom-col" aria-label={dom.name}>
      <div className="hd">
        <div className="who">
          <b>{dom.name || t('dom.newName')}</b>
          <span className="line">
            {ppOn && <Level />}
            {showFree && <span className="free">{t('dom.freeMinutes', { minutes: Math.ceil(freeSeconds / 60) })}</span>}
          </span>
        </div>
        <button type="button" className="dom-stop" onClick={stop}>
          <Square />
          {t('common.stop')}
          <span className="dom-kbd">Esc</span>
        </button>
      </div>
      <Portrait dom={dom} src={image} className="pic" />
      <div className="log" ref={log}>
        {lines.map((l) => {
          if (l.kind === 'act') {
            const Icon = ACT_ICON[l.icon]
            return (
              <div key={l.id} className={l.warn ? 'act warn' : 'act'}>
                <Icon />
                <span>{l.text}{l.value && <> <b>{l.value}</b></>}</span>
              </div>
            )
          }
          if (l.kind === 'error') return <div key={l.id} className="act err">{l.text}</div>
          return <div key={l.id} className={`msg ${l.kind}`}>{l.text}</div>
        })}
        {thinking && <div className="msg dom typing" aria-label={t('dom.typing')}>…</div>}
      </div>
      <form className="ft" onSubmit={submit}>
        <label className="dom-composer">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('dom.reply', { name: dom.name || t('dom.newName') })} />
          <button type="submit" className="send" aria-label={t('dom.send')} disabled={!draft.trim()}>
            <ArrowUp />
          </button>
        </label>
      </form>
    </aside>
  )
}
