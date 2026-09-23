import * as Popover from '@radix-ui/react-popover'
import { Check, Plus, Search, Tag, X } from 'lucide-react'
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useT } from '@/state/i18n'
import './TagPicker.css'

interface Props {
  tags: readonly string[]
  selected: readonly string[]
  onChange: (tags: string[]) => Promise<void>
  onClose: () => void
  rect: DOMRect
  anchor: HTMLElement | null
  saveError?: boolean
}

export function TagPicker({ tags, selected, onChange, onClose, rect, anchor, saveError = false }: Props) {
  const t = useT()
  const headingId = useId()
  const selectedId = useId()
  const listId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const chipsRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState(false)
  const revision = useRef(0)
  const interactedOutside = useRef(false)
  const [catalogue, setCatalogue] = useState(() => [...new Set([...tags, ...selected])].sort((a, b) => a.localeCompare(b)))
  const matches = catalogue.filter((tag) => tag.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

  const change = (next: string[]) => {
    const own = ++revision.current
    setError(false)
    void onChange(next).catch(() => {
      if (own === revision.current) setError(true)
    })
  }
  const toggle = (tag: string) => change(selected.includes(tag) ? selected.filter((value) => value !== tag) : [...selected, tag])
  const remove = (tag: string, index: number) => {
    const buttons = chipsRef.current?.querySelectorAll<HTMLButtonElement>('button')
    const next = buttons?.[index + 1] ?? buttons?.[index - 1] ?? searchRef.current
    next?.focus()
    change(selected.filter((value) => value !== tag))
  }
  const navigate = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const inputs = [...(listRef.current?.querySelectorAll<HTMLInputElement>('input') ?? [])]
    if (!inputs.length) return
    const index = inputs.findIndex((input) => input === event.target)
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, inputs.length - 1) : index < 0 ? inputs.length - 1 : Math.max(index - 1, 0)
    event.preventDefault()
    inputs[next]?.focus()
  }
  const add = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim().toLowerCase()
    if (!trimmed) return
    const tag = catalogue.find((value) => value.toLocaleLowerCase() === trimmed.toLocaleLowerCase()) ?? trimmed
    if (!catalogue.includes(tag)) setCatalogue((values) => [...values, tag].sort((a, b) => a.localeCompare(b)))
    if (!selected.includes(tag)) change([...selected, tag])
    setName('')
    setQuery('')
    setCreating(false)
    searchRef.current?.focus()
  }

  return (
    <Popover.Root open onOpenChange={(open) => !open && onClose()}>
      <Popover.Anchor asChild><span className="menu-anchor" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} aria-hidden /></Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className="tag-picker"
          aria-labelledby={headingId}
          align={rect.width === 0 ? 'start' : 'end'}
          sideOffset={4}
          collisionPadding={12}
          onOpenAutoFocus={(event) => { event.preventDefault(); searchRef.current?.focus() }}
          onInteractOutside={() => { interactedOutside.current = true }}
          onCloseAutoFocus={(event) => { event.preventDefault(); if (!interactedOutside.current && anchor?.isConnected) anchor.focus() }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="tag-picker-header">
            <Tag aria-hidden />
            <h2 id={headingId}>{t('library.sidebar.tags')}</h2>
            <Popover.Close className="tag-picker-done">{t('common.done')}</Popover.Close>
          </div>
          <label className="tag-picker-search">
            <Search aria-hidden />
            <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={navigate} placeholder={t('library.tag.search')} aria-label={t('library.tag.search')} autoComplete="off" />
          </label>
          <section className="tag-picker-selected" aria-labelledby={selectedId}>
            <div className="tag-picker-label" id={selectedId}>{t('library.select.selected', { count: selected.length })}</div>
            <div className="tag-picker-chips" ref={chipsRef}>
              {selected.map((tag, index) => <button key={tag} type="button" className="tag-picker-chip" title={tag} aria-label={t('library.tag.remove', { name: tag })} onClick={() => remove(tag, index)}><span>{tag}</span><X aria-hidden /></button>)}
              {selected.length === 0 && <span className="tag-picker-empty">{t('library.tag.noneSelected')}</span>}
            </div>
          </section>
          <div className="tag-picker-label" id={listId}>{t('library.tag.all')}</div>
          <div className="tag-picker-list" ref={listRef} role="group" aria-labelledby={listId} onKeyDown={navigate}>
            {matches.map((tag) => <label key={tag} className="tag-picker-row" title={tag}>
              <input type="checkbox" checked={selected.includes(tag)} onChange={() => toggle(tag)} />
              <span className="tag-picker-check" aria-hidden><Check /></span><span className="tag-picker-name">{tag}</span>
            </label>)}
            {matches.length === 0 && <div className="tag-picker-empty">{t('library.tag.noResults')}</div>}
          </div>
          {(error || saveError) && <div className="tag-picker-error" role="alert">{t('library.tag.saveFailed')}</div>}
          {creating && <form className="tag-picker-create" onSubmit={add}>
            <input autoFocus className="input" aria-label={t('library.tag.placeholder')} placeholder={t('library.tag.placeholder')} value={name} onChange={(event) => setName(event.target.value)} maxLength={100} />
            <button type="submit" disabled={!name.trim()}>{t('library.tag.add')}</button>
          </form>}
          <div className="tag-picker-footer"><button type="button" onClick={() => setCreating((value) => !value)} aria-expanded={creating}><Plus aria-hidden />{t('library.tag.new')}</button><kbd aria-hidden>esc</kbd></div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
