// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronsUpDown, CornerDownLeft, Search } from 'lucide-react'
import { Fragment, useEffect, useId, useState, type KeyboardEvent } from 'react'
import { cx } from '@/lib/cx'
import { useT } from '@/state/i18n'
import { listModels } from './setup'

interface Props {
  models: readonly string[]
  value: string
  onPick: (model: string) => void
}

export function ModelPicker({ models, value, onPick, onSubmit, inline = false }: Props & { onSubmit?: () => void; inline?: boolean }) {
  const t = useT()
  const id = useId()
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [hi, setHi] = useState(-1)
  const list = listModels(models, query, showAll, value)
  const options = [...(list.unlisted ? [list.unlisted] : []), ...list.groups.flatMap((g) => g.ids), ...(list.typed ? [list.typed] : [])]
  const optId = (i: number) => `${id}-${i}`
  useEffect(() => {
    if (hi >= 0) document.getElementById(`${id}-${hi}`)?.scrollIntoView({ block: 'nearest' })
  }, [hi, id])
  const search = (q: string) => {
    setQuery(q)
    setHi(q.trim() ? 0 : -1)
  }
  const pick = (model: string) => {
    onPick(model)
    setQuery('')
    setHi(-1)
  }
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = options.length
      if (n) setHi((i) => (e.key === 'ArrowDown' ? (i + 1) % n : i <= 0 ? n - 1 : i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const model = options[hi]
      if (model) pick(model)
      else if (value) onSubmit?.()
    }
  }
  const row = (model: string, text: string, index: number) => (
    <div key={model} id={optId(index)} role="option" aria-selected={model === value} className={cx('dom-mrow', model === value && 'sel', index === hi && 'hi')} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(model)}>
      <span className="tick">{model === value && <Check />}</span>
      <span className="n"><Marked text={text} query={query.trim()} /></span>
    </div>
  )
  let index = 0
  return (
    <div className={cx('dom-mbox', inline && 'inline')}>
      <label className="dom-msearch">
        <Search />
        <input role="combobox" aria-expanded aria-controls={`${id}-list`} aria-activedescendant={hi >= 0 ? optId(hi) : undefined} aria-label={t('dom.ai.model')} placeholder={t('library.toolbar.search')} value={query} spellCheck={false} autoComplete="off" autoFocus onChange={(e) => search(e.target.value)} onKeyDown={keys} />
      </label>
      <div className="dom-mlist" id={`${id}-list`} role="listbox" aria-label={t('dom.ai.model')}>
        {list.unlisted && row(list.unlisted, list.unlisted, index++)}
        {list.groups.map((g) => (
          <Fragment key={g.vendor}>
            {g.vendor && <div className="dom-mgrp" role="presentation">{g.vendor}/</div>}
            {g.ids.map((m) => row(m, g.vendor ? m.slice(g.vendor.length + 1) : m, index++))}
          </Fragment>
        ))}
        {query.trim() && !list.groups.length && <div className="dom-mempty">{t('editor.shortcuts.noMatches')}</div>}
        {list.typed && (
          <div id={optId(index)} role="option" aria-selected={false} className={cx('dom-mrow use', index === hi && 'hi')} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(list.typed ?? '')}>
            <CornerDownLeft />
            <span className="n">{t('dom.model.use', { model: list.typed })}</span>
          </div>
        )}
      </div>
      {list.hidden > 0 && (
        <div className="dom-mfoot">
          <span>{t('dom.model.hidden', { count: list.hidden })}</span>
          <button type="button" onClick={() => setShowAll((s) => !s)}>{showAll ? t('common.hide') : t('library.sidebar.show')}</button>
        </div>
      )}
    </div>
  )
}

function Marked({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (at < 0) return <>{text}</>
  return <>{text.slice(0, at)}<b>{text.slice(at, at + query.length)}</b>{text.slice(at + query.length)}</>
}

export function ModelCombobox({ models, value, onPick }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={cx('dom-mtrig dom-ctl', open && 'open')} aria-label={`${t('dom.ai.model')}: ${value || t('common.none')}`}>
          <span className={cx('v', !value && 'faint')}>{value || t('common.none')}</span>
          <ChevronsUpDown />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="dom-mpop" align="end" sideOffset={6} collisionPadding={12}>
          <ModelPicker models={models} value={value} onPick={(m) => {
            onPick(m)
            setOpen(false)
          }} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
